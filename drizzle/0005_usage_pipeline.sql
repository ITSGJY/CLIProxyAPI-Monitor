-- Phase 1: durable CPA usage ingestion, canonical event identity, pricing history and rebuildable rollups.
-- The existing usage_records table remains a legacy UI/history source until the UI read path is switched in a later phase.

CREATE TABLE "model_price_versions" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "model" text NOT NULL,
  "provider" text,
  "service_tier" text,
  "input_price_per_1m" numeric(20, 10) NOT NULL,
  "cached_input_price_per_1m" numeric(20, 10) NOT NULL DEFAULT 0,
  "output_price_per_1m" numeric(20, 10) NOT NULL,
  "currency" text NOT NULL DEFAULT 'USD',
  "source" text NOT NULL DEFAULT 'manual',
  "source_version" text,
  "valid_from" timestamptz NOT NULL,
  "valid_to" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "created_by" text,
  CONSTRAINT "model_price_versions_valid_range_check" CHECK ("valid_to" IS NULL OR "valid_to" > "valid_from")
);

CREATE UNIQUE INDEX "model_price_versions_model_provider_tier_from_idx"
  ON "model_price_versions" ("model", COALESCE("provider", ''), COALESCE("service_tier", ''), "valid_from");
CREATE INDEX "model_price_versions_model_valid_from_idx"
  ON "model_price_versions" ("model", "valid_from" DESC);

ALTER TABLE "model_prices" ADD COLUMN "price_version_id" bigint;

INSERT INTO "model_price_versions" (
  "model", "input_price_per_1m", "cached_input_price_per_1m", "output_price_per_1m",
  "source", "valid_from", "created_at"
)
SELECT
  "model", "input_price_per_1m", "cached_input_price_per_1m", "output_price_per_1m",
  'legacy_model_prices', "created_at", "created_at"
FROM "model_prices";

UPDATE "model_prices" AS current_price
SET "price_version_id" = (
  SELECT version."id"
  FROM "model_price_versions" AS version
  WHERE version."model" = current_price."model"
  ORDER BY version."valid_from" DESC, version."id" DESC
  LIMIT 1
);

ALTER TABLE "model_prices"
  ADD CONSTRAINT "model_prices_price_version_id_fk"
  FOREIGN KEY ("price_version_id") REFERENCES "model_price_versions" ("id") ON DELETE SET NULL;
CREATE OR REPLACE FUNCTION track_model_price_versions() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  should_version boolean := false;
  new_version_id bigint;
  existing_version_id bigint;
  new_valid_from timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- For INSERT ... ON CONFLICT DO UPDATE, defer version creation to the
    -- BEFORE UPDATE trigger. This avoids creating a version twice because
    -- PostgreSQL invokes BEFORE INSERT before resolving the conflict.
    SELECT price_version_id
    INTO existing_version_id
    FROM model_prices
    WHERE model = NEW.model;

    IF FOUND THEN
      NEW.price_version_id := existing_version_id;
      should_version := false;
    ELSE
      should_version := true;
    END IF;
  ELSE
    should_version :=
      OLD.model IS DISTINCT FROM NEW.model
      OR OLD.input_price_per_1m IS DISTINCT FROM NEW.input_price_per_1m
      OR OLD.cached_input_price_per_1m IS DISTINCT FROM NEW.cached_input_price_per_1m
      OR OLD.output_price_per_1m IS DISTINCT FROM NEW.output_price_per_1m;
  END IF;

  IF should_version THEN
    IF TG_OP = 'UPDATE' AND OLD.model IS DISTINCT FROM NEW.model THEN
      UPDATE model_price_versions
      SET valid_to = GREATEST(clock_timestamp(), valid_from + interval '1 microsecond')
      WHERE model = OLD.model AND provider IS NULL AND service_tier IS NULL AND valid_to IS NULL;
    END IF;

    UPDATE model_price_versions
    SET valid_to = GREATEST(clock_timestamp(), valid_from + interval '1 microsecond')
    WHERE model = NEW.model AND provider IS NULL AND service_tier IS NULL AND valid_to IS NULL;

    SELECT MAX(valid_to) INTO new_valid_from
    FROM model_price_versions
    WHERE model = NEW.model AND provider IS NULL AND service_tier IS NULL;
    new_valid_from := GREATEST(COALESCE(new_valid_from, '-infinity'::timestamptz), clock_timestamp());

    INSERT INTO model_price_versions (
      model, input_price_per_1m, cached_input_price_per_1m, output_price_per_1m,
      source, source_version, valid_from, created_at
    ) VALUES (
      NEW.model, NEW.input_price_per_1m, NEW.cached_input_price_per_1m, NEW.output_price_per_1m,
      'model_prices_write', NULLIF(current_setting('app.model_price_source', true), ''), new_valid_from, clock_timestamp()
    )
    RETURNING id INTO new_version_id;

    NEW.price_version_id := new_version_id;
  END IF;

  RETURN NEW;
