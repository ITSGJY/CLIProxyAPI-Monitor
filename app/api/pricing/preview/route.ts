import { NextResponse } from "next/server";
import { z } from "zod";
import { config } from "@/lib/config";
import { databasePool } from "@/lib/db/client";
import { lockUsagePrice } from "@/lib/pricing/quote.mjs";

export const runtime = "nodejs";

const count = z.union([z.string(), z.number()])
  .transform((value) => Number(value))
  .refine((value) => Number.isSafeInteger(value) && value >= 0, "must be a non-negative integer");

const schema = z.object({
  model: z.string().trim().min(1).max(512),
  provider: z.string().trim().max(256).default(""),
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count.default(0),
  cacheWriteTokens: count.default(0),
  serviceTier: z.string().trim().max(64).default(""),
  occurredAt: z.string().datetime({ offset: true }).optional()
});

export async function POST(request: Request) {
  if (!config.postgresUrl || !databasePool) return NextResponse.json({ error: "DATABASE_URL is missing" }, { status: 503 });
  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  const data = parsed.data;
  if (data.cacheReadTokens + data.cacheWriteTokens > data.inputTokens) {
    return NextResponse.json({ error: "Cache token buckets cannot exceed total input tokens" }, { status: 400 });
  }
  const event = {
    model: data.model,
    modelSubstituted: false,
    provider: data.provider || null,
    inputTokens: data.inputTokens,
    outputTokens: data.outputTokens,
    cachedTokens: data.cacheReadTokens + data.cacheWriteTokens,
    cacheReadTokens: data.cacheReadTokens,
    cacheCreationTokens: data.cacheWriteTokens,
    tokenAccounting: null,
    serviceTier: data.serviceTier,
    billedServiceTier: data.serviceTier,
    responseServiceTier: "",
    effectiveServiceTier: data.serviceTier,
    occurredAt: data.occurredAt ?? new Date().toISOString()
  };
  const client = await databasePool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const quote = await lockUsagePrice(client, event);
    await client.query("COMMIT");
    return NextResponse.json({ event, quote });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("/api/pricing/preview failed:", error);
    return NextResponse.json({ error: "Pricing preview failed" }, { status: 500 });
  } finally {
    client.release();
  }
}
