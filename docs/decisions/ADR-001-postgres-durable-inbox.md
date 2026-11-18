# ADR-001: PostgreSQL Durable Inbox Instead of a Local SQLite Spool

- Status: Accepted
- Decision: PostgreSQL 17 `usage_inbox` is the durable journal and replay boundary. Do not add a local SQLite spool to the production Collector.

## Context

The initial architecture discussion considered a local SQLite WAL spool in front of PostgreSQL. The implemented design was subsequently simplified to a PostgreSQL-backed durable Inbox because the production PostgreSQL service is already available on the same host/network, the Inbox and event-processing state must be transactional, and the Collector / Processor / identity-ledger flow is already coordinated through PostgreSQL leases.

## Consequences

- Each received CPA event is sanitized and committed to `usage_inbox` before the subscription callback completes.
- Processor retries, idempotency and dead-letter state remain in the same durable database.
- A PostgreSQL outage prevents new durable Inbox commits. The Collector terminates the subscription session, records an ingestion gap and reconnects after recovery.
- CPA Pub/Sub has no ACK/replay, so the in-flight event may be lost during a PostgreSQL outage. This limitation is explicit and observable; the design does not claim end-to-end zero-loss.
- A local SQLite file would not remove CPA's at-most-once boundary and would introduce a second journal, replay protocol, disk-retention policy and cross-store reconciliation path. It is therefore not part of the accepted design.

## Operational requirements

- Keep PostgreSQL pools small and monitor connection health.
- Back up the dedicated Monitor database and verify restore.
- Keep the Collector in native RESP Subscription mode in production.
- Record every established-stream interruption as an ingestion gap.
