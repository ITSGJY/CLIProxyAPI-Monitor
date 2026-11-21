import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateCollectorHealth, getCollectorHealthStaleAfterMs, countRecentFullPullBatches } from "../../lib/collector/health.mjs";

const now = new Date("2026-11-17T12:00:00.000Z");
const healthyRow = {
  enabled: true,
  state: "receiving",
  leaseExpiresAt: new Date(now.getTime() + 60_000),
  updatedAt: new Date(now.getTime() - 2_000),
  lastSuccessAt: new Date(now.getTime() - 2_000),
  lastErrorCode: null
};

test("collector health accepts a fresh lease and successful pull", () => {
  assert.deepEqual(evaluateCollectorHealth(healthyRow, { now, staleAfterMs: 60_000 }), {
    healthy: true,
    status: "healthy",
    reason: null
  });
});

test("collector health accepts the normal checking heartbeat state", () => {
  assert.equal(evaluateCollectorHealth({ ...healthyRow, state: "checking" }, { now }).healthy, true);
});

test("collector health distinguishes an intentional pause", () => {
  assert.equal(evaluateCollectorHealth({ ...healthyRow, state: "paused" }, { now }).status, "paused");
});

test("collector health reports degraded transport errors", () => {
  const result = evaluateCollectorHealth({ ...healthyRow, state: "degraded", lastErrorCode: "resp_pull_failed" }, { now });
  assert.equal(result.status, "degraded");
  assert.equal(result.reason, "resp_pull_failed");
});

test("collector health rejects expired leases and stale heartbeats", () => {
  assert.equal(evaluateCollectorHealth({ ...healthyRow, leaseExpiresAt: now }, { now }).reason, "collector_lease_expired");
  assert.equal(evaluateCollectorHealth({ ...healthyRow, updatedAt: new Date(now.getTime() - 61_000) }, { now }).reason, "collector_heartbeat_stale");
  assert.equal(evaluateCollectorHealth({ ...healthyRow, lastSuccessAt: new Date(now.getTime() - 61_000) }, { now }).reason, "last_successful_pull_stale");
});

test("collector health reports missing and not-yet-started instances", () => {
  assert.equal(evaluateCollectorHealth(null, { now }).status, "missing");
  assert.equal(evaluateCollectorHealth({ ...healthyRow, lastSuccessAt: null }, { now }).status, "starting");
});

test("health staleness follows polling cadence with a 60-second floor", () => {
  assert.equal(getCollectorHealthStaleAfterMs(10_000), 60_000);
  assert.equal(getCollectorHealthStaleAfterMs(60_000), 180_000);
  assert.throws(() => getCollectorHealthStaleAfterMs(0), /positive number/);
});

test("collector health reads snake_case database error columns", () => {
  const result = evaluateCollectorHealth({ ...healthyRow, state: "checking", last_error_code: "resp_pull_failed" }, { now });
  assert.equal(result.status, "degraded");
  assert.equal(result.reason, "resp_pull_failed");
});

test("capacity warning counts only full FIFO pull batches, not RESP subscription events", () => {
  assert.equal(countRecentFullPullBatches([
    { transport: "resp-subscribe", requested_count: 1, received_count: 8 },
    { transport: "resp", requested_count: 100, received_count: 100 },
    { transport: "http", requested_count: 100, received_count: 120 },
    { transport: "resp", requested_count: 100, received_count: 99 },
    { transport: "unknown", requested_count: 1, received_count: 1 }
  ]), 2);
  assert.equal(countRecentFullPullBatches([
    { transport: "resp-subscribe", requested_count: 1, received_count: 37 }
  ]), 0);
});
