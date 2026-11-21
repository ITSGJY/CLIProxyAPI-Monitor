-- Phase 0-4: versioned Pricing Center, source catalogs, channel multipliers and immutable request snapshots.
-- Existing usage rows and OMC source-price evidence are deliberately preserved.
ALTER TABLE model_price_versions
  ADD COLUMN IF NOT EXISTS cache_write_price_per_1m numeric(30,12) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS price_multiplier numeric(30,12) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS tiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS upstream_provider_id text,
  ADD COLUMN IF NOT EXISTS upstream_model_id text,
  ADD COLUMN IF NOT EXISTS match_kind text,
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'custom',
  ADD COLUMN IF NOT EXISTS available boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS source_snapshot_sha text;
--> statement-breakpoint

ALTER TABLE model_price_versions
  ALTER COLUMN input_price_per_1m TYPE numeric(30,12) USING input_price_per_1m::numeric(30,12),
  ALTER COLUMN cached_input_price_per_1m TYPE numeric(30,12) USING cached_input_price_per_1m::numeric(30,12),
  ALTER COLUMN output_price_per_1m TYPE numeric(30,12) USING output_price_per_1m::numeric(30,12);
--> statement-breakpoint

ALTER TABLE model_prices DROP CONSTRAINT IF EXISTS model_prices_model_unique;
--> statement-breakpoint
ALTER TABLE model_prices
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS service_tier text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS cache_write_price_per_1m numeric(30,12) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS price_multiplier numeric(30,12) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS tiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS source_version text,
  ADD COLUMN IF NOT EXISTS upstream_provider_id text,
  ADD COLUMN IF NOT EXISTS upstream_model_id text,
  ADD COLUMN IF NOT EXISTS match_kind text,
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'custom',
  ADD COLUMN IF NOT EXISTS synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS available boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS created_by text;
--> statement-breakpoint

ALTER TABLE model_prices
  ALTER COLUMN input_price_per_1m TYPE numeric(30,12) USING input_price_per_1m::numeric(30,12),
  ALTER COLUMN cached_input_price_per_1m TYPE numeric(30,12) USING cached_input_price_per_1m::numeric(30,12),
  ALTER COLUMN output_price_per_1m TYPE numeric(30,12) USING output_price_per_1m::numeric(30,12);
--> statement-breakpoint
DROP TRIGGER IF EXISTS model_prices_version_history ON model_prices;
--> statement-breakpoint
UPDATE model_prices SET cache_write_price_per_1m = input_price_per_1m WHERE cache_write_price_per_1m = 0;
--> statement-breakpoint
UPDATE model_price_versions SET cache_write_price_per_1m = input_price_per_1m WHERE cache_write_price_per_1m = 0;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS model_prices_model_provider_tier_unique_idx
  ON model_prices (model, provider, service_tier);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS model_prices_mode_source_idx
  ON model_prices (mode, source, available);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS model_price_versions_scope_time_idx
  ON model_price_versions (model, provider, service_tier, valid_from DESC, id DESC);
--> statement-breakpoint

ALTER TABLE model_prices
  ADD CONSTRAINT model_prices_mode_check CHECK (mode IN ('auto', 'linked', 'custom')),
  ADD CONSTRAINT model_prices_tiers_check CHECK (jsonb_typeof(tiers) = 'array'),
  ADD CONSTRAINT model_prices_multiplier_check CHECK (price_multiplier > 0);
--> statement-breakpoint
ALTER TABLE model_price_versions
  ADD CONSTRAINT model_price_versions_mode_check CHECK (mode IN ('auto', 'linked', 'custom')),
  ADD CONSTRAINT model_price_versions_tiers_check CHECK (jsonb_typeof(tiers) = 'array'),
  ADD CONSTRAINT model_price_versions_multiplier_check CHECK (price_multiplier > 0);
--> statement-breakpoint

