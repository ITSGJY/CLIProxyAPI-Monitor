import assert from "node:assert/strict";
import { test } from "node:test";
import { runErrorCollector, errorReconnectDelay } from "../../lib/cpa-errors/collector.mjs";
import { loadErrorCollectorConfig } from "../../lib/cpa-errors/config.mjs";

function fixture() {
  const calls = [];
  const store = Object.fromEntries(["renew", "subscribed", "confirmCoverage", "persist", "endSession", "release"].map((name) => [name, async (...args) => { calls.push([name, ...args]); }]));
  store.acquire = async () => true;
  let session = 0;
  store.startSession = async () => ++session;
  return { calls, store, config: { enabled: true, instanceId: "test", password: "key", heartbeatMs: 5 }, signal: new AbortController() };
}

test("collector reconnects after malformed payload/transport failures with capped independent backoff", async () => {
  const { calls, store, config, signal } = fixture();
  const delays = [], reports = [];
  let attempts = 0;
  await runErrorCollector({ store, config, signal: signal.signal, report: (r) => reports.push(r), delay: async (ms) => { delays.push(ms); },
    subscribe: async (options) => {
      attempts++;
      await options.onSubscribed();
      if (attempts === 1) await options.onMessage('{"body":"secret-payload","auth_id":"private"');
      if (attempts === 2) throw new Error("Bearer secret-connection");
      await options.onMessage('{"timestamp":"2026-11-20T01:00:00Z","auth_index":"a"}');
      signal.abort();
    }
  });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [500, 1000]);
  assert.equal(errorReconnectDelay(100), 30000);
  assert.equal(calls.filter((c) => c[0] === "persist").length, 1);
  assert.equal(calls.filter((c) => c[0] === "confirmCoverage").length, 1, "a durable error message advances the coverage watermark even without an idle-stream PONG");
  assert.deepEqual(calls.filter((c) => c[0] === "endSession").map((c) => c[2]), ["malformed_payload", "stream_interrupted", "shutdown"]);
  assert.ok(!JSON.stringify(reports).includes("secret"));
  assert.equal(calls.at(-1)[0], "release");
});

test("lease heartbeat failure aborts only the error subscriber and fences shutdown", async () => {
  const { store, config, signal } = fixture();
  store.renew = async () => { throw new Error("lost"); };
  let aborted = false;
  await assert.rejects(runErrorCollector({ config, store, signal: signal.signal,
    subscribe: async ({ signal: inner }) => new Promise((resolve) => inner.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }))
  }), /lease_lost/);
  assert.ok(aborted);
});

test("error config is independent of usage enablement and requires both explicit production gates", () => {
  assert.deepEqual(loadErrorCollectorConfig({ COLLECTOR_ENABLED: "true" }), { enabled: false });
  const env = { ERROR_COLLECTOR_ENABLED: "true", CPA_INSTANCE_ID: "test", CPA_REDIS_ADDR: "127.0.0.1:18317", CPA_MANAGEMENT_KEY: "test", DATABASE_URL: "postgresql://test:test@127.0.0.1/test" };
  assert.equal(loadErrorCollectorConfig(env).maxPending, 256);
  const production = { ...env, CPA_REDIS_ADDR: "127.0.0.1:8317", DATABASE_URL: "postgresql://test:test@127.0.0.1/production",
    ERROR_COLLECTOR_ALLOW_PRODUCTION_TARGET: "true", ERROR_COLLECTOR_ALLOW_PRODUCTION_DATABASE: "true" };
  assert.equal(loadErrorCollectorConfig(production).enabled, true);
  assert.throws(() => loadErrorCollectorConfig({ ...production, ERROR_COLLECTOR_ALLOW_PRODUCTION_TARGET: "false" }));
  assert.throws(() => loadErrorCollectorConfig({ ...production, ERROR_COLLECTOR_ALLOW_PRODUCTION_DATABASE: "false" }));
  assert.throws(() => loadErrorCollectorConfig({ ...env, ERROR_COLLECTOR_MAX_PENDING: "1001" }));
});