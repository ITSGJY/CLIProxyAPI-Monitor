import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("error process, Compose, RESP, schema and UI preserve usage-only architecture boundaries", async () => {
  const read = (path) => readFile(new URL("../../" + path, import.meta.url), "utf8");
  const [script, collector, store, resp, usage, compose, schema, drawer, pkg] = await Promise.all([
    "scripts/error-collector.mjs", "lib/cpa-errors/collector.mjs", "lib/cpa-errors/store.mjs", "lib/collector/resp-client.mjs",
    "scripts/collector.mjs", "deploy/compose/compose.yaml", "drizzle/0011_cpa_error_events.sql",
    "app/components/RecordDetailsDrawer.tsx", "package.json"
  ].map(read));
  assert.doesNotMatch(script + collector + store, /usage_inbox|persistSubscribedUsageEvent|pullUsageVia|\bLPOP\b/);
  assert.doesNotMatch(usage, /subscribeErrors|cpa-errors|error-collector/);
  assert.match(resp, /if \(channel !== "usage"\) throw/);
  assert.doesNotMatch(resp.split("export async function subscribeErrorsViaResp")[1], /LPOP|client\.command\("PING"|client\.command\("UNSUBSCRIBE"/);
  assert.match(compose, /profiles: \["error-collector"\]/);
  assert.match(compose, /test: \["CMD", "node", "scripts\/error-collector-health.mjs"\]/);
  assert.match(compose, /ERROR_COLLECTOR_ENABLED: \$\{ERROR_COLLECTOR_ENABLED:-false\}/);
  assert.doesNotMatch(schema, /\bauth_id\s+text|\braw_payload\s+jsonb|REFERENCES usage_/);
  assert.match(schema, /UNIQUE \(source_instance_id, event_key\)/);
  assert.match(drawer, /type DetailTab = "overview" \| "usage" \| "diagnostics" \| "raw"/);
  assert.doesNotMatch(drawer, /dangerouslySetInnerHTML/);
  assert.match(JSON.parse(pkg).scripts["test:postgres"], /errors-postgres/);
  assert.match(JSON.parse(pkg).scripts["test:import"], /omc-errors-import/);
});
