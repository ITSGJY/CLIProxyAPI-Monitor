const ms = (value) => value === null || value === undefined ? NaN : new Date(value).getTime();

export function normalizeErrorWindowMs(value) {
  return Number.isSafeInteger(value) && value >= 1000 && value <= 600000 ? value : 120000;
}

export function evaluateErrorHealth(state, session, now = Date.now()) {
  if (!state) return { healthy: false, status: "not_configured" };
  if (!state.enabled || state.state === "disabled") return { healthy: false, status: "disabled" };
  if (ms(state.lease_expires_at) <= now || !Number.isFinite(ms(state.lease_expires_at)) || !Number.isFinite(ms(state.heartbeat_at)) || now - ms(state.heartbeat_at) > 20000) return { healthy: false, status: "disconnected" };
  if (state.state !== "collecting") return { healthy: false, status: state.state === "connecting" ? "connecting" : state.state === "degraded" ? "degraded" : "disconnected" };
  if (!session || session.ended_at || !Number.isFinite(ms(session.coverage_through)) || now - ms(session.coverage_through) > 20000) return { healthy: false, status: "degraded" };
  return { healthy: true, status: "collecting" };
}

export function errorCoverage({ occurredAt, state, sessions = [], imports = [], now = Date.now(), configured, windowMs }) {
  const effectiveWindowMs = normalizeErrorWindowMs(windowMs);
  const center = ms(occurredAt), start = center - effectiveWindowMs, end = center + effectiveWindowMs;
  const active = sessions.find((s) => !s.ended_at && s.subscribed_at);
  const health = evaluateErrorHealth(state, active, now);
  const observedEnd = Math.min(end, now);
  const intervals = sessions.filter((s) => s.subscribed_at && s.coverage_through)
    .map((s) => [Math.max(start, ms(s.subscribed_at)), Math.min(observedEnd, ms(s.coverage_through), s.ended_at ? ms(s.ended_at) : Infinity)])
    .filter(([a, b]) => b >= a).sort((a, b) => a[0] - b[0]);
  let cursor = start;
  const gaps = [];
  for (const [from, to] of intervals) {
    if (from > cursor) gaps.push({ from: new Date(cursor).toISOString(), to: new Date(from).toISOString() });
    cursor = Math.max(cursor, to);
  }
  const pendingTail = health.healthy && end > now && cursor >= ms(active.subscribed_at) && cursor >= now - 20000;
  if (cursor < observedEnd && !pendingTail) gaps.push({ from: new Date(cursor).toISOString(), to: new Date(observedEnd).toISOString() });
  const complete = end <= now && cursor >= end && gaps.length === 0;
  const historical = imports.some((r) => r.status === "completed" && ms(r.min_occurred_at) <= end && ms(r.max_occurred_at) >= start);
  const unavailable = imports.some((r) => r.status === "unavailable");
  let status;
  if (complete) status = "complete";
  else if (historical) status = "historical_import";
  else if (configured === false || health.status === "disabled") status = "disabled";
  else if (!state) status = configured ? "connecting" : unavailable || imports.length ? "partial" : "not_configured";
  else if (health.status !== "collecting") status = health.status;
  else if (gaps.length) status = "partial";
  else status = "collecting";
  return { status, complete, window_ms: effectiveWindowMs, window_start: new Date(start).toISOString(), window_end: new Date(end).toISOString(),
    window_closed: end <= now, gaps, historical_available: historical,
    reason: complete ? null : historical ? "historical_snapshot_does_not_prove_continuous_capture" : unavailable ? "source_error_table_unavailable" : "window_not_fully_observed" };
}
