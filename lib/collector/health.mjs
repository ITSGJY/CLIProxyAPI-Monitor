function toMillis(value) {
  if (value === null || value === undefined) return null;
  const millis = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(millis) ? millis : null;
}

export function getCollectorHealthStaleAfterMs(pollIntervalMs = 10_000) {
  const interval = Number(pollIntervalMs);
  if (!Number.isFinite(interval) || interval < 1) {
    throw new RangeError("pollIntervalMs must be a positive number");
  }
  return Math.max(60_000, interval * 3);
}

export function countRecentFullPullBatches(attempts = []) {
  if (!Array.isArray(attempts)) throw new TypeError("attempts must be an array");
  return attempts.filter((attempt) => {
    if (!new Set(["resp", "http"]).has(attempt?.transport)) return false;
    const requestedCount = Number(attempt.requested_count);
    const receivedCount = Number(attempt.received_count);
    return Number.isFinite(requestedCount) && requestedCount > 0
      && Number.isFinite(receivedCount) && receivedCount >= requestedCount;
  }).length;
}

export function evaluateCollectorHealth(row, options = {}) {
  const now = options.now instanceof Date ? options.now.getTime() : Number(options.now ?? Date.now());
  const staleAfterMs = Number(options.staleAfterMs ?? 60_000);

  if (!Number.isFinite(now) || !Number.isFinite(staleAfterMs) || staleAfterMs < 1) {
    throw new RangeError("Collector health evaluation requires a valid clock and positive stale threshold");
  }
  if (!row) return { healthy: false, status: "missing", reason: "collector_not_registered" };

  if (row.state === "paused") {
    return { healthy: false, status: "paused", reason: "collector_paused" };
  }
  const lastErrorCode = row.lastErrorCode ?? row.last_error_code ?? null;
  if (lastErrorCode || row.state === "degraded") {
    return { healthy: false, status: "degraded", reason: lastErrorCode ?? "collector_degraded" };
  }
  if (!row.enabled) {
    return { healthy: false, status: "stopped", reason: "collector_disabled" };
  }

  const leaseExpiresAt = toMillis(row.leaseExpiresAt ?? row.lease_expires_at);
  if (leaseExpiresAt === null || leaseExpiresAt <= now) {
    return { healthy: false, status: "stale", reason: "collector_lease_expired" };
  }

  const updatedAt = toMillis(row.updatedAt ?? row.updated_at);
  if (updatedAt === null || now - updatedAt > staleAfterMs) {
    return { healthy: false, status: "stale", reason: "collector_heartbeat_stale" };
  }

  const lastSuccessAt = toMillis(row.lastSuccessAt ?? row.last_success_at);
  if (lastSuccessAt === null) {
    return { healthy: false, status: "starting", reason: "no_successful_pull_yet" };
  }
  if (now - lastSuccessAt > staleAfterMs) {
    return { healthy: false, status: "stale", reason: "last_successful_pull_stale" };
  }

  if (!new Set(["checking", "receiving"]).has(row.state)) {
    return { healthy: false, status: "unhealthy", reason: "unexpected_collector_state" };
  }

  return { healthy: true, status: "healthy", reason: null };
}
