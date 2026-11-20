import assert from "node:assert/strict";
import { test } from "node:test";
import { errorTestDatabase } from "./errors-db-helper.mjs";
import { createErrorStore, insertErrorEvent } from "../lib/cpa-errors/store.mjs";
import { normalizeErrorEvent } from "../lib/cpa-errors/normalize.mjs";
import { getCredentialErrors, getErrorCollectorHealth } from "../lib/cpa-errors/query.mjs";
import { runErrorCollector } from "../lib/cpa-errors/collector.mjs";
import { respFixture, ack, frame } from "./errors/resp-fixture.mjs";

const options = { skip: !process.env.TEST_DATABASE_URL };
const error = (at, instance = "one", extra = {}) => normalizeErrorEvent({ timestamp: new Date(at).toISOString(), auth_index: "credential-1", provider: "openai", model: "model-a", status_code: 429, body: "limit", ...extra }, { instanceId: instance });

test("PostgreSQL 17 independent error lease fencing, duplicate delivery, sessions and crash recovery", options, async (t) => {
  const { pool } = await errorTestDatabase(t);
  const a = createErrorStore(pool, { instanceId: "one", workerId: "worker-a", leaseSeconds: 45 });
  const b = createErrorStore(pool, { instanceId: "one", workerId: "worker-b", leaseSeconds: 45 });
  assert.equal(await a.acquire(), true);
  assert.equal(await b.acquire(), false);
  const first = await a.startSession();
  await a.subscribed(first);
  const e = error(Date.now());
  assert.equal(await a.persist(first, e), 1);
  assert.equal(await a.persist(first, e), 0);
  assert.equal(await insertErrorEvent(pool, { ...e, source_instance_id: "two" }), 1, "the same event key must be independently insertable for another CPA instance");
  await a.confirmCoverage(first, new Date());
  assert.equal((await getErrorCollectorHealth(pool, "one")).healthy, true);
  const counts = (await pool.query("SELECT received_count,inserted_count,duplicate_count FROM cpa_error_subscription_sessions WHERE id=$1", [first])).rows[0];
  assert.deepEqual(counts, { received_count: "2", inserted_count: "1", duplicate_count: "1" });
  assert.equal(Number((await pool.query("SELECT count(*) FROM usage_inbox")).rows[0].count), 0);
  assert.equal(Number((await pool.query("SELECT count(*) FROM usage_collector_state")).rows[0].count), 0);
  await pool.query("UPDATE cpa_error_collector_state SET lease_expires_at=now()-interval '1 second' WHERE source_instance_id='one'");
  await assert.rejects(a.renew(), /lease_lost/);
  assert.equal(await b.acquire(), true);
  await assert.rejects(a.persist(first, e), /lease_lost/);
  await assert.rejects(a.release(), /lease_lost/);
  const interrupted = (await pool.query("SELECT ended_at,end_reason,coverage_through FROM cpa_error_subscription_sessions WHERE id=$1", [first])).rows[0];
  assert.equal(interrupted.end_reason, "lease_expired");
  assert.ok(interrupted.ended_at && interrupted.coverage_through <= interrupted.ended_at);
  const second = await b.startSession();
  await b.subscribed(second);
  await b.endSession(second, "malformed_payload", true);
  await assert.rejects(b.persist(second, e), /session_fenced/);
  assert.equal((await getErrorCollectorHealth(pool, "one")).status, "degraded");
  await b.release();
  assert.equal((await getErrorCollectorHealth(pool, "one")).status, "disabled");
});

