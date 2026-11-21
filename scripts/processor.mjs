import { setTimeout as sleep } from "node:timers/promises";
import { processInboxBatch } from "../lib/collector/postgres-store.mjs";
import { syncPricingIfDue } from "../lib/pricing/sync.mjs";

function positiveInteger(value, name, fallback, max) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new RangeError(`${name} must be between 1 and ${max}`);
  return parsed;
}

async function run() {
  if (String(process.env.PROCESSOR_ENABLED ?? "false").toLowerCase() !== "true") {
    console.log("Usage Processor disabled; no database connection opened.");
    return;
  }
  const databaseUrl = String(process.env.DATABASE_URL ?? "").trim();
  const instanceId = String(process.env.CPA_INSTANCE_ID ?? "").trim();
  if (!databaseUrl || !instanceId) throw new Error("DATABASE_URL and CPA_INSTANCE_ID are required when PROCESSOR_ENABLED=true");

  const batchSize = positiveInteger(process.env.PROCESSOR_BATCH_SIZE, "PROCESSOR_BATCH_SIZE", 25, 500);
  const leaseSeconds = positiveInteger(process.env.PROCESSOR_LEASE_SECONDS, "PROCESSOR_LEASE_SECONDS", 120, 900);
  const maxAttempts = positiveInteger(process.env.PROCESSOR_MAX_ATTEMPTS, "PROCESSOR_MAX_ATTEMPTS", 8, 100);
  const pollIntervalMs = positiveInteger(process.env.PROCESSOR_POLL_INTERVAL_MS, "PROCESSOR_POLL_INTERVAL_MS", 1000, 60_000);
  const workerId = `${String(process.env.PROCESSOR_WORKER_ID ?? "processor").slice(0, 48)}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`.slice(0, 100);
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl, max: 2, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 5_000, statement_timeout: 20_000, query_timeout: 22_000, application_name: "cliproxyapi-monitor-processor" });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await pool.query("SELECT 1");
    console.log(`Usage Processor ready; instance=${instanceId}; worker=${workerId}; batch=${batchSize}`);
    let nextPricingSyncCheckAt = 0;
    let pricingSyncInFlight = false;
    while (!controller.signal.aborted) {
      if (!pricingSyncInFlight && Date.now() >= nextPricingSyncCheckAt) {
        nextPricingSyncCheckAt = Date.now() + 5 * 60 * 1000;
        pricingSyncInFlight = true;
        void syncPricingIfDue(pool)
          .then((result) => {
            if (result.status !== "not_due") console.log(JSON.stringify({ event: "pricing_catalog_sync", ...result }));
          })
          .catch((error) => {
            const message = String(error instanceof Error ? error.message : error).slice(0, 240);
            console.error("Pricing catalog auto-sync failed:", message);
          })
          .finally(() => { pricingSyncInFlight = false; });
      }
      const summary = await processInboxBatch(pool, { instanceId, workerId, batchSize, leaseSeconds, maxAttempts });
      if (summary.claimed > 0) console.log(JSON.stringify({ event: "usage_inbox_processed", ...summary }));
      if (summary.claimed === 0) {
        try { await sleep(pollIntervalMs, undefined, { signal: controller.signal }); }
        catch (error) { if (error?.name !== "AbortError") throw error; }
      }
    }
  } finally {
    await pool.end();
  }
}

run().catch((error) => {
  const message = String(error instanceof Error ? error.message : error)
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/(postgres(?:ql)?:\/\/[^:\/@\s]+:)[^@\/\s]+@/gi, "$1[redacted]@")
    .slice(0, 300);
  console.error("Usage Processor stopped:", message);
  process.exitCode = 1;
});
