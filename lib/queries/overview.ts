import * as DrizzleOrm from "drizzle-orm";
import { db } from "@/lib/db/client";
import { usageEvents, usageRollupsDaily, usageRollupCheckpoints } from "@/lib/db/schema";
import type { UsageOverview, ModelUsage, UsageSeriesPoint } from "@/lib/types";
import { dashboardWhere, getDashboardFilterOptions, toCount, type DashboardFilters } from "./dashboard-common";

const { and, desc, eq, gte, lt, sql } = DrizzleOrm as any;
type OverviewMeta = { page: number; pageSize: number; totalModels: number; totalPages: number };

function isLocalDayBoundary(value: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.hour === "00" && values.minute === "00" && values.second === "00" && value.getUTCMilliseconds() === 0;
}

function normalizeRange(days?: number, start?: string | null, end?: string | null) {
  const endDate = end ? new Date(end) : new Date();
  if (end && /^\d{4}-\d{2}-\d{2}$/.test(end)) endDate.setUTCDate(endDate.getUTCDate() + 1);
  const startDate = start ? new Date(start) : new Date(endDate.getTime() - Math.min(Math.max(days ?? 14, 1), 366) * 86400000);
  if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime()) || startDate >= endDate) throw new RangeError("Invalid Overview time range");
  return { start: startDate, end: endDate, days: Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / 86400000)) };
}