END;
$$;
CREATE TRIGGER model_prices_version_history
BEFORE INSERT OR UPDATE ON model_prices
FOR EACH ROW EXECUTE FUNCTION track_model_price_versions();

CREATE OR REPLACE FUNCTION close_model_price_version_on_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE model_price_versions
  SET valid_to = GREATEST(clock_timestamp(), valid_from + interval '1 microsecond')
  WHERE model = OLD.model AND provider IS NULL AND service_tier IS NULL AND valid_to IS NULL;
  RETURN OLD;
END;
$$;

CREATE TRIGGER model_prices_version_close_on_delete
BEFORE DELETE ON model_prices
FOR EACH ROW EXECUTE FUNCTION close_model_price_version_on_delete();


CREATE TABLE "usage_collector_instances" (
  "instance_id" text PRIMARY KEY,
  "display_name" text NOT NULL,
  "management_base_url" text NOT NULL,
  "queue_name" text NOT NULL DEFAULT 'usage',
  "collector_mode" text NOT NULL DEFAULT 'pull_first',
  "enabled" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "usage_collector_instances_queue_check" CHECK ("queue_name" = 'usage'),
  CONSTRAINT "usage_collector_instances_mode_check" CHECK ("collector_mode" IN ('pull_first', 'subscribe_experimental'))
);

CREATE TABLE "usage_pull_attempts" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "instance_id" text NOT NULL REFERENCES "usage_collector_instances" ("instance_id") ON DELETE RESTRICT,
  "transport" text NOT NULL,
  "queue_name" text NOT NULL DEFAULT 'usage',
  "requested_count" integer NOT NULL,
  "received_count" integer NOT NULL DEFAULT 0,
  "persisted_count" integer NOT NULL DEFAULT 0,
  "status" text NOT NULL DEFAULT 'started',
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  "error_code" text,
  "error_message" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT "usage_pull_attempts_transport_check" CHECK ("transport" IN ('resp', 'http')),
  CONSTRAINT "usage_pull_attempts_status_check" CHECK ("status" IN ('started', 'completed', 'empty', 'failed', 'interrupted')),
  CONSTRAINT "usage_pull_attempts_count_check" CHECK ("requested_count" > 0 AND "received_count" >= 0 AND "persisted_count" >= 0)
);

CREATE INDEX "usage_pull_attempts_instance_started_idx"
  ON "usage_pull_attempts" ("instance_id", "started_at" DESC);
CREATE INDEX "usage_pull_attempts_empty_cleanup_idx"
  ON "usage_pull_attempts" ("completed_at") WHERE "status" = 'empty';

CREATE TABLE "usage_collector_state" (
  "instance_id" text PRIMARY KEY REFERENCES "usage_collector_instances" ("instance_id") ON DELETE CASCADE,
  "state" text NOT NULL DEFAULT 'idle',
  "lease_owner" text,
  "lease_expires_at" timestamptz,
  "last_attempt_at" timestamptz,
  "last_success_at" timestamptz,
  "last_event_at" timestamptz,
  "last_transport" text,
  "last_error_code" text,
  "last_error_message" text,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "usage_collector_commands" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "instance_id" text NOT NULL REFERENCES "usage_collector_instances" ("instance_id") ON DELETE CASCADE,
  "command" text NOT NULL DEFAULT 'pull_now',
  "status" text NOT NULL DEFAULT 'pending',
  "requested_by" text,
  "requested_at" timestamptz NOT NULL DEFAULT now(),
  "claimed_at" timestamptz,
  "claimed_by" text,
  "lease_expires_at" timestamptz,
  "completed_at" timestamptz,
  "last_error" text,
  CONSTRAINT "usage_collector_commands_command_check" CHECK ("command" IN ('pull_now', 'pause', 'resume')),
  CONSTRAINT "usage_collector_commands_status_check" CHECK ("status" IN ('pending', 'claimed', 'completed', 'failed'))
);

