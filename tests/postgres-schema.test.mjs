import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  acquireCollectorLease,
  claimCollectorCommands,
  completeCollectorCommands,
  createPullAttempt,
  ensureCollectorInstance,
  heartbeatCollectorState,
  markCollectorStopped,
  markInterruptedPullAttempts,
  markPullAttemptFailed,
  markSubscriptionEstablished,
  persistPulledBatch,
  persistSubscribedUsageEvent,
  completeSubscriptionAttempt,
  interruptSubscriptionAttempt,
  processInboxBatch,
  pruneEmptyPullAttempts
} from "../lib/collector/postgres-store.mjs";
import { refreshUsageRollups } from "../lib/collector/rollups.mjs";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test("PostgreSQL migration preflight ignores model_prices in an unrelated schema", {
  skip: !testDatabaseUrl
}, async () => {
  const parsedUrl = new URL(testDatabaseUrl);
  const databaseName = decodeURIComponent(parsedUrl.pathname.replace(/^\//, ""));
  assert.ok(["127.0.0.1", "localhost"].includes(parsedUrl.hostname), "TEST_DATABASE_URL must use loopback");
  assert.ok(databaseName.toLowerCase().includes("test"), "TEST_DATABASE_URL database name must include test");

  const { Pool } = await import("pg");
  const adminPool = new Pool({ connectionString: testDatabaseUrl, max: 1 });
  const targetDatabase = "phase8_migration_preflight_test_" + randomUUID().replaceAll("-", "");
  const targetUrl = new URL(testDatabaseUrl);
  targetUrl.pathname = "/" + targetDatabase;
  let targetPool;

  try {
    await adminPool.query(`CREATE DATABASE "${targetDatabase}"`);
    targetPool = new Pool({ connectionString: targetUrl.toString(), max: 1 });
    await targetPool.query("CREATE SCHEMA unrelated_probe");
    await targetPool.query("CREATE TABLE unrelated_probe.model_prices (id integer PRIMARY KEY)");
    await targetPool.end();
    targetPool = undefined;

    const migrationOutput = execFileSync(process.execPath, ["scripts/migrate.mjs"], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: targetUrl.toString(), DATABASE_DRIVER: "pg" }
    });
    assert.match(migrationOutput, /迁移完成/);

    targetPool = new Pool({ connectionString: targetUrl.toString(), max: 1 });
    const verification = await targetPool.query(
      `SELECT
         (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS migration_count,
         to_regclass('public.usage_events') IS NOT NULL AS usage_events_created,
         to_regclass('unrelated_probe.model_prices') IS NOT NULL AS unrelated_table_preserved`
    );
    assert.equal(verification.rows[0].migration_count, 12);
    assert.equal(verification.rows[0].usage_events_created, true);
    assert.equal(verification.rows[0].unrelated_table_preserved, true);
  } finally {
    if (targetPool) await targetPool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${targetDatabase}" WITH (FORCE)`);
    await adminPool.end();
  }
});


