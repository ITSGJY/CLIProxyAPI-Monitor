import * as DrizzleOrm from "drizzle-orm";
import { db } from "@/lib/db/client";
import { usageEvents } from "@/lib/db/schema";

const { and, eq, gte, lt, sql } = DrizzleOrm as any;

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
};

export function dashboardWhere(filters: DashboardFilters = {}) {
  const parts: any[] = [];
  const start = filters.start ? new Date(filters.start) : null;
  const end = filters.end ? new Date(filters.end) : null;
  if (start && Number.isFinite(start.getTime())) parts.push(gte(usageEvents.occurredAt, start));
  if (end && Number.isFinite(end.getTime())) parts.push(lt(usageEvents.occurredAt, end));
  if (filters.model) parts.push(eq(usageEvents.model, filters.model));
  const keyMask = filters.route;
  if (keyMask) parts.push(eq(usageEvents.apiKeyMask, keyMask));
  const credentialLabel = sql<string>`coalesce((select nullif(af.name, '') from auth_file_mappings af where af.auth_id = ${usageEvents.authIndex} limit 1), nullif(${usageEvents.source}, ''), nullif(${usageEvents.authIndex}, ''), '-')`;
  if (filters.source || filters.name) parts.push(sql`${credentialLabel} = ${filters.source ?? filters.name}`);
  if (filters.provider) parts.push(eq(usageEvents.provider, filters.provider));
  if (filters.serviceTier) parts.push(sql`coalesce(${usageEvents.effectiveServiceTier}, ${usageEvents.billedServiceTier}, ${usageEvents.serviceTier}, '') = ${filters.serviceTier}`);
  if (filters.status === "error") parts.push(eq(usageEvents.isError, true));
  if (filters.status === "success") parts.push(eq(usageEvents.isError, false));
  if (filters.currency) parts.push(eq(usageEvents.costCurrency, filters.currency));
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
