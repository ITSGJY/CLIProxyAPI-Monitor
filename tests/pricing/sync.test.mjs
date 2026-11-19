import assert from "node:assert/strict";
import { test } from "node:test";
import { syncPricingCatalogs } from "../../lib/pricing/sync.mjs";

function createPool({ observedRows = [], catalogRows = [] } = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (String(sql).includes("pg_try_advisory_lock")) return { rows: [{ locked: true }], rowCount: 1 };
      if (String(sql).includes("SELECT etag, last_modified, last_hash")) return { rows: [], rowCount: 0 };
      if (String(sql).includes("SELECT model, provider, service_tier, mode")) return { rows: catalogRows, rowCount: catalogRows.length };
      if (String(sql).includes("SELECT model, provider, source, upstream_provider_id")) return { rows: [], rowCount: 0 };
      if (String(sql).includes("FROM usage_events")) return { rows: observedRows, rowCount: observedRows.length };
      if (String(sql).includes("pg_advisory_unlock")) return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() {}
  };
  return { pool: { async connect() { return client; } }, calls };
}

test("models.dev sync persists Provider Offerings and only writes safe exact Auto prices", async () => {
  const previousFetch = globalThis.fetch;
  const fixture = {
    openai: {
      models: {
        "gpt-test": {
          id: "gpt-test",
          canonical_model_id: "openai/gpt-test",
          cost: { input: "1.25", output: "10", cache_read: "0.125", cache_write: "1.25" }
        }
      }
    }
  };
  const { pool, calls } = createPool({
    observedRows: [{ model: "gpt-test", provider: "openai", requests: "3" }]
  });
  globalThis.fetch = async () => new Response(JSON.stringify(fixture), {
    status: 200,
    headers: { "content-type": "application/json", etag: '"catalog-v1"' }
  });
  try {
    const result = await syncPricingCatalogs(pool, { sources: ["models.dev"], force: true });
    assert.equal(result.status, "success");
    assert.equal(result.results[0].modelCount, 1);
    assert.equal(result.results[0].matchedCount, 1);
    assert.equal(result.results[0].updatedPriceCount, 1);

    const catalogInsert = calls.find((call) => call.sql.includes("INSERT INTO pricing_upstream_catalog"));
    assert.ok(catalogInsert);
    assert.equal(catalogInsert.params.length, 14);
    assert.equal(catalogInsert.params[0], "models.dev");
    assert.equal(catalogInsert.params[1], "openai");
    assert.equal(catalogInsert.params[2], "gpt-test");

    const priceInsert = calls.find((call) => call.sql.includes("INSERT INTO model_prices"));
    assert.ok(priceInsert);
    assert.equal(priceInsert.params[0], "gpt-test");
    assert.equal(priceInsert.params[1], "");
    assert.equal(priceInsert.params[2], "1.25");
    assert.equal(priceInsert.params[3], "0.125");
    assert.equal(priceInsert.params[4], "10");
    assert.equal(priceInsert.params[5], "1.25");
    assert.equal(priceInsert.params[11], "auto");
    assert.ok(calls.some((call) => call.sql.includes("INSERT INTO pricing_catalog_snapshots")));
    assert.ok(calls.some((call) => call.sql.includes("UPDATE pricing_sync_state")));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("an empty upstream catalog fails closed and does not retire the previous catalog", async () => {
  const previousFetch = globalThis.fetch;
  const { pool, calls } = createPool();
  globalThis.fetch = async () => new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" }
  });
  try {
    const result = await syncPricingCatalogs(pool, { sources: ["models.dev"], force: true });
    assert.equal(result.status, "partial");
    assert.equal(result.results[0].status, "failed");
    assert.match(result.results[0].error, /no model offerings/i);
    assert.equal(calls.some((call) => call.sql.includes("UPDATE pricing_upstream_catalog SET is_active = false")), false);
    assert.ok(calls.some((call) => call.sql.includes("status, error_message")));
  } finally {
    globalThis.fetch = previousFetch;
  }
});
