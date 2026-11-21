import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeErrorEvent, normalizeOmcError, redactErrorText } from "../../lib/cpa-errors/normalize.mjs";

export const payload = { timestamp: "2026-11-20T01:00:00.123456789Z", provider: "openai", model: "test-model", auth_index: "auth-9", auth_id: "credential-file.json",
  status_code: 429, body: "quota exceeded", code: "rate_limit", retryable: true,
  auth_status: { status: "error", status_message: "cooldown", disabled: false, unavailable: true, next_retry_after: "2026-11-20T02:00:00Z",
    quota: { exceeded: true, reason: "credential_quota", next_recover_at: "2026-11-20T02:30:00Z", backoff_level: 2 },
    model: { name: "test-model", status: "error", status_message: "cooldown", unavailable: true, next_retry_after: "2026-11-20T02:00:00Z",
      quota: { exceeded: true, reason: "quota", next_recover_at: "2026-11-20T02:30:00Z", backoff_level: 1 } } } };

test("CPA v8.0.56 projection preserves quota/model status and OMC derivation rules", () => {
  const event = normalizeErrorEvent(payload, { instanceId: "one" });
  assert.equal(event.auth_status.status, "error");
  assert.equal(event.auth_status.model.unavailable, true);
  assert.equal(event.model_quota_inherited, true);
  assert.equal(event.auth_quota_aggregate, false);
  assert.equal(event.backoff_level, 2);
  assert.equal(event.model_backoff_level, 1);
  assert.equal(event.cooldown_model, "test-model");
  assert.equal(normalizeErrorEvent({ ...payload, model: "gemini-2.5-pro-preview-06-05" }, { instanceId: "one" }).model, "gemini-2.5-pro-preview-06-05");
  const aggregate = structuredClone(payload);
  aggregate.auth_status.quota.reason = "quota";
  assert.equal(normalizeErrorEvent(aggregate, { instanceId: "one" }).auth_quota_aggregate, true);
  aggregate.auth_status.quota.reason = "credential_quota";
  aggregate.auth_status.model.next_retry_after = "2026-11-21T02:00:00Z";
  assert.equal(normalizeErrorEvent(aggregate, { instanceId: "one" }).model_quota_inherited, false);
});

test("error identity ignores unknown fields/auth_id and preserves submillisecond source distinction", () => {
  const first = normalizeErrorEvent(payload, { instanceId: "one" });
  assert.equal(first.event_key, normalizeErrorEvent({ unknown: "secret", ...payload, auth_id: "another" }, { instanceId: "one" }).event_key);
  assert.notEqual(first.event_key, normalizeErrorEvent({ ...payload, timestamp: "2026-11-20T01:00:00.123456790Z" }, { instanceId: "one" }).event_key);
  assert.equal(first.event_key, normalizeErrorEvent(JSON.stringify(payload), { instanceId: "one", receivedAt: "2026-11-21" }).event_key);
});

test("allowlist and redaction exclude auth ID, secrets, tokens, emails and network PII", () => {
  const dirty = structuredClone(payload);
  const text = 'credential-file.json Bearer bearer-secret sk-proj-supersecret123 user@example.com 203.0.113.22 +65 9123 4567 api_key="key-value" password: secret-value token=token-value {"email":"somebody@example.org"} https://host/path?token=hidden <script>alert(1)</script>';
  dirty.body = text;
  dirty.auth_status.status_message = text;
  dirty.auth_status.model.status_message = text;
  dirty.auth_status.quota.reason = text;
  dirty.auth_status.secret = "hidden-field";
  dirty.auth_status.model.private = "hidden-field";
  dirty.headers = { authorization: "hidden-field" };
  const stored = JSON.stringify(normalizeErrorEvent(dirty, { instanceId: "one" }));
  for (const secret of ["auth_id", "credential-file.json", "bearer-secret", "supersecret123", "user@example.com", "203.0.113.22", "9123", "key-value", "secret-value", "token-value", "hidden-field"]) assert.ok(!stored.includes(secret), secret);
  assert.match(stored, /<script>/, "body is plain text; React must escape it rather than render HTML");
  assert.equal(redactErrorText("x".repeat(4090) + " Bearer long-credential-value").includes("long-credential"), false);
  for (const input of ["full_name: Alice Smith", "地址：北京市朝阳区街道", "Set-Cookie: session=abc; refresh=def", "Authorization: custom secret-value"]) {
    assert.ok(!redactErrorText(input).includes(input.split(/[:：]/)[1].trim()));
  }
});

test("absent optional fields remain unknown; malformed timestamps do not create false correlation", () => {
  const event = normalizeErrorEvent({ timestamp: payload.timestamp }, { instanceId: "one" });
  assert.equal(event.auth_index, null);
  assert.equal(event.retryable, null);
  assert.equal(event.quota_exceeded, null);
  assert.equal(event.auth_status.model, null);
  for (const input of ["bad-json", [], null, {}, { timestamp: "bad" }]) assert.throws(() => normalizeErrorEvent(input, { instanceId: "one" }));
  assert.equal(normalizeErrorEvent({ timestamp: payload.timestamp, auth_index: "user@example.com" }, { instanceId: "one" }).auth_index, null);
  assert.throws(() => normalizeOmcError({ timestamp_ms: 1, created_at_ms: null }, { instanceId: "one" }));
});
