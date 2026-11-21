-- Independent error pipeline. No foreign keys to usage state/inbox and no raw payload/auth_id.
CREATE TABLE cpa_error_collector_state (
 source_instance_id text PRIMARY KEY,
 enabled boolean NOT NULL DEFAULT true,
 state text NOT NULL DEFAULT 'connecting' CHECK (state IN ('connecting','collecting','disconnected','degraded','disabled')),
 lease_owner text,
 lease_epoch bigint NOT NULL DEFAULT 0,
 lease_expires_at timestamptz,
 heartbeat_at timestamptz,
 last_event_at timestamptz,
 last_error_code text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE cpa_error_subscription_sessions (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 source_instance_id text NOT NULL REFERENCES cpa_error_collector_state(source_instance_id),
 lease_epoch bigint NOT NULL,
 started_at timestamptz NOT NULL DEFAULT now(),
 subscribed_at timestamptz,
 coverage_through timestamptz,
 ended_at timestamptz,
 end_reason text,
 received_count bigint NOT NULL DEFAULT 0,
 inserted_count bigint NOT NULL DEFAULT 0,
 duplicate_count bigint NOT NULL DEFAULT 0,
 malformed_count bigint NOT NULL DEFAULT 0,
 CHECK (coverage_through IS NULL OR (subscribed_at IS NOT NULL AND coverage_through >= subscribed_at))
);
CREATE INDEX cpa_error_sessions_window_idx ON cpa_error_subscription_sessions(source_instance_id, subscribed_at, coverage_through);
CREATE UNIQUE INDEX cpa_error_sessions_open_idx ON cpa_error_subscription_sessions(source_instance_id) WHERE ended_at IS NULL;
--> statement-breakpoint
CREATE TABLE cpa_error_import_runs (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 source_instance_id text NOT NULL,
 source_sha256 text NOT NULL,
 source_schema_version text,
 status text NOT NULL CHECK (status IN ('running','completed','failed','unavailable')),
 expected_count bigint,
 processed_count bigint NOT NULL DEFAULT 0,
 inserted_count bigint NOT NULL DEFAULT 0,
 skipped_count bigint NOT NULL DEFAULT 0,
 failed_count bigint NOT NULL DEFAULT 0,
 reconciled_count bigint NOT NULL DEFAULT 0,
 min_occurred_at timestamptz,
 max_occurred_at timestamptz,
 last_error_code text,
 started_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 CHECK (expected_count IS NULL OR expected_count >= 0),
 CHECK (processed_count = inserted_count + skipped_count + failed_count),
 CHECK (status <> 'completed' OR (processed_count = expected_count AND reconciled_count = expected_count AND failed_count = 0))
);
CREATE INDEX cpa_error_import_runs_snapshot_idx ON cpa_error_import_runs(source_instance_id, source_sha256);
--> statement-breakpoint
CREATE TABLE cpa_error_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 source_instance_id text NOT NULL,
 event_key text NOT NULL,
 origin_system text NOT NULL CHECK (origin_system IN ('cpa','oh_my_cpa')),
 source_transport text NOT NULL CHECK (source_transport IN ('resp-subscribe','legacy_import')),
 source_native_id text,
 source_snapshot_sha256 text,
 import_run_id bigint REFERENCES cpa_error_import_runs(id),
 subscription_session_id bigint REFERENCES cpa_error_subscription_sessions(id),
 occurred_at timestamptz NOT NULL,
 received_at timestamptz NOT NULL,
 auth_index text,
 provider text,
 model text,
 status_code integer,
 code text,
 body text,
 retryable boolean,
 auth_status jsonb NOT NULL DEFAULT '{}'::jsonb,
 quota_exceeded boolean,
 quota_reason text,
 next_retry_after timestamptz,
 next_recover_at timestamptz,
 backoff_level integer,
 cooldown_model text,
 model_quota_exceeded boolean,
 model_quota_reason text,
 model_next_retry_after timestamptz,
 model_next_recover_at timestamptz,
 model_backoff_level integer,
 auth_quota_aggregate boolean,
 model_quota_inherited boolean,
 CONSTRAINT cpa_error_events_instance_key_unique UNIQUE (source_instance_id, event_key)
);
CREATE INDEX cpa_error_events_correlation_idx ON cpa_error_events(source_instance_id, auth_index, occurred_at, id) WHERE auth_index IS NOT NULL AND auth_index <> '';
--> statement-breakpoint
-- Membership makes final reconciliation independent of other overlapping snapshots.
CREATE TABLE cpa_error_import_items (
 run_id bigint NOT NULL REFERENCES cpa_error_import_runs(id),
 event_id bigint NOT NULL REFERENCES cpa_error_events(id) ON DELETE CASCADE,
 PRIMARY KEY (run_id,event_id)
);
