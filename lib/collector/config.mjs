import { randomUUID } from "node:crypto";
import { parseRespAddress } from "./resp-client.mjs";

function required(env, name) {
  const value = String(env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required when COLLECTOR_ENABLED=true`);
  return value;
}

function positiveInteger(value, name, fallback, max) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new RangeError(`${name} must be an integer between 1 and ${max}`);
  }
  return parsed;
}

export function loadCollectorConfig(env = process.env) {
  if (String(env.COLLECTOR_ENABLED ?? "false").toLowerCase() !== "true") {
    return { enabled: false };
  }

  const instanceId = required(env, "CPA_INSTANCE_ID");
  const redisAddress = required(env, "CPA_REDIS_ADDR");
  const managementBaseUrl = required(env, "CPA_MANAGEMENT_BASE_URL");
  const managementKey = required(env, "CPA_MANAGEMENT_KEY");
  const databaseUrl = required(env, "DATABASE_URL");
  const queueName = String(env.CPA_USAGE_QUEUE ?? "usage").trim();

  if (queueName !== "usage") {
    throw new Error("CPA v8 Collector only supports the 'usage' queue");
  }
  const configuredMode = String(env.COLLECTOR_MODE ?? "auto").trim().toLowerCase();
  if (!["auto", "subscribe", "pull", "pull-first"].includes(configuredMode)) {
    throw new Error("COLLECTOR_MODE must be one of auto, subscribe or pull");
  }
  const mode = configuredMode === "pull-first" ? "pull" : configuredMode;

  const redis = parseRespAddress(redisAddress);
  let managementUrl;
  try {
    managementUrl = new URL(managementBaseUrl);
  } catch {
    throw new TypeError("CPA_MANAGEMENT_BASE_URL must be an absolute HTTP(S) URL");
  }
  if (managementUrl.protocol !== "http:" && managementUrl.protocol !== "https:") {
    throw new TypeError("CPA_MANAGEMENT_BASE_URL must use HTTP or HTTPS");
  }
  if (managementUrl.username || managementUrl.password || managementUrl.search || managementUrl.hash) {
    throw new TypeError("CPA_MANAGEMENT_BASE_URL must not embed credentials, query parameters or fragments");
  }

  const allowProductionTarget = String(env.CPA_ALLOW_PRODUCTION_TARGET ?? "false").toLowerCase() === "true";
  const allowProductionDatabase = String(env.COLLECTOR_ALLOW_PRODUCTION_DATABASE ?? "false").toLowerCase() === "true";
  const allowPullFallback = String(env.COLLECTOR_ALLOW_PULL_FALLBACK ?? "false").toLowerCase() === "true";
  if (allowPullFallback && (allowProductionTarget || allowProductionDatabase)) {
    throw new Error("FIFO pull fallback is forbidden for production CPA or PostgreSQL targets; use native RESP SUBSCRIBE");
  }
  const managementPort = Number(managementUrl.port || (managementUrl.protocol === "https:" ? 443 : 80));
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (!allowProductionTarget) {
    if (redis.port === 8317 || managementPort === 8317) {
      throw new Error("CPA port 8317 is protected; set CPA_ALLOW_PRODUCTION_TARGET=true only during an explicitly approved production cutover");
    }
    if (!loopbackHosts.has(redis.host) || !loopbackHosts.has(managementUrl.hostname)) {
      throw new Error("Phase 3 Collector only permits loopback CPA test endpoints unless CPA_ALLOW_PRODUCTION_TARGET=true is explicitly approved");
    }
  }

  let database;
  try {
    database = new URL(databaseUrl);
  } catch {
    throw new TypeError("DATABASE_URL must be a valid PostgreSQL URL");
  }
  const databaseName = decodeURIComponent(database.pathname.replace(/^\//, ""));
  if (!allowProductionDatabase && (!loopbackHosts.has(database.hostname) || !databaseName.toLowerCase().includes("test"))) {
    throw new Error("Phase 3 Collector requires a loopback PostgreSQL database whose name contains 'test'; set COLLECTOR_ALLOW_PRODUCTION_DATABASE=true only during an explicitly approved production cutover");
  }

  const pollIntervalMs = positiveInteger(env.COLLECTOR_POLL_INTERVAL_MS, "COLLECTOR_POLL_INTERVAL_MS", 10_000, 60_000);
  const leaseSeconds = positiveInteger(env.COLLECTOR_LEASE_SECONDS, "COLLECTOR_LEASE_SECONDS", 60, 300);
  const minimumLeaseSeconds = Math.max(60, Math.ceil((pollIntervalMs * 3) / 1000));
  if (leaseSeconds < minimumLeaseSeconds) {
    throw new RangeError(`COLLECTOR_LEASE_SECONDS must be at least ${minimumLeaseSeconds} seconds for the configured polling interval and bounded retry window`);
  }

  return {
    enabled: true,
    instanceId,
    redisAddress,
    redisHost: redis.host,
    redisPort: redis.port,
    managementBaseUrl: managementUrl.toString(),
    managementKey,
    databaseUrl,
    queueName,
    mode,
    allowProductionTarget,
    allowProductionDatabase,
    allowPullFallback,
    pollIntervalMs,
    batchSize: positiveInteger(env.COLLECTOR_BATCH_SIZE, "COLLECTOR_BATCH_SIZE", 100, 1000),
    leaseSeconds,
    workerId: `${String(env.COLLECTOR_WORKER_ID ?? "collector").slice(0, 50)}-${process.pid}-${randomUUID().slice(0, 8)}`.slice(0, 100)
  };
}
