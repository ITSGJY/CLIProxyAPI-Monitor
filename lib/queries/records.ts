import * as DrizzleOrm from "drizzle-orm";
import { db, databasePool } from "@/lib/db/client";
import { getCredentialErrors } from "@/lib/cpa-errors/query.mjs";
import { usageEvents, authFileMappings } from "@/lib/db/schema";
import { dashboardWhere, getDashboardFilterOptions, type DashboardFilters } from "./dashboard-common";

const { and, asc, desc, eq, sql } = DrizzleOrm as any;

export type SortField =
  | "occurredAt" | "model" | "route" | "source" | "provider" | "requestId"
  | "totalTokens" | "inputTokens" | "outputTokens" | "reasoningTokens" | "cachedTokens"
  | "cacheReadTokens" | "cacheCreationTokens" | "latencyMs" | "ttftMs" | "cost" | "isError"
  | "sessionId" | "parentSessionId" | "executionId" | "traceId" | "nodeKind" | "isFork" | "isCompaction";
export type SortOrder = "asc" | "desc";
export type SortKey = { field: SortField; order: SortOrder };
export type UsageRecordCursor = { v: 1; sort: SortKey[]; values: Array<string | number | boolean | null>; eventId: number };

function encodeCursor(value: UsageRecordCursor) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeCursor(value: string | null): UsageRecordCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (parsed?.v !== 1 || !Number.isSafeInteger(parsed.eventId) || parsed.eventId <= 0 || !Array.isArray(parsed.sort) || !Array.isArray(parsed.values) || parsed.sort.length !== parsed.values.length || parsed.sort.length === 0) return null;
    if (parsed.values.some((item: unknown) => item !== null && !["string", "number", "boolean"].includes(typeof item))) return null;
    const fields: SortField[] = [
      "occurredAt", "model", "route", "source", "provider", "requestId", "totalTokens", "inputTokens",
      "outputTokens", "reasoningTokens", "cachedTokens", "cacheReadTokens", "cacheCreationTokens",
      "latencyMs", "ttftMs", "cost", "isError", "sessionId", "parentSessionId", "executionId", "traceId", "nodeKind", "isFork", "isCompaction"
    ];
    if (parsed.sort.some((item: any) => !fields.includes(item.field) || !["asc", "desc"].includes(item.order))) return null;
    if (parsed.sort.some((item: any, index: number) => item.field === "occurredAt" && (typeof parsed.values[index] !== "string" || !Number.isFinite(new Date(parsed.values[index]).getTime())))) return null;
    return parsed;
  } catch {
    return null;
  }
}

function sortExpr(field: SortField): any {
  switch (field) {
    case "model": return usageEvents.model;
    case "route": return sql`coalesce(${usageEvents.apiKeyMask}, '')`;
    case "source": return sql`coalesce(nullif(${authFileMappings.name}, ''), nullif(${usageEvents.source}, ''), nullif(${usageEvents.authIndex}, ''), '-')`;
    case "provider": return sql`coalesce(${usageEvents.provider}, '')`;
    case "requestId": return sql`coalesce(${usageEvents.requestId}, '')`;
    case "sessionId": return sql`coalesce(${usageEvents.sessionId}, ${usageEvents.rawPayload}->>'session_id', '')`;
    case "parentSessionId": return sql`coalesce(${usageEvents.parentSessionId}, ${usageEvents.rawPayload}->>'parent_session_id', '')`;
    case "executionId": return sql`coalesce(${usageEvents.executionId}, ${usageEvents.rawPayload}->>'execution_id', '')`;
    case "traceId": return sql`coalesce(${usageEvents.traceId}, ${usageEvents.rawPayload}->>'trace_id', '')`;
    case "nodeKind": return sql`coalesce(${usageEvents.nodeKind}, ${usageEvents.rawPayload}->>'node_kind', '')`;
    case "isFork": return sql`coalesce(${usageEvents.isFork}, CASE lower(coalesce(${usageEvents.rawPayload}->>'is_fork', '')) WHEN 'true' THEN true WHEN '1' THEN true WHEN 'yes' THEN true WHEN 'false' THEN false WHEN '0' THEN false WHEN 'no' THEN false ELSE false END)`;
    case "isCompaction": return sql`coalesce(${usageEvents.isCompaction}, CASE lower(coalesce(${usageEvents.rawPayload}->>'is_compaction', '')) WHEN 'true' THEN true WHEN '1' THEN true WHEN 'yes' THEN true WHEN 'false' THEN false WHEN '0' THEN false WHEN 'no' THEN false ELSE false END)`;
    case "totalTokens": return usageEvents.totalTokens;
    case "inputTokens": return usageEvents.inputTokens;
    case "outputTokens": return usageEvents.outputTokens;
    case "reasoningTokens": return usageEvents.reasoningTokens;
    case "cachedTokens": return usageEvents.cachedTokens;
    case "cacheReadTokens": return usageEvents.cacheReadTokens;
    case "cacheCreationTokens": return usageEvents.cacheCreationTokens;
    case "latencyMs": return sql`coalesce(${usageEvents.latencyMs}, -1)`;
    case "ttftMs": return sql`coalesce(${usageEvents.ttftMs}, -1)`;
    case "cost": return sql`coalesce(${usageEvents.costNanos}, -1)`;
    case "isError": return usageEvents.isError;
    default: return usageEvents.occurredAt;
  }
}

