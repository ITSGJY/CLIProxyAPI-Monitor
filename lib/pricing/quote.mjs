const SCALE_DIGITS = 12;
const SCALE = 10n ** BigInt(SCALE_DIGITS);
const MAX_COST_NANOS = 9_223_372_036_854_775_807n;

function pow10(power) {
  if (power < 0 || power > 100) throw new Error("decimal exponent is out of range");
  return 10n ** BigInt(power);
}

export function decimalToScaled(value, scaleDigits = SCALE_DIGITS) {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value).trim();
  const match = raw.match(/^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
  if (!match) throw new Error("invalid decimal value");
  const sign = match[1] === "-" ? -1n : 1n;
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) throw new Error("decimal exponent is out of range");
  const digits = BigInt((match[2] + fraction).replace(/^0+(?=\d)/, ""));
  const shift = scaleDigits - fraction.length + exponent;
  if (shift >= 0) return sign * digits * pow10(shift);
  const divisor = pow10(-shift);
  const quotient = digits / divisor;
  const remainder = digits % divisor;
  return sign * (quotient + (remainder * 2n >= divisor ? 1n : 0n));
}

function roundHalfUp(numerator, denominator) {
  if (denominator <= 0n) throw new Error("denominator must be positive");
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return quotient + (remainder * 2n >= denominator ? 1n : 0n);
}

function integerTokens(value) {
  if (value === null || value === undefined || value === "") return 0n;
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new Error("token counts must be non-negative integers");
  return BigInt(text);
}

function normalizeTierName(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function resolveServiceTier(event = {}) {
  const candidates = [
    event.billedServiceTier,
    event.responseServiceTier,
    event.serviceTier,
    event.effectiveServiceTier
  ];
  for (const candidate of candidates) {
    const value = normalizeTierName(candidate);
    if (value && value !== "auto") return value;
  }
  return "";
}

function localMinutes(timestamp, timeZone) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error("request timestamp is invalid");
  const zone = timeZone || "UTC";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) throw new Error("time zone could not resolve a local time");
  return hour * 60 + minute;
}

function validHHMM(value) {
  return Number.isInteger(value) && value >= 0 && value <= 2359 && value % 100 < 60;
}

function inWindow(minute, start, end) {
  if (!validHHMM(start) || !validHHMM(end) || start === end) return false;
  const startMinute = Math.floor(start / 100) * 60 + start % 100;
  const endMinute = Math.floor(end / 100) * 60 + end % 100;
  return startMinute < endMinute
    ? minute >= startMinute && minute < endMinute
    : minute >= startMinute || minute < endMinute;
}

function tierMatches(tier, context) {
  const serviceTiers = Array.isArray(tier.service_tiers)
    ? tier.service_tiers.map(normalizeTierName).filter(Boolean)
    : [];
  if (serviceTiers.length && !serviceTiers.includes(context.serviceTier)) return false;
  const minPrompt = Number(tier.min_prompt_tokens ?? 0);
  if (!Number.isSafeInteger(minPrompt) || minPrompt < 0) throw new Error("tier min_prompt_tokens is invalid");
  if (minPrompt > 0 && context.inputTokens < BigInt(minPrompt)) return false;

  const start = tier.utc_start;
  const end = tier.utc_end;
  if (start !== undefined || end !== undefined) {
    if (start === undefined || end === undefined) throw new Error("tier time window needs both utc_start and utc_end");
    const minute = localMinutes(context.timestamp, tier.time_zone || "UTC");
    if (!inWindow(minute, Number(start), Number(end))) return false;
  } else if (tier.time_zone) {
    throw new Error("tier time_zone requires a time window");
  }
  return serviceTiers.length > 0 || minPrompt > 0 || start !== undefined;
}

function tierPriority(tier, index) {
  return {
    service: Array.isArray(tier.service_tiers) && tier.service_tiers.length > 0 ? 1 : 0,
    prompt: Number(tier.min_prompt_tokens ?? 0),
    window: tier.utc_start !== undefined && tier.utc_end !== undefined ? 1 : 0,
    index
  };
}

