# Phase 4 — Processor, Pricing and Rollups

## Scope

Phase 4 consumes only the PostgreSQL Durable Inbox produced by the Phase 3 Collector. It does not connect to CPA and does not change the Collector's destructive queue contract.

- Independent Processor Worker: `pnpm processor`.
- Inbox processing: one row is claimed per transaction using `FOR UPDATE SKIP LOCKED`; each row receives its own processing lease and attempt count.
- Normalization: CPA v8 usage payloads are normalized into the canonical `usage_events` schema and monthly partition.
- Idempotency: `usage_event_identity` is global and unpartitioned; duplicate payloads update the duplicate ledger without inserting a second canonical event.
- Retry: transient processing failures return the Inbox row to `pending` with bounded exponential backoff; permanent normalization failures and exhausted retries go to `dead_letter`.
- Pricing: match `model_price_versions` by event `occurred_at`, model, provider and effective service tier. Cost is calculated in integer currency nanos; cached input is priced separately and reasoning tokens are not added again when they are already included in output tokens.
- Independent Rollup Worker: `pnpm rollup` rebuilds recent hourly and daily aggregate windows for a configured IANA timezone.

## Safety defaults

`PROCESSOR_ENABLED` and `ROLLUP_ENABLED` both default to `false`. Neither worker is started by the Collector, Next.js app, build or migration command. Do not run either worker against production until a separate deployment/cutover approval.

## Processor configuration

Required when enabled:

- `PROCESSOR_ENABLED=true`
- `DATABASE_URL`
- `CPA_INSTANCE_ID` — exact registered source instance whose Inbox is consumed

Optional bounds:

- `PROCESSOR_WORKER_ID=processor`
- `PROCESSOR_BATCH_SIZE=25` (1–500)
- `PROCESSOR_LEASE_SECONDS=120` (5–900)
- `PROCESSOR_MAX_ATTEMPTS=8` (1–100)
- `PROCESSOR_POLL_INTERVAL_MS=1000` (1–60000)

Each row is claimed independently so a slow earlier row cannot consume the lease time of every later row in the same batch. Multiple Processor processes may run for one instance; PostgreSQL `SKIP LOCKED` and per-row leases coordinate them. If a process exits while holding a row, another worker may reclaim it after lease expiry.

The processing transaction writes the canonical event, global identity row, Inbox completion state and last-event timestamp together. The retry path only updates a row still owned by the failing worker; it cannot overwrite a successful commit or a row reclaimed by another worker after an ambiguous connection failure.

## Pricing semantics

- Price selection is based on the event's occurrence time, not ingestion/processing time.
- Exact provider/service-tier versions take precedence over broader model-only versions.
- Input cost is split into uncached input and cached input; cached tokens are capped at input tokens.
- Output tokens are billed once. Reasoning tokens are retained as a separate metric but are not added on top of output tokens.
- `cost_nanos` is an integer amount in 1e-9 currency units. `pricing_status` is `priced` or `unpriced` on individual events.
- A missing matching historical price does not dead-letter the event; the event is stored as unpriced for later audit/repricing policy.

## Rollup configuration

Required when enabled:

- `ROLLUP_ENABLED=true`
- `DATABASE_URL`

Optional bounds:

- `ROLLUP_TIMEZONE=UTC` — validated IANA timezone
- `ROLLUP_HOURLY_LOOKBACK_HOURS=48` (1–8784)
- `ROLLUP_DAILY_LOOKBACK_DAYS=90` (1–3660)
- `ROLLUP_HOURLY_INTERVAL_MS=60000` (1–86400000)
- `ROLLUP_DAILY_INTERVAL_MS=3600000` (1–604800000)

The worker rebuilds its configured recent windows independently: hourly by default every minute, daily by default every hour. This deliberately captures late-arriving events without scanning the full 90-day daily window every minute. Hourly and daily refreshes are transactional; a PostgreSQL transaction-scoped advisory lock prevents overlapping workers from deleting/rebuilding the same rollup and timezone simultaneously. Checkpoints report `completed` or `failed` state.

The lookback is intentionally bounded. It is not the historical-import/backfill mechanism; Phase 6 owns broad historical imports and Phase 7 owns final production validation/cutover.

## Run locally

Use only the isolated PostgreSQL 17 test database and synthetic/test Inbox data:

```bash
pnpm processor
pnpm rollup
```

The commands print a disabled message and open no database connection unless their respective enable flag is explicitly true. Example systemd units are in `deploy/systemd/`; they are templates only and are not installed on the production server.

## Phase 4 acceptance

- [x] Processor implementation exists independently of Collector and is disabled by default.
- [x] Inbox rows are claimed one at a time with `SKIP LOCKED`, retry leases and bounded attempts.
- [x] Event normalization, global deduplication, historical price matching and token accounting are covered by PostgreSQL integration tests.
- [x] Permanent malformed events reach Dead Letter; transient database failures remain retryable.
- [x] Hourly and daily rollups rebuild recent windows with timezone support and concurrency locking.
- [x] GitHub Actions CI passed on commit `ab064d7` (Collector unit tests, PostgreSQL 17 integration, lint, TypeScript and production build). [Run #44111471549](https://github.com/ITSGJY/CLIProxyAPI-Monitor/actions/runs/44111471549).
- [x] Independent worker E2E smoke: Processor consumed 2 synthetic CPA-shaped Inbox rows into 2 priced canonical events; Rollup Worker produced hourly and daily aggregates (2 requests, 280000 USD nanos). No CPA connection or production Collector was involved.

Production CPA, production database, OMC/Keeper/CPAMP and production worker services remain unchanged. Their cutover is Phase 7 work.
