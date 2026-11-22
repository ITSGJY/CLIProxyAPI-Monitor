export type UsageMetricsRecord = {
  inputTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  cachedTokens?: number | null;
  cacheReadTokens?: number | null;
  totalTokens?: number | null;
  latencyMs?: number | null;
  generate?: boolean | null;
  accountingStatus?: string | null;
  tokenAccounting?: unknown;
};

const TRUSTED_ACCOUNTING_STATUSES = new Set([
  "complete",
  "valid",
  "canonical",
  "verified",
  "reconciled",
  "exact",
  "legacy"
]);

function tokenAccountingStatus(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = (value as Record<string, unknown>).status;
  return typeof status === "string" ? status : null;
}

export function calculateCacheRate(record: UsageMetricsRecord): number | null {
  const cached = Math.max(0, record.cacheReadTokens || record.cachedTokens || 0);
  if (cached <= 0) return 0;
  let prompt = Math.max(0, record.inputTokens || ((record.totalTokens ?? 0) - (record.outputTokens ?? 0)));
  if (prompt <= 0 && (record.totalTokens ?? 0) > 0) prompt = record.totalTokens ?? 0;
  const denominator = cached > prompt ? prompt + cached : prompt;
  return denominator > 0 ? Math.min(100, Math.max(0, cached / denominator * 100)) : null;
}

export function calculateOutputRate(record: UsageMetricsRecord): number | null {
  const status = String(record.accountingStatus ?? tokenAccountingStatus(record.tokenAccounting) ?? "legacy").toLowerCase();
  if (record.generate === false || !TRUSTED_ACCOUNTING_STATUSES.has(status)) return null;
  if (!record.latencyMs || record.latencyMs <= 0 || !record.outputTokens || record.outputTokens <= 0) return null;
  const rate = record.outputTokens * 1000 / record.latencyMs;
  return Number.isFinite(rate) ? rate : null;
}