CREATE INDEX "usage_collector_commands_pending_idx"
  ON "usage_collector_commands" ("instance_id", "status", "requested_at");

CREATE TABLE "usage_events" (
  "event_id" bigint GENERATED ALWAYS AS IDENTITY,
  "occurred_at" timestamptz NOT NULL,
  "ingested_at" timestamptz NOT NULL DEFAULT now(),
  "source_instance_id" text NOT NULL,
  "origin_system" text NOT NULL DEFAULT 'cpa_live',
  "source_transport" text NOT NULL,
  "source_native_id" text,
  "identity_key" text NOT NULL,
  "provider" text,
  "endpoint" text,
  "auth_type" text,
  "request_id" text,
  "client_ip" text,
  "x_forwarded_for" text,
  "user_agent" text,
  "api_group_key" text,
  "api_group_label" text,
  "api_key_mask" text,
  "model" text NOT NULL,
  "model_alias" text,
  "response_model" text,
  "model_substituted" boolean,
  "reasoning_effort" text,
  "service_tier" text,
  "response_service_tier" text,
  "effective_service_tier" text,
  "billed_service_tier" text,
  "billed_service_tier_source" text,
  "executor_type" text,
  "source" text,
  "auth_index" text,
  "access_provider" text,
  "is_native_key" boolean,
  "stream" boolean,
  "generate" boolean,
  "latency_ms" bigint,
  "ttft_ms" bigint,
  "input_tokens" bigint NOT NULL DEFAULT 0,
  "output_tokens" bigint NOT NULL DEFAULT 0,
  "reasoning_tokens" bigint NOT NULL DEFAULT 0,
  "cached_tokens" bigint NOT NULL DEFAULT 0,
  "cache_read_tokens" bigint NOT NULL DEFAULT 0,
  "cache_creation_tokens" bigint NOT NULL DEFAULT 0,
  "total_tokens" bigint NOT NULL DEFAULT 0,
  "is_error" boolean NOT NULL DEFAULT false,
  "status_code" integer,
  "fail_code" text,
  "fail_body" text,
  "response_headers" jsonb,
  "token_accounting" jsonb,
  "structured_usage" jsonb,
  "raw_payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "price_version_id" bigint REFERENCES "model_price_versions" ("id") ON DELETE SET NULL,
  "cost_nanos" bigint,
  "cost_currency" text NOT NULL DEFAULT 'USD',
  "pricing_status" text NOT NULL DEFAULT 'unpriced',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "usage_events_pkey" PRIMARY KEY ("occurred_at", "event_id"),
  CONSTRAINT "usage_events_transport_check" CHECK ("source_transport" IN ('resp', 'http', 'subscribe_experimental', 'legacy_import')),
  CONSTRAINT "usage_events_token_counts_check" CHECK (
    "input_tokens" >= 0 AND "output_tokens" >= 0 AND "reasoning_tokens" >= 0
    AND "cached_tokens" >= 0 AND "cache_read_tokens" >= 0
    AND "cache_creation_tokens" >= 0 AND "total_tokens" >= 0
  )
) PARTITION BY RANGE ("occurred_at");

DO $$
DECLARE
  month_offset integer;
  month_start date;
  month_end date;
  partition_name text;
BEGIN
  FOR month_offset IN -1..2 LOOP
    month_start := (date_trunc('month', CURRENT_DATE) + make_interval(months => month_offset))::date;
    month_end := (month_start + interval '1 month')::date;
    partition_name := 'usage_events_' || to_char(month_start, 'YYYYMM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF usage_events FOR VALUES FROM (%L) TO (%L)',
      partition_name, month_start, month_end
    );
  END LOOP;
