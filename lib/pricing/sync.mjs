import { createHash } from "node:crypto";
import {
  catalogSha256,
  matchExactOffering,
  normalizeModelsDevCatalog,
  normalizeOpenRouterCatalog
} from "./catalog.mjs";

const SOURCES = {
  "models.dev": {
    url: "https://models.dev/api.json?type=all",
    normalize: normalizeModelsDevCatalog
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/models",
    normalize: normalizeOpenRouterCatalog
  }
};

function safeError(error) {
  return String(error instanceof Error ? error.message : error ?? "unknown error")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/(postgres(?:ql)?:\/\/[^:\/@\s]+:)[^@\/\s]+@/gi, "$1[redacted]@")
    .slice(0, 500);
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

async function persistCatalog(client, source, offerings, snapshotSha, sourceVersion) {
  await client.query("UPDATE pricing_upstream_catalog SET is_active = false WHERE source = $1", [source]);
  for (const batch of chunks(offerings, 80)) {
    const values = [];
    const parameters = [];
    let index = 1;
    for (const offer of batch) {
      values.push(`($${index++}, $${index++}, $${index++}, $${index++}, $${index++}, $${index++},
        $${index++}, $${index++}, $${index++}, $${index++}, $${index++}::jsonb, $${index++}::jsonb,
        $${index++}, $${index++}, true, now())`);
      parameters.push(
        source, offer.providerId, offer.modelId, offer.name, offer.canonicalId, offer.contextLength,
        offer.inputPricePer1M, offer.outputPricePer1M, offer.cacheReadPricePer1M, offer.cacheWritePricePer1M,
        JSON.stringify(offer.tiers ?? []), JSON.stringify(offer.metadata ?? {}),
        sourceVersion, snapshotSha
      );
    }
    await client.query(
      `INSERT INTO pricing_upstream_catalog (
        source, provider_id, model_id, name, canonical_id, context_length,
        input_price_per_1m, output_price_per_1m, cache_read_price_per_1m, cache_write_price_per_1m,
        tiers, metadata, source_version, snapshot_sha, is_active, synced_at
      ) VALUES ${values.join(",")}
      ON CONFLICT (source, provider_id, model_id) DO UPDATE SET
        name = EXCLUDED.name, canonical_id = EXCLUDED.canonical_id, context_length = EXCLUDED.context_length,
        input_price_per_1m = EXCLUDED.input_price_per_1m, output_price_per_1m = EXCLUDED.output_price_per_1m,
        cache_read_price_per_1m = EXCLUDED.cache_read_price_per_1m, cache_write_price_per_1m = EXCLUDED.cache_write_price_per_1m,
        tiers = EXCLUDED.tiers, metadata = EXCLUDED.metadata, source_version = EXCLUDED.source_version,
        snapshot_sha = EXCLUDED.snapshot_sha, is_active = true, synced_at = now()`,
      parameters
    );
  }
}

