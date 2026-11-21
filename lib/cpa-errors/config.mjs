import { randomUUID } from "node:crypto";
import { parseRespAddress } from "../collector/resp-client.mjs";

export function loadErrorCollectorConfig(env = process.env) {
  if (env.ERROR_COLLECTOR_ENABLED !== "true") return { enabled: false };
  for (const key of ["CPA_INSTANCE_ID", "CPA_REDIS_ADDR", "CPA_MANAGEMENT_KEY", "DATABASE_URL"]) {
    if (!env[key]?.trim()) throw new Error(`missing_${key}`);
  }
  const redis = parseRespAddress(env.CPA_REDIS_ADDR);
  let database;
  try { database = new URL(env.DATABASE_URL); } catch { throw new Error("invalid_error_database_url"); }
  const loopback = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (env.ERROR_COLLECTOR_ALLOW_PRODUCTION_TARGET !== "true" && (!loopback.has(redis.host) || redis.port === 8317)) throw new Error("error_cpa_target_protected");
  if (!["postgres:", "postgresql:"].includes(database.protocol)) throw new Error("invalid_error_database_protocol");
  if (env.ERROR_COLLECTOR_ALLOW_PRODUCTION_DATABASE !== "true" && (!loopback.has(database.hostname) || !decodeURIComponent(database.pathname).toLowerCase().includes("test"))) throw new Error("error_database_target_protected");
  const number = (name, fallback, min, max) => {
    const value = Number(env[name] || fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`invalid_${name}`);
    return value;
  };
  return { enabled: true, instanceId: env.CPA_INSTANCE_ID.trim(), address: env.CPA_REDIS_ADDR, password: env.CPA_MANAGEMENT_KEY,
    databaseUrl: env.DATABASE_URL, workerId: `error-${process.pid}-${randomUUID()}`,
    leaseSeconds: number("ERROR_COLLECTOR_LEASE_SECONDS", 45, 30, 300), heartbeatMs: 5000,
    maxPending: number("ERROR_COLLECTOR_MAX_PENDING", 256, 1, 1000),
    maxPendingBytes: number("ERROR_COLLECTOR_MAX_PENDING_BYTES", 1048576, 65536, 16777216) };
}
