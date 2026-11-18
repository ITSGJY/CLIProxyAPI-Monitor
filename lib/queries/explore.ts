import * as DrizzleOrm from "drizzle-orm";
import { db } from "@/lib/db/client";
import { usageEvents } from "@/lib/db/schema";
import { dashboardWhere, getDashboardFilterOptions, toCount, type DashboardFilters } from "./dashboard-common";

const { and, eq, sql } = DrizzleOrm as any;

export type ExplorePoint = {
  ts: number; tokens: number; inputTokens: number; outputTokens: number;
  reasoningTokens: number; cachedTokens: number; model: string;
  cacheCreationTokens?: number; latencyMs?: number | null; ttftMs?: number | null;
  serviceTier?: string | null; isError?: boolean; costNanos?: number | null;
  costCurrency?: string; pricingStatus?: string;
};

function resolveRange(days?: number, start?: string | null, end?: string | null) {
  const endDate = end ? new Date(end) : new Date();
  if (end && /^\d{4}-\d{2}-\d{2}$/.test(end)) endDate.setUTCDate(endDate.getUTCDate() + 1);
  const startDate = start ? new Date(start) : new Date(endDate.getTime() - Math.min(Math.max(days ?? 14, 1), 366) * 86400000);
  if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime()) || startDate >= endDate) throw new RangeError("Invalid Explore time range");
  return { start: startDate, end: endDate, days: Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / 86400000)) };
}

export async function getExplorePoints(daysInput?: number, opts: DashboardFilters & { maxPoints?: number | null; filterInvalid?: boolean } = {}) {
  const range = resolveRange(daysInput, opts.start, opts.end);
  const maxPoints = Math.min(Math.max(Math.floor(opts.maxPoints ?? 8000), 1), 8000);
  const filters = { ...opts, start: range.start.toISOString(), end: range.end.toISOString() };
  const where = dashboardWhere(filters);
  const [totalRows, zeroRows, pointRows, options] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(usageEvents).where(where),
    db.select({ count: sql<number>`count(*)` }).from(usageEvents).where(and(where, sql`${usageEvents.totalTokens} = 0`)),
    (() => {
      const pointWhere = opts.filterInvalid === false ? where : and(where, sql`${usageEvents.totalTokens} > 0`);
      const bucketed = db.select({
        ts: sql<number>`(extract(epoch from ${usageEvents.occurredAt}) * 1000)::bigint`.as("ts"),
        occurredAt: usageEvents.occurredAt,
        eventId: usageEvents.eventId,
        tokens: usageEvents.totalTokens,
        inputTokens: usageEvents.inputTokens,
        outputTokens: usageEvents.outputTokens,
        reasoningTokens: usageEvents.reasoningTokens,
        cachedTokens: usageEvents.cachedTokens,
        cacheCreationTokens: usageEvents.cacheCreationTokens,
        model: usageEvents.model,
        latencyMs: usageEvents.latencyMs,
        ttftMs: usageEvents.ttftMs,
        serviceTier: sql<string | null>`coalesce(${usageEvents.effectiveServiceTier}, ${usageEvents.billedServiceTier}, ${usageEvents.serviceTier})`.as("serviceTier"),
        isError: usageEvents.isError,
        costNanos: usageEvents.costNanos,
        costCurrency: usageEvents.costCurrency,
        pricingStatus: usageEvents.pricingStatus,
        bucket: sql<number>`ntile(${maxPoints}) OVER (ORDER BY ${usageEvents.occurredAt}, ${usageEvents.eventId})`.as("bucket")
      }).from(usageEvents).where(pointWhere).as("bucketed_points");
      const ranked = db.select({
        ts: bucketed.ts, occurredAt: bucketed.occurredAt, eventId: bucketed.eventId,
        tokens: bucketed.tokens, inputTokens: bucketed.inputTokens, outputTokens: bucketed.outputTokens,
        reasoningTokens: bucketed.reasoningTokens, cachedTokens: bucketed.cachedTokens,
        cacheCreationTokens: bucketed.cacheCreationTokens, model: bucketed.model,
        latencyMs: bucketed.latencyMs, ttftMs: bucketed.ttftMs, serviceTier: bucketed.serviceTier,
        isError: bucketed.isError, costNanos: bucketed.costNanos, costCurrency: bucketed.costCurrency,
        pricingStatus: bucketed.pricingStatus,
        sampleRank: sql<number>`row_number() OVER (PARTITION BY ${bucketed.bucket} ORDER BY ${bucketed.occurredAt}, ${bucketed.eventId})`.as("sampleRank")
      }).from(bucketed).as("ranked_points");
      return db.select({
        ts: ranked.ts, tokens: ranked.tokens, inputTokens: ranked.inputTokens,
        outputTokens: ranked.outputTokens, reasoningTokens: ranked.reasoningTokens,
        cachedTokens: ranked.cachedTokens, cacheCreationTokens: ranked.cacheCreationTokens,
        model: ranked.model, latencyMs: ranked.latencyMs, ttftMs: ranked.ttftMs,
        serviceTier: ranked.serviceTier, isError: ranked.isError, costNanos: ranked.costNanos,
        costCurrency: ranked.costCurrency, pricingStatus: ranked.pricingStatus
      }).from(ranked).where(eq(ranked.sampleRank, 1)).orderBy(ranked.ts).limit(maxPoints);
    })(),
    getDashboardFilterOptions({ start: range.start.toISOString(), end: range.end.toISOString() })
  ]);
  const total = toCount(totalRows[0]?.count);
  const points: ExplorePoint[] = pointRows.map((row: any) => ({
    ts: toCount(row.ts), tokens: toCount(row.tokens), inputTokens: toCount(row.inputTokens),
    outputTokens: toCount(row.outputTokens), reasoningTokens: toCount(row.reasoningTokens),
    cachedTokens: toCount(row.cachedTokens), cacheCreationTokens: toCount(row.cacheCreationTokens),
    model: row.model, latencyMs: row.latencyMs == null ? null : toCount(row.latencyMs),
    ttftMs: row.ttftMs == null ? null : toCount(row.ttftMs), serviceTier: row.serviceTier,
    isError: Boolean(row.isError), costNanos: row.costNanos == null ? null : toCount(row.costNanos),
    costCurrency: row.costCurrency, pricingStatus: row.pricingStatus
  }));
  return {
    days: range.days, total, zeroTokensCount: toCount(zeroRows[0]?.count),
    returned: points.length, step: total > points.length && points.length ? Math.ceil(total / points.length) : 1,
    filters: { routes: options.routes, names: options.names }, points
  };
}
