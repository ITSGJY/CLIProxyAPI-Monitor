# CLIProxyAPI-Monitor Plus Architecture (v2.1)

## Scope

This is a personal fork of CLIProxyAPI-Monitor. It retains the original Overview, Explore and Records experience while replacing the legacy `/usage` adapter with a CPA v8 request-level Collector, a PostgreSQL durable Inbox, an independent Processor and versioned pricing / Rollup services.

The production data store and durable Inbox are PostgreSQL 17. The final design intentionally does not use a local SQLite spool; see [ADR-001](decisions/ADR-001-postgres-durable-inbox.md). A PostgreSQL outage can interrupt the at-most-once CPA stream, so the Collector records a gap rather than claiming lossless delivery.

## Data flow

```text
CLIProxyAPI v8
  |
  | RESP AUTH + SUBSCRIBE usage (production primary)
  | RESP LPOP / HTTP Usage Queue (explicit single-consumer compatibility only)
  v
Independent Collector
  |
  | one PostgreSQL transaction per received Pub/Sub event
  v
usage_pull_attempts + usage_inbox (durable, sanitized payloads)
  |
  | Processor Worker, per-row lease / retry
  v
usage_event_identity (global idempotency ledger)
  |
  v
usage_events (monthly range partitions)
  |
  +--> immutable versioned model prices and request cost snapshots
  |
  +--> Rollup Worker --> rebuildable hourly / daily rollups
  |
  +--> Overview / Explore / Records read APIs
```

The Collector is disabled by default. Phase 3 validation uses loopback CPA test endpoints and a loopback PostgreSQL database whose name contains `test`. Port 8317 and non-test databases require their respective explicit production flags. Production Compose pins `COLLECTOR_MODE=subscribe` and `COLLECTOR_ALLOW_PULL_FALLBACK=false`.

## CPA v8 Usage delivery semantics

The verified CPA v8 implementation exposes RESP `AUTH`, `SUBSCRIBE usage`, `LPOP usage <count>`, and the Management Usage Queue HTTP endpoint. The RESP interface is not a complete Redis server; do not depend on `LLEN`, `INFO`, `BLPOP` or other undocumented commands.

- `SUBSCRIBE usage` broadcasts each event to every connected subscriber.
- While at least one Usage subscriber is connected, CPA does not enqueue those events in its FIFO Usage Queue.
- `LPOP usage` and the HTTP Usage Queue endpoint are destructive reads.
- Production must use native Subscription so Monitor can coexist with OMC and CPA Usage Keeper.
- FIFO pull is permitted only in a separately coordinated single-consumer window after every other Usage subscriber is confirmed stopped.
- `auto` fallback is disabled by default and requires explicit `COLLECTOR_ALLOW_PULL_FALLBACK=true`; configuration rejects this option whenever either production target flag is enabled.

## Delivery guarantee and loss window

CPA Pub/Sub is at-most-once. It has no server ACK, replay cursor or consumer-group semantics. The Collector records the Subscription Attempt and the exact `subscribed_at` acknowledgement time, then commits every received, sanitized event to PostgreSQL `usage_inbox` before the message callback completes.

The PostgreSQL Inbox guarantees replayable processing after its transaction commits. If PostgreSQL fails after CPA has delivered an event, the in-flight event may be lost; the Collector closes the session, records an `usage_ingest_gaps` row with an unknown missing count and reconnects with capped backoff. The durable Inbox cannot make CPA delivery and PostgreSQL commit atomic. Never describe this path as end-to-end zero-loss.

The optional FIFO compatibility path records a Pull Attempt before each destructive pop. A disconnect after a pop may have been sent is uncertain consumption; HTTP fallback is forbidden in that state. Empty pull attempts are audited and pruned after seven days.

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

The original `usage_records` table is retained as a legacy UI/history source during Phase 1. The Phase 3 Collector writes only to `usage_inbox`; the Phase 4 Processor normalizes and writes `usage_events`. Switching the three UI read paths to the canonical event model is a later phase. This avoids duplicating each live event into two stores.

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

The existing PostgreSQL 17 container reported `max_connections=100` during the latest preflight. Application pools remain deliberately small because this database is shared with the Personal Cloud Hub workload:

- Web application pool: maximum 3.
- Collector pool: maximum 2.
- Processor pool: maximum 2.
- Rollup pool: maximum 1.
- Optional error collector pool: maximum 1.
- Each health CLI: maximum 1, short-lived; the usage and error probes are independent.
- Migration / operator connections: temporary and serialized.

Keep the Monitor's steady-state application budget at or below 9 connections. Do not increase pool defaults without observing `pg_stat_activity`, memory and dashboard query latency.

## Migration and deployment

- SQL migrations are hand-authored and reviewed because PostgreSQL partition DDL and compatibility constraints are explicit.
- `pnpm build` must not mutate a database.
- Run `pnpm db:migrate` as a separate, deliberate operation.
- Never use `drizzle-kit push` against production.
- CI uses an ephemeral PostgreSQL 17 service and a dedicated test database.
- Production uses a dedicated database and role inside the existing PostgreSQL service; Cloudreve's database, role and volume remain untouched.
- Production Collector uses `SUBSCRIBE`; it does not stop or compete with other broadcast subscribers. FIFO pull remains a separately coordinated compatibility mode.

## Phase 5.5: independent credential error evidence

CPA `errors` has a separate RESP connection, collector process, fenced lease, session history and Compose profile. It writes sanitized projections directly to `cpa_error_events`; it never consumes FIFO errors, enters `usage_inbox`, or controls the usage subscription. OMC errors use a separate audited importer and the same legacy instance ID as historical usage.

Records Diagnostics associates at most 20 events by CPA instance, non-empty credential index and an inclusive ±120-second window. Signed deltas and provider/model matches are investigative evidence, not request IDs or proof of causation. Session watermarks and import audits distinguish complete, collecting, gap, disconnected, unavailable and failed-query coverage. Read events and coverage within one PostgreSQL snapshot.

See [Phase 5.5 runbook](phase5.5-cpa-error-events.md) for the pinned CPA v8.0.56 / OMC v0.4.2 contract, privacy projection, state semantics, migration, import reconciliation and deployment prerequisites.