export function selectPriceTier(tiers, context) {
  if (!Array.isArray(tiers)) throw new Error("price tiers must be an array");
  let selected = null;
  for (let index = 0; index < tiers.length; index += 1) {
    const tier = tiers[index];
    if (!tier || typeof tier !== "object" || Array.isArray(tier)) throw new Error("price tier must be an object");
    if (!tierMatches(tier, context)) continue;
    if (!selected) {
      selected = { index, tier };
      continue;
    }
    const candidatePriority = tierPriority(tier, index);
    const currentPriority = tierPriority(selected.tier, selected.index);
    if (
      candidatePriority.service > currentPriority.service ||
      (candidatePriority.service === currentPriority.service && candidatePriority.prompt > currentPriority.prompt) ||
      (candidatePriority.service === currentPriority.service && candidatePriority.prompt === currentPriority.prompt && candidatePriority.window > currentPriority.window)
    ) {
      selected = { index, tier };
    }
  }
  return selected;
}

function rateOrInherit(tier, tierKey, baseValue) {
  if (!tier || !Object.prototype.hasOwnProperty.call(tier, tierKey)) return baseValue;
  return tier[tierKey];
}

function buildTokenBuckets(event) {
  const input = integerTokens(event.inputTokens);
  const output = integerTokens(event.outputTokens);
  const explicitWrite = integerTokens(event.cacheCreationTokens);
  const cached = integerTokens(event.cachedTokens);
  const explicitRead = integerTokens(event.cacheReadTokens);
  if (explicitWrite > input || cached > input) {
    throw new Error("cache token counts exceed total input tokens");
  }
  const cacheWrite = explicitWrite;
  // cached_tokens is cache-read usage when no dedicated read field exists;
  // cache creation/write tokens are a separate bucket and must not be subtracted.
  const cacheRead = event.cacheReadTokens === null || event.cacheReadTokens === undefined
    ? cached
    : explicitRead;
  if (cacheRead > input - cacheWrite) {
    throw new Error("cache read and write token buckets exceed total input tokens");
  }
  const uncached = input - cacheRead - cacheWrite;  return { input, output, uncached, cacheRead, cacheWrite };
}

function accountingIsUnresolved(accounting) {
  if (!accounting || typeof accounting !== "object") return false;
  const status = normalizeTierName(accounting.status ?? accounting.quality ?? accounting.breakdown?.quality);
  return Boolean(status && !["complete", "valid", "canonical", "verified", "reconciled", "exact"].includes(status));
}

export function quoteUsage(price, channelMultiplier, event) {
  if (!price || price.available === false) return { status: "unpriced", reason: "no_effective_price" };
  if (accountingIsUnresolved(event.tokenAccounting)) {
    return { status: "unpriced", reason: "token_accounting_unresolved" };
  }

  try {
    const buckets = buildTokenBuckets(event);
    const serviceTier = resolveServiceTier(event);
    const timestamp = event.occurredAt ?? event.timestamp ?? event.timestampMs;
    const selected = selectPriceTier(price.tiers ?? [], {
      inputTokens: buckets.input,
      timestamp,
      serviceTier
    });
    const tier = selected?.tier ?? null;
    const rates = {
      input: rateOrInherit(tier, "prompt_price_per_1m", price.input_price_per_1m),
      output: rateOrInherit(tier, "completion_price_per_1m", price.output_price_per_1m),
      cacheRead: rateOrInherit(tier, "cache_read_price_per_1m", price.cached_input_price_per_1m),
      cacheWrite: rateOrInherit(tier, "cache_write_price_per_1m", price.cache_write_price_per_1m)
    };
    const modelMultiplier = decimalToScaled(price.price_multiplier ?? "1");
    const channelScale = decimalToScaled(channelMultiplier ?? "1");
    if (modelMultiplier === null || modelMultiplier <= 0n || channelScale === null || channelScale <= 0n) {
      throw new Error("price multipliers must be positive");
    }

    const pricedBuckets = [
      ["input", buckets.uncached, rates.input],
      ["output", buckets.output, rates.output],
      ["cache_read", buckets.cacheRead, rates.cacheRead],
      ["cache_write", buckets.cacheWrite, rates.cacheWrite]
    ];
    let sum = 0n;
    const breakdownBuckets = [];
    for (const [kind, tokens, rawRate] of pricedBuckets) {
      if (tokens === 0n) {
        breakdownBuckets.push({ kind, tokens: "0", rate_per_1m: rawRate === null || rawRate === undefined ? null : String(rawRate) });
        continue;
      }
      const rate = decimalToScaled(rawRate);
      if (rate === null || rate < 0n) throw new Error(`missing or invalid ${kind} price`);
      sum += tokens * rate;
      breakdownBuckets.push({ kind, tokens: tokens.toString(), rate_per_1m: String(rawRate) });
    }

    // USD/M tokens × tokens × model multiplier × channel multiplier → USD nanos.
    const costNanos = roundHalfUp(sum * modelMultiplier * channelScale * 1000n, SCALE * SCALE * SCALE);
    if (costNanos > MAX_COST_NANOS) throw new Error("quoted cost exceeds the PostgreSQL bigint storage range");
    return {
      status: "priced",
      costNanos: costNanos.toString(),
      currency: "USD",
      priceTierIndex: selected?.index ?? null,
      resolvedServiceTier: serviceTier || null,
      breakdown: {
        policy_version: 1,
        buckets: breakdownBuckets,
        model_multiplier: String(price.price_multiplier ?? "1"),
        channel_multiplier: String(channelMultiplier ?? "1"),
        selected_tier_index: selected?.index ?? null,
        selected_tier: tier,
        total_cost_nanos: costNanos.toString()
      }
    };
  } catch (error) {
    return {
      status: "invalid_price",
      reason: error instanceof Error ? error.message : "invalid_price"
    };
  }
}