test("PostgreSQL event pipeline: durable Inbox, Processor, pricing, deduplication and rollups", {
  skip: !testDatabaseUrl
}, async () => {
  const parsedUrl = new URL(testDatabaseUrl);
  const databaseName = decodeURIComponent(parsedUrl.pathname.replace(/^\//, ""));
  assert.ok(["127.0.0.1", "localhost"].includes(parsedUrl.hostname), "TEST_DATABASE_URL must use loopback");
  assert.ok(databaseName.includes("test"), "TEST_DATABASE_URL database name must include 'test'");

  const { Pool } = await import("pg");
  const adminPool = new Pool({ connectionString: testDatabaseUrl, max: 1 });
  const schemaName = "phase1_test_" + randomUUID().replaceAll("-", "");
  let scopedPool;

  try {
    await adminPool.query('CREATE SCHEMA "' + schemaName + '"');
    scopedPool = new Pool({
      connectionString: testDatabaseUrl,
      options: "-c search_path=" + schemaName + ",public",
      max: 2
    });

    const client = await scopedPool.connect();
    try {
      const migrations = [
        "0000_pink_christian_walker.sql",
        "0001_remove_request_counts.sql",
        "0002_add_source_to_usage_records.sql",
        "0003_add_auth_index_to_usage_records.sql",
        "0004_add_auth_file_mappings.sql",
        "0005_usage_pipeline.sql",
        "0006_phase5_dashboard_rollup_dimensions.sql",
        "0007_phase6_legacy_import.sql",
        "0008_resp_subscription.sql",
        "0009_request_event_context.sql",
        "0010_pricing_center.sql", "0011_cpa_error_events.sql"
      ];
      for (const migration of migrations) {
        const sql = await readFile(new URL("../drizzle/" + migration, import.meta.url), "utf8");
        await client.query(sql);
      }

      const targetSchemaModelPrices = await client.query("SELECT to_regclass('model_prices') IS NOT NULL AS exists");
      const unrelatedSchemaModelPrices = await adminPool.query("SELECT to_regclass('model_prices') IS NOT NULL AS exists");
      assert.equal(targetSchemaModelPrices.rows[0].exists, true, "legacy detection should see model_prices in the target search_path");
      assert.equal(unrelatedSchemaModelPrices.rows[0].exists, false, "legacy detection must ignore model_prices in an unrelated schema");

      const relation = await client.query(
        "SELECT c.relkind FROM pg_class c WHERE c.oid = to_regclass('usage_events')"
      );
      assert.equal(relation.rows[0]?.relkind, "p", "usage_events must be partitioned");
      const priceColumn = await client.query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'model_prices' AND column_name = 'price_version_id'"
      );
      assert.equal(priceColumn.rowCount, 1);
      const importColumns = await client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'usage_import_runs'"
      );
      assert.ok(importColumns.rows.some((row) => row.column_name === "last_source_id"));
      const sourcePriceColumn = await client.query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'usage_events' AND column_name = 'source_price_version_id'"
      );
      assert.equal(sourcePriceColumn.rowCount, 1);
    } finally {
      client.release();
    }

    const config = {
      instanceId: "test-cpa",
      displayName: "Isolated CPA test instance",
      managementBaseUrl: "http://127.0.0.1:19171",
      queueName: "usage",
      mode: "pull"
    };
    await ensureCollectorInstance(scopedPool, config);

    assert.equal(await acquireCollectorLease(scopedPool, config.instanceId, "worker-a", 30), true);
    assert.equal(await acquireCollectorLease(scopedPool, config.instanceId, "worker-b", 30), false);
    await heartbeatCollectorState(scopedPool, config.instanceId, "worker-a", "receiving", 30);
    const subscriptionAckAttempt = await createPullAttempt(scopedPool, {
      instanceId: config.instanceId,
      transport: "resp-subscribe",
      requestedCount: 100
    });
    const subscriptionAck = await markSubscriptionEstablished(scopedPool, {
      attemptId: subscriptionAckAttempt,
      instanceId: config.instanceId,
      workerId: "worker-a",
      leaseSeconds: 30
    });
    assert.ok(Date.parse(subscriptionAck.subscribed_at), "server SUBSCRIBE acknowledgement time must be persisted");
    const subscriptionAudit = await scopedPool.query(
      "SELECT metadata->>'subscribed_at' AS subscribed_at FROM usage_pull_attempts WHERE id = $1",
      [subscriptionAckAttempt]
    );
    assert.equal(subscriptionAudit.rows[0].subscribed_at, subscriptionAck.subscribed_at);
    await completeSubscriptionAttempt(scopedPool, subscriptionAckAttempt);

    await assert.rejects(
      ensureCollectorInstance(scopedPool, { ...config, managementBaseUrl: "http://127.0.0.1:19172" }),
      /registration does not match/
    );
    const registeredEndpoint = await scopedPool.query(
      "SELECT management_base_url FROM usage_collector_instances WHERE instance_id = $1",
      [config.instanceId]
    );
    assert.equal(registeredEndpoint.rows[0].management_base_url, config.managementBaseUrl);

    const [commandRow] = (await scopedPool.query(
      `INSERT INTO usage_collector_commands (instance_id, command, status)
       VALUES ($1, 'pull_now', 'pending') RETURNING id`,
      [config.instanceId]
    )).rows;
    const claimedCommands = await claimCollectorCommands(scopedPool, config.instanceId, "worker-a", 30);
    assert.equal(claimedCommands.length, 1);
    assert.equal(claimedCommands[0].id, Number(commandRow.id));
    assert.deepEqual(await claimCollectorCommands(scopedPool, config.instanceId, "worker-b", 30), []);
    assert.equal(await completeCollectorCommands(scopedPool, claimedCommands, "worker-a", "completed"), 1);
    const completedCommand = await scopedPool.query(
      "SELECT status, claimed_by, lease_expires_at FROM usage_collector_commands WHERE id = $1",
      [commandRow.id]
    );
    assert.equal(completedCommand.rows[0].status, "completed");
    assert.equal(completedCommand.rows[0].claimed_by, null);
    assert.equal(completedCommand.rows[0].lease_expires_at, null);

    const oldEmptyAttempt = await createPullAttempt(scopedPool, {
      instanceId: config.instanceId,
      transport: "resp",
      requestedCount: 100
    });
    const recentEmptyAttempt = await createPullAttempt(scopedPool, {
      instanceId: config.instanceId,
      transport: "resp",
      requestedCount: 100
    });
    await scopedPool.query(
      "UPDATE usage_pull_attempts SET status = 'empty', completed_at = now() - interval '8 days' WHERE id = $1",
      [oldEmptyAttempt]
    );
    await scopedPool.query(
      "UPDATE usage_pull_attempts SET status = 'empty', completed_at = now() WHERE id = $1",
      [recentEmptyAttempt]
    );
    assert.equal(await pruneEmptyPullAttempts(scopedPool, config.instanceId, 7), 1);
    const remainingEmpty = await scopedPool.query(
      "SELECT id FROM usage_pull_attempts WHERE id = ANY($1::bigint[]) ORDER BY id",
      [[oldEmptyAttempt, recentEmptyAttempt]]
    );
    assert.deepEqual(remainingEmpty.rows.map((row) => Number(row.id)), [recentEmptyAttempt]);

    await scopedPool.query(
      `INSERT INTO model_prices (model, input_price_per_1m, cached_input_price_per_1m, output_price_per_1m)
       VALUES ('gpt-test', 1, 0.5, 2)`
    );
    const initialPrice = await scopedPool.query(
      "SELECT price_version_id FROM model_prices WHERE model = 'gpt-test' AND provider = '' AND service_tier = ''"
    );
    assert.ok(initialPrice.rows[0].price_version_id, "model price insert must create a version");
    await scopedPool.query(
      `INSERT INTO model_prices (model, provider, service_tier, input_price_per_1m, cached_input_price_per_1m, output_price_per_1m)
       VALUES ('gpt-test', 'anthropic', '', 3, 1, 6)`
    );
    const providerPriceScopes = await scopedPool.query(
      "SELECT count(*)::int AS scopes FROM model_prices WHERE model = 'gpt-test'"
    );
    assert.equal(providerPriceScopes.rows[0].scopes, 2, "same CPA model must allow both shared and provider-specific prices");
    await scopedPool.query(
      "INSERT INTO pricing_channels (channel, multiplier, note) VALUES ('openai', 2, 'PostgreSQL pricing integration test')"
    );
    const initialChannelVersion = await scopedPool.query(
      "SELECT id, multiplier FROM pricing_channel_versions WHERE channel = 'openai' AND available = true ORDER BY effective_from DESC LIMIT 1"
    );
    assert.equal(Number(initialChannelVersion.rows[0].multiplier), 2);
    const eventTimestamp = new Date(Date.now() + 60_000).toISOString();
    const record = {
      timestamp: eventTimestamp,
      provider: "openai",
      endpoint: "/v1/responses",
      service_tier: "priority",
      api_group_key: "test-group",
      model: "gpt-test",
      request_id: "phase1-request-001",
      api_key: "sk-test-secret-123456789",
      tokens: {
        input_tokens: 100,
        output_tokens: 25,
        reasoning_tokens: 5,
        cached_tokens: 20,
        total_tokens: 130
      }
    };

    await scopedPool.query(`
      CREATE FUNCTION fail_inbox_insert_for_test() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.payload->>'model' = 'force-inbox-failure' THEN
          RAISE EXCEPTION 'forced inbox failure for transaction test';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER fail_inbox_insert_for_test
      BEFORE INSERT ON usage_inbox
      FOR EACH ROW EXECUTE FUNCTION fail_inbox_insert_for_test();
    `);
    const atomicAttempt = await createPullAttempt(scopedPool, {
      instanceId: config.instanceId,
      transport: "resp",
      requestedCount: 10
    });
    await assert.rejects(persistPulledBatch(scopedPool, {
      attemptId: atomicAttempt,
      instanceId: config.instanceId,
      transport: "resp",
      items: [record, { ...record, model: "force-inbox-failure", request_id: "inbox-rollback" }]
    }));
    const atomicCounts = await scopedPool.query(
      "SELECT count(*) AS rows FROM usage_inbox WHERE pull_attempt_id = $1",
      [atomicAttempt]
    );
    assert.equal(Number(atomicCounts.rows[0].rows), 0, "inbox batch must roll back as one transaction");
    await markPullAttemptFailed(scopedPool, atomicAttempt, new Error("expected test rollback"), "test_rollback");
    await scopedPool.query("DROP TRIGGER fail_inbox_insert_for_test ON usage_inbox");
    await scopedPool.query("DROP FUNCTION fail_inbox_insert_for_test()");

    const secondRecord = {
      ...record,
      timestamp: new Date(new Date(eventTimestamp).getTime() + 1000).toISOString(),
      request_id: "phase1-request-002"
    };
    const firstAttempt = await createPullAttempt(scopedPool, {
      instanceId: config.instanceId,
      transport: "resp",
      requestedCount: 10
    });
    const attemptHeartbeat = await scopedPool.query(
      "SELECT last_attempt_at FROM usage_collector_state WHERE instance_id = $1",
      [config.instanceId]
    );
    assert.ok(attemptHeartbeat.rows[0].last_attempt_at, "starting a destructive pull must update the Collector health heartbeat");
    const firstPersist = await persistPulledBatch(scopedPool, {
      attemptId: firstAttempt,
      instanceId: config.instanceId,
      transport: "resp",
      items: [record, secondRecord]
    });
    assert.equal(firstPersist.persistedCount, 2, "one pull batch must be bulk-inserted into the durable inbox");

    const inboxBeforeProcess = await scopedPool.query(
      "SELECT status, payload->>'api_key' AS api_key FROM usage_inbox WHERE pull_attempt_id = $1 ORDER BY id",
      [firstAttempt]
    );
    assert.equal(inboxBeforeProcess.rowCount, 2);
    assert.deepEqual(inboxBeforeProcess.rows.map((row) => row.status), ["pending", "pending"]);
    assert.deepEqual(inboxBeforeProcess.rows.map((row) => row.api_key), ["****6789", "****6789"]);

    const firstProcess = await processInboxBatch(scopedPool, {
      instanceId: config.instanceId,
      workerId: "worker-a",
      batchSize: 10
    });
    assert.equal(firstProcess.processed, 2);

    const pricedEvent = await scopedPool.query(
      "SELECT price_version_id, channel_version_id, price_tier_index, resolved_service_tier, pricing_policy_version, cost_breakdown, cost_nanos, cost_currency, pricing_status FROM usage_events WHERE request_id = $1",
      ["phase1-request-001"]
    );
    assert.ok(pricedEvent.rows[0].price_version_id);
    assert.equal(Number(pricedEvent.rows[0].cost_nanos), 280000);
    assert.equal(pricedEvent.rows[0].cost_currency, "USD");
    assert.equal(pricedEvent.rows[0].pricing_status, "priced");
    assert.equal(Number(pricedEvent.rows[0].price_version_id), Number(initialPrice.rows[0].price_version_id));
    assert.equal(Number(pricedEvent.rows[0].channel_version_id), Number(initialChannelVersion.rows[0].id));
    assert.equal(pricedEvent.rows[0].pricing_policy_version, 1);
    assert.equal(Number(pricedEvent.rows[0].cost_breakdown.channel_multiplier), 2);
    await assert.rejects(
      scopedPool.query("UPDATE usage_events SET pricing_status = 'unpriced' WHERE request_id = $1", ["phase1-request-001"]),
      /priced usage evidence is immutable/
    );
    await assert.rejects(
      scopedPool.query("UPDATE model_price_versions SET input_price_per_1m = 99 WHERE id = $1", [initialPrice.rows[0].price_version_id]),
      /model price versions are immutable/
    );
    await assert.rejects(
      scopedPool.query("UPDATE pricing_channel_versions SET multiplier = 99 WHERE id = $1", [initialChannelVersion.rows[0].id]),
      /pricing channel versions are immutable/
    );
    await scopedPool.query(
      "UPDATE usage_events SET cache_creation_tokens = 5 WHERE request_id IN ($1, $2)",
      ["phase1-request-001", "phase1-request-002"]
    );

    const storedApiKey = await scopedPool.query(
      "SELECT api_key_mask, raw_payload->>'api_key' AS raw_payload_api_key FROM usage_events WHERE request_id = $1",
      ["phase1-request-001"]
    );
    assert.equal(storedApiKey.rows[0].api_key_mask, "****6789");
    assert.equal(storedApiKey.rows[0].raw_payload_api_key, "****6789");
    assert.equal(JSON.stringify(storedApiKey.rows[0]).includes("sk-test-secret"), false);

    await scopedPool.query(
      `INSERT INTO model_prices (model, input_price_per_1m, cached_input_price_per_1m, output_price_per_1m)
       VALUES ('gpt-test', 1, 0.5, 2)
       ON CONFLICT (model, provider, service_tier) DO UPDATE SET
         input_price_per_1m = EXCLUDED.input_price_per_1m,
         cached_input_price_per_1m = EXCLUDED.cached_input_price_per_1m,
         output_price_per_1m = EXCLUDED.output_price_per_1m`
    );
    const noOpPriceHistory = await scopedPool.query(
      "SELECT count(*) AS versions FROM model_price_versions WHERE model = 'gpt-test' AND provider IS NULL"
    );
    assert.equal(Number(noOpPriceHistory.rows[0].versions), 1, "no-op upsert must not create a price version");

    await scopedPool.query(
      `INSERT INTO model_prices (model, input_price_per_1m, cached_input_price_per_1m, output_price_per_1m)
       VALUES ('gpt-test', 1.5, 0.5, 2)
       ON CONFLICT (model, provider, service_tier) DO UPDATE SET
         input_price_per_1m = EXCLUDED.input_price_per_1m,
         cached_input_price_per_1m = EXCLUDED.cached_input_price_per_1m,
         output_price_per_1m = EXCLUDED.output_price_per_1m`
    );
    const priceHistory = await scopedPool.query(
      "SELECT count(*) AS versions, count(*) FILTER (WHERE valid_to IS NOT NULL) AS closed_versions FROM model_price_versions WHERE model = 'gpt-test' AND provider IS NULL"
    );
    assert.equal(Number(priceHistory.rows[0].versions), 2);
    assert.equal(Number(priceHistory.rows[0].closed_versions), 0, "price versions are append-only and never rewritten");

    await scopedPool.query("UPDATE pricing_channels SET multiplier = 3 WHERE channel = 'openai'");
    const channelVersions = await scopedPool.query(
      "SELECT id, multiplier FROM pricing_channel_versions WHERE channel = 'openai' ORDER BY effective_from, id"
    );
    assert.equal(channelVersions.rowCount, 2);
    assert.deepEqual(channelVersions.rows.map((row) => Number(row.multiplier)), [2, 3]);

    const laterRecord = {
      ...record,
      timestamp: new Date(Date.now() + 60_000).toISOString(),
      request_id: "phase1-request-after-price-change"
    };
    const laterAttempt = await createPullAttempt(scopedPool, {
      instanceId: config.instanceId,
      transport: "resp",
      requestedCount: 10
    });
    await persistPulledBatch(scopedPool, {
      attemptId: laterAttempt,
      instanceId: config.instanceId,
      transport: "resp",
      items: [laterRecord]
    });
    const laterProcess = await processInboxBatch(scopedPool, {
      instanceId: config.instanceId,
      workerId: "worker-a",
      batchSize: 10
    });
    assert.equal(laterProcess.processed, 1);
    const laterPricedEvent = await scopedPool.query(
      "SELECT price_version_id, channel_version_id, cost_nanos, cost_breakdown FROM usage_events WHERE request_id = $1",
      ["phase1-request-after-price-change"]
    );
    assert.notEqual(Number(laterPricedEvent.rows[0].price_version_id), Number(initialPrice.rows[0].price_version_id));
    assert.notEqual(Number(laterPricedEvent.rows[0].channel_version_id), Number(initialChannelVersion.rows[0].id));
    assert.equal(Number(laterPricedEvent.rows[0].cost_nanos), 540000);
    assert.equal(Number(laterPricedEvent.rows[0].cost_breakdown.channel_multiplier), 3);

    await scopedPool.query("DELETE FROM model_prices WHERE model = 'gpt-test'");
    const deletedPriceHistory = await scopedPool.query(
      "SELECT available FROM model_price_versions WHERE model = 'gpt-test' AND provider IS NULL ORDER BY valid_from DESC, id DESC LIMIT 1"
    );
    assert.equal(deletedPriceHistory.rows[0].available, false, "deleting a price must append an unavailable version");

    const firstCounts = await scopedPool.query(
      "SELECT (SELECT count(*) FROM usage_events) AS events, (SELECT count(*) FROM usage_event_identity) AS identities, (SELECT count(*) FROM usage_inbox WHERE status = 'processed') AS processed"
    );
    assert.deepEqual(
      {
        events: Number(firstCounts.rows[0].events),
        identities: Number(firstCounts.rows[0].identities),
        processed: Number(firstCounts.rows[0].processed)
      },
      { events: 3, identities: 3, processed: 3 }
    );

    const partition = await scopedPool.query(
      "SELECT tableoid::regclass::text AS partition_name FROM usage_events WHERE request_id = $1",
      ["phase1-request-001"]
    );
    assert.equal(partition.rows[0].partition_name, "usage_events_" + eventTimestamp.slice(0, 7).replace("-", ""));

    const duplicateAttempt = await createPullAttempt(scopedPool, {
      instanceId: config.instanceId,
      transport: "http",
      requestedCount: 10
    });
    await persistPulledBatch(scopedPool, {
      attemptId: duplicateAttempt,
      instanceId: config.instanceId,
      transport: "http",
      items: [
        { ...record, api_key: "sk-another-key-999999" },
        { ...secondRecord, api_key: "sk-another-key-999999" }
      ]
    });
    const duplicateProcess = await processInboxBatch(scopedPool, {
      instanceId: config.instanceId,
      workerId: "worker-a",
      batchSize: 10
    });
    assert.equal(duplicateProcess.duplicates, 2);

    const duplicateCounts = await scopedPool.query(
      "SELECT (SELECT count(*) FROM usage_events) AS events, (SELECT duplicate_count FROM usage_event_identity WHERE request_id = $1) AS duplicates",
      ["phase1-request-001"]
    );
    assert.equal(Number(duplicateCounts.rows[0].events), 3);
    assert.equal(Number(duplicateCounts.rows[0].duplicates), 1);

    const rollups = await refreshUsageRollups(scopedPool, {
      timezone: "UTC",
      hourlyLookbackHours: 48,
      dailyLookbackDays: 90
    });
    assert.equal(rollups.hourly.skipped, false);
    assert.equal(rollups.daily.skipped, false);
    const hourlyRollup = await scopedPool.query(
      "SELECT request_count, input_tokens, output_tokens, total_tokens, cache_creation_tokens, cost_nanos, pricing_status, api_key_mask, service_tier, priced_request_count, unpriced_request_count FROM usage_rollups_hourly WHERE model = 'gpt-test' AND timezone = 'UTC'"
    );
    assert.ok(hourlyRollup.rowCount >= 1);
    assert.equal(hourlyRollup.rows.reduce((sum, row) => sum + Number(row.request_count), 0), 3);
    assert.equal(hourlyRollup.rows.reduce((sum, row) => sum + Number(row.input_tokens), 0), 300);
    assert.equal(hourlyRollup.rows.reduce((sum, row) => sum + Number(row.output_tokens), 0), 75);
    assert.equal(hourlyRollup.rows.reduce((sum, row) => sum + Number(row.total_tokens), 0), 390);
    assert.equal(hourlyRollup.rows.reduce((sum, row) => sum + Number(row.cost_nanos), 0), 1_100_000);
    assert.ok(hourlyRollup.rows.every((row) => row.pricing_status === "priced"));
    assert.ok(hourlyRollup.rows.every((row) => row.api_key_mask === "****6789"));
    assert.ok(hourlyRollup.rows.every((row) => row.service_tier === "priority"));
    assert.equal(hourlyRollup.rows.reduce((sum, row) => sum + Number(row.cache_creation_tokens), 0), 10);
    assert.equal(hourlyRollup.rows.reduce((sum, row) => sum + Number(row.priced_request_count), 0), 3);
    assert.equal(hourlyRollup.rows.reduce((sum, row) => sum + Number(row.unpriced_request_count), 0), 0);
    const dailyRollup = await scopedPool.query(
      "SELECT request_count, cost_nanos FROM usage_rollups_daily WHERE model = 'gpt-test' AND timezone = 'UTC'"
    );
    assert.ok(dailyRollup.rowCount >= 1);
    assert.equal(dailyRollup.rows.reduce((sum, row) => sum + Number(row.request_count), 0), 3);
    assert.equal(dailyRollup.rows.reduce((sum, row) => sum + Number(row.cost_nanos), 0), 1_100_000);
    const checkpointStates = await scopedPool.query(
      "SELECT rollup_name, state FROM usage_rollup_checkpoints WHERE timezone = 'UTC' ORDER BY rollup_name"
    );
    assert.deepEqual(checkpointStates.rows, [
      { rollup_name: "usage_daily", state: "completed" },
      { rollup_name: "usage_hourly", state: "completed" }
    ]);

    const lateRecord = {
      ...record,
      timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      request_id: "phase4-late-arrival"
    };
    const lateAttempt = await createPullAttempt(scopedPool, {
      instanceId: config.instanceId,
      transport: "http",
      requestedCount: 10
    });
    await persistPulledBatch(scopedPool, {
      attemptId: lateAttempt,
      instanceId: config.instanceId,
      transport: "http",
      items: [lateRecord]
    });
    const lateProcess = await processInboxBatch(scopedPool, {
      instanceId: config.instanceId,
      workerId: "worker-a",
      batchSize: 10
    });
    assert.equal(lateProcess.processed, 1);
    await scopedPool.query("UPDATE usage_events SET cache_creation_tokens = 5 WHERE request_id = $1", ["phase4-late-arrival"]);
    await refreshUsageRollups(scopedPool, { timezone: "UTC", hourlyLookbackHours: 48, dailyLookbackDays: 90 });
    const afterLateArrival = await scopedPool.query(
      "SELECT sum(request_count) AS requests, sum(cost_nanos) AS cost, min(pricing_status) AS min_pricing, max(pricing_status) AS max_pricing FROM usage_rollups_daily WHERE model = 'gpt-test' AND timezone = 'UTC'"
    );
    assert.equal(Number(afterLateArrival.rows[0].requests), 4, "late-arriving event must be included in the rebuilt daily window");
    assert.equal(Number(afterLateArrival.rows[0].cost), 1_100_000, "unpriced late event must not invent cost");
    assert.equal(afterLateArrival.rows[0].max_pricing, "partial");
    const coverageRollup = await scopedPool.query(
      "SELECT sum(priced_request_count) AS priced, sum(unpriced_request_count) AS unpriced FROM usage_rollups_daily WHERE model = 'gpt-test' AND timezone = 'UTC'"
    );
    assert.equal(Number(coverageRollup.rows[0].priced), 3);
    assert.equal(Number(coverageRollup.rows[0].unpriced), 1);

    await refreshUsageRollups(scopedPool, { timezone: "UTC", hourlyLookbackHours: 48, dailyLookbackDays: 90 });
    const idempotentRollup = await scopedPool.query(
      "SELECT sum(request_count) AS requests, sum(cost_nanos) AS cost FROM usage_rollups_daily WHERE model = 'gpt-test' AND timezone = 'UTC'"
    );
    assert.equal(Number(idempotentRollup.rows[0].requests), 4, "rebuilding the same window must not double count events");
    assert.equal(Number(idempotentRollup.rows[0].cost), 1_100_000);

    await scopedPool.query(`
      CREATE FUNCTION fail_identity_insert_for_test() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.request_id = 'force-rollback' THEN
          RAISE EXCEPTION 'forced identity failure for transaction test';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER fail_identity_insert_for_test
      BEFORE INSERT ON usage_event_identity
      FOR EACH ROW EXECUTE FUNCTION fail_identity_insert_for_test();
    `);

    const rollbackAttempt = await createPullAttempt(scopedPool, {
      instanceId: config.instanceId,
      transport: "resp",
      requestedCount: 10
    });
    await persistPulledBatch(scopedPool, {
      attemptId: rollbackAttempt,
      instanceId: config.instanceId,
      transport: "resp",
      items: [{
        ...record,
        timestamp: new Date(Date.now() + 120_000).toISOString(),
        request_id: "force-rollback"
      }]
    });
    const rollbackProcess = await processInboxBatch(scopedPool, {
      instanceId: config.instanceId,
      workerId: "worker-a",
      batchSize: 10
    });
    assert.equal(rollbackProcess.retried, 1);

    const rollbackCounts = await scopedPool.query(
      "SELECT (SELECT count(*) FROM usage_events) AS events, (SELECT count(*) FROM usage_event_identity WHERE request_id = 'force-rollback') AS identities, (SELECT status FROM usage_inbox WHERE pull_attempt_id = $1) AS inbox_status",
      [rollbackAttempt]
    );
    assert.equal(Number(rollbackCounts.rows[0].events), 4);
    assert.equal(Number(rollbackCounts.rows[0].identities), 0);
    assert.equal(rollbackCounts.rows[0].inbox_status, "pending");
    await scopedPool.query(
      "UPDATE usage_inbox SET available_at = now() + interval '1 hour' WHERE pull_attempt_id = $1",
      [rollbackAttempt]
    );

    await scopedPool.query("DROP TRIGGER fail_identity_insert_for_test ON usage_event_identity");
    await scopedPool.query("DROP FUNCTION fail_identity_insert_for_test()");

    const invalidAttempt = await createPullAttempt(scopedPool, {
      instanceId: config.instanceId,
      transport: "resp",
      requestedCount: 10
    });
    await persistPulledBatch(scopedPool, {
      attemptId: invalidAttempt,
      instanceId: config.instanceId,
      transport: "resp",
      items: [{ model: "gpt-test", request_id: "missing-timestamp" }]
    });
    const invalidProcess = await processInboxBatch(scopedPool, {
      instanceId: config.instanceId,
      workerId: "worker-a",
      batchSize: 10
    });
    assert.equal(invalidProcess.deadLettered, 1);
    const deadLetter = await scopedPool.query(
      "SELECT status, last_error_code FROM usage_inbox WHERE pull_attempt_id = $1",
      [invalidAttempt]
    );
    assert.equal(deadLetter.rows[0].status, "dead_letter");
    assert.equal(deadLetter.rows[0].last_error_code, "MISSING_EVENT_TIMESTAMP");

    await assert.rejects(
      processInboxBatch(scopedPool, { instanceId: config.instanceId, batchSize: 0 }),
      /batchSize must be between 1 and 500/
    );

    const interruptedAttempt = await createPullAttempt(scopedPool, {
      instanceId: config.instanceId,
      transport: "resp",
      requestedCount: 10
    });
    assert.equal(await markInterruptedPullAttempts(scopedPool, config.instanceId, 0), 1);
    const gapAudit = await scopedPool.query(
      "SELECT status, error_code FROM usage_pull_attempts WHERE id = $1",
      [interruptedAttempt]
    );
    assert.equal(gapAudit.rows[0].status, "interrupted");
    assert.equal(gapAudit.rows[0].error_code, "collector_interrupted");
    const gapCount = await scopedPool.query(
      "SELECT count(*) AS gaps FROM usage_ingest_gaps WHERE pull_attempt_id = $1",
      [interruptedAttempt]
    );
    assert.equal(Number(gapCount.rows[0].gaps), 1, "an uncertain destructive pull must create one explicit ingest gap");

    // A committed Inbox batch must survive a Collector/Processor process restart.
    const restartRecord = { ...record, request_id: "phase7-process-restart-durable" };
    const restartAttempt = await createPullAttempt(scopedPool, {
      instanceId: config.instanceId,
      transport: "resp",
      requestedCount: 10
    });
    await persistPulledBatch(scopedPool, {
      attemptId: restartAttempt,
      instanceId: config.instanceId,
      transport: "resp",
      items: [restartRecord]
    });
    await scopedPool.end();
    scopedPool = new Pool({
      connectionString: testDatabaseUrl,
      options: "-c search_path=" + schemaName + ",public",
      max: 2
    });
    const durableInbox = await scopedPool.query(
      "SELECT status, payload->>'request_id' AS request_id FROM usage_inbox WHERE pull_attempt_id=$1",
      [restartAttempt]
    );
    assert.equal(durableInbox.rowCount, 1);
    assert.equal(durableInbox.rows[0].status, "pending");
    assert.equal(durableInbox.rows[0].request_id, "phase7-process-restart-durable");
    const afterRestart = await processInboxBatch(scopedPool, {
      instanceId: config.instanceId,
      workerId: "worker-after-restart",
      batchSize: 10
    });
    assert.equal(afterRestart.processed, 1);
    const restartEvent = await scopedPool.query(
      "SELECT count(*)::int AS count FROM usage_events WHERE request_id='phase7-process-restart-durable'"
    );
    assert.equal(restartEvent.rows[0].count, 1);

    // Expired per-row Processor leases are reclaimed by a replacement worker.
    const leaseRecord = { ...record, request_id: "phase7-expired-processor-lease" };
    const leaseAttempt = await createPullAttempt(scopedPool, {
      instanceId: config.instanceId,
      transport: "http",
      requestedCount: 10
    });
    await persistPulledBatch(scopedPool, {
      attemptId: leaseAttempt,
      instanceId: config.instanceId,
      transport: "http",
      items: [leaseRecord]
    });
    await scopedPool.query(
      `UPDATE usage_inbox SET status='processing', lease_owner='crashed-worker',
         lease_expires_at=now()-interval '1 second', attempt_count=1 WHERE pull_attempt_id=$1`,
      [leaseAttempt]
    );
    const reclaimed = await processInboxBatch(scopedPool, {
      instanceId: config.instanceId,
      workerId: "replacement-worker",
      batchSize: 10
    });
    assert.equal(reclaimed.processed, 1);
    const reclaimedEvent = await scopedPool.query(
      "SELECT count(*)::int AS count FROM usage_events WHERE request_id='phase7-expired-processor-lease'"
    );
    assert.equal(reclaimedEvent.rows[0].count, 1);

    // Native RESP Pub/Sub events enter the same durable Inbox and Processor pipeline.
    const subscriptionConfig = {
      ...config,
      instanceId: "test-cpa-subscription",
      mode: "subscribe"
    };
    await ensureCollectorInstance(scopedPool, subscriptionConfig);
    const subscriptionAttempt = await createPullAttempt(scopedPool, {
      instanceId: subscriptionConfig.instanceId,
      transport: "resp-subscribe",
      requestedCount: 1
    });
    const subscriptionRecord = {
      ...record,
      request_id: "phase7-resp-subscription-event",
      session_id: "session-resp-123",
      parent_session_id: "session-parent-resp-123",
      execution_id: "execution-resp-123",
      trace_id: "trace-resp-123",
      node_kind: "message",
      is_fork: true,
      is_compaction: false,
      timestamp: new Date().toISOString()
    };
    await persistSubscribedUsageEvent(scopedPool, {
      attemptId: subscriptionAttempt,
      instanceId: subscriptionConfig.instanceId,
      item: JSON.stringify(subscriptionRecord)
    });
    const subscriptionCounters = await scopedPool.query(
      "SELECT received_count, persisted_count, status FROM usage_pull_attempts WHERE id=$1",
      [subscriptionAttempt]
    );
    assert.equal(Number(subscriptionCounters.rows[0].received_count), 1);
    assert.equal(Number(subscriptionCounters.rows[0].persisted_count), 1);
    assert.equal(subscriptionCounters.rows[0].status, "started");
    const beforeSubscriptionProcess = await scopedPool.query(
      "SELECT id, status, available_at, instance_id FROM usage_inbox WHERE pull_attempt_id=$1",
      [subscriptionAttempt]
    );
    assert.equal(beforeSubscriptionProcess.rowCount, 1, "subscription event must be present in the durable Inbox");
    const subscriptionProcessed = await processInboxBatch(scopedPool, {
      instanceId: subscriptionConfig.instanceId,
      workerId: "subscription-processor",
      batchSize: 10
    });
    const afterSubscriptionProcess = await scopedPool.query(
      "SELECT status, last_error_code, last_error_message FROM usage_inbox WHERE pull_attempt_id=$1",
      [subscriptionAttempt]
    );
    assert.equal(subscriptionProcessed.processed, 1, JSON.stringify({ summary: subscriptionProcessed, inbox: beforeSubscriptionProcess.rows, after: afterSubscriptionProcess.rows }));
    const subscriptionEvent = await scopedPool.query(
      "SELECT count(*)::int AS count FROM usage_events WHERE request_id='phase7-resp-subscription-event'"
    );
    assert.equal(subscriptionEvent.rows[0].count, 1);
    const subscriptionContext = await scopedPool.query(
      "SELECT session_id, parent_session_id, execution_id, trace_id, node_kind, is_fork, is_compaction FROM usage_events WHERE request_id=$1",
      ["phase7-resp-subscription-event"]
    );
    assert.deepEqual(subscriptionContext.rows[0], {
      session_id: "session-resp-123",
      parent_session_id: "session-parent-resp-123",
      execution_id: "execution-resp-123",
      trace_id: "trace-resp-123",
      node_kind: "message",
      is_fork: true,
      is_compaction: false
    });
    const subscriptionSummary = await completeSubscriptionAttempt(scopedPool, subscriptionAttempt);
    assert.equal(Number(subscriptionSummary.received_count), 1);

    const interruptedSubscription = await createPullAttempt(scopedPool, {
      instanceId: subscriptionConfig.instanceId,
      transport: "resp-subscribe",
      requestedCount: 1
    });
    await interruptSubscriptionAttempt(scopedPool, {
      attemptId: interruptedSubscription,
      instanceId: subscriptionConfig.instanceId,
      startedAt: new Date(),
      error: new Error("test subscription disconnect")
    });
    const subscriptionGap = await scopedPool.query(
      "SELECT reason, details->>'missing_count' AS missing_count FROM usage_ingest_gaps WHERE pull_attempt_id=$1",
      [interruptedSubscription]
    );
    assert.equal(subscriptionGap.rows[0].reason, "resp_subscription_disconnected");
    assert.equal(subscriptionGap.rows[0].missing_count, "unknown");

    // Terminate one PostgreSQL backend; the pool must reconnect on the next query.
    const doomedClient = await scopedPool.connect();
    const backendErrorPromise = new Promise((resolve) => doomedClient.once("error", resolve));
    const backend = await doomedClient.query("SELECT pg_backend_pid() AS pid");
    const termination = await adminPool.query("SELECT pg_terminate_backend($1)", [backend.rows[0].pid]);
    assert.equal(termination.rows[0].pg_terminate_backend, true);
    const backendError = await backendErrorPromise;
    assert.equal(backendError.code, "57P01", "the terminated backend error should be observed by the borrowed client");
    doomedClient.release(true);
    const recoveredConnection = await scopedPool.query("SELECT 1 AS recovered");
    assert.equal(recoveredConnection.rows[0].recovered, 1);

    await markCollectorStopped(scopedPool, config.instanceId, "worker-a");
    const stoppedState = await scopedPool.query(
      `SELECT state.lease_owner, state.lease_expires_at, state.state, instance.enabled
       FROM usage_collector_state AS state
       JOIN usage_collector_instances AS instance USING (instance_id)
       WHERE state.instance_id = $1`,
      [config.instanceId]
    );
    assert.equal(stoppedState.rows[0].state, "stopped");
    assert.equal(stoppedState.rows[0].lease_owner, null);
    assert.equal(stoppedState.rows[0].lease_expires_at, null);
    assert.equal(stoppedState.rows[0].enabled, false);
  } finally {
    if (scopedPool) await scopedPool.end();
    await adminPool.query('DROP SCHEMA IF EXISTS "' + schemaName + '" CASCADE');
    await adminPool.end();
  }
});
