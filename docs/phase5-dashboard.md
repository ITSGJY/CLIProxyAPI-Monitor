# Phase 5 — Dashboard Read Path

## Objective

Switch the existing Overview, Explore and Records pages from legacy `usage_records` to the canonical PostgreSQL `usage_events` and rebuildable rollups. Preserve the current Monitor UI and its interactions. This phase does not import legacy history (Phase 6) or deploy/cut over production (Phase 7).

## Shared read contract

- Time range is half-open UTC `[start, end)` internally; display buckets use the requested validated IANA timezone.
- Common filters: model, masked API key (`route` compatibility alias), credential (`source` compatibility alias), provider, effective/billed service tier, status and currency where relevant.
- Credential label: `COALESCE(auth_file_mappings.name, usage_events.source, usage_events.auth_index, '-')`.
- Cost: read the event's persisted `cost_nanos`, `cost_currency`, `pricing_status`; never recalculate with the current price table. `NULL` cost is unknown, not zero. Never sum different currencies.
- Reasoning tokens remain a subset of output tokens.
- API responses must never include `raw_payload`, client IP, forwarded-for, user-agent, raw API key or auth secrets.

## Page contracts

### Overview

Keep existing KPI/chart/model/credential presentation. Aggregate from rollups when the query dimensions are representable; use canonical event aggregation for unsupported filter combinations. Every KPI, chart and breakdown must share the same filter predicate. Return cost totals grouped by currency and explicit priced/unpriced/partial counts. Use fresh timezone-matched daily rollups for complete local-day trend ranges up to 90 days when all selected dimensions are represented; use canonical event aggregation for partial-day windows and unsupported filters. Hourly rollups remain available for future short-range optimization but are not yet selected by the Overview read path.

### Explore

Apply all filters in SQL before sampling. Return at most 8,000 points. Deterministic time-stratified sampling must preserve coverage across the requested interval, with stable tie-breaking by `(occurred_at,event_id)`. Include cache read/creation, latency, TTFT, service tier, status and cost where available. Never return PII or raw payload.

### Records

Use cursor-stable ordering. Every sort must include a unique tie-breaker `(occurred_at,event_id)` or the corresponding selected sort value plus `(occurred_at,event_id)`. Cursor is opaque, versioned and validated. Preserve the existing `route` API parameter but map it only to `api_key_mask`. Include price state and currency; unknown cost stays null.

### Operational visibility

Expose per-instance Collector state, lease freshness, last successful poll, transport, last error code, Inbox pending/processing/dead-letter counts, recent pull outcomes and explicit ingestion gaps. Show price coverage: priced, unpriced, partial, and percentage based on priced requests (not treating unknown cost as zero).

## Schema compatibility resolution

Migration `0006_phase5_dashboard_rollup_dimensions.sql` adds `api_key_mask`, `service_tier`, `cache_creation_tokens`, `priced_request_count` and `unpriced_request_count` to hourly/daily rollups and extends their primary keys to preserve the global filter dimensions. It also adds API Key, Service Tier and ingestion-time indexes. Rollup generation now groups and writes these fields. Overview uses the daily rollup only when the matching timezone checkpoint is completed and fresh; otherwise it falls back to canonical events. Filters not represented in the rollup dimensions (credential display name and request status) also use canonical events.

## Implementation batches

1. 5A shared filters/read models and additive rollup schema compatibility.
2. 5B Overview + Explore canonical query path and response-compatible UI.
3. 5C Records canonical query path, details and stable cursor pagination.
4. 5D price coverage and Collector health/gap visibility, query performance and full regression.

## Acceptance

- No new live dashboard query reads `usage_records`.
- Same filters produce reconcilable totals across Overview, Explore and Records.
- Costs reconcile by currency and price status; no unknown cost becomes zero.
- Explore is deterministic, SQL-filtered first, capped at 8,000 and PII-safe.
- Records cursor pagination has no duplicates or omissions under stable data and supported sorts.
- Collector status/gaps and pricing coverage are visible and operationally accurate.
- PostgreSQL 17 integration, unit tests, lint, TypeScript and production build pass in GitHub Actions.
- No historical import, production migration, CPA queue consumption or production deployment.
