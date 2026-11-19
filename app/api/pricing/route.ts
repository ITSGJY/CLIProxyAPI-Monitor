import { NextResponse } from "next/server";
import { z } from "zod";
import { config } from "@/lib/config";
import { databasePool } from "@/lib/db/client";

export const runtime = "nodejs";

function ensureDbEnv() {
  if (!config.postgresUrl || !databasePool) throw new Error("DATABASE_URL is missing");
}

function normalizeIdentity(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function priceSignature(row: any) {
  return JSON.stringify([
    row.input_price_per_1m, row.output_price_per_1m,
    row.cache_read_price_per_1m, row.cache_write_price_per_1m, row.tiers ?? []
  ]);
}

function matchOffering(model: string, provider: string, offerings: any[]) {
  const exact = offerings.filter((row) => row.model_id === model || row.canonical_id === model);
  if (!exact.length) return { status: "unmatched", candidates: [] as any[] };
  const providerMatches = exact.filter((row) => normalizeIdentity(row.provider_id) === normalizeIdentity(provider));
  if (providerMatches.length === 1) return { status: "matched", candidates: providerMatches, matchKind: "exact_provider" };
  if (providerMatches.length > 1) {
    return new Set(providerMatches.map(priceSignature)).size === 1
      ? { status: "matched", candidates: providerMatches, matchKind: "exact_equivalent_offering" }
      : { status: "ambiguous", candidates: providerMatches };
  }
  if (exact.length === 1) return { status: "matched", candidates: exact, matchKind: exact[0].model_id === model ? "exact_unique" : "canonical" };
  return new Set(exact.map(priceSignature)).size === 1
    ? { status: "matched", candidates: exact, matchKind: "exact_equivalent_offering" }
    : { status: "ambiguous", candidates: exact };
}

const decimal = z.union([z.string(), z.number()])
  .transform((value) => String(value).trim())
  .refine((value) => /^[+]?\d+(?:\.\d{1,12})?(?:[eE][+-]?\d+)?$/.test(value) && Number.isFinite(Number(value)) && Number(value) >= 0, "must be a non-negative decimal");

const priceSchema = z.object({
  model: z.string().trim().min(1).max(512),
  provider: z.string().trim().max(256).default(""),
  serviceTier: z.string().trim().max(64).default(""),
  inputPricePer1M: decimal,
  cachedInputPricePer1M: decimal,
  outputPricePer1M: decimal,
  cacheWritePricePer1M: decimal,
  priceMultiplier: decimal.refine((value) => Number(value) > 0, "must be greater than zero").default("1"),
  tiers: z.array(z.record(z.string(), z.unknown())).max(16).default([])
});

function validateTiers(tiers: Array<Record<string, unknown>>) {
  for (const [index, tier] of tiers.entries()) {
    const serviceTiers = tier.service_tiers;
    if (serviceTiers !== undefined && (!Array.isArray(serviceTiers) || serviceTiers.length > 8 || serviceTiers.some((value) => typeof value !== "string" || !/^[a-zA-Z0-9._-]{1,64}$/.test(value)))) {
      throw new Error(`Tier ${index + 1}: invalid service_tiers`);
    }
    const minPrompt = Number(tier.min_prompt_tokens ?? 0);
    if (!Number.isSafeInteger(minPrompt) || minPrompt < 0) throw new Error(`Tier ${index + 1}: invalid min_prompt_tokens`);
    const start = tier.utc_start;
    const end = tier.utc_end;
    if ((start === undefined) !== (end === undefined)) throw new Error(`Tier ${index + 1}: utc_start and utc_end must be set together`);
    if (start !== undefined) {
      const valid = (value: unknown) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 2359 && Number(value) % 100 < 60;
      if (!valid(start) || !valid(end) || Number(start) === Number(end)) throw new Error(`Tier ${index + 1}: invalid time window`);
      try { new Intl.DateTimeFormat("en-US", { timeZone: String(tier.time_zone || "UTC") }).format(new Date()); }
      catch { throw new Error(`Tier ${index + 1}: invalid IANA time zone`); }
    } else if (tier.time_zone) {
      throw new Error(`Tier ${index + 1}: time_zone requires a time window`);
    }
    if (!(Array.isArray(serviceTiers) && serviceTiers.length) && minPrompt === 0 && start === undefined) {
      throw new Error(`Tier ${index + 1}: a tier needs at least one condition`);
    }
    for (const key of ["prompt_price_per_1m", "completion_price_per_1m", "cache_read_price_per_1m", "cache_write_price_per_1m"]) {
      if (tier[key] !== undefined && (!Number.isFinite(Number(tier[key])) || Number(tier[key]) < 0)) {
        throw new Error(`Tier ${index + 1}: ${key} must be non-negative`);
      }
    }
  }
}

export async function GET() {
  try {
    ensureDbEnv();
    const [pricesResult, observedResult, channelsResult, channelVersionsResult, syncResult, snapshotsResult, versionsResult, catalogResult, catalogCountResult, linksResult] = await Promise.all([
      databasePool.query("SELECT * FROM model_prices ORDER BY model, provider, service_tier"),
      databasePool.query(`SELECT
        CASE WHEN model_substituted = true AND NULLIF(response_model, '') IS NOT NULL THEN response_model ELSE model END AS model,
        COALESCE(provider, '') AS provider,
        count(*)::bigint AS requests,
        COALESCE(sum(total_tokens), 0)::numeric::text AS total_tokens,
        count(*) FILTER (WHERE pricing_status = 'priced')::bigint AS priced_requests
      FROM usage_events GROUP BY 1, 2 ORDER BY 1, 2`),
      databasePool.query("SELECT * FROM pricing_channels ORDER BY channel"),
      databasePool.query("SELECT * FROM pricing_channel_versions ORDER BY effective_from DESC, id DESC LIMIT 100"),
      databasePool.query(`SELECT state.*, latest.status AS latest_status, latest.fetched_at AS latest_fetched_at,
        latest.model_count AS latest_model_count, latest.matched_count AS latest_matched_count,
        latest.ambiguous_count AS latest_ambiguous_count, latest.error_message AS latest_error
      FROM pricing_sync_state state
      LEFT JOIN LATERAL (
        SELECT status, fetched_at, model_count, matched_count, ambiguous_count, error_message
        FROM pricing_catalog_snapshots WHERE source = state.source ORDER BY fetched_at DESC LIMIT 1
      ) latest ON true
      ORDER BY state.source`),
      databasePool.query("SELECT * FROM pricing_catalog_snapshots ORDER BY fetched_at DESC LIMIT 12"),
      databasePool.query("SELECT * FROM model_price_versions ORDER BY created_at DESC, id DESC LIMIT 100"),
      databasePool.query(`SELECT * FROM pricing_upstream_catalog
        WHERE is_active = true
          AND source IN ('models.dev', 'openrouter')
          AND (
            model_id IN (
              SELECT DISTINCT CASE WHEN model_substituted = true AND NULLIF(response_model, '') IS NOT NULL THEN response_model ELSE model END
              FROM usage_events
            )
            OR canonical_id IN (
              SELECT DISTINCT CASE WHEN model_substituted = true AND NULLIF(response_model, '') IS NOT NULL THEN response_model ELSE model END
              FROM usage_events
            )
          )
        ORDER BY source, provider_id, model_id`),
      databasePool.query("SELECT count(*)::int AS total FROM pricing_upstream_catalog WHERE source = 'models.dev' AND is_active = true"),
      databasePool.query("SELECT * FROM pricing_model_links")
    ]);

    const priceRows = pricesResult.rows;
    const priceByScope = new Map(priceRows.map((row: any) => [`${row.model}\u0000${row.provider}\u0000${row.service_tier}`, row]));
    const linksByScope = new Map(linksResult.rows.map((row: any) => [`${row.model}\u0000${row.provider}`, row]));
    const modelsDev = catalogResult.rows.filter((row: any) => row.source === "models.dev");
    const openrouter = catalogResult.rows.filter((row: any) => row.source === "openrouter");

    const models = observedResult.rows.map((row: any) => {
      const model = String(row.model);
      const provider = String(row.provider ?? "");
      const scopedPrice = priceByScope.get(`${model}\u0000${provider}\u0000`) as any;
      const sharedPrice = priceByScope.get(`${model}\u0000\u0000`) as any;
      const price = scopedPrice?.available ? scopedPrice : sharedPrice?.available ? sharedPrice : null;
      const link = linksByScope.get(`${model}\u0000${provider}`) ?? linksByScope.get(`${model}\u0000`);
      const match = matchOffering(model, provider, modelsDev);
      const reference = matchOffering(model, provider, openrouter);
      return {
        model, provider,
        requests: Number(row.requests),
        totalTokens: String(row.total_tokens),
        pricedRequests: Number(row.priced_requests),
        pricingStatus: price ? "priced" : "unpriced",
        priceMode: price?.mode ?? null,
        price,
        link: link ?? null,
        matchStatus: link ? "linked" : match.status,
        matchKind: link ? "linked" : match.matchKind ?? null,
        candidates: match.candidates.map((candidate: any) => ({
          providerId: candidate.provider_id,
          modelId: candidate.model_id,
          name: candidate.name,
          inputPricePer1M: candidate.input_price_per_1m,
          outputPricePer1M: candidate.output_price_per_1m,
          cacheReadPricePer1M: candidate.cache_read_price_per_1m,
          cacheWritePricePer1M: candidate.cache_write_price_per_1m,
          contextLength: candidate.context_length
        })),
        referenceCandidates: reference.candidates.map((candidate: any) => ({
          providerId: candidate.provider_id,
          modelId: candidate.model_id,
          name: candidate.name,
          inputPricePer1M: candidate.input_price_per_1m,
          outputPricePer1M: candidate.output_price_per_1m
        }))
      };
    });
    const pricedModels = models.filter((model: any) => model.pricingStatus === "priced").length;
    const ambiguousModels = models.filter((model: any) => model.matchStatus === "ambiguous").length;

    return NextResponse.json({
      summary: {
        observedModels: models.length,
        pricedModels,
        unpricedModels: models.length - pricedModels,
        ambiguousModels,
        catalogOfferings: Number(catalogCountResult.rows[0]?.total ?? 0)
      },
      models,
      prices: priceRows,
      channels: channelsResult.rows,
      channelVersions: channelVersionsResult.rows,
      syncState: syncResult.rows,
      snapshots: snapshotsResult.rows,
      priceVersions: versionsResult.rows
    });
  } catch (error) {
    console.error("/api/pricing GET failed:", error);
    return NextResponse.json({ error: "Failed to load pricing data" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    ensureDbEnv();
    const parsed = priceSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    validateTiers(parsed.data.tiers);
    const data = parsed.data;
    const result = await databasePool.query(
      `INSERT INTO model_prices (
        model, provider, service_tier, input_price_per_1m, cached_input_price_per_1m,
        output_price_per_1m, cache_write_price_per_1m, price_multiplier, tiers,
        source, source_version, upstream_provider_id, upstream_model_id, match_kind,
        mode, synced_at, updated_at, available, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'manual', NULL, NULL, NULL, 'manual', 'custom', NULL, now(), true, 'dashboard')
      ON CONFLICT (model, provider, service_tier) DO UPDATE SET
        input_price_per_1m = EXCLUDED.input_price_per_1m,
        cached_input_price_per_1m = EXCLUDED.cached_input_price_per_1m,
        output_price_per_1m = EXCLUDED.output_price_per_1m,
        cache_write_price_per_1m = EXCLUDED.cache_write_price_per_1m,
        price_multiplier = EXCLUDED.price_multiplier,
        tiers = EXCLUDED.tiers,
        source = 'manual',
        source_version = NULL,
        upstream_provider_id = NULL,
        upstream_model_id = NULL,
        match_kind = 'manual',
        mode = 'custom',
        synced_at = NULL,
        updated_at = now(),
        available = true,
        created_by = 'dashboard'
      RETURNING *`,
      [data.model, data.provider, data.serviceTier, data.inputPricePer1M, data.cachedInputPricePer1M,
        data.outputPricePer1M, data.cacheWritePricePer1M, data.priceMultiplier, JSON.stringify(data.tiers)]
    );
    return NextResponse.json({ ok: true, price: result.rows[0] });
  } catch (error) {
    console.error("/api/pricing POST failed:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to save price" }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  try {
    ensureDbEnv();
    const body = await request.json();
    const model = String(body?.model ?? "").trim();
    const provider = String(body?.provider ?? "");
    const serviceTier = String(body?.serviceTier ?? "");
    if (!model) return NextResponse.json({ error: "model is required" }, { status: 400 });
    const result = await databasePool.query(
      "DELETE FROM model_prices WHERE model = $1 AND provider = $2 AND service_tier = $3 RETURNING model",
      [model, provider, serviceTier]
    );
    if (!result.rowCount) return NextResponse.json({ error: "Price row not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("/api/pricing DELETE failed:", error);
    return NextResponse.json({ error: "Failed to remove price" }, { status: 500 });
  }
}
