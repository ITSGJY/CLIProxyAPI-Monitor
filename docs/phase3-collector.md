# Phase 3 — CPA Pull Collector

## Scope and boundary

Phase 3 owns one responsibility: consume the CPA v8 `usage` queue and commit every successfully returned batch to PostgreSQL `usage_inbox` before acknowledging success to the Collector loop.

- Primary transport: RESP `AUTH` + `LPOP usage <count>`.
- Fallback: HTTP `GET /v8/management/observability/usage/queue?count=<count>` only when RESP fails before a destructive pop may have occurred.
- Persistence: one sanitized, multi-row `INSERT ... SELECT FROM jsonb_to_recordset(...)` in a PostgreSQL transaction; the pull-attempt completion and Collector success state are committed in that same transaction.
- Processor: deliberately not started by this process. Normalization, idempotent event creation and pricing are the separate Phase 4 worker.
- Production cutover: not part of Phase 3. OMC, Keeper, CPAMP and production CPA configuration remain unchanged.

CPA v8.0.75 does not implement RESP `LLEN`. Empty polls therefore receive a Pull Attempt audit row too; empty rows are retained for seven days and pruned automatically.

## Safety defaults

The Collector remains disabled unless `COLLECTOR_ENABLED=true` and refuses the production CPA management port `8317` or non-test database targets unless the separately approved cutover flags are set. Do not set those flags for Phase 3 testing.

Never run this Collector alongside OMC, CPA Usage Keeper or CPA Manager Plus against the same production CPA queue. Both RESP `LPOP` and the HTTP queue endpoint consume items.

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
- `COLLECTOR_MODE=pull-first` — Subscribe is not enabled
- `COLLECTOR_POLL_INTERVAL_MS=10000`
- `COLLECTOR_BATCH_SIZE=100` — maximum 1000
- `COLLECTOR_LEASE_SECONDS=60` — minimum `max(60, 3 × poll interval in seconds)`
- `COLLECTOR_HEALTH_STALE_AFTER_MS` — defaults to `max(60 seconds, 3 × poll interval)`

The Collector performs a database readiness query at startup and commits a Pull Attempt before each destructive queue operation. If PostgreSQL cannot accept that audit row, it does not issue the queue pop.

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
- lease expiry and last successful poll
- last transport and error code
- pending, processing and dead-letter Inbox counts
- a capacity warning when at least three of the latest five completed pulls filled their requested batch size

The health command exits non-zero unless the Collector has a fresh heartbeat, a live lease and a recent successful pull. A paused Collector is intentionally not considered healthy for ingestion.

## Retry and recovery contract

1. A RESP connection, authentication or server-command failure that is known to occur before a destructive pop is recorded as a failed RESP attempt; the Collector then tries HTTP.
2. An empty successful RESP result is a successful poll. It never triggers HTTP fallback.
3. A timeout, disconnect or malformed response after a destructive command may have been sent is treated as uncertain consumption. HTTP fallback is forbidden.
4. If the HTTP fallback returns a result, it is persisted as its own HTTP Pull Attempt.
5. If HTTP fails with a response that may have consumed the queue, or if PostgreSQL fails after a successful pull, the attempt is marked interrupted and an `usage_ingest_gaps` row is written. The Collector exits non-zero; the systemd example restarts it after a delay. Review the gap record before treating the interval as complete.
6. Definite pre-consumption transport failures use capped exponential backoff. The Collector renews its lease and heartbeat during polling and backoff waits.
7. The service supervisor uses `Restart=on-failure`; the example is in `deploy/systemd/cliproxyapi-monitor-collector.service.example`. Adjust the service account and paths before installing it. It is a template only and has not been installed on the production server.

The durable Inbox guarantees replay after the PostgreSQL transaction commits. It cannot make CPA's destructive pop and PostgreSQL commit atomic; an interruption between those systems is recorded as a gap, not silently described as lossless delivery.

## Phase 3 acceptance

- [x] PostgreSQL 17 CI and schema/inbox transaction tests are green.
- [x] CPA v8.0.75 isolated RESP and HTTP end-to-end paths have been exercised.
- [x] RESP empty results do not trigger a second destructive pull.
- [x] Uncertain destructive pulls are audited, stop the Collector with a non-zero exit and surface degraded health.
- [x] The Collector no longer runs the Phase 4 Processor in its polling loop.
- [x] Inbox batches use one bulk insert inside the pull transaction.
- [x] Lease bounds cover retry backoff and long polling intervals.
- [x] Collector health is independently queryable and exposes batch-saturation warnings.
- [x] Repeated-poll soak against isolated CPA v8.0.75 and PostgreSQL 17: 20 additional requests drained in batches; 28 distinct events durable in Inbox.
- [x] Final GitHub Actions run for the Phase 3 branch (PostgreSQL 17, Collector tests, lint, TypeScript and production build).

Production deployment, production database migration, disabling OMC/Keeper/CPAMP collectors and cutover approval are Phase 7 work, not Phase 3 acceptance.
