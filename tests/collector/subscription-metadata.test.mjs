import assert from "node:assert/strict";
import { test } from "node:test";
import { markSubscriptionEstablished } from "../../lib/collector/postgres-store.mjs";

function createPool(stateRowCount = 1) {
  const calls = [];
  let released = false;
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).trim();
      calls.push({ sql: normalized, params });
      if (normalized.startsWith("UPDATE usage_pull_attempts")) {
        return {
          rowCount: 1,
          rows: [{ started_at: "2026-11-18T10:00:00.000Z", subscribed_at: "2026-11-18T10:00:01.000Z" }]
        };
      }
      if (normalized.startsWith("UPDATE usage_collector_state")) return { rowCount: stateRowCount, rows: [] };
      return { rowCount: 0, rows: [] };
    },
    release() { released = true; }
  };
  return { pool: { async connect() { return client; } }, calls, wasReleased: () => released };
}

test("subscription acknowledgement is recorded transactionally with lease renewal", async () => {
  const fixture = createPool();
  const result = await markSubscriptionEstablished(fixture.pool, {
    attemptId: 12,
    instanceId: "oracle-primary",
    workerId: "collector-worker",
    leaseSeconds: 90
  });
  assert.equal(result.subscribed_at, "2026-11-18T10:00:01.000Z");
  assert.ok(fixture.calls.some((call) => call.sql === "BEGIN"));
  assert.ok(fixture.calls.some((call) => call.sql === "COMMIT"));
  assert.ok(fixture.calls.some((call) => call.sql.includes("jsonb_build_object('subscribed_at', clock_timestamp())")));
  assert.ok(fixture.calls.some((call) => call.sql.includes("lease_expires_at = now() + make_interval(secs => $3)")));
  assert.equal(fixture.wasReleased(), true);
});

test("subscription acknowledgement fails closed when the worker lease is lost", async () => {
  const fixture = createPool(0);
  await assert.rejects(
    markSubscriptionEstablished(fixture.pool, {
      attemptId: 12,
      instanceId: "oracle-primary",
      workerId: "stale-worker",
      leaseSeconds: 90
    }),
    /lease was lost/
  );
  assert.ok(fixture.calls.some((call) => call.sql === "ROLLBACK"));
  assert.equal(fixture.wasReleased(), true);
});
