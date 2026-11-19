import * as DrizzleOrm from "drizzle-orm";
import { db } from "@/lib/db/client";
import { usageEvents } from "@/lib/db/schema";

const { and, eq, gte, lte, lt, or, sql } = DrizzleOrm as any;

export type DashboardFilters = {
  start?: string | null;
  end?: string | null;
  model?: string | null;
  route?: string | null;
  source?: string | null;
  name?: string | null;
  provider?: string | null;
  serviceTier?: string | null;
  status?: "success" | "error" | null;
  currency?: string | null;
  q?: string | null;
  requestId?: string | null;
  endpoint?: string | null;
  authType?: string | null;
  executorType?: string | null;
  reasoningEffort?: string | null;
  modelAlias?: string | null;
  responseModel?: string | null;
  apiGroupLabel?: string | null;
  statusCode?: number | null;
  latencyMin?: number | null;
  latencyMax?: number | null;
  tokensMin?: number | null;
  tokensMax?: number | null;
  costStatus?: "priced" | "unpriced" | null;
};

export function dashboardWhere(filters: DashboardFilters = {}) {
  const parts: any[] = [];
  const start = filters.start ? new Date(filters.start) : null;
  const end = filters.end ? new Date(filters.end) : null;
  if (start && Number.isFinite(start.getTime())) parts.push(gte(usageEvents.occurredAt, start));
  if (end && Number.isFinite(end.getTime())) parts.push(lt(usageEvents.occurredAt, end));
  if (filters.model) parts.push(eq(usageEvents.model, filters.model));
  if (filters.route) parts.push(eq(usageEvents.apiKeyMask, filters.route));

  const credentialLabel = sql<string>`coalesce((select nullif(af.name, '') from auth_file_mappings af where af.auth_id = ${usageEvents.authIndex} limit 1), nullif(${usageEvents.source}, ''), nullif(${usageEvents.authIndex}, ''), '-')`;
  if (filters.source || filters.name) parts.push(sql`${credentialLabel} = ${filters.source ?? filters.name}`);
  if (filters.provider) parts.push(eq(usageEvents.provider, filters.provider));
  if (filters.serviceTier) parts.push(sql`coalesce(${usageEvents.effectiveServiceTier}, ${usageEvents.billedServiceTier}, ${usageEvents.serviceTier}, '') = ${filters.serviceTier}`);
  if (filters.status === "error") parts.push(eq(usageEvents.isError, true));
  if (filters.status === "success") parts.push(eq(usageEvents.isError, false));
  if (filters.currency) parts.push(eq(usageEvents.costCurrency, filters.currency));

  if (filters.requestId) parts.push(eq(usageEvents.requestId, filters.requestId));
  if (filters.endpoint) parts.push(eq(usageEvents.endpoint, filters.endpoint));
  if (filters.authType) parts.push(eq(usageEvents.authType, filters.authType));
  if (filters.executorType) parts.push(eq(usageEvents.executorType, filters.executorType));
  if (filters.reasoningEffort) parts.push(eq(usageEvents.reasoningEffort, filters.reasoningEffort));
  if (filters.modelAlias) parts.push(eq(usageEvents.modelAlias, filters.modelAlias));
  if (filters.responseModel) parts.push(eq(usageEvents.responseModel, filters.responseModel));
  if (filters.apiGroupLabel) parts.push(eq(usageEvents.apiGroupLabel, filters.apiGroupLabel));
  if (filters.statusCode !== undefined && filters.statusCode !== null) parts.push(eq(usageEvents.statusCode, filters.statusCode));
  if (filters.latencyMin !== undefined && filters.latencyMin !== null) parts.push(gte(usageEvents.latencyMs, filters.latencyMin));
  if (filters.latencyMax !== undefined && filters.latencyMax !== null) parts.push(lte(usageEvents.latencyMs, filters.latencyMax));
  if (filters.tokensMin !== undefined && filters.tokensMin !== null) parts.push(gte(usageEvents.totalTokens, filters.tokensMin));
  if (filters.tokensMax !== undefined && filters.tokensMax !== null) parts.push(lte(usageEvents.totalTokens, filters.tokensMax));
  if (filters.costStatus === "priced") parts.push(eq(usageEvents.pricingStatus, "priced"));
  if (filters.costStatus === "unpriced") parts.push(sql`${usageEvents.pricingStatus} <> 'priced'`);

  const query = filters.q?.trim();
  if (query) {
    const pattern = `%${query}%`;
    parts.push(or(
      sql`${usageEvents.requestId} ILIKE ${pattern}`,
      sql`${usageEvents.model} ILIKE ${pattern}`,
      sql`${usageEvents.modelAlias} ILIKE ${pattern}`,
      sql`${usageEvents.responseModel} ILIKE ${pattern}`,
      sql`${usageEvents.endpoint} ILIKE ${pattern}`,
      sql`${usageEvents.apiGroupLabel} ILIKE ${pattern}`,
      sql`${usageEvents.apiGroupKey} ILIKE ${pattern}`,
      sql`${usageEvents.source} ILIKE ${pattern}`,
      sql`${usageEvents.failCode} ILIKE ${pattern}`,
      sql`coalesce(${usageEvents.sessionId}, ${usageEvents.rawPayload}->>'session_id', '') ILIKE ${pattern}`,
      sql`coalesce(${usageEvents.parentSessionId}, ${usageEvents.rawPayload}->>'parent_session_id', '') ILIKE ${pattern}`,
      sql`coalesce(${usageEvents.executionId}, ${usageEvents.rawPayload}->>'execution_id', '') ILIKE ${pattern}`,
      sql`coalesce(${usageEvents.traceId}, ${usageEvents.rawPayload}->>'trace_id', '') ILIKE ${pattern}`,
      sql`coalesce(${usageEvents.nodeKind}, ${usageEvents.rawPayload}->>'node_kind', '') ILIKE ${pattern}`,
      sql`coalesce(${usageEvents.isFork}::text, ${usageEvents.rawPayload}->>'is_fork', '') ILIKE ${pattern}`,
      sql`coalesce(${usageEvents.isCompaction}::text, ${usageEvents.rawPayload}->>'is_compaction', '') ILIKE ${pattern}`
    ));
  }

  return parts.length ? and(...parts) : undefined;
}

