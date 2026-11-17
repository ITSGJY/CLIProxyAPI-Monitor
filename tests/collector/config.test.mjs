import assert from "node:assert/strict";
import { test } from "node:test";
import { loadCollectorConfig } from "../../lib/collector/config.mjs";

test("Collector is disabled by default and opens no connections", () => {
  assert.deepEqual(loadCollectorConfig({}), { enabled: false });
});

const safeEnv = {
  COLLECTOR_ENABLED: "true",
  CPA_INSTANCE_ID: "test-cpa",
  CPA_REDIS_ADDR: "127.0.0.1:19171",
  CPA_MANAGEMENT_BASE_URL: "http://127.0.0.1:19171",
  CPA_MANAGEMENT_KEY: "test-only-key",
  DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/cpa_monitor_test"
};

test("Collector requires explicit endpoints and credentials", () => {
  assert.throws(
    () => loadCollectorConfig({ ...safeEnv, CPA_REDIS_ADDR: "" }),
    /CPA_REDIS_ADDR is required/
  );
});

test("production CPA port 8317 is blocked without an explicit cutover flag", () => {
  assert.throws(
    () => loadCollectorConfig({ ...safeEnv, CPA_REDIS_ADDR: "127.0.0.1:8317" }),
    /port 8317 is protected/
  );
});

test("Collector rejects the legacy queue name and non-pull-first mode", () => {
  assert.throws(
    () => loadCollectorConfig({ ...safeEnv, CPA_USAGE_QUEUE: "queue" }),
    /only supports the 'usage' queue/
  );
  assert.throws(
    () => loadCollectorConfig({ ...safeEnv, COLLECTOR_MODE: "subscribe" }),
    /mode is pull-first/
  );
});

test("non-loopback CPA targets are rejected without explicit approval", () => {
  assert.throws(
    () => loadCollectorConfig({ ...safeEnv, CPA_REDIS_ADDR: "10.0.0.10:19171", CPA_MANAGEMENT_BASE_URL: "http://10.0.0.10:19171" }),
    /only permits loopback CPA test endpoints/
  );
});

test("production or remote PostgreSQL databases are rejected by default", () => {
  assert.throws(
    () => loadCollectorConfig({ ...safeEnv, DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/cpa_monitor" }),
    /requires a loopback PostgreSQL database/
  );
  assert.throws(
    () => loadCollectorConfig({ ...safeEnv, DATABASE_URL: "postgresql://test:test@10.0.0.5:5432/cpa_monitor_test" }),
    /requires a loopback PostgreSQL database/
  );
});

test("Collector lease covers the bounded retry window as well as the polling interval", () => {
  assert.throws(
    () => loadCollectorConfig({ ...safeEnv, COLLECTOR_POLL_INTERVAL_MS: "10000", COLLECTOR_LEASE_SECONDS: "30" }),
    /at least 60 seconds/
  );
  assert.equal(
    loadCollectorConfig({ ...safeEnv, COLLECTOR_POLL_INTERVAL_MS: "10000", COLLECTOR_LEASE_SECONDS: "60" }).leaseSeconds,
    60
  );
  assert.equal(
    loadCollectorConfig({ ...safeEnv, CPA_REDIS_ADDR: "127.0.0.1:19171", CPA_MANAGEMENT_BASE_URL: "http://127.0.0.1:19171", COLLECTOR_POLL_INTERVAL_MS: "60000", COLLECTOR_LEASE_SECONDS: "180" }).leaseSeconds,
    180
  );
});

test("explicit test endpoints are accepted without production permission", () => {
  const config = loadCollectorConfig(safeEnv);
  assert.equal(config.enabled, true);
  assert.equal(config.queueName, "usage");
  assert.equal(config.allowProductionTarget, false);
  assert.equal(config.redisPort, 19171);
});