test("correlation is instance scoped, includes ±120s boundaries, returns signed delta and stable 20-row nearest ordering", options, async (t) => {
  const { pool } = await errorTestDatabase(t);
  const center = Date.parse("2026-11-20T01:00:00Z");
  const record = { sourceInstanceId: "one", authIndex: "credential-1", occurredAt: new Date(center), provider: "openai", model: "model-a" };
  for (const delta of [-120001, -120000, -1000, 1000, 120000, 120001]) await insertErrorEvent(pool, error(center + delta));
  await insertErrorEvent(pool, error(center, "two", { body: "other-instance" }));
  await insertErrorEvent(pool, error(center, "one", { auth_index: "other-credential" }));
  await insertErrorEvent(pool, error(center, "one", { auth_index: "" }));
  let result = await getCredentialErrors(pool, record, { now: center + 200000 });
  assert.deepEqual(result.events.map((e) => e.time_delta_ms), [-1000, 1000, -120000, 120000]);
  assert.ok(result.events.every((e) => e.provider_match && e.model_match && e.attribution === "credential_time_window"));
  const narrowed = await getCredentialErrors(pool, record, { now: center + 200000, windowMs: 30000 });
  assert.equal(narrowed.window_ms, 30000);
  assert.deepEqual(narrowed.events.map((e) => e.time_delta_ms), [-1000, 1000]);
  assert.equal(result.coverage.status, "not_configured");
  for (let i = 0; i < 25; i++) await insertErrorEvent(pool, error(center + i, "one", { body: "tie-" + i, provider: "other", model: "other" }));
  result = await getCredentialErrors(pool, record);
  assert.equal(result.events.length, 20);
  assert.deepEqual(result.events.map((e) => e.time_delta_ms), Array.from({ length: 20 }, (_, i) => i));
  assert.ok(result.events.every((e) => !e.provider_match && !e.model_match));
  await insertErrorEvent(pool, error(center, "one", { body: "another-tie" }));
  const stable = await getCredentialErrors(pool, record);
  assert.deepEqual(stable.events.slice(0, 2).map((e) => e.body), ["tie-0", "another-tie"]);
  assert.equal((await getCredentialErrors(pool, { ...record, authIndex: "  " })).coverage.status, "not_correlatable");
  assert.ok(!JSON.stringify(result).includes("auth_id"));
});

