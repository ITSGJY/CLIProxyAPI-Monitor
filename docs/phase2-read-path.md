# Phase 2 — Dashboard Read Path

## Goal

Move Overview, Explore and Records from the legacy `usage_records` table to the canonical request-level `usage_events` store without changing the existing page layout or breaking historical OMC-era records.

Phase 1 is accepted: PostgreSQL 17 CI is green and the CPA v8.0.75 isolated test exercised both RESP LPOP and HTTP fallback. Phase 2 remains a personal-fork branch; no production database migration, historical import, CPA cutover or deployment is part of this work.

## Canonical data contract

- `usage_events` is the source of truth for request-level data.
- `usage_event_identity` provides global idempotency across partitions and imports.
- `model_price_versions` is the effective-dated price ledger. Event cost is `cost_nanos / 1e9` in `cost_currency`; do not recalculate historical event cost from the current `model_prices` row.
- `cost_nanos = NULL` and `pricing_status = 'unpriced'` mean unknown cost, not zero cost.
- `reasoning_tokens` is a subset of `output_tokens`; never add it to output tokens when calculating total tokens or cost.
- API keys are represented only by `api_key_mask`. Raw keys must not enter read models, rollups, logs or UI responses.
- Credential display names resolve as `COALESCE(auth_file_mappings.name, usage_events.source, usage_events.auth_index, '')`.

## Legacy compatibility and import

The old `usage_records.route` column was used as the API-key filter/display value. In the new read model, that contract maps to `usage_events.api_key_mask`, not `endpoint`.

| Legacy `usage_records` field | Canonical event field |
|---|---|
| `occurred_at` | `occurred_at` |
| `route` (legacy API key) | `api_key_mask` after masking |
| `source` | `source` / credential display fallback |
| `auth_index` | `auth_index` |
| `model` | `model` |
| `input_tokens` | `input_tokens` |
| `output_tokens` | `output_tokens` |
| `reasoning_tokens` | `reasoning_tokens` (subset of output) |
| `cached_tokens` | `cached_tokens` / `cache_read_tokens` where supported |
| `total_tokens` | `total_tokens` |
| `is_error` | `is_error` |
| `raw` | sanitized `raw_payload`; never copy raw credentials |

Historical rows are imported by an explicit, idempotent backfill command. It writes `origin_system='legacy_import'` and `source_transport='legacy_import'`, creates a stable identity from the legacy row ID, records an `usage_import_batches` audit row, and can be resumed safely. The command must support dry-run and bounded batches. It is not run automatically by migrations or application startup.

## Page read models

### Overview

- Keep the existing KPI cards, time-series chart, model ranking and credential/API-key breakdowns.
- Use hourly rollups for shorter ranges and daily rollups for longer ranges.
- Apply the same filters to every KPI, series and breakdown: time range, model, masked API key (`route` compatibility parameter), credential (`source` compatibility parameter), provider and service tier.
- Sum costs only within the same currency. Expose unpriced request counts separately; never turn unknown cost into `$0`.
- Use request-level events for drill-downs and rollups for aggregate chart queries.

### Explore

- Keep the existing time/token scatter and model visibility controls.
- Add cache-read/cache-creation, latency, TTFT, service-tier, result and priced-cost fields to point tooltips where present.
- Cap the scatter at 8,000 points using deterministic time-stratified sampling; apply filters before sampling.
- Do not include request IDs, raw API keys, client IPs, forwarded-for values, user-agent strings or raw payloads in scatter responses.
- Preserve existing filters and add provider/service-tier filters without changing the default visual layout.

### Records

- Read request-level events with cursor-stable ordering and the existing filter/sort contract.
- Keep `route` as the compatibility name for the masked API-key field; do not expose the old raw `route` value.
- Resolve credential names through `auth_file_mappings` with safe fallbacks.
- Show cost only when priced; show the currency and an explicit unpriced state otherwise.
- Preserve existing table interactions, column settings, multi-sort and record details while adding provider, endpoint, status, latency, TTFT, cache and service-tier fields where useful.

## Rollup dimensions

Rollups must support the filters used by Overview: timezone, provider, model, credential display source, API group, masked API key, service tier and cost currency. They must also retain unpriced request counts so partial pricing is visible. Rollups are rebuildable from `usage_events`; they are never the source of truth.

## Phase 2 acceptance

1. Backfill is idempotent: rerunning it creates no duplicate events and does not expose raw API keys.
2. Imported legacy and live events can be queried through one canonical read path.
3. Overview totals reconcile to request-level events for the same filters and currency.
4. Explore sampling is deterministic, time-stratified, bounded to 8,000 rows and PII-safe.
5. Records pagination has no duplicate or skipped rows across pages for supported sort modes.
6. Existing UI interactions and response contracts remain compatible.
7. PostgreSQL 17 integration tests, lint, TypeScript checks and production build pass in GitHub Actions.
8. Production backfill and deployment remain a separate, explicitly approved cutover.
