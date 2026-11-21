export type ModelPrice = {
  model: string;
  inputPricePer1M: number;
  cachedInputPricePer1M: number;
  outputPricePer1M: number;
};

export type ModelUsage = {
  model: string;
  requests: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
};

export type UsageSeriesPoint = {
  label: string;
  requests: number;
  errors?: number;
  tokens: number;
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  timestamp?: string;
};

export type UsageOverview = {
  totalRequests: number;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  totalCachedTokens: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  totalCost: number | null;
  models: ModelUsage[];
  byDay: UsageSeriesPoint[];
  byHour: UsageSeriesPoint[];
};
export type ErrorCoverageStatus = "disabled" | "not_configured" | "connecting" | "disconnected" | "degraded" |
  "collecting" | "complete" | "partial" | "historical_import" | "not_correlatable" | "query_failed";

export type CredentialErrorEvent = {
  id: string;
  occurred_at: string;
  received_at: string;
  provider: string | null;
  model: string | null;
  status_code: number | null;
  code: string | null;
  body: string | null;
  retryable: boolean | null;
  auth_status: unknown;
  quota_exceeded: boolean | null;
  quota_reason: string | null;
  next_retry_after: string | null;
  next_recover_at: string | null;
  backoff_level: number | null;
  cooldown_model: string | null;
  model_quota_exceeded: boolean | null;
  model_quota_reason: string | null;
  model_next_retry_after: string | null;
  model_next_recover_at: string | null;
  model_backoff_level: number | null;
  auth_quota_aggregate: boolean | null;
  model_quota_inherited: boolean | null;
  origin_system: string;
  source_transport: string;
  time_delta_ms: number;
  provider_match: boolean;
  model_match: boolean;
  attribution: "credential_time_window";
};

export type CredentialErrorEvidence = {
  attribution: "credential_time_window";
  window_ms: number;
  limit: number;
  events: CredentialErrorEvent[];
  coverage: {
    status: ErrorCoverageStatus;
    complete: boolean;
    window_start?: string;
    window_end?: string;
    window_closed?: boolean;
    gaps: { from: string; to: string }[];
    historical_available?: boolean;
    reason: string | null;
  };
};
