#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import pg from "pg";
import { validateImportTarget } from "./import-target-policy.mjs";
import { importOmcErrors } from "./import-omc-errors.mjs";

const { Pool } = pg;
const SOURCE_KEY = "oh-my-cpa:default";
const SOURCE_INSTANCE_ID = "legacy-oh-my-cpa-default";
const BATCH_SIZE_DEFAULT = 250;

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
function getManifest(source) {
  const result = spawnSync("python3", ["scripts/omc-sqlite-source.py", "manifest", "--source", source], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || "Unable to inspect OMC SQLite source").trim());
  return JSON.parse(result.stdout);
}
function safeJson(value) { return value === null || value === undefined ? null : JSON.stringify(value); }

async function ensureEventPartitions(pool, minTimestampMs, maxTimestampMs) {
  const start = new Date(Number(minTimestampMs));
  const end = new Date(Number(maxTimestampMs));
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) throw new Error("Invalid source event time range");
  const month = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const lastMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (month <= lastMonth) {
    const next = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));
    const name = `usage_events_${month.getUTCFullYear()}${String(month.getUTCMonth() + 1).padStart(2, "0")}`;
    const from = month.toISOString();
    const to = next.toISOString();
    await pool.query(`CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF usage_events FOR VALUES FROM ('${from}') TO ('${to}')`);
    month.setUTCMonth(month.getUTCMonth() + 1);
  }
}

const INSERT_PRICE_VERSIONS_SQL = `
WITH source_rows AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(
    source_price_version_id bigint, model text, effective_from timestamptz, available boolean,
    prompt_price_per_1m numeric, completion_price_per_1m numeric, cache_read_price_per_1m numeric,
    cache_write_price_per_1m numeric, price_multiplier numeric, source text, tiers jsonb,
    upstream_id text, channel text
  )
), inserted AS (
  INSERT INTO usage_import_source_price_versions (
    source_key, source_price_version_id, source_sha256, model, effective_from, available,
    prompt_price_per_1m, completion_price_per_1m, cache_read_price_per_1m,
    cache_write_price_per_1m, price_multiplier, source, tiers, upstream_id, channel
  )
  SELECT $2, r.source_price_version_id, $3, r.model, r.effective_from, r.available,
         r.prompt_price_per_1m, r.completion_price_per_1m, r.cache_read_price_per_1m,
         r.cache_write_price_per_1m, r.price_multiplier, r.source, r.tiers,
         coalesce(r.upstream_id, ''), coalesce(r.channel, '')
  FROM source_rows r
  ON CONFLICT (source_key, source_price_version_id) DO NOTHING
  RETURNING source_price_version_id
)
SELECT count(*)::bigint AS inserted_count FROM inserted;
`;