CREATE TABLE pricing_upstream_catalog (
  source text NOT NULL CHECK (source IN ('models.dev', 'openrouter')),
  provider_id text NOT NULL,
  model_id text NOT NULL,
  name text NOT NULL DEFAULT '',
  canonical_id text,
  context_length bigint,
  input_price_per_1m numeric(30,12),
  output_price_per_1m numeric(30,12),
  cache_read_price_per_1m numeric(30,12),
  cache_write_price_per_1m numeric(30,12),
  tiers jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tiers) = 'array'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_version text,
  snapshot_sha text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, provider_id, model_id)
);
--> statement-breakpoint
CREATE INDEX pricing_upstream_catalog_model_idx
  ON pricing_upstream_catalog (source, model_id) WHERE is_active;
--> statement-breakpoint
CREATE INDEX pricing_upstream_catalog_provider_idx
  ON pricing_upstream_catalog (source, provider_id) WHERE is_active;
--> statement-breakpoint

CREATE TABLE pricing_catalog_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('models.dev', 'openrouter')),
  snapshot_sha text NOT NULL CHECK (snapshot_sha ~ '^[0-9a-f]{64}$'),
  source_version text,
  etag text,
  last_modified text,
  status text NOT NULL CHECK (status IN ('success', 'not_modified', 'failed')),
  provider_count integer NOT NULL DEFAULT 0,
  model_count integer NOT NULL DEFAULT 0,
  matched_count integer NOT NULL DEFAULT 0,
  ambiguous_count integer NOT NULL DEFAULT 0,
  updated_price_count integer NOT NULL DEFAULT 0,
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, snapshot_sha, fetched_at)
);
--> statement-breakpoint
CREATE INDEX pricing_catalog_snapshots_source_time_idx
  ON pricing_catalog_snapshots (source, fetched_at DESC);
--> statement-breakpoint

CREATE TABLE pricing_sync_state (
  source text PRIMARY KEY CHECK (source IN ('models.dev', 'openrouter')),
  etag text,
  last_modified text,
  last_hash text,
  last_success_at timestamptz,
  last_error text,
  auto_sync_interval_hours integer NOT NULL DEFAULT 24 CHECK (auto_sync_interval_hours BETWEEN 0 AND 168),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
INSERT INTO pricing_sync_state (source) VALUES ('models.dev'), ('openrouter')
ON CONFLICT (source) DO NOTHING;
--> statement-breakpoint

CREATE TABLE pricing_model_links (
  model text NOT NULL,
  provider text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'models.dev' CHECK (source = 'models.dev'),
  upstream_provider_id text NOT NULL,
  upstream_model_id text NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model, provider)
);
--> statement-breakpoint
CREATE INDEX pricing_model_links_upstream_idx
  ON pricing_model_links (source, upstream_provider_id, upstream_model_id);
--> statement-breakpoint

CREATE TABLE pricing_channels (
  channel text PRIMARY KEY,
  multiplier numeric(30,12) NOT NULL CHECK (multiplier > 0 AND multiplier <= 100),
  note text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);
--> statement-breakpoint

