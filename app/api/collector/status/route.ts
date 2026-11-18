import { NextResponse } from "next/server";
import * as DrizzleOrm from "drizzle-orm";
import { assertEnv } from "@/lib/config";
import { db } from "@/lib/db/client";
import { usageCollectorInstances, usageCollectorState, usageInbox, usageIngestGaps, usagePullAttempts, usageEvents } from "@/lib/db/schema";

const { eq, sql, desc } = DrizzleOrm as any;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try { assertEnv(); } catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 501 }); }
  try {
    const [instances, inbox, gaps, attempts, pricing] = await Promise.all([
      db.select({ instanceId: usageCollectorInstances.instanceId, displayName: usageCollectorInstances.displayName, enabled: usageCollectorInstances.enabled, state: usageCollectorState.state, leaseExpiresAt: usageCollectorState.leaseExpiresAt, lastAttemptAt: usageCollectorState.lastAttemptAt, lastSuccessAt: usageCollectorState.lastSuccessAt, lastEventAt: usageCollectorState.lastEventAt, transport: usageCollectorState.lastTransport, errorCode: usageCollectorState.lastErrorCode, updatedAt: usageCollectorState.updatedAt }).from(usageCollectorInstances).leftJoin(usageCollectorState, eq(usageCollectorInstances.instanceId, usageCollectorState.instanceId)).orderBy(usageCollectorInstances.instanceId),
      db.select({ instanceId: usageInbox.instanceId, status: usageInbox.status, count: sql<number>`count(*)` }).from(usageInbox).groupBy(usageInbox.instanceId, usageInbox.status),
      db.select({ id: usageIngestGaps.id, instanceId: usageIngestGaps.instanceId, detectedAt: usageIngestGaps.detectedAt, startedAt: usageIngestGaps.startedAt, reason: usageIngestGaps.reason, estimatedMissingCount: usageIngestGaps.estimatedMissingCount }).from(usageIngestGaps).orderBy(desc(usageIngestGaps.detectedAt)).limit(100),
      db.select({ instanceId: usagePullAttempts.instanceId, transport: usagePullAttempts.transport, status: usagePullAttempts.status, received: usagePullAttempts.receivedCount, persisted: usagePullAttempts.persistedCount, completedAt: usagePullAttempts.completedAt }).from(usagePullAttempts).orderBy(desc(usagePullAttempts.id)).limit(100),
      db.select({ currency: usageEvents.costCurrency, status: usageEvents.pricingStatus, count: sql<number>`count(*)` }).from(usageEvents).groupBy(usageEvents.costCurrency, usageEvents.pricingStatus)
    ]);
    const now = Date.now();
    const pollIntervalMs = Number(process.env.COLLECTOR_POLL_INTERVAL_MS ?? 10_000);
    const staleAfterMs = Math.max(60_000, Number.isFinite(pollIntervalMs) && pollIntervalMs > 0 ? pollIntervalMs * 3 : 30_000);
    const collectorInstances = instances.map((row: any) => ({ ...row,
      healthy: Boolean(row.enabled && row.state && ["checking", "receiving"].includes(row.state) && row.leaseExpiresAt && new Date(row.leaseExpiresAt).getTime() > now && row.updatedAt && now - new Date(row.updatedAt).getTime() <= staleAfterMs && row.lastSuccessAt && now - new Date(row.lastSuccessAt).getTime() <= staleAfterMs && !row.errorCode),
      leaseFresh: Boolean(row.leaseExpiresAt && new Date(row.leaseExpiresAt).getTime() > now)
    }));
    const inboxCounts = inbox.reduce((acc: any, row: any) => { acc[row.instanceId] ??= { pending:0, processing:0, deadLetter:0 }; if (row.status === "pending") acc[row.instanceId].pending=Number(row.count); if (row.status === "processing") acc[row.instanceId].processing=Number(row.count); if (row.status === "dead_letter") acc[row.instanceId].deadLetter=Number(row.count); return acc; }, {});
    const pricingCoverage = pricing.reduce((acc: any, row: any) => { acc[row.currency] ??= { priced:0, unpriced:0, partial:0 }; acc[row.currency][row.status] = Number(row.count); return acc; }, {});
    return NextResponse.json({ instances: collectorInstances, inboxCounts, gaps, attempts, pricingCoverage, generatedAt: new Date().toISOString() });
  } catch (error) {
    console.error("/api/collector/status failed:", error);
    return NextResponse.json({ error: "Unable to load collector status" }, { status: 500 });
  }
}
