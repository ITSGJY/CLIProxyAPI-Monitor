import assert from "node:assert/strict";
import { test } from "node:test";
import { errorCoverage, evaluateErrorHealth } from "../../lib/cpa-errors/coverage.mjs";
import { getCredentialErrors } from "../../lib/cpa-errors/query.mjs";

const center = Date.parse("2026-11-20T01:00:00Z");
const iso = (delta) => new Date(center + delta).toISOString();
const state = { enabled: true, state: "collecting", lease_expires_at: iso(30000), heartbeat_at: iso(0) };
const session = { subscribed_at: iso(-150000), coverage_through: iso(-1000), ended_at: null };

test("coverage distinguishes future collecting, complete, interior gaps and disconnected tail", () => {
  const current = errorCoverage({ occurredAt: iso(0), state, sessions: [session], now: center });
  assert.equal(current.status, "collecting");
  assert.equal(current.complete, false);
  assert.equal(current.window_closed, false);
  const customWindow = errorCoverage({ occurredAt: iso(0), state, sessions: [session], now: center, windowMs: 30000 });
  assert.equal(customWindow.window_ms, 30000);
  assert.equal(customWindow.window_start, iso(-30000));
  assert.equal(customWindow.window_end, iso(30000));
  const complete = errorCoverage({ occurredAt: iso(0), sessions: [{ ...session, coverage_through: iso(120000), ended_at: iso(120000) }], now: center + 130000 });
  assert.equal(complete.status, "complete");
  assert.equal(complete.complete, true);
  const liveCompleteWithUnavailableHistory = errorCoverage({ occurredAt: iso(0), state,
    sessions: [{ ...session, coverage_through: iso(120000), ended_at: iso(120000) }], now: center + 130000,
    imports: [{ status: "unavailable" }] });
  assert.equal(liveCompleteWithUnavailableHistory.status, "complete");
  assert.equal(liveCompleteWithUnavailableHistory.reason, null);
  const gaps = errorCoverage({ occurredAt: iso(0), state, sessions: [
    { ...session, coverage_through: iso(-50000), ended_at: iso(-45000) }, { ...session, subscribed_at: iso(-30000) }
  ], now: center });
  assert.equal(gaps.status, "partial");
  assert.deepEqual(gaps.gaps, [{ from: iso(-50000), to: iso(-30000) }]);
  const disconnected = errorCoverage({ occurredAt: iso(0), state: { ...state, state: "disconnected" }, sessions: [{ ...session, ended_at: iso(0) }], now: center });
  assert.equal(disconnected.status, "disconnected");
  assert.equal(disconnected.gaps.length, 1);
});

test("coverage distinguishes disabled, unconfigured, connecting, historical and missing error table", () => {
  const input = { occurredAt: iso(0), now: center + 150000 };
  assert.equal(errorCoverage(input).status, "not_configured");
  assert.equal(errorCoverage({ ...input, configured: false }).status, "disabled");
  assert.equal(errorCoverage({ ...input, configured: true }).status, "connecting");
  assert.equal(errorCoverage({ ...input, imports: [{ status: "unavailable" }] }).reason, "source_error_table_unavailable");
  const historical = errorCoverage({ ...input, imports: [{ status: "completed", min_occurred_at: iso(-100000), max_occurred_at: iso(100000) }] });
  assert.equal(historical.status, "historical_import");
  assert.equal(historical.complete, false);
  assert.equal(errorCoverage({ ...input, imports: [{ status: "failed", min_occurred_at: iso(-100000), max_occurred_at: iso(100000) }] }).status, "partial");
});

test("health requires live lease, heartbeat and drained PONG watermark even on an idle stream", () => {
  assert.equal(evaluateErrorHealth(state, session, center).healthy, true);
  assert.equal(evaluateErrorHealth({ ...state, lease_expires_at: iso(-1) }, session, center).status, "disconnected");
  assert.equal(evaluateErrorHealth({ ...state, heartbeat_at: null }, session, center).healthy, false);
  assert.equal(evaluateErrorHealth(state, { ...session, coverage_through: iso(-25000) }, center).status, "degraded");
  assert.equal(evaluateErrorHealth({ ...state, state: "connecting" }, null, center).status, "connecting");
});

test("missing credential skips queries and query failure stays explicit without leaking exceptions", async () => {
  const pool = { query: async () => { throw new Error("password=secret auth_id=user@example.com"); } };
  const record = { sourceInstanceId: "one", authIndex: "", occurredAt: iso(0) };
  assert.equal((await getCredentialErrors(pool, record)).coverage.status, "not_correlatable");
  const failed = await getCredentialErrors(pool, { ...record, authIndex: "auth-9" });
  assert.equal(failed.coverage.status, "query_failed");
  assert.equal(failed.coverage.complete, false);
  assert.ok(!JSON.stringify(failed).includes("secret"));
});
