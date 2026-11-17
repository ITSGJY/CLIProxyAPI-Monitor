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
  markPullAttemptFailed,
  persistPulledBatch,
  processInboxBatch
} from "../lib/collector/postgres-store.mjs";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test("Phase 1 PostgreSQL migration, durable inbox, partitioning and replay safety", {
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

    await scopedPool.query(
      `INSERT INTO model_prices (model, input_price_per_1m, cached_input_price_per_1m, output_price_per_1m)
       VALUES ('gpt-test', 1, 0.5, 2)`
    );
    const initialPrice = await scopedPool.query(
      "SELECT price_version_id FROM model_prices WHERE model = 'gpt-test'"
    );
    assert.ok(initialPrice.rows[0].price_version_id, "model price insert must create a version");

    const eventTimestamp = new Date(Date.now() + 60_000).toISOString();
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

    const firstAttempt = await createPullAttempt(scopedPool, {
      instanceId: config.instanceId,
      transport: "resp",
      requestedCount: 10
    });
    const firstPersist = await persistPulledBatch(scopedPool, {
      attemptId: firstAttempt,
      instanceId: config.instanceId,
      transport: "resp",
      items: [record]
    });
    assert.equal(firstPersist.persistedCount, 1);

    const inboxBeforeProcess = await scopedPool.query(
      "SELECT status, payload->>'api_key' AS api_key FROM usage_inbox WHERE pull_attempt_id = $1",
      [firstAttempt]
    );
    assert.equal(inboxBeforeProcess.rows[0].status, "pending");
    assert.equal(inboxBeforeProcess.rows[0].api_key, "[redacted]");

    const firstProcess = await processInboxBatch(scopedPool, {
      instanceId: config.instanceId,
      workerId: "worker-a",
      batchSize: 10
    });
    assert.equal(firstProcess.processed, 1);

    const pricedEvent = await scopedPool.query(
      "SELECT price_version_id, cost_nanos, cost_currency, pricing_status FROM usage_events WHERE request_id = $1",
      ["phase1-request-001"]
    );
    assert.ok(pricedEvent.rows[0].price_version_id);
    assert.equal(Number(pricedEvent.rows[0].cost_nanos), 140000);
    assert.equal(pricedEvent.rows[0].cost_currency, "USD");
    assert.equal(pricedEvent.rows[0].pricing_status, "priced");

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
      { events: 1, identities: 1, processed: 1 }
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
      items: [{ ...record, api_key: "sk-another-key-999999" }]
    });
    const duplicateProcess = await processInboxBatch(scopedPool, {
      instanceId: config.instanceId,
      workerId: "worker-a",
      batchSize: 10
    });
    assert.equal(duplicateProcess.duplicates, 1);

    const duplicateCounts = await scopedPool.query(
      "SELECT (SELECT count(*) FROM usage_events) AS events, (SELECT duplicate_count FROM usage_event_identity WHERE request_id = $1) AS duplicates",
      ["phase1-request-001"]
    );
    assert.equal(Number(duplicateCounts.rows[0].events), 1);
    assert.equal(Number(duplicateCounts.rows[0].duplicates), 1);

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
    assert.equal(Number(rollbackCounts.rows[0].events), 1);
    assert.equal(Number(rollbackCounts.rows[0].identities), 0);
    assert.equal(rollbackCounts.rows[0].inbox_status, "pending");

    await scopedPool.query("DROP TRIGGER fail_identity_insert_for_test ON usage_event_identity");
    await scopedPool.query("DROP FUNCTION fail_identity_insert_for_test()");
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