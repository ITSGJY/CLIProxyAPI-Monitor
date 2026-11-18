# Phase 1 Runbook

## Safety defaults

The Collector is disabled unless `COLLECTOR_ENABLED=true`. The production CPA management port 8317 is rejected unless `CPA_ALLOW_PRODUCTION_TARGET=true` is explicitly set. Phase 1 must use an isolated CPA instance with a non-production port and an isolated PostgreSQL test database.

Never put a production CPA key in a web build, test fixture, GitHub Actions secret or committed file.

## Local checks

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm lint
pnpm typecheck
pnpm build-only
```

For PostgreSQL integration tests, use a disposable PostgreSQL 17 database named `cpa_monitor_test` bound to loopback:

```bash
TEST_DATABASE_URL=postgresql://test:test@127.0.0.1:5432/cpa_monitor_test pnpm test:postgres
```

The integration test refuses non-loopback hosts or database names without a `test` suffix. It creates and drops a unique schema; it does not reset the database's public schema.

## Collector configuration

Required only when starting the standalone Collector:

- `COLLECTOR_ENABLED=true`
- `CPA_INSTANCE_ID`
- `CPA_REDIS_ADDR` (explicit host:port)
- `CPA_MANAGEMENT_BASE_URL`
- `CPA_MANAGEMENT_KEY`
- `DATABASE_URL` (loopback PostgreSQL database with `test` in its name for Phase 1)

Production safety overrides, reserved for a separately approved cutover:

- `CPA_ALLOW_PRODUCTION_TARGET=true`
- `COLLECTOR_ALLOW_PRODUCTION_DATABASE=true`

Optional bounds:

- `CPA_USAGE_QUEUE=usage` (any other queue is rejected)
- `COLLECTOR_MODE=subscribe` for production native Pub/Sub; `auto` is a test compatibility mode
- `COLLECTOR_ALLOW_PULL_FALLBACK=false` by default; production config rejects enabling it
- `COLLECTOR_POLL_INTERVAL_MS=10000`
- `COLLECTOR_BATCH_SIZE=100`
- `COLLECTOR_LEASE_SECONDS=60` (minimum `max(60, 3 × poll interval in seconds)`)

Run `pnpm collector` only against an isolated CPA test instance and disposable PostgreSQL database. The command is not run as part of build or CI. Phase 3 operations and health checks are documented in [the Phase 3 Collector runbook](phase3-collector.md).

## Phase 1 exit criteria

- [ ] Fork baseline and feature branch are reviewed.
- [ ] PostgreSQL migration applies to an ephemeral PostgreSQL 17 database.
- [ ] Inbox commit survives process restart.
- [ ] Processor replay does not create duplicate logical events.
- [ ] Event insert + identity ledger insert are transactionally atomic.
- [ ] Monthly partition routing is verified.
- [x] RESP AUTH/SUBSCRIBE Pub/Sub stream and FIFO LPOP/HTTP fallback pass fake-server tests.
- [ ] RESP empty result does not trigger a second destructive HTTP pull.
- [ ] A persistence failure after a successful LPOP does not invoke HTTP fallback.
- [ ] Production OMC, Keeper, CPAMP, CPA and PostgreSQL remain unchanged.
