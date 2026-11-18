# ADR-002: Native CPA RESP Subscription as the Production Ingestion Mode

- Status: Accepted
- Decision: Production uses RESP `AUTH` + `SUBSCRIBE usage`. FIFO `LPOP` / HTTP Queue pull is a separately coordinated compatibility mode only.

## Context

CPA v8 broadcasts Usage events to all active `SUBSCRIBE usage` clients. While at least one subscriber is connected, it does not add those events to its FIFO Usage Queue. `LPOP` and the Management Usage Queue HTTP endpoint are destructive reads.

## Consequences

- Monitor can coexist with OMC and CPA Usage Keeper as independent broadcast subscribers.
- Production Compose explicitly sets `COLLECTOR_MODE=subscribe` and `COLLECTOR_ALLOW_PULL_FALLBACK=false`.
- Configuration rejects FIFO fallback when production CPA or PostgreSQL flags are enabled.
- Pull mode is only allowed after a coordinated maintenance window confirms every other Usage subscriber has stopped.
- Pub/Sub is at-most-once and has no ACK or replay cursor; every established-stream interruption is recorded as an ingestion gap.
