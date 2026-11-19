import assert from "node:assert/strict";
import { test } from "node:test";
import { decimalToScaled, lockUsagePrice, quoteUsage, selectPriceTier } from "../../lib/pricing/quote.mjs";

const basePrice = {
  input_price_per_1m: "2",
  cached_input_price_per_1m: "0.5",
  output_price_per_1m: "8",
  cache_write_price_per_1m: "1",
  price_multiplier: "1",
  tiers: []
};

test("quotes four disjoint token buckets and applies model/channel multipliers once", () => {
  const result = quoteUsage(
    { ...basePrice, price_multiplier: "1.5" },
    "0.5",
    { inputTokens: 1000, outputTokens: 200, cachedTokens: 400, cacheReadTokens: 300, cacheCreationTokens: 100, occurredAt: "2026-11-19T12:00:00Z" }
  );
  assert.equal(result.status, "priced");
  // 600*2 + 200*8 + 300*0.5 + 100*1 = 3050 USD/M tokens; × 1.5 × 0.5 × 1000 nanos.
  assert.equal(result.costNanos, "2287500");
  assert.deepEqual(result.breakdown.buckets.map((bucket) => bucket.tokens), ["600", "200", "300", "100"]);
});
test("treats cached_tokens as cache-read tokens when cache-write is a separate field", () => {
  const result = quoteUsage(basePrice, "1", {
    inputTokens: 1000,
    outputTokens: 0,
    cachedTokens: 400,
    cacheCreationTokens: 100,
    occurredAt: "2026-11-19T12:00:00Z"
  });
  assert.equal(result.status, "priced");
  assert.deepEqual(result.breakdown.buckets.map((bucket) => bucket.tokens), ["500", "0", "400", "100"]);
});

test("reasoning tokens are not added to output a second time", () => {
  const result = quoteUsage(basePrice, "1", {
    inputTokens: 0,
    outputTokens: 100,
    reasoningTokens: 60,
    occurredAt: "2026-11-19T12:00:00Z"
  });
  assert.equal(result.costNanos, "800000");
});
test("accepts CPA canonical token accounting status without double-counting", () => {
  const result = quoteUsage(basePrice, "1", {
    inputTokens: 100,
    outputTokens: 20,
    cachedTokens: 10,
    cacheReadTokens: 10,
    tokenAccounting: { version: 1, status: "canonical" },
    occurredAt: "2026-11-19T12:00:00Z"
  });
  assert.equal(result.status, "priced");
});

test("fails closed on unresolved token accounting and inconsistent cache buckets", () => {
  const unresolved = quoteUsage(basePrice, "1", {
    inputTokens: 100, outputTokens: 20,
    tokenAccounting: { status: "estimated" },
    occurredAt: "2026-11-19T12:00:00Z"
  });
  const inconsistent = quoteUsage(basePrice, "1", {
    inputTokens: 10, outputTokens: 0, cacheCreationTokens: 11,
    occurredAt: "2026-11-19T12:00:00Z"
  });
  assert.equal(unresolved.status, "unpriced");
  assert.equal(inconsistent.status, "invalid_price");
});

test("rejects a quote that cannot fit the persisted bigint cost field", () => {
  const result = quoteUsage({
    ...basePrice,
    input_price_per_1m: "999999999999999999"
  }, "100", {
    inputTokens: 9000000000000,
    outputTokens: 0,
    occurredAt: "2026-11-19T12:00:00Z"
  });
  assert.equal(result.status, "invalid_price");
});

test("missing cache-write price is invalid only when cache-write tokens are present", () => {
  const withoutWrite = quoteUsage({ ...basePrice, cache_write_price_per_1m: null }, "1", {
    inputTokens: 10, outputTokens: 0, cacheCreationTokens: 0, occurredAt: "2026-11-19T12:00:00Z"
  });
  const withWrite = quoteUsage({ ...basePrice, cache_write_price_per_1m: null }, "1", {
    inputTokens: 10, outputTokens: 0, cacheCreationTokens: 5, occurredAt: "2026-11-19T12:00:00Z"
  });
  assert.equal(withoutWrite.status, "priced");
  assert.equal(withWrite.status, "invalid_price");
});

test("selects service-tier rules before long-context and window rules, without stacking", () => {
  const tiers = [
    { min_prompt_tokens: 100, prompt_price_per_1m: 1 },
    { service_tiers: ["priority"], prompt_price_per_1m: 2 },
    { utc_start: 900, utc_end: 1700, time_zone: "UTC", prompt_price_per_1m: 3 }
  ];
  const selected = selectPriceTier(tiers, {
    inputTokens: 1000n,
    timestamp: "2026-11-19T12:00:00Z",
    serviceTier: "priority"
  });
  assert.equal(selected.index, 1);
});

test("time windows use the configured IANA zone and support midnight wrap", () => {
  const tiers = [{ utc_start: 2200, utc_end: 200, time_zone: "Asia/Shanghai", prompt_price_per_1m: 0 }];
  const selected = selectPriceTier(tiers, {
    inputTokens: 1n,
    timestamp: "2026-11-19T16:30:00Z",
    serviceTier: ""
  });
  assert.equal(selected.index, 0);
});

test("invalid time zones fail closed", () => {
  const result = quoteUsage({
    ...basePrice,
    tiers: [{ utc_start: 900, utc_end: 1700, time_zone: "Mars/Olympus", prompt_price_per_1m: 1 }]
  }, "1", { inputTokens: 1, outputTokens: 0, occurredAt: "2026-11-19T12:00:00Z" });
  assert.equal(result.status, "invalid_price");
});

test("decimal parsing handles scientific notation without floating point", () => {
  assert.equal(decimalToScaled("7.5e-7").toString(), "750000");
  assert.equal(decimalToScaled("1.2300000000005").toString(), "1230000000001");
});
test("locks the provider-scoped price and the event-time channel multiplier version", async () => {
  const calls = [];
  const priceVersion = {
    id: "22", model: "gpt-test", provider: "relay", service_tier: "priority",
    input_price_per_1m: "1", cached_input_price_per_1m: "0.5",
    output_price_per_1m: "2", cache_write_price_per_1m: "1",
    price_multiplier: "1.25", tiers: [], currency: "USD", available: true
  };
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("FROM model_price_versions")) return { rows: [priceVersion] };
      if (sql.includes("FROM pricing_channel_versions")) return { rows: [{ id: "7", available: true, multiplier: "2" }] };
      throw new Error("unexpected SQL in quote lock test");
    }
  };
  const result = await lockUsagePrice(client, {
    model: "gpt-test", provider: "relay", inputTokens: 100, outputTokens: 10,
    cachedTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    billedServiceTier: "priority", occurredAt: "2026-11-19T12:00:00Z"
  });
  assert.equal(result.pricingStatus, "priced");
  assert.equal(result.priceVersionId, 22);
  assert.equal(result.channelVersionId, 7);
  assert.equal(result.resolvedServiceTier, "priority");
  assert.equal(result.costNanos, "300000");
  assert.equal(calls[0].params[1], "relay");
  assert.equal(calls[0].params[2], "priority");
});