function cursorValueFor(key: SortKey, row: any): string | number | boolean | null {
  switch (key.field) {
    case "occurredAt": return row.occurredAt;
    case "route": return row.route ?? "";
    case "source": return row.credentialName ?? "-";
    case "provider": return row.provider ?? "";
    case "requestId": return row.requestId ?? "";
    case "sessionId": return row.sessionId ?? "";
    case "parentSessionId": return row.parentSessionId ?? "";
    case "executionId": return row.executionId ?? "";
    case "traceId": return row.traceId ?? "";
    case "nodeKind": return row.nodeKind ?? "";
    case "isFork": return row.isFork ?? false;
    case "isCompaction": return row.isCompaction ?? false;
    case "latencyMs": return row.latencyMs ?? -1;
    case "ttftMs": return row.ttftMs ?? -1;
    case "cost": return row.costNanos ?? -1;
    default: return row[key.field] ?? 0;
  }
}

function toRecordItem(row: any) {
  return {
    ...row,
    occurredAt: row.occurredAt instanceof Date ? row.occurredAt.toISOString() : row.occurredAt,
    cost: row.costNanos == null ? null : Number(row.costNanos) / 1_000_000_000
  };
}

const listSelection = {
  id: usageEvents.eventId,
  occurredAt: usageEvents.occurredAt,
  route: sql<string>`coalesce(${usageEvents.apiKeyMask}, '')`,
  source: usageEvents.source,
  credentialName: sql<string>`coalesce(nullif(${authFileMappings.name}, ''), nullif(${usageEvents.source}, ''), nullif(${usageEvents.authIndex}, ''), '-')`,
  provider: usageEvents.provider,
  apiGroupLabel: usageEvents.apiGroupLabel,
  endpoint: usageEvents.endpoint,
  requestId: usageEvents.requestId,
  sessionId: sql<string | null>`coalesce(${usageEvents.sessionId}, ${usageEvents.rawPayload}->>'session_id')`,
  parentSessionId: sql<string | null>`coalesce(${usageEvents.parentSessionId}, ${usageEvents.rawPayload}->>'parent_session_id')`,
  executionId: sql<string | null>`coalesce(${usageEvents.executionId}, ${usageEvents.rawPayload}->>'execution_id')`,
  traceId: sql<string | null>`coalesce(${usageEvents.traceId}, ${usageEvents.rawPayload}->>'trace_id')`,
  nodeKind: sql<string | null>`coalesce(${usageEvents.nodeKind}, ${usageEvents.rawPayload}->>'node_kind')`,
  isFork: sql<boolean | null>`coalesce(${usageEvents.isFork}, CASE lower(coalesce(${usageEvents.rawPayload}->>'is_fork', '')) WHEN 'true' THEN true WHEN '1' THEN true WHEN 'yes' THEN true WHEN 'false' THEN false WHEN '0' THEN false WHEN 'no' THEN false ELSE NULL END)`,
  isCompaction: sql<boolean | null>`coalesce(${usageEvents.isCompaction}, CASE lower(coalesce(${usageEvents.rawPayload}->>'is_compaction', '')) WHEN 'true' THEN true WHEN '1' THEN true WHEN 'yes' THEN true WHEN 'false' THEN false WHEN '0' THEN false WHEN 'no' THEN false ELSE NULL END)`,
  authType: usageEvents.authType,
  stream: usageEvents.stream,
  generate: usageEvents.generate,
  modelAlias: usageEvents.modelAlias,
  responseModel: usageEvents.responseModel,
  modelSubstituted: usageEvents.modelSubstituted,
  reasoningEffort: usageEvents.reasoningEffort,
  executorType: usageEvents.executorType,
  accessProvider: usageEvents.accessProvider,
  isNativeKey: usageEvents.isNativeKey,
  model: usageEvents.model,
  totalTokens: usageEvents.totalTokens,
  inputTokens: usageEvents.inputTokens,
  outputTokens: usageEvents.outputTokens,
  reasoningTokens: usageEvents.reasoningTokens,
  cachedTokens: usageEvents.cachedTokens,
  cacheReadTokens: usageEvents.cacheReadTokens,
  cacheCreationTokens: usageEvents.cacheCreationTokens,
  latencyMs: usageEvents.latencyMs,
  ttftMs: usageEvents.ttftMs,
  serviceTier: sql<string | null>`coalesce(${usageEvents.effectiveServiceTier}, ${usageEvents.billedServiceTier}, ${usageEvents.serviceTier})`,
  statusCode: usageEvents.statusCode,
  failCode: usageEvents.failCode,
  isError: usageEvents.isError,
  costNanos: usageEvents.costNanos,
  costCurrency: usageEvents.costCurrency,
  pricingStatus: usageEvents.pricingStatus,
  priceVersionId: usageEvents.priceVersionId
};

