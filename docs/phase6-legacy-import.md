# Phase 6 — Historical OMC Import

## Source discovery

- Source: `/var/lib/oh-my-cpa/data/oh-my-cpa.db` (Oh My CPA SQLite).
- Snapshot: created with SQLite's online backup API into a mode-0600 file under a mode-0700 temporary directory; the live OMC database is opened read-only and is not modified.
- Source schema migration version: 63.
- Source `usage_events`: 17,132 rows, 31 models, 13 providers, 42 auth indexes. The separate CPA Manager Plus SQLite database is not part of this Oh My CPA import.
- Time range: 2026-08-20 07:50:28.224 UTC through 2026-11-17 15:04:14.160 UTC.
- Source pricing snapshot: 3,268 priced events and 13,864 unpriced events. Historical `cost_nanos` totals 74,059,490,998 nanos.
- Historical pricing catalog: 105 immutable `model_price_versions` rows; all 105 are retained in `usage_import_source_price_versions`. Eight distinct source price-version IDs are referenced by the 3,268 priced usage events.
- Source `event_key` has 1,010 duplicate groups (2,256 additional rows). All source rows are retained; the importer identity is based on immutable source row ID, not `event_key` or `request_id`.

## Import contract

- One source `usage_events.id` becomes one canonical PostgreSQL event. No synthetic request expansion or aggregation.
- `occurred_at` comes from source `timestamp_ms`; `created_at` comes from source `created_at_ms`.
- Historical cost snapshots and pricing status are preserved. Source `price_version_id` is stored as `source_price_version_id`; it is never reused as a foreign key into the target price catalog. Target `price_version_id` remains NULL.
- All 105 OMC historical price-version rows are imported into a separate audit table with original prompt/completion/cache-read/cache-write rates, multiplier, tier JSON, source, upstream ID, channel and effective time. They are not coerced into the narrower live price catalog.
- The OMC event and price-version schemas do not contain a currency column. The importer uses USD as the canonical OMC price unit; this is a schema-level mapping assumption. The separate display exchange-rate cache is not imported.
- `source_instance_id=legacy-oh-my-cpa-default`, `origin_system=oh_my_cpa`, `source_transport=legacy_import`. The matching collector instance is registered disabled; no queue is consumed.
- Deterministic identity: SHA-256 of `legacy-oh-my-cpa-v1`, source key and immutable source row ID. The original `event_key` is retained separately as `source_event_key` for provenance and duplicate analysis. Duplicate source `event_key` values do not collapse distinct source rows.
- The importer is restartable by source ID, batched transactionally, source-SHA256 bound, serialized with a PostgreSQL advisory lock, and replay-safe. By default it only accepts loopback PostgreSQL test databases. Production import is an explicit Phase 7 operation requiring both `--allow-production-target` and `PHASE6_IMPORT_ALLOW_PRODUCTION_TARGET=true`, and it only accepts the dedicated `cliproxyapi_monitor` role/database on Docker host `postgres`. It verifies the source file hash again before finalizing a run. A completed source snapshot is a no-op on re-run.
- A run ledger records source checksum, schema version, manifest, progress, inserted/skipped counts, and completion/failure state.

## Privacy boundary

- Imported: token/accounting fields, masked API key, model/provider/endpoint, credential/source labels, request ID, service tier, status, latency, historical cost and pricing metadata.
- Excluded: client IP, forwarded-for, User-Agent, raw request JSON, failure body and response headers. `raw_payload` is `{}`.
- `token_accounting` and `structured_usage` are imported as structured accounting metadata.

## Reconciliation snapshot

The isolated PostgreSQL 17 E2E import inserted 17,132/17,132 usage rows and 105/105 historical price-version rows with 0 skipped. Source and target matched exactly for input, output, reasoning, cached, cache-read and total tokens; failures; priced/unpriced counts; historical cost nanos; and min/max event time. There are 17,132 identity rows for 17,132 imported events. Sensitive columns are NULL and the legacy Collector instance remains disabled.

The daily/hourly rollups were rebuilt for `Asia/Shanghai`. The daily rollup totals also matched all 17,132 events and the canonical token/cost totals. Overview raw-event and rollup daily series matched; Explore, Records and Collector status APIs were exercised against the imported dataset.

## Scope boundary

This phase builds and validates the importer against an isolated PostgreSQL 17 database. It does not write to a production PostgreSQL endpoint, change OMC's SQLite database, enable the legacy Collector instance, or deploy the Monitor. Production target provisioning, final migration rehearsal and cutover remain Phase 7.
