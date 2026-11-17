import { setTimeout as sleep } from "node:timers/promises";
import { refreshUsageHourlyRollups, refreshUsageDailyRollups } from "../lib/collector/rollups.mjs";

function positiveInteger(value, name, fallback, max) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new RangeError(`${name} must be between 1 and ${max}`);
  return parsed;
}

async function run() {
  if (String(process.env.ROLLUP_ENABLED ?? "false").toLowerCase() !== "true") {
    console.log("Usage Rollup Worker disabled; no database connection opened.");
    return;
  }
  const databaseUrl = String(process.env.DATABASE_URL ?? "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required when ROLLUP_ENABLED=true");
  const timezone = String(process.env.ROLLUP_TIMEZONE ?? "UTC");
  const hourlyLookbackHours = positiveInteger(process.env.ROLLUP_HOURLY_LOOKBACK_HOURS, "ROLLUP_HOURLY_LOOKBACK_HOURS", 48, 24 * 366);
  const dailyLookbackDays = positiveInteger(process.env.ROLLUP_DAILY_LOOKBACK_DAYS, "ROLLUP_DAILY_LOOKBACK_DAYS", 90, 3660);
  const hourlyIntervalMs = positiveInteger(process.env.ROLLUP_HOURLY_INTERVAL_MS, "ROLLUP_HOURLY_INTERVAL_MS", 60_000, 86_400_000);
  const dailyIntervalMs = positiveInteger(process.env.ROLLUP_DAILY_INTERVAL_MS, "ROLLUP_DAILY_INTERVAL_MS", 3_600_000, 604_800_000);
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl, max: 1, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 5_000, statement_timeout: 60_000, query_timeout: 65_000, application_name: "cliproxyapi-monitor-rollup" });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await pool.query("SELECT 1");
    console.log(`Usage Rollup Worker ready; timezone=${timezone}; hourly=${hourlyLookbackHours}h/${hourlyIntervalMs}ms; daily=${dailyLookbackDays}d/${dailyIntervalMs}ms`);
    let nextHourlyAt = 0;
    let nextDailyAt = 0;
    while (!controller.signal.aborted) {
      const now = Date.now();
      if (now >= nextHourlyAt) {
        const hourly = await refreshUsageHourlyRollups(pool, { timezone, hourlyLookbackHours });
        console.log(JSON.stringify({ event: "usage_rollup_refreshed", ...hourly }));
        nextHourlyAt = Date.now() + hourlyIntervalMs;
      }
      if (now >= nextDailyAt) {
        const daily = await refreshUsageDailyRollups(pool, { timezone, dailyLookbackDays });
        console.log(JSON.stringify({ event: "usage_rollup_refreshed", ...daily }));
        nextDailyAt = Date.now() + dailyIntervalMs;
      }
      const delay = Math.max(1, Math.min(nextHourlyAt, nextDailyAt) - Date.now());
      try { await sleep(delay, undefined, { signal: controller.signal }); }
      catch (error) { if (error?.name !== "AbortError") throw error; }
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
  console.error("Usage Rollup Worker stopped:", message);
  process.exitCode = 1;
});
