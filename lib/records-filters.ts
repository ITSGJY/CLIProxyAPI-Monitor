import type { DashboardFilters } from "@/lib/queries/dashboard-common";

export class RecordsFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordsFilterError";
  }
}

function text(params: URLSearchParams, key: string, maxLength = 512): string | null {
  const value = params.get(key)?.trim() ?? "";
  if (!value) return null;
  if (value.length > maxLength) throw new RecordsFilterError(`Filter "${key}" is too long`);
  return value;
}

function number(params: URLSearchParams, key: string): number | null {
  const raw = params.get(key);
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new RecordsFilterError(`Filter "${key}" must be a non-negative number`);
  return value;
}

export function parseRecordsFilters(params: URLSearchParams): DashboardFilters {
  const statusValue = text(params, "status", 16);
  if (statusValue && statusValue !== "success" && statusValue !== "error") {
    throw new RecordsFilterError("Invalid status filter");
  }
  const costStatusValue = text(params, "costStatus", 16);
  if (costStatusValue && costStatusValue !== "priced" && costStatusValue !== "unpriced") {
    throw new RecordsFilterError("Invalid cost status filter");
  }

  const start = text(params, "start", 64);
  const end = text(params, "end", 64);
  if (start && !Number.isFinite(new Date(start).getTime())) throw new RecordsFilterError("Invalid start date");
  if (end && !Number.isFinite(new Date(end).getTime())) throw new RecordsFilterError("Invalid end date");

  const latencyMin = number(params, "latencyMin");
  const latencyMax = number(params, "latencyMax");
  const tokensMin = number(params, "tokensMin");
  const tokensMax = number(params, "tokensMax");
  const statusCode = number(params, "statusCode");
  if (latencyMin !== null && latencyMax !== null && latencyMin > latencyMax) throw new RecordsFilterError("Latency minimum cannot exceed maximum");
  if (tokensMin !== null && tokensMax !== null && tokensMin > tokensMax) throw new RecordsFilterError("Token minimum cannot exceed maximum");
  if (statusCode !== null && (!Number.isInteger(statusCode) || statusCode > 599)) throw new RecordsFilterError("Invalid HTTP status code");

  return {
    start,
    end,
    model: text(params, "model"),
    route: text(params, "route"),
    source: text(params, "source"),
    provider: text(params, "provider"),
    serviceTier: text(params, "serviceTier"),
    status: statusValue as "success" | "error" | null,
    currency: text(params, "currency", 8)?.toUpperCase() ?? null,
    q: text(params, "q", 256),
    requestId: text(params, "requestId"),
    endpoint: text(params, "endpoint"),
    authType: text(params, "authType", 128),
    executorType: text(params, "executorType", 128),
    reasoningEffort: text(params, "reasoningEffort", 128),
    modelAlias: text(params, "modelAlias"),
    responseModel: text(params, "responseModel"),
    apiGroupLabel: text(params, "apiGroupLabel", 128),
    statusCode,
    latencyMin,
    latencyMax,
    tokensMin,
    tokensMax,
    costStatus: costStatusValue as "priced" | "unpriced" | null
  };
}
