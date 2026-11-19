import { createHash } from "node:crypto";

function scaledDecimal(value, scaleDigits = 12, exponentAdjustment = 0) {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
  if (!match) return null;
  const exponent = Number(match[4] ?? 0) + exponentAdjustment;
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) return null;
  const fraction = match[3] ?? "";
  const digits = BigInt((match[2] + fraction).replace(/^0+(?=\d)/, ""));
  const shift = scaleDigits - fraction.length + exponent;
  if (shift >= 0) return (match[1] === "-" ? -1n : 1n) * digits * (10n ** BigInt(shift));
  const divisor = 10n ** BigInt(-shift);
  const quotient = digits / divisor;
  const remainder = digits % divisor;
  const rounded = quotient + (remainder * 2n >= divisor ? 1n : 0n);
  return (match[1] === "-" ? -1n : 1n) * rounded;
}

function formatScaled(value, scaleDigits = 12) {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const scale = 10n ** BigInt(scaleDigits);
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(scaleDigits, "0").replace(/0+$/, "");
  return sign + whole.toString() + (fraction ? "." + fraction : "");
}

function numericRate(value) {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value).trim();
  const scaled = scaledDecimal(raw);
  if (scaled === null || scaled < 0n || !Number.isFinite(Number(raw))) return null;
  return formatScaled(scaled);
}
function metadataFor(model) {
  const keys = [
    "description", "knowledge", "release_date", "last_updated", "modalities",
    "open_weights", "tool_call", "reasoning", "attachment", "temperature",
    "interleaved", "structured_output", "limit", "provider"
  ];
  return Object.fromEntries(keys.filter((key) => model?.[key] !== undefined).map((key) => [key, model[key]]));
}

export function normalizeModelsDevCatalog(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("models.dev response must be a provider object");
  }
  const offerings = [];
  for (const [providerId, provider] of Object.entries(payload)) {
    if (!provider || typeof provider !== "object" || !provider.models || typeof provider.models !== "object") continue;
    for (const [modelKey, model] of Object.entries(provider.models)) {
      if (!model || typeof model !== "object") continue;
      const modelId = String(model.id ?? modelKey).trim();
      if (!providerId || !modelId) continue;
      const cost = model.cost && typeof model.cost === "object" ? model.cost : {};
      const input = numericRate(cost.input);
      const output = numericRate(cost.output);
      const cacheReadSource = numericRate(cost.cache_read);
      const cacheWriteSource = numericRate(cost.cache_write);
      const tiers = Array.isArray(cost.tiers) ? cost.tiers : Array.isArray(model.tiers) ? model.tiers : [];
      offerings.push({
        source: "models.dev",
        providerId,
        modelId,
        name: String(model.name ?? modelId),
        canonicalId: model.canonical_model_id ?? model.canonical_id ?? model.canonical ?? null,
        contextLength: Number.isSafeInteger(Number(model.limit?.context)) ? Number(model.limit.context) : null,
        inputPricePer1M: input,
        outputPricePer1M: output,
        // Match OMC's conservative cache policy: absent cache rates inherit prompt pricing, never zero.
        cacheReadPricePer1M: cacheReadSource ?? input,
        cacheWritePricePer1M: cacheWriteSource ?? input,
        tiers,
        metadata: {
          ...metadataFor(model),
          cache_read_inferred: cacheReadSource === null && input !== null,
          cache_write_inferred: cacheWriteSource === null && input !== null
        }
      });
    }
  }
  return offerings;
}

function perMillion(value) {
  if (value === null || value === undefined || value === "") return null;
  const scaled = scaledDecimal(value, 12, 6);
  if (scaled === null || scaled < 0n || !Number.isFinite(Number(value))) return null;
  return formatScaled(scaled);
}

export function normalizeOpenRouterCatalog(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : null;
  if (!rows) throw new Error("OpenRouter response must contain a data array");
  const offerings = [];
  for (const model of rows) {
    if (!model || typeof model !== "object" || typeof model.id !== "string") continue;
    const parts = model.id.split("/");
    const providerId = parts.length > 1 ? parts[0] : "openrouter";
    const modelId = parts.length > 1 ? parts.slice(1).join("/") : model.id;
    const pricing = model.pricing && typeof model.pricing === "object" ? model.pricing : {};
    const input = perMillion(pricing.prompt);
    const output = perMillion(pricing.completion);
    const cacheRead = perMillion(pricing.input_cache_read ?? pricing.cache_read);
    const cacheWrite = perMillion(pricing.input_cache_write ?? pricing.cache_write);
    offerings.push({
      source: "openrouter",
      providerId,
      modelId,
      name: String(model.name ?? model.id),
      canonicalId: model.canonical_slug ?? null,
      contextLength: Number.isSafeInteger(Number(model.context_length)) ? Number(model.context_length) : null,
      inputPricePer1M: input,
      outputPricePer1M: output,
      cacheReadPricePer1M: cacheRead ?? input,
      cacheWritePricePer1M: cacheWrite ?? input,
      tiers: Array.isArray(pricing.tiers) ? pricing.tiers : [],
      metadata: {
        description: model.description ?? null,
        architecture: model.architecture ?? null,
        top_provider: model.top_provider ?? null,
        per_request_limits: model.per_request_limits ?? null,
        cache_read_inferred: cacheRead === null && input !== null,
        cache_write_inferred: cacheWrite === null && input !== null
      }
    });
  }
  return offerings;
}

export function catalogSha256(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

function normalizeIdentity(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function priceSignature(offer) {
  return JSON.stringify([
    offer.inputPricePer1M,
    offer.outputPricePer1M,
    offer.cacheReadPricePer1M,
    offer.cacheWritePricePer1M,
    offer.tiers ?? []
  ]);
}

export function matchExactOffering(model, cpaProvider, offerings) {
  const exact = offerings.filter((offer) => offer.modelId === model || offer.canonicalId === model);
  if (!exact.length) return { status: "unmatched", candidates: [] };

  const providerMatches = exact.filter((offer) => normalizeIdentity(offer.providerId) === normalizeIdentity(cpaProvider));
  if (providerMatches.length === 1) {
    return { status: "matched", matchKind: "exact_provider", offering: providerMatches[0], candidates: exact };
  }
  if (providerMatches.length > 1) {
    const signatures = new Set(providerMatches.map(priceSignature));
    if (signatures.size === 1) {
      const offering = [...providerMatches].sort((a, b) => a.providerId.localeCompare(b.providerId))[0];
      return { status: "matched", matchKind: "exact_equivalent_offering", offering, candidates: providerMatches };
    }
    return { status: "ambiguous", candidates: providerMatches };
  }
  if (exact.length === 1) {
    return { status: "matched", matchKind: exact[0].modelId === model ? "exact_unique" : "canonical", offering: exact[0], candidates: exact };
  }
  const signatures = new Set(exact.map(priceSignature));
  if (signatures.size === 1) {
    const offering = [...exact].sort((a, b) => a.providerId.localeCompare(b.providerId))[0];
    return { status: "matched", matchKind: "exact_equivalent_offering", offering, candidates: exact };
  }
  return { status: "ambiguous", candidates: exact };
}