export async function getUsageRecords(input: DashboardFilters & {
  limit?: number; sortKeys?: SortKey[]; sortField?: SortField; sortOrder?: SortOrder;
  cursor?: string | null; includeFilters?: boolean;
}) {
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 50), 1), 200);
  const rawSortKeys = (input.sortKeys?.length ? input.sortKeys : [{ field: input.sortField ?? "occurredAt", order: input.sortOrder ?? "desc" }]) as SortKey[];
  const seenSortFields = new Set<SortField>();
  const sortKeys = rawSortKeys.filter((key) => {
    if (seenSortFields.has(key.field)) return false;
    seenSortFields.add(key.field);
    return true;
  });
  const primary = sortKeys[0];
  const cursor = decodeCursor(input.cursor ?? null);
  if (input.cursor && (!cursor || JSON.stringify(cursor.sort) !== JSON.stringify(sortKeys))) throw new Error("Invalid or mismatched records cursor");

  const whereParts: any[] = [dashboardWhere(input)];
  if (cursor) {
    const clauses: any[] = [];
    const equalPrefix: any[] = [];
    for (let index = 0; index < sortKeys.length; index += 1) {
      const key = sortKeys[index];
      const expression = sortExpr(key.field);
      const op = key.order === "asc" ? sql`>` : sql`<`;
      const rawValue = cursor.values[index];
      const value = key.field === "occurredAt" ? new Date(String(rawValue)) : rawValue;
      clauses.push(and(...equalPrefix, sql`${expression} ${op} ${value}`));
      equalPrefix.push(sql`${expression} = ${value}`);
    }
    const tieOp = primary.order === "asc" ? sql`>` : sql`<`;
    clauses.push(and(...equalPrefix, sql`${usageEvents.eventId} ${tieOp} ${cursor.eventId}`));
    whereParts.push(DrizzleOrm.or(...clauses));
  }

  const where = and(...whereParts.filter(Boolean));
  const ordering = sortKeys.map((key) => key.order === "asc" ? asc(sortExpr(key.field)) : desc(sortExpr(key.field)));
  ordering.push(primary.order === "asc" ? asc(usageEvents.eventId) : desc(usageEvents.eventId));
  const rows = await db.select(listSelection)
    .from(usageEvents)
    .leftJoin(authFileMappings, eq(usageEvents.authIndex, authFileMappings.authId))
    .where(where)
    .orderBy(...ordering)
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(toRecordItem);
  let nextCursor: string | null = null;
  if (hasMore && items.length) {
    const last = items[items.length - 1];
    nextCursor = encodeCursor({ v: 1, sort: sortKeys, values: sortKeys.map((key) => cursorValueFor(key, last)), eventId: last.id });
  }
  const filters = input.includeFilters ? await getDashboardFilterOptions(input) : undefined;
  return {
    items,
    nextCursor,
    filters: filters ? { models: filters.models, routes: filters.routes, sources: filters.names, providers: filters.providers, serviceTiers: filters.serviceTiers } : undefined
  };
}

