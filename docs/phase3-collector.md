# Phase 3 — CPA Usage Collector

## Scope and boundary

Phase 3 owns one responsibility: receive CPA v8 `usage` events and commit each event to PostgreSQL `usage_inbox` before the Collector acknowledges it locally.

- Default transport: RESP `AUTH` + `SUBSCRIBE usage` (native Redis Pub/Sub).
- Explicit compatibility mode: RESP `LPOP usage <count>` with HTTP `GET /v8/management/observability/usage/queue?count=<count>` fallback only when RESP fails before a destructive pop may have occurred.
- `auto` prefers subscription. FIFO fallback additionally requires `COLLECTOR_ALLOW_PULL_FALLBACK=true`; this flag is rejected for production CPA or PostgreSQL targets.
- Production Compose pins `COLLECTOR_MODE=subscribe` and `COLLECTOR_ALLOW_PULL_FALLBACK=false` so a rejected subscription can never silently switch to destructive LPOP.
- Persistence: every Pub/Sub payload is sanitized and committed to PostgreSQL `usage_inbox` in its own transaction. Subscription-session attempts track received/persisted counters and the exact `subscribed_at` acknowledgement timestamp; Processor remains an independent worker.
- Processor: deliberately not started by this process. Normalization, idempotent event creation and pricing are the separate Phase 4 worker.
- Production subscription can coexist with OMC and CPA Usage Keeper. Pull compatibility requires a coordinated single-consumer window.

CPA v8.0.75 does not implement RESP `LLEN`. Empty polls therefore receive a Pull Attempt audit row too; empty rows are retained for seven days and pruned automatically.

## Safety defaults

The Collector remains disabled unless `COLLECTOR_ENABLED=true` and refuses the production CPA management port `8317` or non-test database targets unless the separately approved cutover flags are set. Do not set those flags for Phase 3 testing.

The native `SUBSCRIBE usage` transport is designed to coexist with OMC and CPA Usage Keeper: CPA broadcasts each event to every subscriber and suppresses FIFO queue writes while at least one subscriber is connected. Do not run multiple FIFO pull consumers. A subscription is at-most-once; CPA provides no replay or acknowledgement, so disconnects create an explicit `usage_ingest_gaps` record and cannot be described as lossless.

## Configuration

Required variables when enabled:

- `COLLECTOR_ENABLED=true`
- `CPA_INSTANCE_ID`
- `CPA_REDIS_ADDR` — explicit `host:port` or `[IPv6]:port`
- `CPA_MANAGEMENT_BASE_URL`
- `CPA_MANAGEMENT_KEY`
- `DATABASE_URL` — PostgreSQL URL

Optional bounds:

- `CPA_USAGE_QUEUE=usage` — other queue names are rejected
- `COLLECTOR_MODE=subscribe` — production native Pub/Sub; `auto` is for isolated compatibility tests; `pull` / `pull-first` explicitly force FIFO polling
- `COLLECTOR_ALLOW_PULL_FALLBACK=false` — explicit test-only opt-in; forbidden with production CPA or PostgreSQL flags
- `COLLECTOR_POLL_INTERVAL_MS=10000`
- `COLLECTOR_BATCH_SIZE=100` — maximum 1000
- `COLLECTOR_LEASE_SECONDS=60` — minimum `max(60, 3 × poll interval in seconds)`
- `COLLECTOR_HEALTH_STALE_AFTER_MS` — defaults to `max(60 seconds, 3 × poll interval)`

The Collector performs a database readiness query at startup and commits a Subscription Attempt before subscribing. The database records the server-acknowledged `subscribed_at` timestamp so the OMC history snapshot can be reconciled at the production handover boundary.

## Run and inspect

Run the Collector only against the isolated CPA test instance and disposable PostgreSQL 17 test database:

```bash
pnpm collector
```

In another shell, inspect health:

```bash
pnpm collector:health
```

The health command requires only `DATABASE_URL` and `CPA_INSTANCE_ID`; it does not need the CPA management key. It reports:

- healthy / starting / paused / degraded / stale / stopped state
- lease expiry and last successful receive/heartbeat
- last transport and error code
- pending, processing and dead-letter Inbox counts
- a capacity warning when at least three of the latest five completed FIFO pulls filled their requested batch size

The health command exits non-zero unless the Collector has a fresh heartbeat, a live lease and a recent successful receive (or pull in compatibility mode). A paused Collector is intentionally not considered healthy for ingestion.

## Retry and recovery contract

1. `auto` authenticates and subscribes to `usage`. It only switches to FIFO after an explicit server rejection and explicit `COLLECTOR_ALLOW_PULL_FALLBACK=true`; production flags make this combination invalid.
2. Each Pub/Sub message is persisted to Inbox before the callback completes. The stream has no server acknowledgement, replay cursor or redelivery guarantee.
3. A disconnect after the subscription acknowledgement marks the session interrupted and writes an `usage_ingest_gaps` row with unknown missing count. The Collector reconnects with capped exponential backoff; it never LPOP in production subscription mode.
4. If PostgreSQL fails after a message is delivered, the session is terminated and a gap is recorded. Already committed Inbox rows remain durable; the in-flight message may be lost because CPA Pub/Sub is at-most-once.
5. Explicit `pull` mode uses RESP LPOP and HTTP fallback only before uncertain destructive consumption. A timeout/disconnect after the pop command may have been sent is marked uncertain; HTTP fallback is forbidden.
6. The Collector renews its lease and heartbeat while the subscription is open, including periods with no usage events.
7. The service supervisor uses `Restart=on-failure`; the example is in `deploy/systemd/cliproxyapi-monitor-collector.service.example`. Adjust the service account and paths before installing it. It is a template only and has not been installed on the production server.

The durable Inbox guarantees replay after the PostgreSQL transaction commits. It cannot make CPA's destructive pop and PostgreSQL commit atomic; an interruption between those systems is recorded as a gap, not silently described as lossless delivery.

## Phase 3 acceptance

- [x] PostgreSQL 17 CI and schema/inbox transaction tests are green.
- [x] CPA v8.0.75 isolated RESP and HTTP end-to-end paths have been exercised.
- [x] RESP Pub/Sub stream persists events to the durable Inbox and shares Processor/idempotency logic.
- [x] Established subscription disconnects and persistence failures create explicit ingest-gap records; reconnect does not blindly pull.
- [x] `auto` mode only switches to pull on an explicit server rejection of `SUBSCRIBE`.
- [x] Explicit FIFO pull retains the prior empty-result and uncertain-consumption safety behavior.
- [x] Uncertain destructive pulls are audited, stop the Collector with a non-zero exit and surface degraded health.
- [x] The Collector no longer runs the Phase 4 Processor in its polling loop.
- [x] Inbox batches use one bulk insert inside the pull transaction.
- [x] Lease bounds cover retry backoff and long polling intervals.
- [x] Collector health is independently queryable and exposes batch-saturation warnings.
- [x] Repeated-poll soak against isolated CPA v8.0.75 and PostgreSQL 17: 20 additional requests drained in batches; 28 distinct events durable in Inbox.
- [x] Final GitHub Actions run for the Phase 3 branch (PostgreSQL 17, Collector tests, lint, TypeScript and production build).

Production deployment, production database migration and deployment approval are Phase 7 work, not Phase 3 acceptance. Native RESP Subscription can coexist with OMC and Keeper; only the optional FIFO pull compatibility mode requires all other subscribers to be stopped.
