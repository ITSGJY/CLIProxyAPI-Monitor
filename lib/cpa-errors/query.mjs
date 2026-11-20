import { errorCoverage, evaluateErrorHealth, normalizeErrorWindowMs } from "./coverage.mjs";
import { redactErrorText, safeAuthIndex } from "./normalize.mjs";

const eventSelection = `id::text,occurred_at,received_at,provider,model,status_code,code,body,retryable,auth_status,
  quota_exceeded,quota_reason,next_retry_after,next_recover_at,backoff_level,cooldown_model,
  model_quota_exceeded,model_quota_reason,model_next_retry_after,model_next_recover_at,model_backoff_level,
  auth_quota_aggregate,model_quota_inherited,origin_system,source_transport`;

// Explicit public DTO: never SELECT * from an event and spread it into an API.
function publicEvent(row) {
  const boolean = (value) => typeof value === "boolean" ? value : null;
  const integer = (value) => Number.isSafeInteger(value) ? value : null;
  const date = (value) => typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  const cleanStatus = (value, model = false) => {
    if (!value || typeof value !== "object") return null;
    const quota = value.quota && typeof value.quota === "object" ? {
      exceeded: boolean(value.quota.exceeded),
      reason: redactErrorText(value.quota.reason), next_recover_at: date(value.quota.next_recover_at),
      backoff_level: integer(value.quota.backoff_level)
    } : null;
    return { status: typeof value.status === "number" ? integer(value.status) : redactErrorText(value.status),
      status_message: redactErrorText(value.status_message), disabled: boolean(value.disabled), unavailable: boolean(value.unavailable),
      next_retry_after: date(value.next_retry_after), quota,
      ...(model ? { name: redactErrorText(value.name) } : { model: cleanStatus(value.model, true) }) };
  };
  return {
    id: String(row.id), occurred_at: row.occurred_at, received_at: row.received_at,
    provider: redactErrorText(row.provider), model: redactErrorText(row.model), status_code: row.status_code,
    code: redactErrorText(row.code), body: redactErrorText(row.body), retryable: row.retryable,
    auth_status: cleanStatus(row.auth_status), quota_exceeded: row.quota_exceeded, quota_reason: redactErrorText(row.quota_reason),
    next_retry_after: row.next_retry_after, next_recover_at: row.next_recover_at, backoff_level: row.backoff_level,
    cooldown_model: redactErrorText(row.cooldown_model), model_quota_exceeded: row.model_quota_exceeded,
    model_quota_reason: redactErrorText(row.model_quota_reason), model_next_retry_after: row.model_next_retry_after,
    model_next_recover_at: row.model_next_recover_at, model_backoff_level: row.model_backoff_level,
    auth_quota_aggregate: row.auth_quota_aggregate, model_quota_inherited: row.model_quota_inherited,
    origin_system: row.origin_system, source_transport: row.source_transport,
    time_delta_ms: Number(row.time_delta_ms), provider_match: row.provider_match, model_match: row.model_match,
    attribution: "credential_time_window"
  };
}

export async function getCredentialErrors(pool, record, { now = Date.now(), configured, windowMs } = {}) {
  const effectiveWindowMs = normalizeErrorWindowMs(windowMs ?? Number(process.env.ERROR_CORRELATION_WINDOW_MS));
  const base = { attribution: "credential_time_window", window_ms: effectiveWindowMs, limit: 20, events: [] };
  if (!record.sourceInstanceId || !safeAuthIndex(record.authIndex) || !Number.isFinite(new Date(record.occurredAt).getTime())) {
    return { ...base, coverage: { status: "not_correlatable", complete: false, gaps: [], reason: "missing_credential_or_source_time" } };
  }
  let client;
  try {
    client = await pool.connect();
    // One snapshot prevents coverage from advancing past events visible to this read.
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '2500ms'");
    const at = new Date(record.occurredAt);
    const events = await client.query(`SELECT ${eventSelection},
        (extract(epoch FROM occurred_at-$3::timestamptz)*1000)::double precision AS time_delta_ms,
        (provider IS NOT NULL AND provider<>'' AND provider=$4) AS provider_match,
        (model IS NOT NULL AND model<>'' AND model=$5) AS model_match
        FROM cpa_error_events WHERE source_instance_id=$1 AND auth_index=$2 AND auth_index<>''
          AND occurred_at BETWEEN $3::timestamptz-($6::int * interval '1 millisecond')
          AND $3::timestamptz+($6::int * interval '1 millisecond')
        ORDER BY abs(extract(epoch FROM occurred_at-$3::timestamptz)),occurred_at,id LIMIT 20`,
      [record.sourceInstanceId, record.authIndex.trim(), at, record.provider || "", record.model || "", effectiveWindowMs]);
    const states = await client.query("SELECT enabled,state,lease_expires_at,heartbeat_at FROM cpa_error_collector_state WHERE source_instance_id=$1", [record.sourceInstanceId]);
    const sessions = await client.query(`SELECT subscribed_at,coverage_through,ended_at,end_reason FROM cpa_error_subscription_sessions
        WHERE source_instance_id=$1 AND (ended_at IS NULL OR (subscribed_at <= $2::timestamptz+($3::int * interval '1 millisecond')
        AND ended_at >= $2::timestamptz-($3::int * interval '1 millisecond'))) ORDER BY subscribed_at,id`,
      [record.sourceInstanceId, at, effectiveWindowMs]);
    const imports = await client.query(`SELECT status,min_occurred_at,max_occurred_at FROM cpa_error_import_runs WHERE source_instance_id=$1
        AND (status='unavailable' OR (min_occurred_at <= $2::timestamptz+($3::int * interval '1 millisecond')
        AND max_occurred_at >= $2::timestamptz-($3::int * interval '1 millisecond')))`,
      [record.sourceInstanceId, at, effectiveWindowMs]);
    await client.query("COMMIT");
    return { ...base, events: events.rows.map(publicEvent), coverage: errorCoverage({
      occurredAt: at, state: states.rows[0], sessions: sessions.rows, imports: imports.rows, now, configured, windowMs: effectiveWindowMs
    }) };
  } catch {
    if (client) await client.query("ROLLBACK").catch(() => {});
    // Failure is isolated to this section. Do not log potentially sensitive SQL errors.
    return { ...base, coverage: { status: "query_failed", complete: false, gaps: [], reason: "error_evidence_unavailable" } };
  } finally { client?.release(); }
}

export async function getErrorCollectorHealth(pool, instanceId, now = Date.now()) {
  const state = await pool.query("SELECT enabled,state,lease_expires_at,heartbeat_at FROM cpa_error_collector_state WHERE source_instance_id=$1", [instanceId]);
  const session = await pool.query("SELECT ended_at,coverage_through FROM cpa_error_subscription_sessions WHERE source_instance_id=$1 AND ended_at IS NULL ORDER BY id DESC LIMIT 1", [instanceId]);
  return evaluateErrorHealth(state.rows[0], session.rows[0], now);
}