export async function getOverview(daysInput?: number, opts?: DashboardFilters & {
  page?: number | null; pageSize?: number | null; timezone?: string | null;
}): Promise<{ overview: UsageOverview; empty: boolean; days: number; meta: OverviewMeta; filters: { models: string[]; routes: string[]; sources: string[]; names: string[]; providers?: string[]; serviceTiers?: string[] }; timezone: string; lastSyncAt: string | null; costByCurrency: Array<{currency:string; costNanos:number | null}>; pricingCoverage: {priced:number;unpriced:number;partial:number;rate:number} }> {
  const range = normalizeRange(daysInput, opts?.start, opts?.end);
  const timezone = opts?.timezone || "Asia/Shanghai";
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); } catch { throw new RangeError("Invalid timezone"); }
  const page = Math.max(1, Math.floor(opts?.page ?? 1));
  const pageSize = Math.min(500, Math.max(5, Math.floor(opts?.pageSize ?? 10)));
  const filters = { ...opts, start: range.start.toISOString(), end: range.end.toISOString() };
  const where = dashboardWhere(filters);
  const timezoneLiteral = sql.raw(`'${timezone.replace(/'/g, "''")}'`);
  const dayExpr = sql`date_trunc('day', ${usageEvents.occurredAt} AT TIME ZONE ${timezoneLiteral})`;
  const hourExpr = sql`date_trunc('hour', ${usageEvents.occurredAt} AT TIME ZONE ${timezoneLiteral})`;
  const dailyCheckpoint = range.days <= 90 && !opts?.name && !opts?.status
    ? await db.select({ state: usageRollupCheckpoints.state, completedAt: usageRollupCheckpoints.completedAt }).from(usageRollupCheckpoints).where(and(eq(usageRollupCheckpoints.rollupName, "usage_daily"), eq(usageRollupCheckpoints.timezone, timezone))).limit(1)
    : [];
  const useDailyRollup = isLocalDayBoundary(range.start, timezone) && isLocalDayBoundary(range.end, timezone) && !opts?.source && dailyCheckpoint[0]?.state === "completed" && dailyCheckpoint[0]?.completedAt && Date.now() - new Date(dailyCheckpoint[0].completedAt).getTime() < 2 * 60 * 60 * 1000;
  const rollupParts: any[] = [gte(usageRollupsDaily.bucketStart, range.start), lt(usageRollupsDaily.bucketStart, range.end), eq(usageRollupsDaily.timezone, timezone)];
  if (opts?.model) rollupParts.push(eq(usageRollupsDaily.model, opts.model));
  if (opts?.route) rollupParts.push(eq(usageRollupsDaily.apiKeyMask, opts.route));
  if (opts?.source) rollupParts.push(eq(usageRollupsDaily.source, opts.source));
  if (opts?.provider) rollupParts.push(eq(usageRollupsDaily.provider, opts.provider));
  if (opts?.serviceTier) rollupParts.push(eq(usageRollupsDaily.serviceTier, opts.serviceTier));
  if (opts?.currency) rollupParts.push(eq(usageRollupsDaily.costCurrency, opts.currency));
  const dayRowsPromise = useDailyRollup
    ? db.select({ label: sql<string>`to_char(${usageRollupsDaily.bucketStart} AT TIME ZONE ${timezoneLiteral}, 'YYYY-MM-DD')`, requests: sql<number>`sum(${usageRollupsDaily.requestCount})`, errors: sql<number>`sum(${usageRollupsDaily.errorCount})`, tokens: sql<number>`sum(${usageRollupsDaily.totalTokens})` }).from(usageRollupsDaily).where(and(...rollupParts)).groupBy(usageRollupsDaily.bucketStart).orderBy(usageRollupsDaily.bucketStart).limit(366)
    : db.select({ label: sql<string>`to_char(${dayExpr}, 'YYYY-MM-DD')`, requests: sql<number>`count(*)`, errors: sql<number>`count(*) FILTER (WHERE ${usageEvents.isError})`, tokens: sql<number>`sum(${usageEvents.totalTokens})` }).from(usageEvents).where(where).groupBy(dayExpr).orderBy(dayExpr).limit(366);
  const [totalsRows, currencyRows, modelRows, dayRows, hourRows, modelCountRows, options, lastRows, pricedRows] = await Promise.all([
    db.select({ requests: sql<number>`count(*)`, tokens: sql<number>`coalesce(sum(${usageEvents.totalTokens}),0)`, input: sql<number>`coalesce(sum(${usageEvents.inputTokens}),0)`, output: sql<number>`coalesce(sum(${usageEvents.outputTokens}),0)`, reasoning: sql<number>`coalesce(sum(${usageEvents.reasoningTokens}),0)`, cached: sql<number>`coalesce(sum(${usageEvents.cachedTokens}),0)`, success: sql<number>`count(*) FILTER (WHERE NOT ${usageEvents.isError})`, errors: sql<number>`count(*) FILTER (WHERE ${usageEvents.isError})` }).from(usageEvents).where(where),
    db.select({ currency: usageEvents.costCurrency, costNanos: sql<number>`coalesce(sum(${usageEvents.costNanos}) FILTER (WHERE ${usageEvents.pricingStatus}='priced'),0)`, priced: sql<number>`count(*) FILTER (WHERE ${usageEvents.pricingStatus}='priced')`, unpriced: sql<number>`count(*) FILTER (WHERE ${usageEvents.pricingStatus}='unpriced')`, partial: sql<number>`count(*) FILTER (WHERE ${usageEvents.pricingStatus}='partial')` }).from(usageEvents).where(where).groupBy(usageEvents.costCurrency),
    db.select({ model: usageEvents.model, requests: sql<number>`count(*)`, tokens: sql<number>`sum(${usageEvents.totalTokens})`, input: sql<number>`sum(${usageEvents.inputTokens})`, output: sql<number>`sum(${usageEvents.outputTokens})`, costNanos: sql<number>`sum(${usageEvents.costNanos}) FILTER (WHERE ${usageEvents.costCurrency} = 'USD' AND ${usageEvents.pricingStatus} = 'priced')`, priced: sql<number>`count(*) FILTER (WHERE ${usageEvents.pricingStatus}='priced' AND ${usageEvents.costCurrency}='USD')` }).from(usageEvents).where(where).groupBy(usageEvents.model).orderBy(desc(sql`sum(${usageEvents.totalTokens})`)).limit(pageSize).offset((page-1)*pageSize),
    dayRowsPromise,
    db.select({ label: sql<string>`to_char(${hourExpr}, 'MM-DD HH24')`, hourStart: sql<Date>`(${hourExpr}) AT TIME ZONE ${timezone}`, requests: sql<number>`count(*)`, tokens: sql<number>`sum(${usageEvents.totalTokens})`, input: sql<number>`sum(${usageEvents.inputTokens})`, output: sql<number>`sum(${usageEvents.outputTokens})`, reasoning: sql<number>`sum(${usageEvents.reasoningTokens})`, cached: sql<number>`sum(${usageEvents.cachedTokens})` }).from(usageEvents).where(where).groupBy(hourExpr).orderBy(hourExpr).limit(24*367),
    db.select({ count: sql<number>`count(distinct ${usageEvents.model})` }).from(usageEvents).where(where),
    getDashboardFilterOptions({ start: range.start.toISOString(), end: range.end.toISOString() }),
    db.select({ last: sql<Date | null>`max(${usageEvents.ingestedAt})` }).from(usageEvents),
    db.select({ priced: sql<number>`count(*) FILTER (WHERE ${usageEvents.pricingStatus}='priced')`, unpriced: sql<number>`count(*) FILTER (WHERE ${usageEvents.pricingStatus}='unpriced')`, partial: sql<number>`count(*) FILTER (WHERE ${usageEvents.pricingStatus}='partial')`, total: sql<number>`count(*)` }).from(usageEvents).where(where)
  ]);
  const total = totalsRows[0];
  const costByCurrency = currencyRows.map((row: any) => ({ currency: row.currency, costNanos: toCount(row.priced) > 0 ? toCount(row.costNanos) : null }));
  const usdRow = currencyRows.find((row: any) => row.currency === "USD");
  const usdNanos = toCount(usdRow?.costNanos);
  const models: ModelUsage[] = modelRows.map((row: any) => ({ model: row.model, requests: toCount(row.requests), tokens: toCount(row.tokens), inputTokens: toCount(row.input), outputTokens: toCount(row.output), cost: row.costNanos == null || row.priced === 0 ? null : toCount(row.costNanos) / 1e9 }));
  const byDay: UsageSeriesPoint[] = dayRows.map((row: any) => ({ label: row.label, requests: toCount(row.requests), errors: toCount(row.errors), tokens: toCount(row.tokens) }));
  const byHour: UsageSeriesPoint[] = hourRows.map((row: any) => ({ label: row.label, timestamp: new Date(row.hourStart).toISOString(), requests: toCount(row.requests), tokens: toCount(row.tokens), inputTokens: toCount(row.input), outputTokens: toCount(row.output), reasoningTokens: toCount(row.reasoning), cachedTokens: toCount(row.cached) }));
  const requests = toCount(total?.requests);
  const coverage = pricedRows[0];
  const priced = toCount(coverage?.priced), unpriced = toCount(coverage?.unpriced), partial = toCount(coverage?.partial);
  const overview: UsageOverview = {
    totalRequests: requests, totalTokens: toCount(total?.tokens), totalInputTokens: toCount(total?.input), totalOutputTokens: toCount(total?.output), totalReasoningTokens: toCount(total?.reasoning), totalCachedTokens: toCount(total?.cached), successCount: toCount(total?.success), failureCount: toCount(total?.errors), successRate: requests ? toCount(total?.success)/requests : 1,
    totalCost: toCount(usdRow?.priced) > 0 ? usdNanos / 1e9 : null, models, byDay, byHour
  };
  const totalModels = toCount(modelCountRows[0]?.count);
  return {
    overview, empty: requests === 0, days: range.days,
    meta: { page, pageSize, totalModels, totalPages: Math.max(1, Math.ceil(totalModels/pageSize)) },
    filters: { models: options.models, routes: options.routes, sources: options.names, names: options.names, providers: options.providers, serviceTiers: options.serviceTiers },
    timezone, lastSyncAt: lastRows[0]?.last ? new Date(lastRows[0].last).toISOString() : null,
    costByCurrency, pricingCoverage: { priced, unpriced, partial, rate: requests ? priced / requests : 1 }
  };
}
