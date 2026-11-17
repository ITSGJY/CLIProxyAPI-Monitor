import assert from "node:assert/strict";
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
  persistPulledBatch,
  processInboxBatch,
  pruneEmptyPullAttempts
} from "../lib/collector/postgres-store.mjs";
import { refreshUsageRollups } from "../lib/collector/rollups.mjs";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

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
        "0005_usage_pipeline.sql"
      ];
      for (const migration of migrations) {
        const sql = await readFile(new URL("../drizzle/" + migration, import.meta.url), "utf8");
        await client.query(sql);
      }

      const relation = await client.query(
        "SELECT c.relkind FROM pg_class c WHERE c.oid = to_regclass('usage_events')"
      );
      assert.equal(relation.rows[0]?.relkind, "p", "usage_events must be partitioned");

      const priceColumn = await client.query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'model_prices' AND column_name = 'price_version_id'"
      );
      assert.equal(priceColumn.rowCount, 1);
    } finally {
      client.release();
    }

    const config = {
      instanceId: "test-cpa",
      displayName: "Isolated CPA test instance",
      managementBaseUrl: "http://127.0.0.1:19171",
      queueName: "usage"
    };
    await ensureCollectorInstance(scopedPool, config);

    assert.equal(await acquireCollectorLease(scopedPool, config.instanceId, "worker-a", 30), true);
    assert.equal(await acquireCollectorLease(scopedPool, config.instanceId, "worker-b", 30), false);
    await heartbeatCollectorState(scopedPool, config.instanceId, "worker-a", "receiving", 30);
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
      "SELECT price_version_id FROM model_prices WHERE model = 'gpt-test'"
    );
    assert.ok(initialPrice.rows[0].price_version_id, "model price insert must create a version");
    await scopedPool.query(
      "UPDATE model_price_versions SET valid_from = now() - interval '5 minutes' WHERE id = $1",
      [initialPrice.rows[0].price_version_id]
    );

    const eventTimestamp = new Date(Date.now() - 60_000).toISOString();
    const record = {
      timestamp: eventTimestamp,
      provider: "openai",
      endpoint: "/v1/responses",
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
      "SELECT price_version_id, cost_nanos, cost_currency, pricing_status FROM usage_events WHERE request_id = $1",
      ["phase1-request-001"]
    );
    assert.ok(pricedEvent.rows[0].price_version_id);
    assert.equal(Number(pricedEvent.rows[0].cost_nanos), 140000);
    assert.equal(pricedEvent.rows[0].cost_currency, "USD");
    assert.equal(pricedEvent.rows[0].pricing_status, "priced");
    assert.equal(Number(pricedEvent.rows[0].price_version_id), Number(initialPrice.rows[0].price_version_id));

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
       ON CONFLICT (model) DO UPDATE SET
         input_price_per_1m = EXCLUDED.input_price_per_1m,
         cached_input_price_per_1m = EXCLUDED.cached_input_price_per_1m,
         output_price_per_1m = EXCLUDED.output_price_per_1m`
    );
    const noOpPriceHistory = await scopedPool.query(
      "SELECT count(*) AS versions FROM model_price_versions WHERE model = 'gpt-test'"
    );
    assert.equal(Number(noOpPriceHistory.rows[0].versions), 1, "no-op upsert must not create a price version");

    await scopedPool.query(
      `INSERT INTO model_prices (model, input_price_per_1m, cached_input_price_per_1m, output_price_per_1m)
       VALUES ('gpt-test', 1.5, 0.5, 2)
       ON CONFLICT (model) DO UPDATE SET
         input_price_per_1m = EXCLUDED.input_price_per_1m,
         cached_input_price_per_1m = EXCLUDED.cached_input_price_per_1m,
         output_price_per_1m = EXCLUDED.output_price_per_1m`
    );
    const priceHistory = await scopedPool.query(
      "SELECT count(*) AS versions, count(*) FILTER (WHERE valid_to IS NOT NULL) AS closed_versions FROM model_price_versions WHERE model = 'gpt-test'"
    );
    assert.equal(Number(priceHistory.rows[0].versions), 2);
    assert.equal(Number(priceHistory.rows[0].closed_versions), 1);

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
      "SELECT price_version_id, cost_nanos FROM usage_events WHERE request_id = $1",
      ["phase1-request-after-price-change"]
    );
    assert.notEqual(Number(laterPricedEvent.rows[0].price_version_id), Number(initialPrice.rows[0].price_version_id));
    assert.equal(Number(laterPricedEvent.rows[0].cost_nanos), 180000);

    await scopedPool.query("DELETE FROM model_prices WHERE model = 'gpt-test'");
    const deletedPriceHistory = await scopedPool.query(
      "SELECT count(*) FILTER (WHERE valid_to IS NULL) AS open_versions FROM model_price_versions WHERE model = 'gpt-test'"
    );
    assert.equal(Number(deletedPriceHistory.rows[0].open_versions), 0);

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
      "SELECT request_count, input_tokens, output_tokens, total_tokens, cost_nanos, pricing_status FROM usage_rollups_hourly WHERE model = 'gpt-test' AND timezone = 'UTC'"
    );
    assert.ok(hourlyRollup.rowCount >= 1);
    assert.equal(hourlyRollup.rows.reduce((sum, row) => sum + Number(row.request_count), 0), 3);
    assert.equal(hourlyRollup.rows.reduce((sum, row) => sum + Number(row.input_tokens), 0), 300);
    assert.equal(hourlyRollup.rows.reduce((sum, row) => sum + Number(row.output_tokens), 0), 75);
    assert.equal(hourlyRollup.rows.reduce((sum, row) => sum + Number(row.total_tokens), 0), 390);
    assert.equal(hourlyRollup.rows.reduce((sum, row) => sum + Number(row.cost_nanos), 0), 460000);
    assert.ok(hourlyRollup.rows.every((row) => row.pricing_status === "priced"));
    const dailyRollup = await scopedPool.query(
      "SELECT request_count, cost_nanos FROM usage_rollups_daily WHERE model = 'gpt-test' AND timezone = 'UTC'"
    );
    assert.ok(dailyRollup.rowCount >= 1);
    assert.equal(dailyRollup.rows.reduce((sum, row) => sum + Number(row.request_count), 0), 3);
    assert.equal(dailyRollup.rows.reduce((sum, row) => sum + Number(row.cost_nanos), 0), 460000);
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
    await refreshUsageRollups(scopedPool, { timezone: "UTC", hourlyLookbackHours: 48, dailyLookbackDays: 90 });
    const afterLateArrival = await scopedPool.query(
      "SELECT sum(request_count) AS requests, sum(cost_nanos) AS cost, min(pricing_status) AS min_pricing, max(pricing_status) AS max_pricing FROM usage_rollups_daily WHERE model = 'gpt-test' AND timezone = 'UTC'"
    );
    assert.equal(Number(afterLateArrival.rows[0].requests), 4, "late-arriving event must be included in the rebuilt daily window");
    assert.equal(Number(afterLateArrival.rows[0].cost), 460000, "unpriced late event must not invent cost");
    assert.equal(afterLateArrival.rows[0].max_pricing, "partial");

    await refreshUsageRollups(scopedPool, { timezone: "UTC", hourlyLookbackHours: 48, dailyLookbackDays: 90 });
    const idempotentRollup = await scopedPool.query(
      "SELECT sum(request_count) AS requests, sum(cost_nanos) AS cost FROM usage_rollups_daily WHERE model = 'gpt-test' AND timezone = 'UTC'"
    );
    assert.equal(Number(idempotentRollup.rows[0].requests), 4, "rebuilding the same window must not double count events");
    assert.equal(Number(idempotentRollup.rows[0].cost), 460000);

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