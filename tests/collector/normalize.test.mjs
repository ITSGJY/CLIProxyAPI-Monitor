import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hashRawPayload,
  usageControlMessageKind,
  normalizeUsageRecord,
  sanitizeUsagePayload
} from "../../lib/collector/normalize.mjs";

const baseRecord = {
  timestamp: "2026-11-17T00:00:00.000Z",
  provider: "openai",
  model: "gpt-test",
  request_id: "request-123",
  session_id: "session-123",
  parent_session_id: "session-parent-123",
  execution_id: "execution-123",
  trace_id: "trace-123",
  node_kind: "message",
  is_fork: true,
  is_compaction: false,
  api_key: "sk-test-secret-123456789",
  tokens: {
    input_tokens: 100,
    output_tokens: 20,
    reasoning_tokens: 5,
    cached_tokens: 30,
    total_tokens: 125
  }
};

test("recognizes CPA RESP control messages without classifying usage records as control", () => {
  assert.equal(usageControlMessageKind('{"support_refresh":true}'), "support_refresh");
  assert.equal(usageControlMessageKind('{"refresh":true}'), "refresh");
  assert.equal(usageControlMessageKind(baseRecord), null);
  assert.equal(usageControlMessageKind('{"support_refresh":true,"timestamp":"2026-11-17T00:00:00Z"}'), null);
  assert.equal(usageControlMessageKind("not-json"), null);
});


test("normalization stores only a masked API key and redacted raw payload", () => {
  const normalized = normalizeUsageRecord(baseRecord, {
    sourceInstanceId: "test-cpa",
    sourceTransport: "resp"
  });

  assert.equal(normalized.apiKeyMask, "****6789");
  assert.equal(normalized.inputTokens, 100);
  assert.equal(normalized.outputTokens, 20);
  assert.equal(normalized.totalTokens, 125);
  assert.equal(normalized.sessionId, "session-123");
  assert.equal(normalized.parentSessionId, "session-parent-123");
  assert.equal(normalized.executionId, "execution-123");
  assert.equal(normalized.traceId, "trace-123");
  assert.equal(normalized.nodeKind, "message");
  assert.equal(normalized.isFork, true);
  assert.equal(normalized.isCompaction, false);
  assert.equal(normalized.rawPayload.api_key, "****6789");
  assert.equal(JSON.stringify(normalized.rawPayload).includes("sk-test-secret"), false);
});

test("request identity is stable across legacy-source differences", () => {
  const first = normalizeUsageRecord({ ...baseRecord, source: "omc" }, {
    sourceInstanceId: "default",
    sourceTransport: "legacy_import",
    originSystem: "omc"
  });
  const second = normalizeUsageRecord({ ...baseRecord, source: "keeper" }, {
    sourceInstanceId: "default",
    sourceTransport: "legacy_import",
    originSystem: "keeper"
  });

  assert.equal(first.identityKind, "request_id");
  assert.equal(first.identityKey, second.identityKey);
});

test("canonical fallback identity is stable when no request identifiers exist", () => {
  const record = { ...baseRecord, request_id: undefined, execution_id: undefined, trace_id: undefined, api_key: undefined };
  const first = normalizeUsageRecord(record, { sourceInstanceId: "default" });
  const second = normalizeUsageRecord({ ...record }, { sourceInstanceId: "default" });
  assert.equal(first.identityKind, "canonical_fingerprint");
  assert.equal(first.identityKey, second.identityKey);
});

test("sanitizer redacts nested credentials and preserves non-secret metadata", () => {
  const payload = sanitizeUsagePayload({
    model: "gpt-test",
    auth: { api_key: "secret", authorization: "Bearer secret" },
    tokens: { input_tokens: 1 }
  });

  assert.equal(payload.model, "gpt-test");
  assert.equal(payload.auth.api_key, "****cret");
  assert.equal(payload.auth.authorization, "[redacted]");
  assert.equal(payload.tokens.input_tokens, 1);
});

test("invalid event timestamps are rejected instead of replaced with ingest time", () => {
  assert.throws(
    () => normalizeUsageRecord({ model: "gpt-test" }),
    (error) => error.code === "MISSING_EVENT_TIMESTAMP" && error.permanent === true
  );
});

test("payload hash is deterministic", () => {
  assert.equal(hashRawPayload({ a: 1 }), hashRawPayload({ a: 1 }));
});


test("request ID identity remains stable when timestamp and model metadata differ", () => {
  const first = normalizeUsageRecord(baseRecord, { sourceInstanceId: "default" });
  const second = normalizeUsageRecord({
    ...baseRecord,
    timestamp: "2026-11-17T00:01:00.000Z",
    model: "gpt-test-alias"
  }, { sourceInstanceId: "default" });
  assert.equal(first.identityKey, second.identityKey);
});

test("numeric Unix-second timestamps are normalized to milliseconds", () => {
  const normalized = normalizeUsageRecord({ ...baseRecord, timestamp: 1794873600 });
  assert.equal(normalized.occurredAt, new Date(1794873600 * 1000).toISOString());
});

test("string fields containing inline API credentials are redacted", () => {
  const payload = sanitizeUsagePayload({
    model: "gpt-test",
    message: "api_key=sk-inline-secret-123456789 authorization: Bearer secret-token"
  });
  assert.equal(JSON.stringify(payload).includes("sk-inline-secret"), false);
  assert.equal(JSON.stringify(payload).includes("secret-token"), false);
});


test("API key fields are masked while cookies and tokens are redacted recursively", () => {
  const payload = sanitizeUsagePayload({
    headers: {
      cookie: "session=private-session-value",
      "set-cookie": "sid=private-cookie-value",
      "x-api-key": "private-api-key-value",
      "x-auth-token": "private-auth-token-value"
    }
  });
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes("private-session-value"), false);
  assert.equal(serialized.includes("private-cookie-value"), false);
  assert.equal(serialized.includes("private-api-key-value"), false);
  assert.equal(payload.headers["x-api-key"], "****alue");
  assert.equal(serialized.includes("private-auth-token-value"), false);
});

test("numeric Unix-second timestamps encoded as strings are normalized", () => {
  const normalized = normalizeUsageRecord({ ...baseRecord, timestamp: "1794873600" });
  assert.equal(normalized.occurredAt, new Date(1794873600 * 1000).toISOString());
});
