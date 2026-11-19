import { NextResponse } from "next/server";
import { z } from "zod";
import { config } from "@/lib/config";
import { databasePool } from "@/lib/db/client";

export const runtime = "nodejs";

const priceSchema = z.object({
  model: z.string().trim().min(1).max(512),
  inputPricePer1M: z.number().finite().nonnegative(),
  cachedInputPricePer1M: z.number().finite().nonnegative().optional().default(0),
  outputPricePer1M: z.number().finite().nonnegative()
});

function ensureDbEnv() {
  if (!config.postgresUrl || !databasePool) throw new Error("DATABASE_URL is missing");
}

export async function GET() {
  try {
    ensureDbEnv();
    const result = await databasePool.query(
      `SELECT model, input_price_per_1m, cached_input_price_per_1m, output_price_per_1m
       FROM model_prices
       WHERE provider = '' AND service_tier = '' AND available = true
       ORDER BY model`
    );
    return NextResponse.json(result.rows.map((row: any) => ({
      model: row.model,
      inputPricePer1M: Number(row.input_price_per_1m),
      cachedInputPricePer1M: Number(row.cached_input_price_per_1m),
      outputPricePer1M: Number(row.output_price_per_1m)
    })), { status: 200 });
  } catch (error) {
    console.error("/api/prices GET failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    ensureDbEnv();
    const parsed = priceSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
    const data = parsed.data;
    await databasePool.query(
      `INSERT INTO model_prices (
        model, provider, service_tier, input_price_per_1m, cached_input_price_per_1m,
        output_price_per_1m, cache_write_price_per_1m, price_multiplier, tiers,
        source, match_kind, mode, available, updated_at, created_by
      ) VALUES ($1, '', '', $2, $3, $4, $2, 1, '[]'::jsonb, 'manual', 'manual', 'custom', true, now(), 'legacy-api')
      ON CONFLICT (model, provider, service_tier) DO UPDATE SET
        input_price_per_1m = EXCLUDED.input_price_per_1m,
        cached_input_price_per_1m = EXCLUDED.cached_input_price_per_1m,
        output_price_per_1m = EXCLUDED.output_price_per_1m,
        cache_write_price_per_1m = EXCLUDED.cache_write_price_per_1m,
        price_multiplier = 1, tiers = '[]'::jsonb, source = 'manual', match_kind = 'manual',
        mode = 'custom', available = true, updated_at = now(), created_by = 'legacy-api'`,
      [data.model, String(data.inputPricePer1M), String(data.cachedInputPricePer1M ?? 0), String(data.outputPricePer1M)]
    );
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    console.error("/api/prices POST failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    ensureDbEnv();
    const body = await request.json();
    const model = String(body?.model ?? "").trim();
    if (!model) return NextResponse.json({ error: "model is required" }, { status: 400 });
    await databasePool.query(
      "DELETE FROM model_prices WHERE model = $1 AND provider = '' AND service_tier = ''",
      [model]
    );
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    console.error("/api/prices DELETE failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