CREATE TABLE pricing_channel_versions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel text NOT NULL,
  effective_from timestamptz NOT NULL,
  available boolean NOT NULL DEFAULT true,
  multiplier numeric(30,12) NOT NULL CHECK (multiplier > 0 AND multiplier <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, effective_from)
);
--> statement-breakpoint
CREATE INDEX pricing_channel_versions_lookup_idx
  ON pricing_channel_versions (channel, effective_from DESC, id DESC);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION track_model_price_versions() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  should_version boolean := false;
  existing_version_id bigint;
  new_version_id bigint;
  next_valid_from timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pricing:model:' || NEW.model || chr(31) || COALESCE(NEW.provider, '') || chr(31) || COALESCE(NEW.service_tier, ''), 0));

  IF TG_OP = 'INSERT' THEN
    SELECT price_version_id INTO existing_version_id
    FROM model_prices
    WHERE model = NEW.model AND provider = NEW.provider AND service_tier = NEW.service_tier;
    IF FOUND THEN
      NEW.price_version_id := existing_version_id;
      RETURN NEW;
    END IF;
    should_version := true;
  ELSE
    should_version :=
      ROW(OLD.model, OLD.provider, OLD.service_tier, OLD.input_price_per_1m, OLD.cached_input_price_per_1m,
          OLD.output_price_per_1m, OLD.cache_write_price_per_1m, OLD.price_multiplier, OLD.tiers, OLD.source,
          OLD.upstream_provider_id, OLD.upstream_model_id, OLD.match_kind, OLD.mode, OLD.available)
      IS DISTINCT FROM
      ROW(NEW.model, NEW.provider, NEW.service_tier, NEW.input_price_per_1m, NEW.cached_input_price_per_1m,
          NEW.output_price_per_1m, NEW.cache_write_price_per_1m, NEW.price_multiplier, NEW.tiers, NEW.source,
          NEW.upstream_provider_id, NEW.upstream_model_id, NEW.match_kind, NEW.mode, NEW.available);
  END IF;

  IF should_version THEN
    SELECT GREATEST(clock_timestamp(), COALESCE(MAX(valid_from) + interval '1 microsecond', '-infinity'::timestamptz))
      INTO next_valid_from
    FROM model_price_versions
    WHERE model = NEW.model
      AND provider IS NOT DISTINCT FROM NULLIF(NEW.provider, '')
      AND service_tier IS NOT DISTINCT FROM NULLIF(NEW.service_tier, '');

    INSERT INTO model_price_versions (
      model, provider, service_tier, input_price_per_1m, cached_input_price_per_1m,
      output_price_per_1m, cache_write_price_per_1m, price_multiplier, tiers, currency,
      source, source_version, upstream_provider_id, upstream_model_id, match_kind, mode,
      available, source_snapshot_sha, valid_from, valid_to, created_at, created_by
    ) VALUES (
      NEW.model, NULLIF(NEW.provider, ''), NULLIF(NEW.service_tier, ''),
      NEW.input_price_per_1m, NEW.cached_input_price_per_1m, NEW.output_price_per_1m,
      NEW.cache_write_price_per_1m, NEW.price_multiplier, NEW.tiers, 'USD',
      NEW.source, NEW.source_version, NEW.upstream_provider_id, NEW.upstream_model_id,
      NEW.match_kind, NEW.mode, NEW.available, CASE WHEN NEW.source = 'models.dev' THEN NEW.source_version ELSE NULL END, next_valid_from, NULL, now(), NEW.created_by
    ) RETURNING id INTO new_version_id;

    NEW.price_version_id := new_version_id;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS model_prices_version_history ON model_prices;
--> statement-breakpoint
CREATE TRIGGER model_prices_version_history
BEFORE INSERT OR UPDATE ON model_prices
FOR EACH ROW EXECUTE FUNCTION track_model_price_versions();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION close_model_price_version_on_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  next_valid_from timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pricing:model:' || OLD.model || chr(31) || COALESCE(OLD.provider, '') || chr(31) || COALESCE(OLD.service_tier, ''), 0));

  SELECT GREATEST(clock_timestamp(), COALESCE(MAX(valid_from) + interval '1 microsecond', '-infinity'::timestamptz))
    INTO next_valid_from
  FROM model_price_versions
  WHERE model = OLD.model
    AND provider IS NOT DISTINCT FROM NULLIF(OLD.provider, '')
    AND service_tier IS NOT DISTINCT FROM NULLIF(OLD.service_tier, '');

  INSERT INTO model_price_versions (
    model, provider, service_tier, input_price_per_1m, cached_input_price_per_1m,
    output_price_per_1m, cache_write_price_per_1m, price_multiplier, tiers, currency,
    source, source_version, upstream_provider_id, upstream_model_id, match_kind, mode,
    available, valid_from, valid_to, created_at, created_by
  ) VALUES (
    OLD.model, NULLIF(OLD.provider, ''), NULLIF(OLD.service_tier, ''),
    OLD.input_price_per_1m, OLD.cached_input_price_per_1m, OLD.output_price_per_1m,
    OLD.cache_write_price_per_1m, OLD.price_multiplier, OLD.tiers, 'USD',
    OLD.source, OLD.source_version, OLD.upstream_provider_id, OLD.upstream_model_id,
    OLD.match_kind, OLD.mode, false, next_valid_from, NULL, now(), OLD.created_by
  );
  RETURN OLD;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS model_prices_version_close_on_delete ON model_prices;
