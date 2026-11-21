import { createHash } from "node:crypto";

const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const bool = (value) => typeof value === "boolean" ? value : null;
const integer = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 2147483647 ? value : null;

// Applied before truncation: a credential crossing the length boundary must not leak.
// Unknown JSON fields never reach persistence. Free text remains untrusted even after redaction.
export function redactErrorText(value, secrets = [], limit = 4096) {
  if (typeof value !== "string") return null;
  let text = value;
  for (const secret of secrets) {
    if (typeof secret === "string" && secret) text = text.split(secret).join("[redacted]");
  }
  text = text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gi, "[redacted]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"'<>]+/gi, "[redacted]")
    .replace(/\b(?:set-cookie|cookie|authorization)\s*:\s*[^\r\n]+/gi, "[redacted-header]")
    .replace(/((?:full[_-]?name|user[_-]?name|first[_-]?name|last[_-]?name|address|姓名|地址|电话|手机号)\s*[:=：]\s*)[^\r\n,;}]+/gi, "$1[redacted]")
    .replace(/(["']?(?:[\w-]*(?:token|secret|password|api[_-]?key)|authorization|cookie|auth[_-]?id|email|phone|address|full[_-]?name|user[_-]?name|first[_-]?name|last[_-]?name)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)/gi, "$1[redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted]")
    .replace(/https?:\/\/[^\s<>"']+/gi, "[redacted-url]")
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_|AIza|AKIA)[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, "[redacted]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[redacted-ip]")
    .replace(/\b(?:[a-f\d]{1,4}:){2,}[a-f\d:]+\b/gi, "[redacted-ip]")
    .replace(/(?<!\w)\+?\d[\d ()-]{8,}\d(?!\w)/g, "[redacted-number]")
    .replace(/\b[A-Za-z0-9_+/=]{24,}\b/g, "[redacted]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return text.trim().slice(0, limit) || null;
}

function instant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

// Reject suspicious identifiers instead of transforming them into shared correlation keys.
export function safeAuthIndex(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(trimmed) || /^(?:sk-|eyJ|ghp_|github_pat_)/.test(trimmed)) return null;
  return trimmed;
}

export function normalizeErrorEvent(input, { instanceId, receivedAt = new Date(), secrets = [] } = {}) {
  if (typeof instanceId !== "string" || !instanceId.trim()) throw new Error("invalid_error_instance");
  let payload;
  try { payload = typeof input === "string" ? JSON.parse(input) : input; } catch { throw new Error("malformed_error_payload"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("malformed_error_payload");
  const occurredAt = instant(payload.timestamp);
  // Without source time the event cannot truthfully enter a credential/time window.
  if (!occurredAt) throw new Error("invalid_error_timestamp");
  const sensitive = [...secrets, payload.auth_id].filter((s) => typeof s === "string" && s);
  const text = (value, limit = 512) => redactErrorText(value, sensitive, limit);
  const status = (value) => typeof value === "number" ? integer(value) : text(value, 64);
  const quota = (value) => {
    const q = object(value);
    return { exceeded: bool(q.exceeded), reason: text(q.reason), next_recover_at: instant(q.next_recover_at), backoff_level: integer(q.backoff_level) };
  };
  const a = object(payload.auth_status);
  const m = object(a.model);
  const aq = quota(a.quota);
  const mq = quota(m.quota);
  const retry = instant(a.next_retry_after);
  const modelRetry = instant(m.next_retry_after);
  const credentialUntil = Math.max(Date.parse(retry) || 0, Date.parse(aq.next_recover_at) || 0);
  const hasModel = Object.keys(m).length > 0;
  const authStatus = {
    status: status(a.status), status_message: text(a.status_message), disabled: bool(a.disabled), unavailable: bool(a.unavailable),
    next_retry_after: retry, quota: aq,
    model: hasModel ? { name: text(m.name, 256), status: status(m.status), status_message: text(m.status_message), unavailable: bool(m.unavailable), next_retry_after: modelRetry, quota: mq } : null
  };
  const projection = {
    occurred_at: occurredAt, auth_index: safeAuthIndex(payload.auth_index), provider: text(payload.provider, 256), model: text(payload.model, 256),
    status_code: integer(payload.status_code), code: text(payload.code, 256), body: text(payload.body, 4096), retryable: bool(payload.retryable),
    auth_status: authStatus, quota_exceeded: aq.exceeded, quota_reason: aq.reason, next_retry_after: retry,
    next_recover_at: aq.next_recover_at, backoff_level: aq.backoff_level,
    cooldown_model: text(m.name, 256), model_quota_exceeded: mq.exceeded, model_quota_reason: mq.reason,
    model_next_retry_after: modelRetry, model_next_recover_at: mq.next_recover_at, model_backoff_level: mq.backoff_level,
    auth_quota_aggregate: hasModel && aq.reason === "quota",
    model_quota_inherited: Boolean(hasModel && aq.exceeded && aq.reason === "credential_quota" && mq.exceeded && credentialUntil &&
      (!modelRetry || Date.parse(modelRetry) <= credentialUntil) && (!mq.next_recover_at || Date.parse(mq.next_recover_at) <= credentialUntil))
  };
  // Hash only the allowlisted projection; no plaintext auth_id or raw-payload digest.
  // Retain source timestamp precision in identity even though PG/JS correlation is milliseconds.
  const eventKey = createHash("sha256").update(JSON.stringify(["cpa-error-v1", payload.timestamp, projection])).digest("hex");
  return { ...projection, source_instance_id: instanceId, event_key: eventKey, received_at: new Date(receivedAt).toISOString(),
    origin_system: "cpa", source_transport: "resp-subscribe", source_native_id: null, source_snapshot_sha256: null, import_run_id: null };
}

export function normalizeOmcError(row, options) {
  for (const field of ["timestamp_ms", "created_at_ms"]) {
    if (!Number.isSafeInteger(row[field]) || row[field] <= 0) throw new Error("invalid_omc_error_timestamp");
  }
  const date = (ms) => ms === null || ms === undefined ? undefined : new Date(Number(ms)).toISOString();
  const flag = (v) => v === null || v === undefined ? undefined : Boolean(Number(v));
  const hasModel = Boolean(row.cooldown_model);
  const event = normalizeErrorEvent({
    timestamp: date(row.timestamp_ms), provider: row.provider, model: row.model, auth_index: row.auth_index,
    status_code: row.status_code, code: row.code, body: row.body, retryable: flag(row.retryable),
    auth_status: { status_message: row.auth_status, disabled: flag(row.auth_disabled), unavailable: flag(row.auth_unavailable),
      next_retry_after: date(row.next_retry_after_ms), quota: { exceeded: flag(row.quota_exceeded), reason: row.quota_reason, next_recover_at: date(row.next_recover_at_ms), backoff_level: row.backoff_level },
      model: hasModel ? { name: row.cooldown_model, next_retry_after: date(row.model_next_retry_after_ms), quota: { exceeded: flag(row.model_quota_exceeded), reason: row.model_quota_reason, next_recover_at: date(row.model_next_recover_at_ms), backoff_level: row.model_backoff_level } } : undefined }
  }, { ...options, receivedAt: date(row.created_at_ms) });
  if (!Number.isSafeInteger(row.id) || row.id < 1 || row.instance_id !== "default") throw new Error("invalid_omc_error_identity");
  return { ...event,
    event_key: createHash("sha256").update(`omc-error-v1\ndefault\n${row.id}`).digest("hex"),
    origin_system: "oh_my_cpa", source_transport: "legacy_import", source_native_id: String(row.id),
    auth_quota_aggregate: flag(row.auth_quota_aggregate) ?? event.auth_quota_aggregate,
    model_quota_inherited: flag(row.model_quota_inherited) ?? event.model_quota_inherited,
    model_quota_exceeded: flag(row.model_quota_exceeded) ?? event.model_quota_exceeded,
    model_backoff_level: integer(row.model_backoff_level) ?? event.model_backoff_level
  };
}