export async function getDashboardFilterOptions(filters: DashboardFilters = {}) {
  const where = dashboardWhere(filters);
  const [models, keys, credentials, providers, tiers] = await Promise.all([
    db.select({ value: usageEvents.model }).from(usageEvents).where(where).groupBy(usageEvents.model).orderBy(usageEvents.model).limit(200),
    db.select({ value: usageEvents.apiKeyMask }).from(usageEvents).where(where).groupBy(usageEvents.apiKeyMask).orderBy(usageEvents.apiKeyMask).limit(200),
    db.select({ value: sql<string>`coalesce((select nullif(af.name, '') from auth_file_mappings af where af.auth_id = ${usageEvents.authIndex} limit 1), nullif(${usageEvents.source}, ''), nullif(${usageEvents.authIndex}, ''), '-')` }).from(usageEvents).where(where).groupBy(sql`coalesce((select nullif(af.name, '') from auth_file_mappings af where af.auth_id = ${usageEvents.authIndex} limit 1), nullif(${usageEvents.source}, ''), nullif(${usageEvents.authIndex}, ''), '-')`).orderBy(sql`1`).limit(200),
    db.select({ value: usageEvents.provider }).from(usageEvents).where(where).groupBy(usageEvents.provider).orderBy(usageEvents.provider).limit(200),
    db.select({ value: sql<string>`coalesce(${usageEvents.effectiveServiceTier}, ${usageEvents.billedServiceTier}, ${usageEvents.serviceTier}, '')` }).from(usageEvents).where(where).groupBy(sql`1`).orderBy(sql`1`).limit(100)
  ]);
  return {
    models: models.map((r: any) => r.value).filter(Boolean),
    routes: keys.map((r: any) => r.value).filter(Boolean),
    names: credentials.map((r: any) => r.value).filter((v: string) => v && v !== "-"),
    providers: providers.map((r: any) => r.value).filter(Boolean),
    serviceTiers: tiers.map((r: any) => r.value).filter(Boolean)
  };
}

export function toCount(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}