export async function getUsageRecordDetails(eventId: number) {
  const rows = await db.select({
    ...listSelection,
    ingestedAt: usageEvents.ingestedAt,
    sourceInstanceId: usageEvents.sourceInstanceId,
    authIndex: usageEvents.authIndex,
    originSystem: usageEvents.originSystem,
    sourceTransport: usageEvents.sourceTransport,
    sourceNativeId: usageEvents.sourceNativeId,
    sourceEventKey: usageEvents.sourceEventKey,
    apiGroupKey: usageEvents.apiGroupKey,
    apiKeyMask: usageEvents.apiKeyMask,
    clientIp: usageEvents.clientIp,
    xForwardedFor: usageEvents.xForwardedFor,
    userAgent: usageEvents.userAgent,
    sessionId: sql<string | null>`coalesce(${usageEvents.sessionId}, ${usageEvents.rawPayload}->>'session_id')`,
    parentSessionId: sql<string | null>`coalesce(${usageEvents.parentSessionId}, ${usageEvents.rawPayload}->>'parent_session_id')`,
    executionId: sql<string | null>`coalesce(${usageEvents.executionId}, ${usageEvents.rawPayload}->>'execution_id')`,
    traceId: sql<string | null>`coalesce(${usageEvents.traceId}, ${usageEvents.rawPayload}->>'trace_id')`,
    nodeKind: sql<string | null>`coalesce(${usageEvents.nodeKind}, ${usageEvents.rawPayload}->>'node_kind')`,
    isFork: sql<boolean | null>`coalesce(${usageEvents.isFork}, CASE lower(coalesce(${usageEvents.rawPayload}->>'is_fork', '')) WHEN 'true' THEN true WHEN '1' THEN true WHEN 'yes' THEN true WHEN 'false' THEN false WHEN '0' THEN false WHEN 'no' THEN false ELSE NULL END)`,
    isCompaction: sql<boolean | null>`coalesce(${usageEvents.isCompaction}, CASE lower(coalesce(${usageEvents.rawPayload}->>'is_compaction', '')) WHEN 'true' THEN true WHEN '1' THEN true WHEN 'yes' THEN true WHEN 'false' THEN false WHEN '0' THEN false WHEN 'no' THEN false ELSE NULL END)`,
    responseServiceTier: usageEvents.responseServiceTier,
    effectiveServiceTier: usageEvents.effectiveServiceTier,
    billedServiceTier: usageEvents.billedServiceTier,
    billedServiceTierSource: usageEvents.billedServiceTierSource,
    failBody: usageEvents.failBody,
    responseHeaders: usageEvents.responseHeaders,
    tokenAccounting: usageEvents.tokenAccounting,
    accountingStatus: sql<string | null>`${usageEvents.tokenAccounting}->>'status'`,
    structuredUsage: usageEvents.structuredUsage,
    rawPayload: usageEvents.rawPayload,
    resourceId: sql<string | null>`coalesce(${usageEvents.rawPayload}->>'resource_id', ${usageEvents.rawPayload}->>'resourceId')`,
    resourceName: sql<string | null>`coalesce(${usageEvents.rawPayload}->>'resource_name', ${usageEvents.rawPayload}->>'resourceName')`,
    sourcePriceVersionId: usageEvents.sourcePriceVersionId,
    channelVersionId: usageEvents.channelVersionId,
    priceTierIndex: usageEvents.priceTierIndex,
    resolvedServiceTier: usageEvents.resolvedServiceTier,
    pricingPolicyVersion: usageEvents.pricingPolicyVersion,
    costBreakdown: usageEvents.costBreakdown,
    createdAt: usageEvents.createdAt
  })
    .from(usageEvents)
    .leftJoin(authFileMappings, eq(usageEvents.authIndex, authFileMappings.authId))
    .where(eq(usageEvents.eventId, eventId))
    .limit(1);
  if (!rows.length) return null;
  const evidence = await getCredentialErrors(databasePool, rows[0], {
    configured: process.env.ERROR_COLLECTOR_ENABLED === undefined ? undefined : process.env.ERROR_COLLECTOR_ENABLED === "true"
  });
  const { authIndex: _authIndex, ...record } = rows[0];
  return { ...toRecordItem(record), credentialErrors: evidence };
}

