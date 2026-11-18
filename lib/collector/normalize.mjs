import { createHash } from "node:crypto";

const SENSITIVE_KEY = /^(?:(?:x-)?api[_-]?key|x-auth-token|authorization|cookie|set-cookie|password|secret|(?:access|refresh|auth|api)[_-]?token|token|client[_-]?secret|credential|private[_-]?key|session)$/i;

export class UsageNormalizationError extends Error {
  constructor(message, code = "INVALID_USAGE_RECORD") {
    super(message);
    this.name = "UsageNormalizationError";
    this.code = code;
    this.permanent = true;
  }
}

export function serializeRawPayload(value) {
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : String(value);
  } catch {
    return String(value);
  }
}

export function usageControlMessageKind(value) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 1) return null;
  if (parsed.support_refresh === true) return "support_refresh";
  if (parsed.refresh === true) return "refresh";
  return null;
}


export function hashRawPayload(value) {
  return createHash("sha256").update(serializeRawPayload(value)).digest("hex");
}

function redactText(value) {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/(["']?(?:(?:x-)?api[_-]?key|x-auth-token|authorization|cookie|set-cookie|password|secret|(?:access|refresh|auth|api)[_-]?token|token|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi, "$1[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]");
}

function sanitizeValue(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, nested] of Object.entries(value)) {
      if (/^(?:x-)?api[_-]?key$/i.test(key)) {
        // Preserve a stable, non-reversible identifier for dashboard filtering.
        // The raw credential is never stored in the durable inbox or event payload.
        output[key] = maskApiKey(nested) ?? "[redacted]";
      } else {
        output[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : sanitizeValue(nested);
      }
    }
    return output;
  }
  if (typeof value === "string") return redactText(value);
  return value;
}

export function sanitizeUsagePayload(value) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return { _invalid_json: true, payload_sha256: hashRawPayload(value) };
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { _invalid_shape: true, payload_sha256: hashRawPayload(value) };
  }
  return sanitizeValue(parsed);
}

function textValue(value) {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result ? result : null;
}

function integerValue(value) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(Math.trunc(parsed), Number.MAX_SAFE_INTEGER);
}

function booleanValue(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return ["true", "1", "yes"].includes(value.toLowerCase());
  return false;
}

function parseOccurredAt(record) {
  const raw = record.timestamp ?? record.occurred_at ?? record.occurredAt ?? record.created_at;
  const numericTimestamp = typeof raw === "string" && /^\d{10,13}$/.test(raw) ? Number(raw) : raw;
  const timestampValue = typeof numericTimestamp === "number" && Math.abs(numericTimestamp) < 1_000_000_000_000
    ? numericTimestamp * 1000
    : numericTimestamp;
  const parsed = timestampValue instanceof Date ? timestampValue : new Date(timestampValue);
  if (!raw || Number.isNaN(parsed.getTime())) {
    throw new UsageNormalizationError("Usage record has no valid event timestamp", "MISSING_EVENT_TIMESTAMP");
  }
  return parsed.toISOString();
}

function maskApiKey(value) {
  const key = textValue(value);
  if (!key) return null;
  return key.length <= 4 ? "****" : `****${key.slice(-4)}`;
}

function identityFor(record, normalized, sourceInstanceId) {
  const requestId = textValue(record.request_id ?? record.requestId);
  const executionId = textValue(record.execution_id ?? record.executionId);
  const traceId = textValue(record.trace_id ?? record.traceId);

  let identityKind;
  let identityBasis;
  if (requestId) {
    identityKind = "request_id";
    identityBasis = { sourceInstanceId, provider: normalized.provider, requestId };
  } else if (executionId) {
    identityKind = "execution_id";
    identityBasis = { sourceInstanceId, provider: normalized.provider, executionId, occurredAt: normalized.occurredAt, model: normalized.model };
  } else if (traceId) {
    identityKind = "trace_id";
    identityBasis = { sourceInstanceId, provider: normalized.provider, traceId, occurredAt: normalized.occurredAt, model: normalized.model };
  } else {
    identityKind = "canonical_fingerprint";
    identityBasis = {
      sourceInstanceId,
      occurredAt: normalized.occurredAt,
      provider: normalized.provider,
      endpoint: normalized.endpoint,
      authType: normalized.authType,
      authIndex: normalized.authIndex,
      model: normalized.model,
      source: normalized.source,
      tokens: {
        input: normalized.inputTokens,
        output: normalized.outputTokens,
        reasoning: normalized.reasoningTokens,
        cached: normalized.cachedTokens,
        total: normalized.totalTokens
      },
      isError: normalized.isError,
      latencyMs: normalized.latencyMs,
      ttftMs: normalized.ttftMs
    };
  }

  const identityKey = createHash("sha256")
    .update(`usage-event-identity-v1\n${JSON.stringify(identityBasis)}`)
    .digest("hex");

  return { identityKey, identityKind, requestId };
}

