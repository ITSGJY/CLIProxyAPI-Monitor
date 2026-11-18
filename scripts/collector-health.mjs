import { getCollectorHealthStaleAfterMs, evaluateCollectorHealth } from "../lib/collector/health.mjs";

function safeError(error) {
  return String(error instanceof Error ? error.message : error ?? "unknown error")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/(postgres(?:ql)?:\/\/[^:\/@\s]+:)[^@\/\s]+@/gi, "$1[redacted]@")
    .replace(/(api[_-]?key|secret|password|token|authorization|cookie)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .slice(0, 300);
}

async function run() {
  const databaseUrl = String(process.env.DATABASE_URL ?? "").trim();
  const instanceId = String(process.env.CPA_INSTANCE_ID ?? "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required for Collector health checks");
  if (!instanceId) throw new Error("CPA_INSTANCE_ID is required for Collector health checks");

  const pollIntervalMs = Number(process.env.COLLECTOR_POLL_INTERVAL_MS ?? 10_000);
  const configuredStaleAfterMs = process.env.COLLECTOR_HEALTH_STALE_AFTER_MS;
  const staleAfterMs = configuredStaleAfterMs === undefined || configuredStaleAfterMs === ""
    ? getCollectorHealthStaleAfterMs(pollIntervalMs)
    : Number(configuredStaleAfterMs);
  if (!Number.isInteger(staleAfterMs) || staleAfterMs < 1 || staleAfterMs > 900_000) {
    throw new RangeError("COLLECTOR_HEALTH_STALE_AFTER_MS must be an integer between 1 and 900000");
  }

  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    query_timeout: 12_000,
    application_name: "cliproxyapi-monitor-collector-health"
  });

  try {
    const result = await pool.query(
      `SELECT instance.instance_id, instance.display_name, instance.enabled,
              state.state, state.lease_owner, state.lease_expires_at,
              state.last_attempt_at, state.last_success_at, state.last_event_at,
              state.last_transport, state.last_error_code, state.updated_at,
              (SELECT count(*) FROM usage_inbox inbox
               WHERE inbox.instance_id = instance.instance_id AND inbox.status = 'pending')::bigint AS pending_inbox_count,
              (SELECT count(*) FROM usage_inbox inbox
               WHERE inbox.instance_id = instance.instance_id AND inbox.status = 'processing')::bigint AS processing_inbox_count,
              (SELECT count(*) FROM usage_inbox inbox
               WHERE inbox.instance_id = instance.instance_id AND inbox.status = 'dead_letter')::bigint AS dead_letter_count
       FROM usage_collector_instances instance
       LEFT JOIN usage_collector_state state ON state.instance_id = instance.instance_id
       WHERE instance.instance_id = $1`,
      [instanceId]
    );

    const row = result.rows[0] ?? null;
    const health = evaluateCollectorHealth(row, { now: new Date(), staleAfterMs });
    let recentFullBatchCount = 0;
    if (row) {
      const attempts = await pool.query(
        `SELECT requested_count, received_count
         FROM usage_pull_attempts
         WHERE instance_id = $1 AND status = 'completed'
         ORDER BY id DESC LIMIT 5`,
        [instanceId]
      );
      recentFullBatchCount = attempts.rows.filter((attempt) => Number(attempt.received_count) >= Number(attempt.requested_count)).length;
    }

    const report = {
      ...health,
      instanceId,
      state: row?.state ?? null,
      enabled: row?.enabled ?? false,
      leaseExpiresAt: row?.lease_expires_at ?? null,
      lastAttemptAt: row?.last_attempt_at ?? null,
      lastSuccessAt: row?.last_success_at ?? null,
      lastEventAt: row?.last_event_at ?? null,
      lastTransport: row?.last_transport ?? null,
      lastErrorCode: row?.last_error_code ?? null,
      pendingInboxCount: Number(row?.pending_inbox_count ?? 0),
      processingInboxCount: Number(row?.processing_inbox_count ?? 0),
      deadLetterCount: Number(row?.dead_letter_count ?? 0),
      recentFullBatchCount,
      capacityWarning: recentFullBatchCount >= 3,
      staleAfterMs
    };
    console.log(JSON.stringify(report, null, 2));
    if (!health.healthy) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

run().catch((error) => {
  console.error(JSON.stringify({ healthy: false, status: "unavailable", reason: safeError(error) }, null, 2));
  process.exitCode = 1;
});
