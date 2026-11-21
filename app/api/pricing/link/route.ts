import { NextResponse } from "next/server";
import { z } from "zod";
import { config } from "@/lib/config";
import { databasePool } from "@/lib/db/client";

export const runtime = "nodejs";

const schema = z.object({
  model: z.string().trim().min(1).max(512),
  provider: z.string().trim().max(256).default(""),
  upstreamProviderId: z.string().trim().min(1).max(256),
  upstreamModelId: z.string().trim().min(1).max(512)
});

export async function POST(request: Request) {
  if (!config.postgresUrl || !databasePool) return NextResponse.json({ error: "DATABASE_URL is missing" }, { status: 503 });
  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  const data = parsed.data;
  const client = await databasePool.connect();
  try {
    const offeringResult = await client.query(
      `SELECT * FROM pricing_upstream_catalog
       WHERE source = 'models.dev' AND provider_id = $1 AND model_id = $2 AND is_active = true LIMIT 1`,
      [data.upstreamProviderId, data.upstreamModelId]
    );
    const offering = offeringResult.rows[0];
    if (!offering || offering.input_price_per_1m === null || offering.output_price_per_1m === null) {
      return NextResponse.json({ error: "Selected models.dev offering is unavailable or has no complete input/output price" }, { status: 404 });
    }

    await client.query("BEGIN");
    const existing = await client.query(
      "SELECT mode FROM model_prices WHERE model = $1 AND provider IN ($2, '') AND service_tier = ''",
      [data.model, data.provider]
    );
    if (existing.rows.some((row: any) => row.mode === "custom")) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "A Custom price already exists; it must be explicitly changed before linking" }, { status: 409 });
    }

    await client.query(
      `INSERT INTO pricing_model_links (model, provider, source, upstream_provider_id, upstream_model_id, updated_at, created_by)
       VALUES ($1, $2, 'models.dev', $3, $4, now(), 'dashboard')
       ON CONFLICT (model, provider) DO UPDATE SET source = 'models.dev',
         upstream_provider_id = EXCLUDED.upstream_provider_id, upstream_model_id = EXCLUDED.upstream_model_id,
         updated_at = now(), created_by = 'dashboard'`,
      [data.model, data.provider, data.upstreamProviderId, data.upstreamModelId]
    );
    const price = await client.query(
      `INSERT INTO model_prices (
        model, provider, service_tier, input_price_per_1m, cached_input_price_per_1m,
        output_price_per_1m, cache_write_price_per_1m, price_multiplier, tiers,
        source, source_version, upstream_provider_id, upstream_model_id, match_kind,
        mode, synced_at, updated_at, available, created_by
      ) VALUES ($1, $2, '', $3, $4, $5, $6, 1, $7::jsonb, 'models.dev', $8, $9, $10, 'linked', 'linked', now(), now(), true, 'dashboard')
      ON CONFLICT (model, provider, service_tier) DO UPDATE SET
        input_price_per_1m = EXCLUDED.input_price_per_1m,
        cached_input_price_per_1m = EXCLUDED.cached_input_price_per_1m,
        output_price_per_1m = EXCLUDED.output_price_per_1m,
        cache_write_price_per_1m = EXCLUDED.cache_write_price_per_1m,
        tiers = EXCLUDED.tiers, source = 'models.dev', source_version = EXCLUDED.source_version,
        upstream_provider_id = EXCLUDED.upstream_provider_id, upstream_model_id = EXCLUDED.upstream_model_id,
        match_kind = 'linked', mode = 'linked', synced_at = now(), updated_at = now(),
        available = true, created_by = 'dashboard'
      RETURNING *`,
      [data.model, data.provider, offering.input_price_per_1m, offering.cache_read_price_per_1m ?? offering.input_price_per_1m,
        offering.output_price_per_1m, offering.cache_write_price_per_1m ?? offering.input_price_per_1m,
        JSON.stringify(offering.tiers ?? []), offering.snapshot_sha, offering.provider_id, offering.model_id]
    );
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, price: price.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("/api/pricing/link POST failed:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to link model" }, { status: 500 });
  } finally {
    client.release();
  }
}

export async function DELETE(request: Request) {
  if (!config.postgresUrl || !databasePool) return NextResponse.json({ error: "DATABASE_URL is missing" }, { status: 503 });
  const body = await request.json().catch(() => ({}));
  const model = String(body?.model ?? "").trim();
  const provider = String(body?.provider ?? "");
  if (!model) return NextResponse.json({ error: "model is required" }, { status: 400 });
  const client = await databasePool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM pricing_model_links WHERE model = $1 AND provider = $2", [model, provider]);
    await client.query(
      "DELETE FROM model_prices WHERE model = $1 AND provider = $2 AND service_tier = '' AND mode = 'linked'",
      [model, provider]
    );
    await client.query("COMMIT");
    return NextResponse.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("/api/pricing/link DELETE failed:", error);
    return NextResponse.json({ error: "Failed to unlink model" }, { status: 500 });
  } finally {
    client.release();
  }
}
