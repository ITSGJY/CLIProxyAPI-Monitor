# CLIProxyAPI-Monitor Plus Architecture (v2.0)

## Scope

This repository is a personal fork of CLIProxyAPI-Monitor. It retains the original Overview, Explore and Records experience while replacing the legacy `/usage` + in-memory adapter ingestion path with a request-level CPA v8 collector and PostgreSQL persistence.

The production data store is PostgreSQL 17. SQLite is not used as a production journal or intermediate write buffer.

## Data flow

```text
CLIProxyAPI v8
  |
  | RESP AUTH + non-destructive LLEN preflight + LPOP usage (primary)
  | HTTP GET /v8/management/observability/usage/queue (fallback)
  v
Collector
  |
  | one short PostgreSQL transaction per pulled batch
  v
usage_pull_attempts + usage_inbox (durable, sanitized payloads)
  |
  | single-worker Processor, retry + lease
  v
usage_event_identity (global idempotency ledger)
  |
  v
usage_events (monthly range partitions)
  |
  +--> versioned model prices
  |
  +--> rebuildable hourly / daily rollups
```

The Collector is disabled by default. It has no default CPA host, port, management key or database URL. Phase 1 requires loopback CPA test endpoints and a loopback PostgreSQL database whose name contains `test`. Port 8317 is blocked unless `CPA_ALLOW_PRODUCTION_TARGET=true` is explicitly supplied; a non-test database additionally requires `COLLECTOR_ALLOW_PRODUCTION_DATABASE=true`. Both flags are reserved for a separately approved production cutover.

## CPA v8 queue semantics

The verified CPA v8 implementation exposes:

- RESP AUTH, non-destructive `LLEN usage`, then `LPOP usage <count>` when the queue is non-empty.
- HTTP `GET /v8/management/observability/usage/queue?count=<count>`.
- Both pull operations consume queue items.
- CPA's in-memory queue broadcasts to active SUBSCRIBE clients and skips normal queue enqueue while subscribers exist.

Therefore:

1. There must be one authoritative production consumer per CPA instance.
2. The production mode is Pull-first: RESP LLEN preflight, RESP LPOP, then HTTP fallback only if the RESP transport fails before a destructive pop is attempted.
3. Empty RESP queues do not create pull-attempt rows and are not a reason to call HTTP.
4. SUBSCRIBE remains experimental and must not run alongside the production Pull collector.
5. Do not start the new collector beside OMC, Keeper or CPAMP. Their existing collectors must be retired in a separately approved cutover.

## Delivery guarantee and loss window

LPOP is destructive and CPA does not provide a transactional acknowledgement spanning CPA and PostgreSQL. The durable inbox guarantees replayable processing **after** the inbox transaction commits; it cannot make the CPA pop and PostgreSQL commit atomic.

The Collector uses non-destructive RESP LLEN to avoid writing an audit row for every empty poll. When items are available, it creates a pull-attempt record before LPOP, persists the returned batch to `usage_inbox` in one transaction, and only then runs the Processor. A PostgreSQL lease permits only one Collector worker for a CPA instance; expired leases can be recovered after a process crash. If a process dies after LPOP but before inbox commit, startup recovery marks the attempt interrupted and writes a gap record. This makes the uncertainty observable; it cannot recover an item that CPA has already removed.

The Collector must never issue HTTP fallback after a successful RESP pop whose PostgreSQL persistence failed, because that would consume a second batch and obscure the first failure.

## PostgreSQL tables

| Table | Responsibility |
|---|---|
| `usage_collector_instances` | Non-secret endpoint metadata and per-CPA collector mode |
| `usage_collector_state` | Last attempt, success, transport, health state and single-worker lease |
| `usage_collector_commands` | Auditable manual pull / pause / resume requests with claim leases |
| `usage_pull_attempts` | Destructive queue pull audit trail |
| `usage_inbox` | Durable sanitized payload inbox, leases and retry state |
| `usage_event_identity` | Global unique event identity independent of time partitions |
| `usage_events` | Canonical request-level event store, partitioned by `occurred_at` month |
| `model_price_versions` | Immutable price history with effective time ranges |
| `usage_rollups_hourly`, `usage_rollups_daily` | Rebuildable aggregates |
| `usage_rollup_checkpoints` | Rollup rebuild watermarks |
| `usage_ingest_gaps` | Explicit record of uncertain / interrupted pulls |
| `usage_import_batches` | Auditable OMC / Keeper / CPAMP / legacy Monitor imports |

The original `usage_records` table is retained as a legacy UI/history source during Phase 1. The new Collector writes only to `usage_inbox` and `usage_events`; switching the three UI read paths to the canonical event model is a later phase. This avoids duplicating each live event into two stores.

## Event identity

Identity precedence:

1. CPA `request_id`.
2. `execution_id`.
3. `trace_id`.
4. A versioned canonical fingerprint over event time, source instance, provider, endpoint, auth index, model, token counts and outcome fields.

The identity ledger is not partitioned. Its unique key prevents the same logical request from being inserted into two event partitions or imported more than once from OMC, Keeper and CPAMP.

Historical imports must use a common source-instance identity and the same identity algorithm where source fields permit. Native database row IDs are provenance, not cross-database identity.

## Security and data minimization

- The Collector stores no raw CPA management key in PostgreSQL.
- API keys in usage payloads are removed from sanitized JSON and retained only as a masked display value.
- Authorization, password, secret, access-token and refresh-token fields are redacted recursively.
- Collector errors are sanitized before persistence or logging.
- CPA management credentials belong in the Collector's environment, not in the web dashboard's public build or database.

## Connection budget

The dedicated PostgreSQL host has a 30-connection server limit and 1 GB RAM. Initial application budgets:

- Web application pool: maximum 3.
- Collector pool: maximum 2.
- Migration / operator connections: temporary and serialized.

Do not increase these defaults without observing `pg_stat_activity` and measuring memory under realistic dashboard queries.

## Migration and deployment

- SQL migrations are hand-authored and reviewed because PostgreSQL partition DDL and compatibility constraints are explicit.
- `pnpm build` must not mutate a database.
- Run `pnpm db:migrate` as a separate, deliberate operation.
- Never use `drizzle-kit push` against production.
- CI uses an ephemeral PostgreSQL 17 service and a dedicated `cpa_monitor_test` database.
- Production database, roles, backups, CPA configuration and existing collectors remain untouched until a separate cutover approval.
