-- Phase 6: auditable, resumable imports from immutable legacy snapshots.
ALTER TABLE usage_events
  ADD COLUMN source_price_version_id bigint,
  ADD COLUMN source_event_key text;

CREATE TABLE usage_import_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_key text NOT NULL,
  source_sha256 text NOT NULL,
  source_name text NOT NULL,
  source_schema_version integer,
  status text NOT NULL DEFAULT 'planned',
  total_rows bigint NOT NULL DEFAULT 0,
  processed_rows bigint NOT NULL DEFAULT 0,
  inserted_rows bigint NOT NULL DEFAULT 0,
  skipped_rows bigint NOT NULL DEFAULT 0,
  last_source_id bigint NOT NULL DEFAULT 0,
  min_occurred_at timestamptz,
  max_occurred_at timestamptz,
  source_duplicate_key_groups bigint NOT NULL DEFAULT 0,
  source_duplicate_key_rows bigint NOT NULL DEFAULT 0,
  priced_rows bigint NOT NULL DEFAULT 0,
  unpriced_rows bigint NOT NULL DEFAULT 0,
  source_price_version_rows bigint NOT NULL DEFAULT 0,
  imported_price_version_rows bigint NOT NULL DEFAULT 0,
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  last_error text,
  CONSTRAINT usage_import_runs_status_check
    CHECK (status IN ('planned', 'running', 'completed', 'failed')),
  CONSTRAINT usage_import_runs_source_sha_check
    CHECK (source_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX usage_import_runs_source_hash_idx
  ON usage_import_runs (source_key, source_sha256);
CREATE INDEX usage_import_runs_status_updated_idx
  ON usage_import_runs (status, updated_at DESC);


-- Preserve OMC's richer historical pricing snapshots without lossy coercion
-- into the live price catalog (which has a narrower schema).
CREATE TABLE usage_import_source_price_versions (
  source_key text NOT NULL,
  source_price_version_id bigint NOT NULL,
  source_sha256 text NOT NULL,
  model text NOT NULL,
  effective_from timestamptz NOT NULL,
  available boolean NOT NULL,
  prompt_price_per_1m numeric(20, 10) NOT NULL,
  completion_price_per_1m numeric(20, 10) NOT NULL,
  cache_read_price_per_1m numeric(20, 10) NOT NULL,
  cache_write_price_per_1m numeric(20, 10) NOT NULL,
  price_multiplier numeric(20, 10) NOT NULL,
  source text NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  tiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  upstream_id text NOT NULL DEFAULT '',
  channel text NOT NULL DEFAULT '',
  PRIMARY KEY (source_key, source_price_version_id),
  CONSTRAINT usage_import_source_price_versions_sha_check
    CHECK (source_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE INDEX usage_import_source_price_versions_model_effective_idx
  ON usage_import_source_price_versions (source_key, model, effective_from DESC);
