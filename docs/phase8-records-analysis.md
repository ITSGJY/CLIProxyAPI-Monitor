# Phase 8 — Request Event Analysis Workbench

## Scope

Upgrade `/records` into a request-event analysis workspace while retaining Monitor's independent PostgreSQL event store and cursor-based pagination.

## UI

- Configurable event columns: show/hide, drag reorder, resize, and browser-local persistence.
- Column preferences use `records-column-settings-v3`; the page reads and migrates the previous v2 preference document.
- Default columns emphasize request identity, result, provider/model, credential, token/cache accounting, latency, TTFT and cost. Session ID, Parent Session ID, Execution ID, Trace ID, Node Kind, Fork and Compaction are also configurable.
- Clicking a row opens a detail drawer. The drawer loads the full event only when requested rather than adding large diagnostic payloads to every list response.
- Detail sections cover routing, model resolution, reasoning/service tiers, token accounting, execution/session context, pricing, error details, sanitized response headers and sanitized raw payload.

## API

- `GET /api/records`: cursor-paginated summary rows with expanded sortable fields and advanced filters. All seven request-context fields are sortable; free-text search also checks their dedicated columns and sanitized legacy payload fallback.
- `GET /api/records/detail?eventId=...`: full request detail by event ID.
- `GET /api/records/export?format=csv|json`: exports the current filter scope, capped at 20,000 rows. The response exposes `X-Records-Truncated` when the cap is reached.
- Advanced filters include free-text search, request ID, API group, endpoint, auth type, executor, reasoning effort, model alias, response model, HTTP status, latency range, token range and pricing state.

## Event schema

Migration `0009_request_event_context.sql` adds:

- `session_id`, `parent_session_id`
- `execution_id`, `trace_id`
- `node_kind`
- nullable `is_fork`, `is_compaction`

The collector normalizes these fields and writes them through the same durable PostgreSQL insert path used by RESP subscription and pull ingestion. Existing sanitized `raw_payload` is used as a read fallback for older rows where dedicated columns are null; no full-table rewrite is required.

## Data safety

- API keys remain masked; raw credentials are never stored.
- Raw event payloads, failure bodies and response headers are displayed/exported only after collector-side sanitization.
- The summary endpoint does not return raw payloads or large diagnostic JSON; these are loaded by the detail endpoint.
- CSV export quotes cells and prefixes formula-leading text to reduce spreadsheet formula injection risk.

## Verification

- Collector unit tests and normalization assertions.
- PostgreSQL 17 migration/collector integration test, including all new request-context fields and target-schema migration preflight isolation.
- TypeScript check, ESLint and Next.js production build.
- Playwright coverage for column preference persistence, request-context column visibility, request-context sorting/search, detail drawer fields and CSV download.
