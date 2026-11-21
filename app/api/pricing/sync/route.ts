import { NextResponse } from "next/server";
import { z } from "zod";
import { config } from "@/lib/config";
import { databasePool } from "@/lib/db/client";
import { syncPricingCatalogs } from "@/lib/pricing/sync.mjs";

export const runtime = "nodejs";

const syncSchema = z.object({
  source: z.enum(["models.dev", "openrouter", "all"]).default("models.dev"),
  force: z.boolean().default(false)
});

const intervalSchema = z.object({
  source: z.enum(["models.dev", "openrouter"]),
  autoSyncIntervalHours: z.number().int().min(0).max(168)
});

function ensureDatabase() {
  if (!config.postgresUrl || !databasePool) throw new Error("DATABASE_URL is missing");
}

export async function POST(request: Request) {
  try {
    ensureDatabase();
    const parsed = syncSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    const sources = parsed.data.source === "all"
      ? ["models.dev", "openrouter"]
      : [parsed.data.source];
    const result = await syncPricingCatalogs(databasePool, { sources, force: parsed.data.force });
    const failed = result.results.some((item: any) => item.status === "failed");
    return NextResponse.json(result, { status: failed ? 502 : 200 });
  } catch (error) {
    console.error("/api/pricing/sync POST failed:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Pricing sync failed" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    ensureDatabase();
    const parsed = intervalSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    const { source, autoSyncIntervalHours } = parsed.data;
    const result = await databasePool.query(
      `UPDATE pricing_sync_state
          SET auto_sync_interval_hours = $2, updated_at = now()
        WHERE source = $1
        RETURNING source, auto_sync_interval_hours, updated_at`,
      [source, autoSyncIntervalHours]
    );
    if (!result.rowCount) return NextResponse.json({ error: "Pricing source not found" }, { status: 404 });
    return NextResponse.json({ ok: true, state: result.rows[0] });
  } catch (error) {
    console.error("/api/pricing/sync PATCH failed:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Pricing sync settings failed" }, { status: 500 });
  }
}