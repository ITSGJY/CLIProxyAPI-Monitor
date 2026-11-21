import assert from "node:assert/strict";
import { test } from "node:test";
import { matchExactOffering, normalizeModelsDevCatalog, normalizeOpenRouterCatalog } from "../../lib/pricing/catalog.mjs";

test("normalizes models.dev Provider Offerings without collapsing same-name models", () => {
  const offerings = normalizeModelsDevCatalog({
    openai: { models: { "gpt-test": { id: "gpt-test", cost: { input: 2, output: 8 } } } },
    relay: { models: { "gpt-test": { id: "gpt-test", cost: { input: 4, output: 12 } } } }
  });
  assert.equal(offerings.length, 2);
  assert.equal(offerings[0].cacheReadPricePer1M, "2");
  assert.equal(offerings[0].cacheWritePricePer1M, "2");
  assert.equal(offerings[1].providerId, "relay");
});

test("normalizes OpenRouter per-token prices to per-million reference rates", () => {
  const offerings = normalizeOpenRouterCatalog({
    data: [{
      id: "openai/gpt-test",
      name: "GPT Test",
      context_length: 128000,
      pricing: { prompt: "0.000002", completion: "0.000008", input_cache_read: "0.0000005" }
    }]
  });
  assert.equal(offerings[0].inputPricePer1M, "2");
  assert.equal(offerings[0].outputPricePer1M, "8");
  assert.equal(offerings[0].cacheReadPricePer1M, "0.5");
  assert.equal(offerings[0].cacheWritePricePer1M, "2");
});

test("matches only exact IDs, exact provider identity, or equivalent exact offerings", () => {
  const offerings = [
    { providerId: "openai", modelId: "gpt-test", inputPricePer1M: "2", outputPricePer1M: "8", cacheReadPricePer1M: "1", cacheWritePricePer1M: "2" },
    { providerId: "relay", modelId: "gpt-test", inputPricePer1M: "4", outputPricePer1M: "12", cacheReadPricePer1M: "2", cacheWritePricePer1M: "4" }
  ];
  assert.equal(matchExactOffering("gpt-test", "openai", offerings).offering.providerId, "openai");
  assert.equal(matchExactOffering("gpt-test", "unknown", offerings).status, "ambiguous");
  assert.equal(matchExactOffering("gpt-test-high", "openai", offerings).status, "unmatched");
});
test("uses models.dev canonical_model_id and preserves exact decimal cache prices", () => {
  const offerings = normalizeModelsDevCatalog({
    openai: {
      models: {
        "gpt-canonical": {
          id: "gpt-canonical",
          canonical_model_id: "openai/gpt-canonical",
          cost: { input: "1.123456789012", output: "2.000000000001", cache_read: "0.123456789012", cache_write: "0.25" }
        }
      }
    }
  });
  assert.equal(offerings[0].canonicalId, "openai/gpt-canonical");
  assert.equal(offerings[0].inputPricePer1M, "1.123456789012");
  assert.equal(offerings[0].cacheReadPricePer1M, "0.123456789012");
});

test("converts OpenRouter per-token rates with decimal arithmetic, not floating point", () => {
  const offerings = normalizeOpenRouterCatalog({
    data: [{
      id: "openai/gpt-precise",
      pricing: { prompt: "0.000001234567891234", completion: "1.25e-8" }
    }]
  });
  assert.equal(offerings[0].inputPricePer1M, "1.234567891234");
  assert.equal(offerings[0].outputPricePer1M, "0.0125");
});
