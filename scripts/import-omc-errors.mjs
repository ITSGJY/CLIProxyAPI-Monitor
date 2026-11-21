import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { normalizeOmcError } from "../lib/cpa-errors/normalize.mjs";
import { insertErrorEvent, ERROR_COLUMNS } from "../lib/cpa-errors/store.mjs";

export const OMC_ERROR_INSTANCE = "legacy-oh-my-cpa-default";
export async function errorSnapshotHash(source) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = await stat(source + suffix).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (sidecar) throw new Error("error_source_requires_snapshot");
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(source)) hash.update(chunk);
  return hash.digest("hex");
}

export async function importOmcErrors({ pool, source, expectedHash, batchSize = 250, beforeReconcile }) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error("invalid_error_import_batch_size");
  const sourceHash = await errorSnapshotHash(source);
  const inspected = spawnSync("python3", ["scripts/omc-sqlite-source.py", "errors-manifest", "--source", source], { encoding: "utf8", maxBuffer: 1048576 });
  if (inspected.status !== 0) throw new Error("error_source_preflight_failed");
  const manifest = JSON.parse(inspected.stdout);
  const client = await pool.connect();
  let runId;
  let processed = 0, inserted = 0, skipped = 0, failed = 0, reconciled = 0;
  let child;
  let closed;
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended('omc-error-import',0))");
    await client.query(`UPDATE cpa_error_import_runs SET status='failed',last_error_code='interrupted',finished_at=now()
      WHERE source_instance_id=$1 AND status='running'`, [OMC_ERROR_INSTANCE]);
    // Runs are append-only audit attempts. Event identity is independent of the snapshot/run.
    const run = await client.query(`INSERT INTO cpa_error_import_runs
      (source_instance_id,source_sha256,source_schema_version,status,expected_count,min_occurred_at,max_occurred_at)
      VALUES ($1,$2,$3,'running',$4,to_timestamp($5::double precision/1000),to_timestamp($6::double precision/1000)) RETURNING id`,
    [OMC_ERROR_INSTANCE, sourceHash, String(manifest.source_schema_version ?? "unknown"), manifest.expected_count,
      manifest.min_timestamp_ms ?? null, manifest.max_timestamp_ms ?? null]);
    runId = run.rows[0].id;
    if ((expectedHash && expectedHash !== sourceHash) || await errorSnapshotHash(source) !== sourceHash) throw new Error("error_source_hash_mismatch");
    if (!manifest.available) {
      await client.query("UPDATE cpa_error_import_runs SET status='unavailable',last_error_code='source_error_table_unavailable',finished_at=now() WHERE id=$1", [runId]);
      return { status: "unavailable", runId, expected: null, processed, inserted, skipped, failed };
    }
    child = spawn("python3", ["scripts/omc-sqlite-source.py", "errors", "--source", source], { stdio: ["ignore", "pipe", "ignore"] });
    closed = new Promise((resolve) => { child.once("error", () => resolve(-1)); child.once("close", resolve); });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let batch = [];
    let lastId = 0;
    async function progress() {
      await client.query(`UPDATE cpa_error_import_runs SET processed_count=$2,inserted_count=$3,skipped_count=$4,
        failed_count=$5,reconciled_count=$6 WHERE id=$1`, [runId, processed, inserted, skipped, failed, reconciled]);
    }
    async function flush() {
      if (!batch.length) return;
      let batchInserted = 0;
      await client.query("BEGIN");
      try {
        for (const event of batch) {
          batchInserted += await insertErrorEvent(client, event);
          // A reused source row ID with changed content is not an idempotent replay.
          const compare = ERROR_COLUMNS.filter((key) => !["source_instance_id", "event_key", "import_run_id", "source_snapshot_sha256"].includes(key));
          const same = await client.query(`SELECT id FROM cpa_error_events WHERE source_instance_id=$1 AND event_key=$2
            AND ${compare.map((key, i) => `${key} IS NOT DISTINCT FROM $${i + 3}`).join(" AND ")}`,
            [event.source_instance_id, event.event_key, ...compare.map((key) => event[key] ?? null)]);
          if (same.rowCount !== 1) throw new Error("error_import_identity_conflict");
        }
        // Verify every identity from this snapshot, including previously imported rows.
        // It need not be the only (or latest) OMC snapshot in the target database.
        const match = await client.query(`SELECT count(*)::int AS count FROM cpa_error_events
          WHERE source_instance_id=$1 AND event_key=ANY($2::text[]) AND source_transport='legacy_import'`,
        [OMC_ERROR_INSTANCE, batch.map((event) => event.event_key)]);
        if (match.rows[0].count !== batch.length) throw new Error("error_import_count_mismatch");
        await client.query(`INSERT INTO cpa_error_import_items (run_id,event_id)
          SELECT $1,id FROM cpa_error_events WHERE source_instance_id=$2 AND event_key=ANY($3::text[])`,
        [runId, OMC_ERROR_INSTANCE, batch.map((event) => event.event_key)]);
        await client.query(`UPDATE cpa_error_import_runs SET processed_count=$2,inserted_count=$3,skipped_count=$4,reconciled_count=$5 WHERE id=$1`,
          [runId, processed + batch.length, inserted + batchInserted, skipped + batch.length - batchInserted, reconciled + match.rows[0].count]);
        await client.query("COMMIT");
        processed += batch.length; inserted += batchInserted; skipped += batch.length - batchInserted; reconciled += match.rows[0].count;
        batch = [];
      } catch (error) {
        await client.query("ROLLBACK");
        if (error.message === "error_import_identity_conflict") { failed += 1; processed += 1; await progress(); }
        throw error;
      }
    }
    for await (const line of lines) {
      if (!line) continue;
      let event;
      try {
        const row = JSON.parse(line);
        if (!Number.isSafeInteger(row.id) || row.id <= lastId) throw new Error("error_source_identity_order");
        event = normalizeOmcError(row, { instanceId: OMC_ERROR_INSTANCE });
        lastId = row.id;
      } catch {
        await flush();
        failed += 1; processed += 1;
        await progress();
        throw new Error("invalid_error_source_row");
      }
      batch.push({ ...event, import_run_id: runId, source_snapshot_sha256: sourceHash });
      if (batch.length >= batchSize) await flush();
    }
    await flush();
    if (await closed !== 0) throw new Error("error_source_export_failed");
    await beforeReconcile?.(); // Deterministic fault injection in isolated integration tests.
    if (await errorSnapshotHash(source) !== sourceHash) throw new Error("error_source_hash_mismatch");
    const finalCount = await client.query("SELECT count(*)::int AS count FROM cpa_error_import_items i JOIN cpa_error_events e ON e.id=i.event_id WHERE i.run_id=$1", [runId]);
    if (processed !== manifest.expected_count || processed !== inserted + skipped || reconciled !== processed || failed || finalCount.rows[0].count !== processed) throw new Error("error_import_count_mismatch");
    await client.query("UPDATE cpa_error_import_runs SET status='completed',finished_at=now() WHERE id=$1", [runId]);
    return { status: "completed", runId, sourceHash, expected: manifest.expected_count, processed, inserted, skipped, failed, reconciled };
  } catch (error) {
    if (child && child.exitCode === null) child.kill("SIGTERM");
    if (closed) await closed;
    // Only locally generated codes are persisted; never child stderr or database errors.
    const codes = new Set(["error_source_hash_mismatch", "error_import_count_mismatch", "invalid_error_source_row", "error_source_export_failed", "error_import_identity_conflict"]);
    const code = codes.has(error.message) ? error.message : "error_import_failed";
    if (runId) await client.query("UPDATE cpa_error_import_runs SET status='failed',last_error_code=$2,finished_at=now() WHERE id=$1", [runId, code]).catch(() => {});
    throw new Error(code);
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtextextended('omc-error-import',0))").catch(() => {});
    client.release();
  }
}
