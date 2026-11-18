import * as DrizzleOrm from "drizzle-orm";
import { db } from "@/lib/db/client";
import { usageEvents, authFileMappings } from "@/lib/db/schema";
import { dashboardWhere, getDashboardFilterOptions, type DashboardFilters } from "./dashboard-common";

const { and, asc, desc, eq, sql } = DrizzleOrm as any;

type SortField = "occurredAt" | "model" | "route" | "source" | "totalTokens" | "inputTokens" | "outputTokens" | "reasoningTokens" | "cachedTokens" | "cost" | "isError";
type SortOrder = "asc" | "desc";
export type SortKey = { field: SortField; order: SortOrder };
export type UsageRecordCursor = { v: 1; sort: SortKey[]; values: Array<string | number | boolean | null>; eventId: number };

function encodeCursor(value: UsageRecordCursor) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function decodeCursor(value: string | null): UsageRecordCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (parsed?.v !== 1 || !Number.isSafeInteger(parsed.eventId) || parsed.eventId <= 0 || !Array.isArray(parsed.sort) || !Array.isArray(parsed.values) || parsed.sort.length !== parsed.values.length || parsed.sort.length === 0) return null;
    if (parsed.values.some((value: unknown) => value !== null && !["string", "number", "boolean"].includes(typeof value))) return null;
    const fields = ["occurredAt", "model", "route", "source", "totalTokens", "inputTokens", "outputTokens", "reasoningTokens", "cachedTokens", "cost", "isError"];
    if (parsed.sort.some((item: any) => !fields.includes(item.field) || !["asc", "desc"].includes(item.order))) return null;
    if (parsed.sort.some((item: any, index: number) => item.field === "occurredAt" && (typeof parsed.values[index] !== "string" || !Number.isFinite(new Date(parsed.values[index]).getTime())))) return null;
    return parsed;
  } catch { return null; }
}

function sortExpr(field: SortField): any {
  switch (field) {
    case "model": return usageEvents.model;
    case "route": return sql`coalesce(${usageEvents.apiKeyMask}, '')`;
    case "source": return sql`coalesce(nullif(${authFileMappings.name}, ''), nullif(${usageEvents.source}, ''), nullif(${usageEvents.authIndex}, ''), '-')`;
    case "totalTokens": return usageEvents.totalTokens;
    case "inputTokens": return usageEvents.inputTokens;
    case "outputTokens": return usageEvents.outputTokens;
    case "reasoningTokens": return usageEvents.reasoningTokens;
    case "cachedTokens": return usageEvents.cachedTokens;
    case "cost": return sql`coalesce(${usageEvents.costNanos}, -1)`;
    case "isError": return usageEvents.isError;
    default: return usageEvents.occurredAt;
  }
}

export async function getUsageRecords(input: DashboardFilters & {
  limit?: number; sortKeys?: SortKey[]; sortField?: SortField; sortOrder?: SortOrder;
  cursor?: string | null; includeFilters?: boolean;
}) {
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 50), 1), 200);
  const rawSortKeys = (input.sortKeys?.length ? input.sortKeys : [{ field: input.sortField ?? "occurredAt", order: input.sortOrder ?? "desc" }]) as SortKey[];
  const seenSortFields = new Set<SortField>();
  const sortKeys = rawSortKeys.filter((key) => { if (seenSortFields.has(key.field)) return false; seenSortFields.add(key.field); return true; });
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
  const rows = await db.select({
    id: usageEvents.eventId,
    occurredAt: usageEvents.occurredAt,
    route: sql`coalesce(${usageEvents.apiKeyMask}, '')`,
    source: usageEvents.source,
    credentialName: sql<string>`coalesce(nullif(${authFileMappings.name}, ''), nullif(${usageEvents.source}, ''), nullif(${usageEvents.authIndex}, ''), '-')`,
    provider: usageEvents.provider,
    endpoint: usageEvents.endpoint,
    requestId: usageEvents.requestId,
    authType: usageEvents.authType,
    stream: usageEvents.stream,
    generate: usageEvents.generate,
    modelAlias: usageEvents.modelAlias,
    responseModel: usageEvents.responseModel,
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
  }).from(usageEvents).leftJoin(authFileMappings, eq(usageEvents.authIndex, authFileMappings.authId)).where(where).orderBy(...ordering).limit(limit + 1);
  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map((row: any) => ({ ...row, occurredAt: row.occurredAt.toISOString(), cost: row.costNanos == null ? null : Number(row.costNanos) / 1_000_000_000 }));
  let nextCursor: string | null = null;
  if (hasMore && items.length) {
    const last: any = items[items.length - 1];
    const values = sortKeys.map((key) => key.field === "occurredAt" ? last.occurredAt : key.field === "route" ? last.route : key.field === "source" ? last.credentialName : key.field === "cost" ? (last.costNanos ?? -1) : last[key.field]);
    nextCursor = encodeCursor({ v: 1, sort: sortKeys, values, eventId: last.id });
  }
  const filters = input.includeFilters ? await getDashboardFilterOptions(input) : undefined;
  return { items, nextCursor, filters: filters ? { models: filters.models, routes: filters.routes, sources: filters.names, providers: filters.providers, serviceTiers: filters.serviceTiers } : undefined };
}
