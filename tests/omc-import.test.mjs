import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

const fixtureSql = String.raw`
import json, sqlite3, sys
p=sys.argv[1]
c=sqlite3.connect(p)
c.executescript('''
CREATE TABLE schema_migrations(version INTEGER NOT NULL, applied_at TEXT);
INSERT INTO schema_migrations(version,applied_at) VALUES (63,'test');
CREATE TABLE model_price_versions (
 id INTEGER PRIMARY KEY, model TEXT NOT NULL, effective_from_ms INTEGER NOT NULL, available INTEGER NOT NULL,
 prompt_price_per_1m REAL NOT NULL, completion_price_per_1m REAL NOT NULL, cache_read_price_per_1m REAL NOT NULL,
 cache_write_price_per_1m REAL NOT NULL, price_multiplier REAL NOT NULL, source TEXT NOT NULL,
 tiers_json TEXT NOT NULL, upstream_id TEXT NOT NULL, channel TEXT NOT NULL
);
INSERT INTO model_price_versions VALUES (77,'gpt-test',1790790000000,1,2.5,10,1.25,2.0,1.0,'modelsdev','[{"name":"priority","input":2.5}]','upstream-gpt-test','responses');
CREATE TABLE usage_events (
 id INTEGER PRIMARY KEY, instance_id TEXT NOT NULL, event_key TEXT NOT NULL,
 api_group_key TEXT NOT NULL, provider TEXT, endpoint TEXT, auth_type TEXT, request_id TEXT,
 model TEXT, model_alias TEXT, reasoning_effort TEXT, service_tier TEXT, response_service_tier TEXT,
 executor_type TEXT, timestamp_ms INTEGER, source TEXT, auth_index TEXT, failed INTEGER,
 generate INTEGER, latency_ms INTEGER, ttft_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER,
 reasoning_tokens INTEGER, cached_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
 total_tokens INTEGER, created_at_ms INTEGER, api_group_label TEXT, api_key_mask TEXT,
 cost_nanos INTEGER, price_version_id INTEGER, pricing_status TEXT, stream INTEGER,
 response_model TEXT, model_substituted INTEGER, fail_status_code INTEGER, access_provider TEXT,
 is_native_key INTEGER, billed_service_tier TEXT, billed_service_tier_source TEXT,
 effective_service_tier TEXT, fail_code TEXT, token_accounting TEXT, structured_usage TEXT,
 client_ip TEXT, x_forwarded_for TEXT, user_agent TEXT, fail_body TEXT, response_headers TEXT, raw_json TEXT
);
''')
base=dict(instance_id='default',event_key='same-key',api_group_key='group-1',timestamp_ms=1790800000000,created_at_ms=1790800001000,cost_nanos=123456,price_version_id=77,provider='openai',endpoint='/v1/responses',auth_type='api_key',request_id='same-request',model='gpt-test',model_alias='gpt-test-alias',reasoning_effort='high',service_tier='priority',response_service_tier='priority',executor_type='test',source='credential-hash',auth_index='auth-1',failed=0,generate=1,latency_ms=123,ttft_ms=45,input_tokens=100,output_tokens=50,reasoning_tokens=10,cached_tokens=20,cache_read_tokens=20,cache_creation_tokens=0,total_tokens=150,api_group_label='Test Group',api_key_mask='sk-test••••1234',pricing_status='priced',stream=1,response_model='gpt-test',model_substituted=0,fail_status_code=0,access_provider='openai',is_native_key=0,effective_service_tier='priority',fail_code='',token_accounting=json.dumps({'version':1,'status':'canonical'}),structured_usage=json.dumps({'tokens':{'input':100}}),client_ip='203.0.113.8',x_forwarded_for='198.51.100.4',user_agent='sensitive-agent',fail_body='sensitive-body',response_headers='{"authorization":"secret"}',raw_json='{"secret":"do-not-import"}')
cols=list(base.keys())
for i,extra in [(1,dict(timestamp_ms=1790800000000,created_at_ms=1790800001000,cost_nanos=123456,price_version_id=77)),(2,dict(timestamp_ms=1790800002000,created_at_ms=1790800003000,cost_nanos=None,price_version_id=None,pricing_status='unpriced',failed=1,fail_status_code=500))]:
 row={**base,**extra,'id':i}
 names=['id']+cols
 c.execute('INSERT INTO usage_events ('+','.join(names)+') VALUES ('+','.join('?' for _ in names)+')',[row.get(k) for k in names])
c.commit(); c.close()
`;

