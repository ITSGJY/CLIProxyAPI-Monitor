import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createOmcErrorFixture } from "./omc-errors-fixture.mjs";
import { errorTestDatabase } from "./errors-db-helper.mjs";
import { importOmcErrors, errorSnapshotHash, OMC_ERROR_INSTANCE } from "../scripts/import-omc-errors.mjs";
import { getCredentialErrors } from "../lib/cpa-errors/query.mjs";

async function sourceFixture(t, mode = "new", count = 2) {
  const dir = await mkdtemp(join(tmpdir(), "phase55-omc-"));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const source = join(dir, "snapshot.sqlite");
  createOmcErrorFixture(source, mode, count);
  return source;
}

test("read-only OMC old/new schema exporter preserves identity/time, leaves absent cooldown fields unknown, and redacts before stdout", async (t) => {
  for (const mode of ["old", "new"]) {
    const source = await sourceFixture(t, mode);
    const hash = await errorSnapshotHash(source);
    const result = execFileSync("python3", ["scripts/omc-sqlite-source.py", "errors", "--source", source], { encoding: "utf8" });
    const rows = result.trim().split("\n").map(JSON.parse);
    assert.equal(rows[0].auth_index, "auth-9");
    assert.equal(rows[0].timestamp_ms, 1795136400001);
    assert.equal(rows[0].created_at_ms, 1795136401001);
    assert.equal(rows[0].model_backoff_level, mode === "new" ? 3 : null);
    assert.equal(rows[0].model_quota_exceeded, mode === "new" ? 1 : null);
    assert.equal(rows[0].cooldown_model, mode === "new" ? "model-a" : null);
    for (const secret of ["auth_id", "credential-secret", "token-value", "user@example.com", "privatetoken123"]) assert.ok(!result.includes(secret));
    assert.equal(await errorSnapshotHash(source), hash);
  }
});

test("error source export rejects WAL sidecars instead of hashing only part of a mutable database", async (t) => {
  const source = await sourceFixture(t);
  await writeFile(source + "-wal", "not a standalone snapshot");
  await assert.rejects(errorSnapshotHash(source), /requires_snapshot/);
  assert.throws(() => execFileSync("python3", ["scripts/omc-sqlite-source.py", "errors", "--source", source], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
});

for (const mode of ["old", "new"]) test(`PostgreSQL 17 OMC ${mode} errors import, replay, provenance, correlation and reconciliation`, { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const { pool, url } = await errorTestDatabase(t);
  const source = await sourceFixture(t, mode);
  const hash = await errorSnapshotHash(source);
  const first = await importOmcErrors({ pool, source, expectedHash: hash, batchSize: 1 });
  assert.equal(first.inserted, 2);
  assert.equal(first.processed, first.expected);
  assert.equal(first.reconciled, 2);
  const replay = await importOmcErrors({ pool, source });
  assert.equal(replay.inserted, 0);
  assert.equal(replay.skipped, 2);
  await pool.query("INSERT INTO cpa_error_import_runs (source_instance_id,source_sha256,status,expected_count) VALUES ($1,$2,'running',2)", [OMC_ERROR_INSTANCE, hash]);
  const events = (await pool.query("SELECT * FROM cpa_error_events ORDER BY id")).rows;
  assert.equal(events.length, 2);
  assert.ok(events.every((e) => e.source_instance_id === OMC_ERROR_INSTANCE && e.source_snapshot_sha256 === hash));
  assert.equal(events[0].model_backoff_level, mode === "new" ? 3 : null);
  assert.equal(events[0].model_quota_exceeded, mode === "new" ? true : null);
  assert.equal(events[0].auth_quota_aggregate, mode === "new");
  assert.equal(events[0].auth_index, "auth-9");
  assert.equal(new Date(events[0].occurred_at).getTime(), 1795136400001);
  assert.equal(new Date(events[0].received_at).getTime(), 1795136401001);
  assert.ok(!JSON.stringify(events).includes("credential-secret"));
  const result = await getCredentialErrors(pool, { sourceInstanceId: OMC_ERROR_INSTANCE, authIndex: "auth-9", occurredAt: new Date(1795136400001) });
  assert.equal(result.events.length, 2);
  assert.equal(result.coverage.status, "historical_import");
  assert.equal(result.coverage.complete, false);
  assert.equal(Number((await pool.query("SELECT count(*) FROM usage_inbox")).rows[0].count), 0);
  const output = execFileSync(process.execPath, ["scripts/import-omc-sqlite.mjs", "--errors-only", "--source", source, "--source-sha256", hash], { encoding: "utf8", env: { ...process.env, DATABASE_URL: url } });
  assert.equal(JSON.parse(output).skipped, 2);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM cpa_error_import_runs WHERE status='failed' AND last_error_code='interrupted'")).rows[0].count, 1);
});

test("missing OMC error table is audited unavailable; a present empty table is reconciled separately", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const { pool } = await errorTestDatabase(t);
  const missing = await importOmcErrors({ pool, source: await sourceFixture(t, "missing") });
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.expected, null);
  const empty = await importOmcErrors({ pool, source: await sourceFixture(t, "old", 0) });
  assert.equal(empty.status, "completed");
  assert.equal(empty.expected, 0);
  assert.equal(empty.reconciled, 0);
});

test("OMC hash mutation, invalid rows and final target-count mismatch produce failed audits and safe repeat import", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const { pool } = await errorTestDatabase(t);
  let source = await sourceFixture(t);
  await assert.rejects(importOmcErrors({ pool, source, expectedHash: "wrong" }), /hash_mismatch/);
  await assert.rejects(importOmcErrors({ pool, source, beforeReconcile: () => appendFile(source, "changed") }), /hash_mismatch/);
  source = await sourceFixture(t);
  await assert.rejects(importOmcErrors({ pool, source, beforeReconcile: () => pool.query("DELETE FROM cpa_error_events") }), /count_mismatch/);
  assert.equal((await importOmcErrors({ pool, source })).inserted, 2);
  const invalid = await sourceFixture(t);
  execFileSync("python3", ["-c", "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute('UPDATE error_events SET timestamp_ms=0 WHERE id=2');c.commit();c.close()", invalid]);
  await assert.rejects(importOmcErrors({ pool, source: invalid, batchSize: 1 }), /invalid_error_source_row/);
  const runs = (await pool.query("SELECT * FROM cpa_error_import_runs ORDER BY id")).rows;
  const last = runs.at(-1);
  assert.equal(last.status, "failed");
  assert.equal(last.processed_count, "2");
  assert.equal(last.failed_count, "1");
  assert.equal(last.skipped_count, "1");
  assert.equal(runs.filter((r) => r.status === "failed").length, 4);
});

test("OMC reused source identity with changed timestamp fails instead of silently claiming a valid replay", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const { pool } = await errorTestDatabase(t);
  const source = await sourceFixture(t);
  await importOmcErrors({ pool, source });
  execFileSync("python3", ["-c", "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute('UPDATE error_events SET timestamp_ms=timestamp_ms+1000 WHERE id=1');c.commit();c.close()", source]);
  await assert.rejects(importOmcErrors({ pool, source }), /identity_conflict/);
  const audit = (await pool.query("SELECT status,failed_count FROM cpa_error_import_runs ORDER BY id DESC LIMIT 1")).rows[0];
  assert.equal(audit.status, "failed");
  assert.equal(audit.failed_count, "1");
  assert.equal(Number((await pool.query("SELECT count(*) FROM cpa_error_events")).rows[0].count), 2);
});