async function importPriceVersions(source, pool, sourceHash) {
  const child = spawn("python3", ["scripts/omc-sqlite-source.py", "price-versions", "--source", source], { stdio: ["ignore", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const childClosed = new Promise((resolve) => child.once("close", (code) => resolve(code)));
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
  let batch = [];
  let inserted = 0;
  async function flush() {
    if (!batch.length) return;
    const payload = batch.map((row) => ({
      source_price_version_id: Number(row.id),
      model: row.model,
      effective_from: new Date(Number(row.effective_from_ms)).toISOString(),
      available: Boolean(Number(row.available)),
      prompt_price_per_1m: Number(row.prompt_price_per_1m),
      completion_price_per_1m: Number(row.completion_price_per_1m),
      cache_read_price_per_1m: Number(row.cache_read_price_per_1m),
      cache_write_price_per_1m: Number(row.cache_write_price_per_1m),
      price_multiplier: Number(row.price_multiplier),
      source: row.source,
      tiers: row.tiers,
      upstream_id: row.upstream_id || "",
      channel: row.channel || ""
    }));
    const result = await pool.query(INSERT_PRICE_VERSIONS_SQL, [JSON.stringify(payload), SOURCE_KEY, sourceHash]);
    inserted += Number(result.rows[0].inserted_count);
    batch = [];
  }
  let pendingError = null;
  try {
    for await (const line of lines) {
      if (!line) continue;
      const row = JSON.parse(line);
      if (!Number.isSafeInteger(Number(row.id)) || Number(row.id) <= 0 || !row.model) throw new Error("Invalid source model-price version row");
      if (!Array.isArray(row.tiers)) throw new Error(`Invalid tiers in source price version ${row.id}`);
      batch.push(row);
      if (batch.length >= 100) await flush();
    }
    await flush();
  } catch (error) {
    pendingError = error;
    child.kill("SIGTERM");
  }
  const exitCode = await childClosed;
  if (pendingError) throw pendingError;
  if (exitCode !== 0) throw new Error(`OMC price-version exporter exited ${exitCode}: ${stderr}`);
  return inserted;
}

const INSERT_BATCH_SQL = `
WITH source_rows AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(
    source_id bigint, source_event_key text, identity_key text, occurred_at timestamptz, created_at timestamptz,
    request_id text, provider text, endpoint text, auth_type text, api_group_key text,
    api_group_label text, api_key_mask text, model text, model_alias text, response_model text,
    model_substituted boolean, reasoning_effort text, service_tier text, response_service_tier text,
    effective_service_tier text, billed_service_tier text, billed_service_tier_source text,
    executor_type text, source text, auth_index text, access_provider text, is_native_key boolean,
    stream boolean, generate boolean, latency_ms bigint, ttft_ms bigint,
    input_tokens bigint, output_tokens bigint, reasoning_tokens bigint, cached_tokens bigint,
    cache_read_tokens bigint, cache_creation_tokens bigint, total_tokens bigint,
    is_error boolean, status_code integer, fail_code text, cost_nanos bigint,
    source_price_version_id bigint, pricing_status text, token_accounting jsonb, structured_usage jsonb
  )
), inserted AS (
  INSERT INTO usage_events (
    occurred_at, source_instance_id, origin_system, source_transport, source_native_id, source_event_key, identity_key,
    provider, endpoint, auth_type, request_id, api_group_key, api_group_label, api_key_mask,
    model, model_alias, response_model, model_substituted, reasoning_effort, service_tier,
    response_service_tier, effective_service_tier, billed_service_tier, billed_service_tier_source,
    executor_type, source, auth_index, access_provider, is_native_key, stream, generate,
    latency_ms, ttft_ms, input_tokens, output_tokens, reasoning_tokens, cached_tokens,
    cache_read_tokens, cache_creation_tokens, total_tokens, is_error, status_code, fail_code,
    token_accounting, structured_usage, raw_payload, source_price_version_id, cost_nanos,
    cost_currency, pricing_status, created_at
  )
  SELECT
    s.occurred_at, $2, 'oh_my_cpa', 'legacy_import', s.source_id::text, s.source_event_key, s.identity_key,
    s.provider, s.endpoint, s.auth_type, s.request_id, s.api_group_key, s.api_group_label, s.api_key_mask,
    coalesce(nullif(s.model, ''), 'unknown'), s.model_alias, s.response_model, s.model_substituted,
    s.reasoning_effort, s.service_tier, s.response_service_tier, s.effective_service_tier,
    s.billed_service_tier, s.billed_service_tier_source, s.executor_type, s.source, s.auth_index,
    s.access_provider, s.is_native_key, s.stream, s.generate, s.latency_ms, s.ttft_ms,
    s.input_tokens, s.output_tokens, s.reasoning_tokens, s.cached_tokens, s.cache_read_tokens,
    s.cache_creation_tokens, s.total_tokens, s.is_error, s.status_code, s.fail_code,
    s.token_accounting, s.structured_usage, '{}'::jsonb, s.source_price_version_id,
    s.cost_nanos, 'USD', s.pricing_status, s.created_at
  FROM source_rows s
  WHERE NOT EXISTS (SELECT 1 FROM usage_event_identity i WHERE i.identity_key = s.identity_key)
  RETURNING occurred_at, event_id, identity_key, source_instance_id, request_id
), identities AS (
  INSERT INTO usage_event_identity (
    identity_key, identity_version, identity_kind, source_instance_id, request_id, occurred_at, event_id
  )
  SELECT identity_key, 1, 'legacy_source_id', source_instance_id, request_id, occurred_at, event_id
  FROM inserted
  ON CONFLICT (identity_key) DO NOTHING
  RETURNING identity_key
)
SELECT (SELECT count(*) FROM inserted)::bigint AS inserted_count,
       (SELECT count(*) FROM identities)::bigint AS identity_count;
`;

async function main() {
  const source = required(arg("--source"), "--source");
  const databaseUrl = required(process.env.DATABASE_URL, "DATABASE_URL");
  const batchSize = Math.min(1000, Math.max(1, Number(arg("--batch-size", String(BATCH_SIZE_DEFAULT))) || BATCH_SIZE_DEFAULT));
  validateImportTarget(databaseUrl, {
    allowProductionTarget: process.argv.includes("--allow-production-target"),
    productionEnvironmentOptIn: process.env.PHASE6_IMPORT_ALLOW_PRODUCTION_TARGET === "true"
  });
  const sourceHash = await sha256File(source);
  const manifest = getManifest(source);
  if (await sha256File(source) !== sourceHash) throw new Error("Source snapshot changed during preflight");
  if (Number(manifest.invalid_price_tier_rows) > 0) throw new Error("Source model-price versions contain invalid tier metadata");
  if (manifest.source_instance_id !== "default") throw new Error("Unexpected OMC source instance; expected 'default'");
  const pool = new Pool({ connectionString: databaseUrl, max: 3, application_name: "phase6-omc-import" });
  let lockClient;
  let runId;
  try {
    lockClient = await pool.connect();
    await lockClient.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [SOURCE_KEY]);
    const schema = await pool.query("SELECT to_regclass('usage_import_runs') AS runs, to_regclass('usage_event_identity') AS identities");
    if (!schema.rows[0]?.runs || !schema.rows[0]?.identities) throw new Error("Target schema is missing Phase 6 migration 0007");

    await ensureEventPartitions(pool, manifest.min_timestamp_ms, manifest.max_timestamp_ms);
    await pool.query(
      `INSERT INTO usage_collector_instances (instance_id, display_name, management_base_url, enabled)
       VALUES ($1, 'Oh My CPA historical import', 'legacy://oh-my-cpa/sqlite-import', false)
       ON CONFLICT (instance_id) DO UPDATE SET display_name = EXCLUDED.display_name, enabled = false, updated_at = now()`,
      [SOURCE_INSTANCE_ID]
    );
    const runResult = await pool.query(
      `INSERT INTO usage_import_runs (
         source_key, source_sha256, source_name, source_schema_version, status, total_rows,
         min_occurred_at, max_occurred_at, source_duplicate_key_groups, source_duplicate_key_rows,
         priced_rows, unpriced_rows, source_price_version_rows, manifest, started_at
       ) VALUES ($1,$2,$3,$4,'running',$5,to_timestamp($6::double precision/1000),to_timestamp($7::double precision/1000),$8,$9,$10,$11,$12,$13::jsonb,now())
       ON CONFLICT (source_key, source_sha256) DO UPDATE SET
         status = CASE WHEN usage_import_runs.status = 'completed' THEN 'completed' ELSE 'running' END,
         started_at = coalesce(usage_import_runs.started_at, now()), updated_at = now(), last_error = NULL
       RETURNING id, status, last_source_id, processed_rows, inserted_rows, skipped_rows`,
      [SOURCE_KEY, sourceHash, manifest.source_name, manifest.source_schema_version, manifest.total_rows,
        manifest.min_timestamp_ms, manifest.max_timestamp_ms, manifest.duplicate_event_key_groups,
        manifest.duplicate_event_key_extra_rows,
        manifest.pricing_status.filter((x) => x.pricing_status === "priced").reduce((n, x) => n + Number(x.row_count), 0),
        manifest.pricing_status.filter((x) => x.pricing_status !== "priced").reduce((n, x) => n + Number(x.row_count), 0),
        manifest.price_version_rows,
        JSON.stringify(manifest)]
    );
    const run = runResult.rows[0];
    runId = Number(run.id);
    if (run.status === "completed") {
      console.log(JSON.stringify({ status: "already_completed", runId, sourceHash, totalRows: manifest.total_rows, priceVersionRows: manifest.price_version_rows }));
      return;
    }

    const priceVersionsInserted = await importPriceVersions(source, pool, sourceHash);
    const priceVersionCount = await pool.query(
      "SELECT count(*)::bigint AS count FROM usage_import_source_price_versions WHERE source_key=$1",
      [SOURCE_KEY]
    );
    const importedPriceVersionRows = Number(priceVersionCount.rows[0].count);
    if (importedPriceVersionRows !== Number(manifest.price_version_rows)) {
      throw new Error(`Historical price-version reconciliation mismatch: expected ${manifest.price_version_rows}, got ${importedPriceVersionRows}`);
    }
    await pool.query("UPDATE usage_import_runs SET imported_price_version_rows=$2, updated_at=now() WHERE id=$1", [runId, importedPriceVersionRows]);

    let processed = Number(run.processed_rows);
    let inserted = Number(run.inserted_rows);
    let skipped = Number(run.skipped_rows);
    let lastSourceId = Number(run.last_source_id);
    let batch = [];
    let pendingError = null;
    const child = spawn("python3", ["scripts/omc-sqlite-source.py", "export", "--source", source, "--after-id", String(lastSourceId)], { stdio: ["ignore", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const childClosed = new Promise((resolve) => child.once("close", (code) => resolve(code)));
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });

    async function flush() {
      if (!batch.length) return;
      const payload = batch.map((row) => ({
        source_id: Number(row.id),
        source_event_key: row.event_key,
        identity_key: createHash("sha256").update(`legacy-oh-my-cpa-v1\n${SOURCE_KEY}\n${row.id}`).digest("hex"),
        occurred_at: new Date(Number(row.timestamp_ms)).toISOString(),
        created_at: new Date(Number(row.created_at_ms)).toISOString(),
        request_id: row.request_id || null,
        provider: row.provider || null,
        endpoint: row.endpoint || null,
        auth_type: row.auth_type || null,
        api_group_key: row.api_group_key || "legacy",
        api_group_label: row.api_group_label || null,
        api_key_mask: row.api_key_mask || null,
        model: row.model || "unknown",
        model_alias: row.model_alias || null,
        response_model: row.response_model || null,
        model_substituted: Boolean(Number(row.model_substituted)),
        reasoning_effort: row.reasoning_effort || null,
        service_tier: row.service_tier || null,
        response_service_tier: row.response_service_tier || null,
        effective_service_tier: row.effective_service_tier || null,
        billed_service_tier: row.billed_service_tier || null,
        billed_service_tier_source: row.billed_service_tier_source || null,
        executor_type: row.executor_type || null,
        source: row.source || null,
        auth_index: row.auth_index || null,
        access_provider: row.access_provider || null,
        is_native_key: Boolean(Number(row.is_native_key)),
        stream: row.stream === null ? null : Boolean(Number(row.stream)),
        generate: row.generate === null ? null : Boolean(Number(row.generate)),
        latency_ms: row.latency_ms,
        ttft_ms: row.ttft_ms,
        input_tokens: Number(row.input_tokens || 0),
        output_tokens: Number(row.output_tokens || 0),
        reasoning_tokens: Number(row.reasoning_tokens || 0),
        cached_tokens: Number(row.cached_tokens || 0),
        cache_read_tokens: Number(row.cache_read_tokens || 0),
        cache_creation_tokens: Number(row.cache_creation_tokens || 0),
        total_tokens: Number(row.total_tokens || 0),
        is_error: Boolean(Number(row.failed)),
        status_code: Number(row.fail_status_code || 0) || null,
        fail_code: row.fail_code || null,
        cost_nanos: row.cost_nanos === null ? null : Number(row.cost_nanos),
        source_price_version_id: row.price_version_id === null ? null : Number(row.price_version_id),
        pricing_status: row.pricing_status || "unpriced",
        token_accounting: safeJson(row.token_accounting),
        structured_usage: safeJson(row.structured_usage)
      }));
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query(INSERT_BATCH_SQL, [JSON.stringify(payload), SOURCE_INSTANCE_ID]);
        const insertedCount = Number(result.rows[0].inserted_count);
        const skippedCount = batch.length - insertedCount;
        processed += batch.length;
        inserted += insertedCount;
        skipped += skippedCount;
        lastSourceId = Number(batch[batch.length - 1].id);
        await client.query(
          `UPDATE usage_import_runs SET status='running', processed_rows=$2, inserted_rows=$3,
             skipped_rows=$4, last_source_id=$5, updated_at=now() WHERE id=$1`,
          [runId, processed, inserted, skipped, lastSourceId]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      console.log(JSON.stringify({ runId, processed, total: manifest.total_rows, inserted, skipped, lastSourceId }));
      batch = [];
    }

    try {
      for await (const line of lines) {
        if (!line) continue;
        const row = JSON.parse(line);
        if (!Number.isSafeInteger(Number(row.id)) || Number(row.id) <= lastSourceId) throw new Error("Invalid or non-monotonic source event ID");
        if (!Number.isFinite(Number(row.timestamp_ms)) || Number(row.timestamp_ms) <= 0) throw new Error(`Invalid timestamp in OMC event ${row.id}`);
        for (const key of ["input_tokens", "output_tokens", "reasoning_tokens", "cached_tokens", "cache_read_tokens", "cache_creation_tokens", "total_tokens"]) {
          if (!Number.isSafeInteger(Number(row[key] ?? 0)) || Number(row[key] ?? 0) < 0) throw new Error(`Invalid ${key} in OMC event ${row.id}`);
        }
        batch.push(row);
        if (batch.length >= batchSize) await flush();
      }
      await flush();
    } catch (error) {
      pendingError = error;
      child.kill("SIGTERM");
    }
    const exitCode = await childClosed;
    if (pendingError) throw pendingError;
    if (exitCode !== 0) throw new Error(`OMC SQLite exporter exited ${exitCode}: ${stderr}`);
    const finalSourceHash = await sha256File(source);
    if (finalSourceHash !== sourceHash) throw new Error("Source snapshot changed during import; refusing to mark this run completed");
    if (processed !== Number(manifest.total_rows)) {
      throw new Error(`Import count mismatch: processed ${processed}, expected ${manifest.total_rows}`);
    }
    const verify = await pool.query(
      `SELECT count(*)::bigint AS events, count(*) FILTER (WHERE origin_system='oh_my_cpa')::bigint AS imported,
              count(DISTINCT identity_key)::bigint AS identities,
              count(*) FILTER (WHERE pricing_status='priced')::bigint AS priced,
              count(*) FILTER (WHERE pricing_status<>'priced')::bigint AS unpriced,
              sum(input_tokens)::numeric AS input_tokens, sum(output_tokens)::numeric AS output_tokens,
              sum(reasoning_tokens)::numeric AS reasoning_tokens, sum(cached_tokens)::numeric AS cached_tokens,
              sum(cache_read_tokens)::numeric AS cache_read_tokens, sum(cache_creation_tokens)::numeric AS cache_creation_tokens,
              sum(total_tokens)::numeric AS total_tokens, count(*) FILTER (WHERE is_error)::bigint AS failures,
              sum(cost_nanos) FILTER (WHERE cost_nanos IS NOT NULL)::numeric AS cost_nanos,
              min(occurred_at) AS min_occurred_at, max(occurred_at) AS max_occurred_at,
              count(*) FILTER (WHERE client_ip IS NOT NULL OR x_forwarded_for IS NOT NULL OR user_agent IS NOT NULL OR fail_body IS NOT NULL OR response_headers IS NOT NULL)::bigint AS sensitive_fields_present,
              (SELECT count(*) FROM usage_import_source_price_versions WHERE source_key=$2)::bigint AS source_price_versions,
              (SELECT count(*) FROM usage_events e WHERE e.source_instance_id=$1 AND e.source_price_version_id IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM usage_import_source_price_versions p WHERE p.source_key=$2 AND p.source_price_version_id=e.source_price_version_id))::bigint AS orphan_source_price_refs
       FROM usage_events WHERE source_instance_id=$1`, [SOURCE_INSTANCE_ID, SOURCE_KEY]);
    const actual = verify.rows[0];
    const expectedPriced = manifest.pricing_status.filter((x) => x.pricing_status === "priced").reduce((n, x) => n + Number(x.row_count), 0);
    const expectedUnpriced = Number(manifest.total_rows) - expectedPriced;
    const expected = {
      events: Number(manifest.total_rows), imported: Number(manifest.total_rows), identities: Number(manifest.total_rows),
      priced: expectedPriced, unpriced: expectedUnpriced,
      input_tokens: Number(manifest.input_tokens), output_tokens: Number(manifest.output_tokens),
      reasoning_tokens: Number(manifest.reasoning_tokens), cached_tokens: Number(manifest.cached_tokens),
      cache_read_tokens: Number(manifest.cache_read_tokens), cache_creation_tokens: Number(manifest.cache_creation_tokens),
      total_tokens: Number(manifest.total_tokens), failures: Number(manifest.failure_rows),
      cost_nanos: Number(manifest.cost_nanos), sensitive_fields_present: 0,
      source_price_versions: Number(manifest.price_version_rows), orphan_source_price_refs: 0
    };
    for (const [key, value] of Object.entries(expected)) {
      if (Number(actual[key] ?? 0) !== value) throw new Error(`Reconciliation mismatch for ${key}: expected ${value}, got ${actual[key]}`);
    }
    if (new Date(actual.min_occurred_at).getTime() !== Number(manifest.min_timestamp_ms) || new Date(actual.max_occurred_at).getTime() !== Number(manifest.max_timestamp_ms)) {
      throw new Error("Reconciliation mismatch for historical event time range");
    }
    await pool.query(
      `UPDATE usage_import_runs SET status='completed', processed_rows=$2, inserted_rows=$3,
         skipped_rows=$4, last_source_id=$5, completed_at=now(), updated_at=now(), last_error=NULL WHERE id=$1`,
      [runId, processed, inserted, skipped, lastSourceId]
    );
    console.log(JSON.stringify({ status: "completed", runId, sourceHash, manifest, processed, inserted, skipped, priceVersionsInserted, importedPriceVersionRows, verification: actual }, null, 2));
  } catch (error) {
    if (runId) await pool.query("UPDATE usage_import_runs SET status='failed', last_error=$2, updated_at=now() WHERE id=$1 AND status<>'completed'", [runId, String(error.message).slice(0, 2000)]).catch(() => {});
    throw error;
  } finally {
    if (lockClient) {
      await lockClient.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [SOURCE_KEY]).catch(() => {});
      lockClient.release();
    }
    await pool.end();
  }
}

async function errorsOnly() {
  const source = required(arg("--source"), "--source");
  const databaseUrl = required(process.env.DATABASE_URL, "DATABASE_URL");
  validateImportTarget(databaseUrl, {
    allowProductionTarget: process.argv.includes("--allow-production-target"),
    productionEnvironmentOptIn: process.env.PHASE6_IMPORT_ALLOW_PRODUCTION_TARGET === "true"
  });
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 30000, application_name: "phase55-omc-error-import" });
  pool.on("error", () => { process.exitCode = 1; });
  try {
    console.log(JSON.stringify(await importOmcErrors({ pool, source, expectedHash: arg("--source-sha256"), batchSize: Number(arg("--batch-size", "250")) })));
  } finally { await pool.end(); }
}

(process.argv.includes("--errors-only") ? errorsOnly() : main()).catch((error) => {
  console.error(process.argv.includes("--errors-only") ? "OMC error import failed (inspect cpa_error_import_runs)" : "Phase 6 OMC import failed: " + error.message);
  process.exitCode = 1;
});