test("Oh My CPA SQLite importer preserves source rows, provenance, prices and idempotency", {
  skip: !testDatabaseUrl
}, async () => {
  const parsed = new URL(testDatabaseUrl);
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  assert.ok(["127.0.0.1", "localhost"].includes(parsed.hostname));
  assert.ok(dbName.toLowerCase().includes("test"));
  const { Pool } = await import("pg");
  const admin = new Pool({ connectionString: testDatabaseUrl, max: 1 });
  const schema = "phase6_import_test_" + randomUUID().replaceAll("-", "");
  const dir = await mkdtemp(join(tmpdir(), "omc-import-test-"));
  const source = join(dir, "fixture.sqlite");
  let scoped;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const options = `-c search_path=${schema},public`;
    const targetUrl = new URL(testDatabaseUrl);
    targetUrl.searchParams.set("options", options);
    scoped = new Pool({ connectionString: targetUrl.toString(), max: 2, options });
    const migrations = [
      "0000_pink_christian_walker.sql", "0001_remove_request_counts.sql",
      "0002_add_source_to_usage_records.sql", "0003_add_auth_index_to_usage_records.sql",
      "0004_add_auth_file_mappings.sql", "0005_usage_pipeline.sql",
      "0006_phase5_dashboard_rollup_dimensions.sql", "0007_phase6_legacy_import.sql"
    ];
    for (const migration of migrations) {
      const sql = await readFile(new URL("../drizzle/" + migration, import.meta.url), "utf8");
      await scoped.query(sql);
    }
    const fixture = spawnSync("python3", ["-c", fixtureSql, source], { encoding: "utf8" });
    assert.equal(fixture.status, 0, fixture.stderr || fixture.stdout);

    const env = { ...process.env, DATABASE_URL: targetUrl.toString() };
    const first = execFileSync(process.execPath, ["scripts/import-omc-sqlite.mjs", "--source", source, "--batch-size", "1"], { encoding: "utf8", env });
    assert.match(first, /"status": "completed"/);
    assert.match(first, /"inserted": 2/);
    assert.match(first, /"skipped": 0/);

    const rows = await scoped.query(
      `SELECT source_native_id, source_event_key, identity_key, origin_system, source_transport, request_id,
              input_tokens, output_tokens, total_tokens, is_error, status_code,
              cost_nanos, cost_currency, pricing_status, source_price_version_id, price_version_id,
              client_ip, x_forwarded_for, user_agent, fail_body, response_headers, raw_payload,
              token_accounting, structured_usage
       FROM usage_events WHERE source_instance_id='legacy-oh-my-cpa-default' ORDER BY source_native_id`
    );
    assert.equal(rows.rowCount, 2);
    assert.deepEqual(rows.rows.map((row) => row.source_native_id), ["1", "2"]);
    assert.deepEqual(rows.rows.map((row) => row.source_event_key), ["same-key", "same-key"]);
    assert.equal(new Set(rows.rows.map((row) => row.identity_key)).size, 2, "duplicate event keys must not collapse distinct source rows");
    assert.ok(rows.rows.every((row) => row.origin_system === "oh_my_cpa" && row.source_transport === "legacy_import"));
    assert.equal(rows.rows[0].cost_nanos, "123456");
    assert.equal(rows.rows[0].cost_currency, "USD");
    assert.equal(rows.rows[0].source_price_version_id, "77");
    assert.equal(rows.rows[0].price_version_id, null, "source price IDs must not be mistaken for target price-version FKs");
    assert.equal(rows.rows[1].pricing_status, "unpriced");
    assert.equal(rows.rows[1].status_code, 500);
    for (const row of rows.rows) {
      assert.equal(row.client_ip, null);
      assert.equal(row.x_forwarded_for, null);
      assert.equal(row.user_agent, null);
      assert.equal(row.fail_body, null);
      assert.equal(row.response_headers, null);
      assert.deepEqual(row.raw_payload, {});
      assert.ok(row.token_accounting);
      assert.ok(row.structured_usage);
    }
    const sourcePrices = await scoped.query(
      "SELECT model, prompt_price_per_1m, completion_price_per_1m, cache_write_price_per_1m, currency, tiers, upstream_id, channel FROM usage_import_source_price_versions WHERE source_key='oh-my-cpa:default' AND source_price_version_id=77"
    );
    assert.equal(sourcePrices.rowCount, 1);
    assert.equal(sourcePrices.rows[0].model, "gpt-test");
    assert.equal(sourcePrices.rows[0].currency, "USD");
    assert.equal(Number(sourcePrices.rows[0].cache_write_price_per_1m), 2);
    assert.equal(sourcePrices.rows[0].tiers[0].name, "priority");
    const run = await scoped.query("SELECT source_price_version_rows, imported_price_version_rows FROM usage_import_runs");
    assert.equal(Number(run.rows[0].source_price_version_rows), 1);
    assert.equal(Number(run.rows[0].imported_price_version_rows), 1);

    const instance = await scoped.query("SELECT enabled FROM usage_collector_instances WHERE instance_id='legacy-oh-my-cpa-default'");
    assert.equal(instance.rows[0].enabled, false);
    const identityCount = await scoped.query("SELECT count(*)::int AS count FROM usage_event_identity WHERE source_instance_id='legacy-oh-my-cpa-default'");
    assert.equal(identityCount.rows[0].count, 2);

    const replay = execFileSync(process.execPath, ["scripts/import-omc-sqlite.mjs", "--source", source], { encoding: "utf8", env });
    assert.match(replay, /already_completed/);
    const afterReplay = await scoped.query("SELECT count(*)::int AS count FROM usage_events WHERE source_instance_id='legacy-oh-my-cpa-default'");
    assert.equal(afterReplay.rows[0].count, 2);
  } finally {
    if (scoped) await scoped.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
    await rm(dir, { recursive: true, force: true });
  }
});