async function selectPriceVersion(client, model, provider, serviceTier, at) {
  const result = await client.query(
    `SELECT id, model, provider, service_tier, input_price_per_1m, cached_input_price_per_1m,
            output_price_per_1m, cache_write_price_per_1m, price_multiplier, tiers, currency,
            source, source_version, upstream_provider_id, upstream_model_id, match_kind, mode, available
       FROM model_price_versions
      WHERE model = $1
        AND provider IS NOT DISTINCT FROM $2
        AND (service_tier IS NULL OR service_tier = $3)
        AND valid_from <= $4
        AND (valid_to IS NULL OR valid_to > $4)
      ORDER BY (service_tier IS NOT NULL) DESC, valid_from DESC, id DESC
      LIMIT 1`,
    [model, provider, serviceTier || null, at]
  );
  return result.rows[0] ?? null;
}

export async function lockUsagePrice(client, event) {
  const model = event.modelSubstituted && event.responseModel ? event.responseModel : event.model;
  const provider = event.provider || null;
  const serviceTier = resolveServiceTier(event);
  const at = event.occurredAt;
  let price = provider ? await selectPriceVersion(client, model, provider, serviceTier, at) : null;
  if (!price || price.available === false) {
    price = await selectPriceVersion(client, model, null, serviceTier, at);
  }
  if (!price || price.available === false) {
    return {
      priceVersionId: null,
      channelVersionId: null,
      priceTierIndex: null,
      resolvedServiceTier: serviceTier || null,
      costNanos: null,
      costCurrency: "USD",
      pricingStatus: "unpriced",
      costBreakdown: { reason: "no_effective_price", model }
    };
  }

  let channelMultiplier = "1";
  let channelVersionId = null;
  if (provider) {
    const channelResult = await client.query(
      `SELECT id, available, multiplier
         FROM pricing_channel_versions
        WHERE channel = $1 AND effective_from <= $2
        ORDER BY effective_from DESC, id DESC
        LIMIT 1`,
      [provider, at]
    );
    const channel = channelResult.rows[0];
    if (channel) {
      channelVersionId = Number(channel.id);
      channelMultiplier = channel.available ? channel.multiplier : "1";
    }
  }

  const quote = quoteUsage(price, channelMultiplier, event);
  return {
    priceVersionId: Number(price.id),
    channelVersionId,
    priceTierIndex: quote.priceTierIndex ?? null,
    resolvedServiceTier: quote.resolvedServiceTier ?? (serviceTier || null),
    costNanos: quote.costNanos ?? null,
    costCurrency: price.currency ?? "USD",
    pricingStatus: quote.status,
    costBreakdown: quote.breakdown ?? { reason: quote.reason ?? "invalid_price" }
  };
}
