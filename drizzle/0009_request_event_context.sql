ALTER TABLE "usage_events"
  ADD COLUMN IF NOT EXISTS "session_id" text,
  ADD COLUMN IF NOT EXISTS "parent_session_id" text,
  ADD COLUMN IF NOT EXISTS "execution_id" text,
  ADD COLUMN IF NOT EXISTS "trace_id" text,
  ADD COLUMN IF NOT EXISTS "node_kind" text,
  ADD COLUMN IF NOT EXISTS "is_fork" boolean,
  ADD COLUMN IF NOT EXISTS "is_compaction" boolean;

CREATE INDEX IF NOT EXISTS "usage_events_request_id_occurred_at_idx"
  ON "usage_events" ("request_id", "occurred_at");
