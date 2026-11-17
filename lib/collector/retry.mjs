export const MAX_PULL_BACKOFF_MS = 30_000;

export function getPullBackoffMs(consecutiveFailures, pollIntervalMs) {
  const failures = Math.max(1, Math.min(Math.trunc(Number(consecutiveFailures) || 1), 5));
  const interval = Math.max(1, Math.trunc(Number(pollIntervalMs) || 1));
  return Math.min(MAX_PULL_BACKOFF_MS, interval * (2 ** failures));
}