END $$;

CREATE INDEX "usage_events_occurred_at_idx" ON "usage_events" ("occurred_at" DESC);
CREATE INDEX "usage_events_model_occurred_at_idx" ON "usage_events" ("model", "occurred_at" DESC);
CREATE INDEX "usage_events_provider_occurred_at_idx" ON "usage_events" ("provider", "occurred_at" DESC);
CREATE INDEX "usage_events_identity_key_idx" ON "usage_events" ("identity_key", "occurred_at");

CREATE TABLE "usage_event_identity" (
  "identity_key" text PRIMARY KEY,
  "identity_version" integer NOT NULL DEFAULT 1,
  "identity_kind" text NOT NULL,
  "source_instance_id" text NOT NULL,
  "request_id" text,
  "occurred_at" timestamptz NOT NULL,
  "event_id" bigint NOT NULL,
  "first_seen_at" timestamptz NOT NULL DEFAULT now(),
  "last_seen_at" timestamptz NOT NULL DEFAULT now(),
  "duplicate_count" bigint NOT NULL DEFAULT 0,
  CONSTRAINT "usage_event_identity_event_fk"
    FOREIGN KEY ("occurred_at", "event_id")
    REFERENCES "usage_events" ("occurred_at", "event_id") ON DELETE RESTRICT,
  CONSTRAINT "usage_event_identity_event_unique" UNIQUE ("occurred_at", "event_id")
);

CREATE INDEX "usage_event_identity_request_id_idx"
  ON "usage_event_identity" ("source_instance_id", "request_id");

CREATE TABLE "usage_inbox" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "instance_id" text NOT NULL REFERENCES "usage_collector_instances" ("instance_id") ON DELETE RESTRICT,
  "pull_attempt_id" bigint REFERENCES "usage_pull_attempts" ("id") ON DELETE SET NULL,
  "transport" text NOT NULL,
  "queue_name" text NOT NULL DEFAULT 'usage',
  "payload_sha256" text NOT NULL,
  "payload" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "available_at" timestamptz NOT NULL DEFAULT now(),
  "lease_owner" text,
  "lease_expires_at" timestamptz,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "processed_at" timestamptz,
  "usage_event_id" bigint,
  "usage_event_occurred_at" timestamptz,
  "duplicate_of_identity_key" text,
  "last_error_code" text,
  "last_error_message" text,
  CONSTRAINT "usage_inbox_transport_check" CHECK ("transport" IN ('resp', 'http')),
  CONSTRAINT "usage_inbox_status_check" CHECK ("status" IN ('pending', 'processing', 'processed', 'dead_letter')),
  CONSTRAINT "usage_inbox_attempt_count_check" CHECK ("attempt_count" >= 0),
  CONSTRAINT "usage_inbox_event_fk"
    FOREIGN KEY ("usage_event_occurred_at", "usage_event_id")
    REFERENCES "usage_events" ("occurred_at", "event_id") ON DELETE SET NULL
);

CREATE INDEX "usage_inbox_pending_idx"
  ON "usage_inbox" ("instance_id", "status", "available_at", "id");
CREATE INDEX "usage_inbox_pull_attempt_idx"
  ON "usage_inbox" ("pull_attempt_id");

CREATE TABLE "usage_ingest_gaps" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "instance_id" text NOT NULL REFERENCES "usage_collector_instances" ("instance_id") ON DELETE RESTRICT,
  "pull_attempt_id" bigint REFERENCES "usage_pull_attempts" ("id") ON DELETE SET NULL,
  "started_at" timestamptz,
  "detected_at" timestamptz NOT NULL DEFAULT now(),
  "reason" text NOT NULL,
  "estimated_missing_count" integer,
  "details" jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX "usage_ingest_gaps_instance_detected_idx"
  ON "usage_ingest_gaps" ("instance_id", "detected_at" DESC);

