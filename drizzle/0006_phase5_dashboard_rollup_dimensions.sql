-- Phase 5: retain every dimension required by the Dashboard's global filters.
ALTER TABLE usage_rollups_hourly
  ADD COLUMN api_key_mask text NOT NULL DEFAULT '',
  ADD COLUMN service_tier text NOT NULL DEFAULT '',
  ADD COLUMN cache_creation_tokens bigint NOT NULL DEFAULT 0,
  ADD COLUMN priced_request_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN unpriced_request_count bigint NOT NULL DEFAULT 0;

ALTER TABLE usage_rollups_daily
  ADD COLUMN api_key_mask text NOT NULL DEFAULT '',
  ADD COLUMN service_tier text NOT NULL DEFAULT '',
  ADD COLUMN cache_creation_tokens bigint NOT NULL DEFAULT 0,
  ADD COLUMN priced_request_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN unpriced_request_count bigint NOT NULL DEFAULT 0;

ALTER TABLE usage_rollups_hourly DROP CONSTRAINT usage_rollups_hourly_pkey;
ALTER TABLE usage_rollups_hourly ADD CONSTRAINT usage_rollups_hourly_pkey
  PRIMARY KEY (bucket_start, timezone, provider, model, source, api_group_key, api_key_mask, service_tier, cost_currency);

ALTER TABLE usage_rollups_daily DROP CONSTRAINT usage_rollups_daily_pkey;
ALTER TABLE usage_rollups_daily ADD CONSTRAINT usage_rollups_daily_pkey
  PRIMARY KEY (bucket_start, timezone, provider, model, source, api_group_key, api_key_mask, service_tier, cost_currency);

CREATE INDEX "usage_events_api_key_mask_occurred_at_idx"
  ON "usage_events" ("api_key_mask", "occurred_at" DESC);
CREATE INDEX "usage_events_service_tier_occurred_at_idx"
  ON "usage_events" ("effective_service_tier", "occurred_at" DESC);
CREATE INDEX "usage_events_ingested_at_idx"
  ON "usage_events" ("ingested_at" DESC);