--> statement-breakpoint
CREATE TRIGGER model_prices_version_close_on_delete
BEFORE DELETE ON model_prices
FOR EACH ROW EXECUTE FUNCTION close_model_price_version_on_delete();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_price_version_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'model price versions are immutable';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS model_price_versions_immutable ON model_price_versions;
--> statement-breakpoint
CREATE TRIGGER model_price_versions_immutable
BEFORE UPDATE OR DELETE ON model_price_versions
FOR EACH ROW EXECUTE FUNCTION reject_price_version_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION append_pricing_channel_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  channel_name text;
  next_effective_from timestamptz;
  channel_multiplier numeric(30,12);
  channel_available boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    channel_name := OLD.channel;
    channel_multiplier := OLD.multiplier;
    channel_available := false;
  ELSE
    channel_name := NEW.channel;
    channel_multiplier := NEW.multiplier;
    channel_available := true;
    IF TG_OP = 'UPDATE' AND OLD.multiplier IS NOT DISTINCT FROM NEW.multiplier THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT GREATEST(clock_timestamp(), COALESCE(MAX(effective_from) + interval '1 microsecond', '-infinity'::timestamptz))
    INTO next_effective_from
  FROM pricing_channel_versions WHERE channel = channel_name;

  INSERT INTO pricing_channel_versions (channel, effective_from, available, multiplier)
  VALUES (channel_name, next_effective_from, channel_available, channel_multiplier);

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS pricing_channels_version_history ON pricing_channels;
--> statement-breakpoint
CREATE TRIGGER pricing_channels_version_history
AFTER INSERT OR UPDATE OR DELETE ON pricing_channels
FOR EACH ROW EXECUTE FUNCTION append_pricing_channel_version();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_pricing_channel_version_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pricing channel versions are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER pricing_channel_versions_immutable
BEFORE UPDATE OR DELETE ON pricing_channel_versions
FOR EACH ROW EXECUTE FUNCTION reject_pricing_channel_version_mutation();
--> statement-breakpoint

ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS channel_version_id bigint REFERENCES pricing_channel_versions(id),
  ADD COLUMN IF NOT EXISTS price_tier_index integer,
  ADD COLUMN IF NOT EXISTS resolved_service_tier text,
  ADD COLUMN IF NOT EXISTS pricing_policy_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS cost_breakdown jsonb;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION prevent_priced_usage_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.pricing_status = 'priced' AND
     ROW(OLD.pricing_status, OLD.cost_nanos, OLD.cost_currency, OLD.price_version_id, OLD.channel_version_id,
         OLD.price_tier_index, OLD.resolved_service_tier, OLD.pricing_policy_version, OLD.cost_breakdown)
     IS DISTINCT FROM
     ROW(NEW.pricing_status, NEW.cost_nanos, NEW.cost_currency, NEW.price_version_id, NEW.channel_version_id,
         NEW.price_tier_index, NEW.resolved_service_tier, NEW.pricing_policy_version, NEW.cost_breakdown)
  THEN
    RAISE EXCEPTION 'priced usage evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS usage_events_pricing_immutable ON usage_events;
--> statement-breakpoint
CREATE TRIGGER usage_events_pricing_immutable
BEFORE UPDATE ON usage_events
FOR EACH ROW EXECUTE FUNCTION prevent_priced_usage_rewrite();
--> statement-breakpoint