test("database session intervals expose closed/future/gap windows and safe empty/query-failed states", options, async (t) => {
  const { pool, schema } = await errorTestDatabase(t);
  const now = Date.now(), center = now - 180000;
  const record = { sourceInstanceId: "one", authIndex: "credential-1", occurredAt: new Date(center) };
  const store = createErrorStore(pool, { instanceId: "one", workerId: "worker", leaseSeconds: 45 });
  await store.acquire();
  const session = await store.startSession();
  await store.subscribed(session);
  await store.confirmCoverage(session, new Date(center - 120000)); // stale app-clock timestamp must not hold back the database watermark
  const clockWatermark = (await pool.query("SELECT subscribed_at,coverage_through FROM cpa_error_subscription_sessions WHERE id=$1", [session])).rows[0];
  assert.ok(new Date(clockWatermark.coverage_through) > new Date(clockWatermark.subscribed_at), "coverage advances using the PostgreSQL clock despite application clock skew");
  await pool.query("UPDATE cpa_error_subscription_sessions SET subscribed_at=$2,coverage_through=$3 WHERE id=$1", [session, new Date(center - 120000), new Date(now)]);
  let result = await getCredentialErrors(pool, record, { now });
  assert.equal(result.coverage.status, "complete");
  assert.equal(result.events.length, 0);
  result = await getCredentialErrors(pool, { ...record, occurredAt: new Date(now) }, { now });
  assert.equal(result.coverage.status, "collecting");
  await pool.query("UPDATE cpa_error_subscription_sessions SET coverage_through=$2,ended_at=$2 WHERE id=$1", [session, new Date(center)]);
  const next = await store.startSession();
  await store.subscribed(next);
  await pool.query("UPDATE cpa_error_subscription_sessions SET subscribed_at=$2,coverage_through=$3 WHERE id=$1", [next, new Date(center + 5000), new Date(now)]);
  result = await getCredentialErrors(pool, record, { now });
  assert.equal(result.coverage.status, "partial");
  assert.equal(result.coverage.gaps.length, 1);
  await store.endSession(next, "stream_interrupted");
  assert.equal((await getCredentialErrors(pool, record, { now })).coverage.status, "disconnected");
  assert.equal((await getCredentialErrors(pool, record, { now, configured: false })).coverage.status, "disabled");
  await pool.query("ALTER TABLE cpa_error_events RENAME TO test_temporarily_unavailable_errors");
  const isolatedPool = { connect: async () => {
    const client = await pool.connect();
    await client.query(`SET search_path TO "${schema}"`);
    return client;
  } };
  result = await getCredentialErrors(isolatedPool, record, { now });
  assert.equal(result.coverage.status, "query_failed");
  assert.equal(result.coverage.complete, false);
});
test("real RESP error collector reconnects with PostgreSQL session history after malformed input and disconnect", options, async (t) => {
  const { pool } = await errorTestDatabase(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  let connection = 0, currentSocket;
  const raw = JSON.stringify({ timestamp: new Date().toISOString(), auth_index: "credential-1", body: "Bearer private-value", auth_id: "private-id" });
  const server = await respFixture(t, (socket) => {
    currentSocket = socket;
    connection++;
    socket.write(Buffer.concat([ack("subscribe", "errors", 1), frame("message", "errors", connection === 1 ? "invalid-json" : raw),
      ...(connection === 2 ? [frame("message", "errors", raw)] : [])]));
  });
  const config = { enabled: true, instanceId: "resp-errors", workerId: "integration-worker", leaseSeconds: 45, heartbeatMs: 30, address: server.address, password: "test-key" };
  const store = createErrorStore(pool, config);
  const persist = store.persist;
  let received = 0;
  store.persist = async (...args) => {
    await persist(...args);
    received++;
    if (received === 2) currentSocket.destroy();
    if (received === 3) controller.abort();
  };
  const delays = [];
  await runErrorCollector({ config, store, signal: controller.signal, delay: async (delay) => { delays.push(delay); } });
  assert.equal(connection, 3);
  assert.deepEqual(delays, [500, 500]);
  const sessions = (await pool.query("SELECT end_reason,received_count,inserted_count,duplicate_count,malformed_count,subscribed_at,coverage_through FROM cpa_error_subscription_sessions ORDER BY id")).rows;
  assert.deepEqual(sessions.map((s) => s.end_reason), ["malformed_payload", "stream_interrupted", "shutdown"]);
  assert.equal(sessions[0].malformed_count, "1");
  assert.equal(sessions.reduce((n, s) => n + Number(s.received_count), 0), 4);
  assert.equal(sessions.reduce((n, s) => n + Number(s.inserted_count), 0), 1);
  assert.equal(sessions.reduce((n, s) => n + Number(s.duplicate_count), 0), 2);
  assert.ok(sessions[0].coverage_through, "the subscription acknowledgement establishes the initial coverage watermark");
  assert.ok(Math.abs(new Date(sessions[0].coverage_through).getTime() - new Date(sessions[0].subscribed_at).getTime()) < 1000, "malformed payloads do not advance coverage beyond the subscription acknowledgement");
  assert.ok(new Date(sessions[1].coverage_through) > new Date(sessions[1].subscribed_at), "a durable error event advances coverage even if the stream then disconnects");
  assert.ok(new Date(sessions[2].coverage_through) > new Date(sessions[2].subscribed_at), "a durable error event advances coverage on a healthy stream");
  assert.equal(Number((await pool.query("SELECT count(*) FROM usage_inbox")).rows[0].count), 0);
  assert.ok(!JSON.stringify((await pool.query("SELECT body,auth_status FROM cpa_error_events")).rows).includes("private-value"));
});
test("Records evidence uses one MVCC snapshot when event and coverage commits race the read", options, async (t) => {
  const { pool } = await errorTestDatabase(t);
  const now = Date.now(), center = now - 180000;
  const store = createErrorStore(pool, { instanceId: "one", workerId: "worker", leaseSeconds: 45 });
  await store.acquire();
  const id = await store.startSession();
  await store.subscribed(id);
  await pool.query("UPDATE cpa_error_subscription_sessions SET subscribed_at=$2,coverage_through=$3 WHERE id=$1", [id, new Date(center - 120000), new Date(center)]);
  let injected = false;
  const racingPool = { connect: async () => {
    const client = await pool.connect();
    return { release: () => client.release(), query: async (sql, values) => {
      const result = await client.query(sql, values);
      if (String(sql).includes("FROM cpa_error_events WHERE") && !injected) {
        injected = true;
        await store.persist(id, error(center));
        await pool.query("UPDATE cpa_error_subscription_sessions SET coverage_through=$2 WHERE id=$1", [id, new Date(now)]);
      }
      return result;
    } };
  } };
  const record = { sourceInstanceId: "one", authIndex: "credential-1", occurredAt: new Date(center) };
  const result = await getCredentialErrors(racingPool, record, { now });
  assert.ok(injected);
  assert.equal(result.events.length, 0);
  assert.equal(result.coverage.complete, false, "new coverage cannot describe an older empty event snapshot as complete");
  const next = await getCredentialErrors(pool, record, { now });
  assert.equal(next.events.length, 1);
  assert.equal(next.coverage.complete, true);
});