CREATE TABLE "usage_import_batches" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "source_system" text NOT NULL,
  "source_version" text,
  "source_fingerprint" text,
  "status" text NOT NULL DEFAULT 'pending',
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  "rows_scanned" bigint NOT NULL DEFAULT 0,
  "events_inserted" bigint NOT NULL DEFAULT 0,
  "duplicates_skipped" bigint NOT NULL DEFAULT 0,
  "rows_rejected" bigint NOT NULL DEFAULT 0,
  "details" jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE "usage_rollup_checkpoints" (
  "rollup_name" text NOT NULL,
  "timezone" text NOT NULL DEFAULT 'UTC',
  "watermark_occurred_at" timestamptz,
  "watermark_event_id" bigint,
  "completed_at" timestamptz,
  "state" text NOT NULL DEFAULT 'pending',
  "last_error" text,
  CONSTRAINT "usage_rollup_checkpoints_pkey" PRIMARY KEY ("rollup_name", "timezone")
);

CREATE TABLE "usage_rollups_hourly" (
  "bucket_start" timestamptz NOT NULL,
  "timezone" text NOT NULL DEFAULT 'UTC',
  "provider" text NOT NULL DEFAULT '',
  "model" text NOT NULL,
  "source" text NOT NULL DEFAULT '',
  "api_group_key" text NOT NULL DEFAULT '',
  "request_count" bigint NOT NULL DEFAULT 0,
  "error_count" bigint NOT NULL DEFAULT 0,
  "input_tokens" bigint NOT NULL DEFAULT 0,
  "output_tokens" bigint NOT NULL DEFAULT 0,
  "reasoning_tokens" bigint NOT NULL DEFAULT 0,
  "cached_tokens" bigint NOT NULL DEFAULT 0,
  "total_tokens" bigint NOT NULL DEFAULT 0,
  "cost_nanos" bigint NOT NULL DEFAULT 0,
  "cost_currency" text NOT NULL DEFAULT 'USD',
  "pricing_status" text NOT NULL DEFAULT 'unpriced',
  "refreshed_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "usage_rollups_hourly_pkey" PRIMARY KEY ("bucket_start", "timezone", "provider", "model", "source", "api_group_key", "cost_currency")
);

CREATE TABLE "usage_rollups_daily" (
  "bucket_start" timestamptz NOT NULL,
  "timezone" text NOT NULL DEFAULT 'UTC',
  "provider" text NOT NULL DEFAULT '',
  "model" text NOT NULL,
  "source" text NOT NULL DEFAULT '',
  "api_group_key" text NOT NULL DEFAULT '',
  "request_count" bigint NOT NULL DEFAULT 0,
  "error_count" bigint NOT NULL DEFAULT 0,
  "input_tokens" bigint NOT NULL DEFAULT 0,
  "output_tokens" bigint NOT NULL DEFAULT 0,
  "reasoning_tokens" bigint NOT NULL DEFAULT 0,
  "cached_tokens" bigint NOT NULL DEFAULT 0,
  "total_tokens" bigint NOT NULL DEFAULT 0,
  "cost_nanos" bigint NOT NULL DEFAULT 0,
  "cost_currency" text NOT NULL DEFAULT 'USD',
  "pricing_status" text NOT NULL DEFAULT 'unpriced',
  "refreshed_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "usage_rollups_daily_pkey" PRIMARY KEY ("bucket_start", "timezone", "provider", "model", "source", "api_group_key", "cost_currency")
);

COMMENT ON TABLE "usage_inbox" IS 'Durable, sanitized queue payloads awaiting idempotent processing. No raw API keys or credentials are stored.';
COMMENT ON TABLE "usage_event_identity" IS 'Global idempotency ledger; unique identity keys are independent of event time partitions.';
COMMENT ON TABLE "usage_events" IS 'Canonical request-level CPA usage events, partitioned by occurred_at month.';
COMMENT ON TABLE "usage_pull_attempts" IS 'Audit trail for destructive CPA queue pulls and their persistence outcomes.';
COMMENT ON TABLE "usage_import_batches" IS 'Auditable import runs from OMC, CPA Usage Keeper, CPAMP and legacy Monitor sources.';