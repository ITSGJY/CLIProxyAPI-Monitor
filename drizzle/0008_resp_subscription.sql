UPDATE "usage_collector_instances"
  SET "collector_mode" = 'subscribe'
  WHERE "collector_mode" = 'subscribe_experimental';

ALTER TABLE "usage_collector_instances"
  DROP CONSTRAINT "usage_collector_instances_mode_check";
ALTER TABLE "usage_collector_instances"
  ADD CONSTRAINT "usage_collector_instances_mode_check"
  CHECK ("collector_mode" IN ('pull_first', 'subscribe'));

ALTER TABLE "usage_pull_attempts"
  DROP CONSTRAINT "usage_pull_attempts_transport_check";
ALTER TABLE "usage_pull_attempts"
  ADD CONSTRAINT "usage_pull_attempts_transport_check"
  CHECK ("transport" IN ('resp', 'http', 'resp-subscribe'));

ALTER TABLE "usage_inbox"
  DROP CONSTRAINT "usage_inbox_transport_check";
ALTER TABLE "usage_inbox"
  ADD CONSTRAINT "usage_inbox_transport_check"
  CHECK ("transport" IN ('resp', 'http', 'resp-subscribe'));

ALTER TABLE "usage_events"
  DROP CONSTRAINT "usage_events_transport_check";
ALTER TABLE "usage_events"
  ADD CONSTRAINT "usage_events_transport_check"
  CHECK ("source_transport" IN ('resp', 'http', 'resp-subscribe', 'subscribe_experimental', 'legacy_import'));