export function normalizeUsageRecord(value, options = {}) {
  const sourceInstanceId = textValue(options.sourceInstanceId) ?? "default";
  const sourceTransport = textValue(options.sourceTransport) ?? "resp";
  const originSystem = textValue(options.originSystem) ?? "cpa_live";

  let record = value;
  if (typeof value === "string") {
    try {
      record = JSON.parse(value);
    } catch {
      throw new UsageNormalizationError("Usage record is not valid JSON", "INVALID_USAGE_JSON");
    }
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new UsageNormalizationError("Usage record must be a JSON object", "INVALID_USAGE_SHAPE");
  }

  const tokens = record.tokens && typeof record.tokens === "object"
    ? record.tokens
    : record.usage && typeof record.usage === "object"
      ? record.usage
      : {};

  const inputTokens = integerValue(tokens.input_tokens ?? record.input_tokens);
  const outputTokens = integerValue(tokens.output_tokens ?? record.output_tokens);
  const reasoningTokens = integerValue(tokens.reasoning_tokens ?? record.reasoning_tokens);
  const cachedTokens = integerValue(tokens.cached_tokens ?? record.cached_tokens);
  const cacheReadTokens = integerValue(tokens.cache_read_tokens ?? record.cache_read_tokens ?? cachedTokens);
  const cacheCreationTokens = integerValue(tokens.cache_creation_tokens ?? record.cache_creation_tokens);
  // reasoning_tokens are normally a subset of output_tokens, not an additional total.
  const totalTokens = integerValue(tokens.total_tokens ?? record.total_tokens ?? (inputTokens + outputTokens));

  const rawApiKey = textValue(record.api_key ?? record.apiKey);
  const rawEndpoint = textValue(record.endpoint ?? record.path);
  const safeEndpoint = rawApiKey && rawEndpoint === rawApiKey ? null : rawEndpoint;

  const normalized = {
    sourceInstanceId,
    originSystem,
    sourceTransport,
    sourceNativeId: textValue(record.event_id ?? record.id ?? record.event_key),
    occurredAt: parseOccurredAt(record),
    provider: textValue(record.provider ?? record.access_provider),
    endpoint: safeEndpoint,
    authType: textValue(record.auth_type),
    clientIp: textValue(record.client_ip),
    xForwardedFor: textValue(record.x_forwarded_for),
    userAgent: textValue(record.user_agent),
    apiGroupKey: textValue(record.api_group_key),
    apiGroupLabel: textValue(record.api_group_label),
    apiKeyMask: maskApiKey(rawApiKey),
    model: textValue(record.model ?? record.model_name) ?? "unknown",
    modelAlias: textValue(record.model_alias ?? record.alias),
    responseModel: textValue(record.response_model),
    modelSubstituted: record.model_substituted === undefined ? null : booleanValue(record.model_substituted),
    reasoningEffort: textValue(record.reasoning_effort),
    serviceTier: textValue(record.service_tier),
    responseServiceTier: textValue(record.response_service_tier),
    effectiveServiceTier: textValue(record.effective_service_tier),
    billedServiceTier: textValue(record.billed_service_tier),
    billedServiceTierSource: textValue(record.billed_service_tier_source),
    executorType: textValue(record.executor_type),
    source: textValue(record.source),
    authIndex: textValue(record.auth_index),
    accessProvider: textValue(record.access_provider),
    isNativeKey: record.is_native_key === undefined ? null : booleanValue(record.is_native_key),
    stream: record.stream === undefined ? null : booleanValue(record.stream),
    generate: record.generate === undefined ? null : booleanValue(record.generate),
    latencyMs: record.latency_ms === undefined ? null : integerValue(record.latency_ms),
    ttftMs: record.ttft_ms === undefined ? null : integerValue(record.ttft_ms),
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    isError: booleanValue(record.failed ?? record.is_error ?? record.isError),
    statusCode: record.status_code === undefined && record.fail_status_code === undefined
      ? null
      : integerValue(record.status_code ?? record.fail_status_code),
    failCode: textValue(record.fail_code),
    failBody: record.fail_body === undefined ? null : redactText(record.fail_body).slice(0, 4000),
    responseHeaders: record.response_headers ? sanitizeValue(record.response_headers) : null,
    tokenAccounting: record.token_accounting ? sanitizeValue(record.token_accounting) : null,
    structuredUsage: record.structured_usage ? sanitizeValue(record.structured_usage) : null,
    rawPayload: sanitizeUsagePayload(record)
  };

  const identity = identityFor(record, normalized, sourceInstanceId);
  return { ...normalized, ...identity, identityVersion: 1 };
}