export async function getUsageRecordsForExport(input: DashboardFilters, limit = 20000) {
  const rows = await db.select({
    ...listSelection,
    apiGroupKey: usageEvents.apiGroupKey,
    sessionId: sql<string | null>`coalesce(${usageEvents.sessionId}, ${usageEvents.rawPayload}->>'session_id')`,
    parentSessionId: sql<string | null>`coalesce(${usageEvents.parentSessionId}, ${usageEvents.rawPayload}->>'parent_session_id')`,
    executionId: sql<string | null>`coalesce(${usageEvents.executionId}, ${usageEvents.rawPayload}->>'execution_id')`,
    traceId: sql<string | null>`coalesce(${usageEvents.traceId}, ${usageEvents.rawPayload}->>'trace_id')`,
    nodeKind: sql<string | null>`coalesce(${usageEvents.nodeKind}, ${usageEvents.rawPayload}->>'node_kind')`,
    isFork: sql<boolean | null>`coalesce(${usageEvents.isFork}, CASE lower(coalesce(${usageEvents.rawPayload}->>'is_fork', '')) WHEN 'true' THEN true WHEN '1' THEN true WHEN 'yes' THEN true WHEN 'false' THEN false WHEN '0' THEN false WHEN 'no' THEN false ELSE NULL END)`,
    isCompaction: sql<boolean | null>`coalesce(${usageEvents.isCompaction}, CASE lower(coalesce(${usageEvents.rawPayload}->>'is_compaction', '')) WHEN 'true' THEN true WHEN '1' THEN true WHEN 'yes' THEN true WHEN 'false' THEN false WHEN '0' THEN false WHEN 'no' THEN false ELSE NULL END)`,
    responseServiceTier: usageEvents.responseServiceTier,
    effectiveServiceTier: usageEvents.effectiveServiceTier,
    billedServiceTier: usageEvents.billedServiceTier,
    billedServiceTierSource: usageEvents.billedServiceTierSource,
    statusCode: usageEvents.statusCode,
    failCode: usageEvents.failCode,
    failBody: usageEvents.failBody,
    responseHeaders: usageEvents.responseHeaders,
    tokenAccounting: usageEvents.tokenAccounting,
    structuredUsage: usageEvents.structuredUsage,
    priceVersionId: usageEvents.priceVersionId
  })
    .from(usageEvents)
    .leftJoin(authFileMappings, eq(usageEvents.authIndex, authFileMappings.authId))
    .where(dashboardWhere(input))
    .orderBy(desc(usageEvents.occurredAt), desc(usageEvents.eventId))
    .limit(limit + 1);
  const truncated = rows.length > limit;
  return { items: (truncated ? rows.slice(0, limit) : rows).map(toRecordItem), truncated, limit };
}