async function applyModelsDevPrices(client, offerings, snapshotSha) {
  const existing = await client.query(
    `SELECT model, provider, service_tier, mode, source, available,
            input_price_per_1m, cached_input_price_per_1m, output_price_per_1m,
            cache_write_price_per_1m, price_multiplier, tiers,
            upstream_provider_id, upstream_model_id, match_kind
       FROM model_prices
      WHERE service_tier = ''`
  );
  const existingByKey = new Map(existing.rows.map((row) => [`${row.model}\\u0000${row.provider}`, row]));
  const linksResult = await client.query(
    "SELECT model, provider, source, upstream_provider_id, upstream_model_id FROM pricing_model_links"
  );
  const links = new Map(linksResult.rows.map((row) => [`${row.model}\\u0000${row.provider}`, row]));
  const catalogByIdentity = new Map(offerings.map((offer) => [`${offer.providerId}\\u0000${offer.modelId}`, offer]));

  // Linked prices are only valid while their explicit link and upstream offering still exist.
  await client.query(
    `UPDATE model_prices price
        SET available = false, updated_at = now()
      WHERE price.source = 'models.dev'
        AND price.mode = 'linked'
        AND price.service_tier = ''
        AND price.available = true
        AND (
          NOT EXISTS (
            SELECT 1 FROM pricing_model_links link
             WHERE link.model = price.model
               AND link.provider = price.provider
               AND link.source = 'models.dev'
          )
          OR NOT EXISTS (
            SELECT 1 FROM pricing_upstream_catalog offering
             WHERE offering.source = 'models.dev'
               AND offering.provider_id = price.upstream_provider_id
               AND offering.model_id = price.upstream_model_id
               AND offering.is_active = true
               AND offering.input_price_per_1m IS NOT NULL
               AND offering.output_price_per_1m IS NOT NULL
          )
        )`
  );

  // Revalidate old Auto mappings against the new complete snapshot. Ambiguous or
  // incomplete matches are disabled rather than silently billing with stale rates.
  for (const row of existing.rows) {
    if (row.source !== "models.dev" || row.mode !== "auto" || row.available !== true || row.service_tier !== "") continue;
    const match = matchExactOffering(row.model, row.provider, offerings);
    const safeSharedMatch = !(row.provider === "" && match.matchKind === "exact_provider" && match.candidates.length > 1);
    if (
      match.status !== "matched" ||
      !match.offering ||
      match.offering.inputPricePer1M === null ||
      match.offering.outputPricePer1M === null ||
      !safeSharedMatch
    ) {
      await client.query(
        `UPDATE model_prices
            SET available = false, updated_at = now()
          WHERE model = $1 AND provider = $2 AND service_tier = ''
            AND source = 'models.dev' AND mode = 'auto' AND available = true`,
        [row.model, row.provider]
      );
      const existingAuto = existingByKey.get(`${row.model}\\u0000${row.provider}`);
      if (existingAuto) existingAuto.available = false;
    }
  }

  const observed = await client.query(
    `SELECT
       CASE WHEN model_substituted = true AND NULLIF(response_model, '') IS NOT NULL THEN response_model ELSE model END AS model,
       COALESCE(provider, '') AS provider,
       count(*)::bigint AS requests
     FROM usage_events
     GROUP BY 1, 2
     ORDER BY 1, 2`
  );

  let matchedCount = 0;
  let ambiguousCount = 0;
  let updatedPriceCount = 0;
  for (const usage of observed.rows) {
    const model = usage.model;
    const provider = usage.provider ?? "";
    const key = `${model}\\u0000${provider}`;
    const globalKey = `${model}\\u0000`;
    const scopedCurrent = existingByKey.get(key);
    const globalCurrent = existingByKey.get(globalKey);

    if (scopedCurrent?.mode === "custom" || (!scopedCurrent && globalCurrent?.mode === "custom")) continue;

    const scopedLink = links.get(key);
    const globalLink = links.get(globalKey);
    const link = scopedLink ?? globalLink;
    if (!link && (scopedCurrent?.mode === "linked" || (!scopedCurrent && globalCurrent?.mode === "linked"))) continue;

    let offering;
    let matchKind;
    let mode = "auto";
    let priceScope = "";
    if (link) {
      offering = catalogByIdentity.get(`${link.upstream_provider_id}\\u0000${link.upstream_model_id}`);
      if (!offering || link.source !== "models.dev") continue;
      matchKind = "linked";
      mode = "linked";
      priceScope = scopedLink ? provider : "";
      if (globalLink && !scopedLink && provider) {
        await client.query(
          `UPDATE model_prices
              SET available = false, updated_at = now()
            WHERE model = $1 AND provider = $2 AND service_tier = ''
              AND source = 'models.dev' AND mode = 'auto' AND available = true`,
          [model, provider]
        );
        if (scopedCurrent?.mode === "auto") scopedCurrent.available = false;
      }
    } else {
      const match = matchExactOffering(model, provider, offerings);
      if (match.status === "ambiguous") {
        ambiguousCount += 1;
        continue;
      }
      if (match.status !== "matched") continue;
      offering = match.offering;
      matchKind = match.matchKind;
      // A unique offering is a shared price. A provider-specific match among
      // different Provider Offerings must remain scoped to the CPA channel.
      priceScope = match.candidates.length > 1 && matchKind === "exact_provider" ? provider : "";
    }

    if (offering.inputPricePer1M === null || offering.outputPricePer1M === null) continue;
    const scopeKey = `${model}\\u0000${priceScope}`;
    const current = existingByKey.get(scopeKey);
    if (current?.mode === "custom") continue;
    if (current?.mode === "linked" && mode !== "linked") continue;

    const nextPrice = {
      input: offering.inputPricePer1M,
      cacheRead: offering.cacheReadPricePer1M ?? offering.inputPricePer1M,
      output: offering.outputPricePer1M,
      cacheWrite: offering.cacheWritePricePer1M ?? offering.inputPricePer1M,
      tiers: JSON.stringify(offering.tiers ?? [])
    };
    const changed = !current ||
      current.available !== true ||
      current.mode !== mode ||
      String(current.input_price_per_1m) !== String(nextPrice.input) ||
      String(current.cached_input_price_per_1m) !== String(nextPrice.cacheRead) ||
      String(current.output_price_per_1m) !== String(nextPrice.output) ||
      String(current.cache_write_price_per_1m) !== String(nextPrice.cacheWrite) ||
      String(current.upstream_provider_id ?? "") !== offering.providerId ||
      String(current.upstream_model_id ?? "") !== offering.modelId ||
      String(current.match_kind ?? "") !== matchKind ||
      JSON.stringify(current.tiers ?? []) !== nextPrice.tiers;

    await client.query(
      `INSERT INTO model_prices (
        model, provider, service_tier, input_price_per_1m, cached_input_price_per_1m,
        output_price_per_1m, cache_write_price_per_1m, price_multiplier, tiers,
        source, source_version, upstream_provider_id, upstream_model_id, match_kind,
        mode, synced_at, updated_at, available
      ) VALUES ($1, $2, '', $3, $4, $5, $6, 1, $7::jsonb, 'models.dev', $8, $9, $10, $11, $12, now(), now(), true)
      ON CONFLICT (model, provider, service_tier) DO UPDATE SET
        input_price_per_1m = EXCLUDED.input_price_per_1m,
        cached_input_price_per_1m = EXCLUDED.cached_input_price_per_1m,
        output_price_per_1m = EXCLUDED.output_price_per_1m,
        cache_write_price_per_1m = EXCLUDED.cache_write_price_per_1m,
        tiers = EXCLUDED.tiers,
        source = EXCLUDED.source,
        source_version = EXCLUDED.source_version,
        upstream_provider_id = EXCLUDED.upstream_provider_id,
        upstream_model_id = EXCLUDED.upstream_model_id,
        match_kind = EXCLUDED.match_kind,
        mode = EXCLUDED.mode,
        synced_at = now(),
        updated_at = now(),
        available = true
      WHERE model_prices.mode = 'auto' OR (model_prices.mode = 'linked' AND EXCLUDED.mode = 'linked')`,
      [
        model, priceScope, nextPrice.input, nextPrice.cacheRead, nextPrice.output, nextPrice.cacheWrite,
        nextPrice.tiers, snapshotSha, offering.providerId, offering.modelId, matchKind, mode
      ]
    );

    existingByKey.set(scopeKey, {
      model, provider: priceScope, service_tier: "", mode, source: "models.dev", available: true,
      input_price_per_1m: nextPrice.input, cached_input_price_per_1m: nextPrice.cacheRead,
      output_price_per_1m: nextPrice.output, cache_write_price_per_1m: nextPrice.cacheWrite,
      price_multiplier: "1", tiers: JSON.parse(nextPrice.tiers),
      upstream_provider_id: offering.providerId, upstream_model_id: offering.modelId, match_kind: matchKind
    });
    matchedCount += 1;
    if (changed) updatedPriceCount += 1;
  }
  return { matchedCount, ambiguousCount, updatedPriceCount };
}
async function syncOneSource(pool, source, { force = false } = {}) {
  const definition = SOURCES[source];
  if (!definition) throw new Error(`unsupported pricing source: ${source}`);
  const client = await pool.connect();
  const lockKey = `cliproxyapi-monitor:pricing-sync:${source}`;
  let locked = false;
  try {
    const lockResult = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [lockKey]);
    locked = lockResult.rows[0]?.locked === true;
    if (!locked) return { source, status: "busy" };

    const stateResult = await client.query("SELECT etag, last_modified, last_hash FROM pricing_sync_state WHERE source = $1", [source]);
    const state = stateResult.rows[0] ?? {};
    const headers = { accept: "application/json" };
    if (!force && state.etag) headers["if-none-match"] = state.etag;
    if (!force && state.last_modified) headers["if-modified-since"] = state.last_modified;

    const response = await fetch(definition.url, { headers, signal: AbortSignal.timeout(30_000) });
    const fetchedAt = new Date();
    if (response.status === 304) {
      await client.query(
        `UPDATE pricing_sync_state
            SET etag = COALESCE($2, etag),
                last_modified = COALESCE($3, last_modified),
                last_success_at = now(), last_error = NULL, updated_at = now()
          WHERE source = $1`,
        [source, response.headers.get("etag"), response.headers.get("last-modified")]
      );
      await client.query(
        `INSERT INTO pricing_catalog_snapshots (source, snapshot_sha, etag, last_modified, status, fetched_at)
         VALUES ($1, $2, $3, $4, 'not_modified', $5)`,
        [source, state.last_hash, response.headers.get("etag") ?? state.etag, response.headers.get("last-modified") ?? state.last_modified, fetchedAt]
      );
      return { source, status: "not_modified", snapshotSha: state.last_hash };
    }
    if (!response.ok) throw new Error(`${source} returned HTTP ${response.status}`);

    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > 15_000_000) throw new Error(`${source} response exceeds the 15 MB catalog limit`);
    const raw = await response.text();
    if (raw.length > 15_000_000) throw new Error(`${source} response exceeds the 15 MB catalog limit`);
    const payload = JSON.parse(raw);
    const offerings = definition.normalize(payload);
    if (!offerings.length) throw new Error(`${source} returned no model offerings; the previous catalog was preserved`);
    const snapshotSha = catalogSha256(raw);
    const sourceVersion = response.headers.get("last-modified") ?? response.headers.get("etag") ?? snapshotSha;
    const providerCount = new Set(offerings.map((offer) => offer.providerId)).size;
    let matchSummary = { matchedCount: 0, ambiguousCount: 0, updatedPriceCount: 0 };

    await client.query("BEGIN");
    try {
      await persistCatalog(client, source, offerings, snapshotSha, sourceVersion);
      if (source === "models.dev") {
        matchSummary = await applyModelsDevPrices(client, offerings, snapshotSha);
      }
      await client.query(
        `INSERT INTO pricing_catalog_snapshots (
          source, snapshot_sha, source_version, etag, last_modified, status,
          provider_count, model_count, matched_count, ambiguous_count, updated_price_count, fetched_at
        ) VALUES ($1, $2, $3, $4, $5, 'success', $6, $7, $8, $9, $10, $11)`,
        [
          source, snapshotSha, sourceVersion, response.headers.get("etag"),
          response.headers.get("last-modified"), providerCount, offerings.length,
          matchSummary.matchedCount, matchSummary.ambiguousCount, matchSummary.updatedPriceCount, fetchedAt
        ]
      );
      await client.query(
        `UPDATE pricing_sync_state
            SET etag = $2, last_modified = $3, last_hash = $4, last_success_at = now(),
                last_error = NULL, updated_at = now()
          WHERE source = $1`,
        [source, response.headers.get("etag"), response.headers.get("last-modified"), snapshotSha]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    return {
      source, status: "success", snapshotSha, providerCount, modelCount: offerings.length,
      ...matchSummary
    };
  } catch (error) {
    const message = safeError(error);
    try {
      await client.query("UPDATE pricing_sync_state SET last_error = $2, updated_at = now() WHERE source = $1", [source, message]);
      const failedSha = createHash("sha256").update(`failed:${source}:${message}`).digest("hex");
      await client.query(
        `INSERT INTO pricing_catalog_snapshots (source, snapshot_sha, status, error_message, fetched_at)
         VALUES ($1, $2, 'failed', $3, now())`,
        [source, failedSha, message]
      );
    } catch {
      // Preserve the original sync failure; the caller receives a bounded message.
    }
    return { source, status: "failed", error: message };
  } finally {
    if (locked) {
      try { await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]); } catch {}
    }
    client.release();
  }
}

export async function syncPricingCatalogs(pool, { sources = ["models.dev", "openrouter"], force = false } = {}) {
  const results = [];
  for (const source of sources) results.push(await syncOneSource(pool, source, { force }));
  return {
    status: results.every((result) => ["success", "not_modified"].includes(result.status)) ? "success" : "partial",
    results
  };
}

export async function syncPricingIfDue(pool, now = Date.now()) {
  const result = await pool.query(
    "SELECT source, auto_sync_interval_hours, last_success_at FROM pricing_sync_state WHERE auto_sync_interval_hours > 0 ORDER BY source"
  );
  const due = result.rows
    .filter((row) => !row.last_success_at || now - new Date(row.last_success_at).getTime() >= Number(row.auto_sync_interval_hours) * 60 * 60 * 1000)
    .map((row) => row.source);
  if (!due.length) return { status: "not_due", results: [] };
  return syncPricingCatalogs(pool, { sources: due });
}
