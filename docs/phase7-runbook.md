# Phase 7 — Complete Validation and Production Cutover

## Scope

Phase 7 is the final operational stage of the seven-phase roadmap. It validates failure recovery and deploys the Monitor as the authoritative CPA usage consumer only after the replacement path is proven.

Acceptance gates:

1. Fault injection and duplicate-event verification.
2. Collector process restart and PostgreSQL connection recovery.
3. CPA usage queue retention-window assessment.
4. Historical price-version and billing consistency.
5. Browser acceptance of Overview, Explore and Records.
6. Docker image and deployment verification.
7. Production Collector cutover after OMC/Keeper usage subscriptions are stopped or disabled, allowing the Monitor pull Collector to become the sole FIFO queue consumer. CPAMP model-price synchronization may remain active if it does not subscribe to usage.

## Deployment topology

- Web, Processor and Rollup run from one immutable GHCR image in Docker Compose.
- They join the existing `personal-cloud-hub_default` network and connect to a dedicated Monitor database in the existing PostgreSQL 17 container. They do not use Cloudreve's database or role.
- CPA binds its RESP/management listener to `127.0.0.1:8317`. The Collector therefore runs in a dedicated Docker Compose `collector` profile using `network_mode: host`; this lets it reach CPA loopback without exposing port 8317. Its PostgreSQL URL targets the host-reachable PostgreSQL bridge address discovered during deployment.
- The Collector uses FIFO pull mode. It must be the only queue consumer, and no `SUBSCRIBE usage` clients may remain connected. OMC and Keeper usage subscriptions must be stopped or disabled as part of the coordinated cutover; CPAMP price synchronization can remain enabled if it does not subscribe to usage.
- CI builds and publishes immutable `sha-*` image tags. The production host pulls the exact pinned tag; it does not run Node/pnpm builds.

## Current production observations (read-only preflight)

- Existing PostgreSQL: PostgreSQL 17 container in `personal-cloud-hub` project, network `personal-cloud-hub_default`, current container address `172.20.0.4`.
- Existing database/role: `cloudreve`; no Monitor database or role exists yet.
- CPA listener: `127.0.0.1:8317`; usage statistics are enabled.
- CPA `redis-usage-queue-retention-seconds` was 300 seconds and has been increased to the documented maximum of 3,600 seconds (1 hour) through the v8 Management API hot-reload path. The original config is backed up at `/opt/cpa/cliproxyapi/config.yaml.phase7-precutover.bak`. See the [official Redis Usage Queue specification](https://help.router-for.me/management/redis-usage-queue).
- OMC is currently configured with `OMCPA_USAGE_INGEST_MODE=subscribe` and logs `usage ingest subscribed`. CPA Usage Keeper's documentation explicitly requires subscription mode when multiple collectors share one CPA instance; its process also has active connections to CPA.
- Official CPA RESP documentation states that while at least one `SUBSCRIBE usage` client is connected, events are broadcast to subscribers and are not stored in the FIFO queue. The Monitor Collector is deliberately pull-first (`LPOP`/HTTP), so it will not receive new events until OMC/Keeper subscriptions are stopped or disabled.
- CPAMP currently shows model-price synchronization activity; there is no evidence in its recent logs that it is a usage subscriber.
- The Monitor has not been deployed and no production Collector has been enabled.

## Operational commands

Run from `/opt/cpa/monitor/deploy/compose` after the dedicated database, role, secrets and pinned image are provisioned:

```bash
docker compose --env-file .env -f compose.yaml pull
docker compose --env-file .env -f compose.yaml run --rm --no-deps web node scripts/migrate.mjs
docker compose --env-file .env -f compose.yaml up -d web processor rollup
docker compose --env-file .env -f compose.yaml ps
```

The Collector is excluded from the default Compose profile. Keep it disabled until the single-consumer cutover is scheduled and approved. At cutover, set `COLLECTOR_ENABLED=true`, `CPA_ALLOW_PRODUCTION_TARGET=true`, and `COLLECTOR_ALLOW_PRODUCTION_DATABASE=true` in `.env`, then run `docker compose --profile collector --env-file .env -f compose.yaml up -d collector`.

## Production safety invariants

- Never point the importer at the production database; Phase 6 importer deliberately accepts loopback test PostgreSQL only.
- Do not run `drizzle-kit push` against production. Use the reviewed SQL migration runner.
- Back up the new Monitor database before migrations and before cutover.
- Keep Cloudreve's existing database, role, data volume and Redis untouched.
- Do not publish CPA port 8317 or change its bind address to make Docker networking easier.
- Do not enable the pull Collector while OMC or Keeper remains subscribed. CPA's broadcast subscription mode suppresses FIFO queue writes while any subscriber is connected. The FIFO queue now has a one-hour retention window; this is not an unlimited outage buffer.
- A pull interrupted after CPA LPOP but before Inbox commit is an explicit ingestion gap; do not describe this delivery boundary as lossless.
- Keep Collector, Processor, Rollup and web database pools within the documented connection budget.

## Current status

- [x] Phase 6 history import and source/target reconciliation.
- [x] Phase 6 PostgreSQL 17 CI, import tests, lint, typecheck and Next build.
- [x] Phase 7 PostgreSQL backend-failure reconnection and committed-Inbox process-restart tests.
- [x] Phase 7 seven-day empty-pull audit retention, expired Processor lease reclamation and duplicate-event tests.
- [x] Added a GitHub Actions PostgreSQL 17 container restart durability test.
- [ ] Phase 7 browser acceptance in GitHub Actions (workflow added; awaiting CI result).
- [ ] Phase 7 immutable Docker image build and container smoke test (workflow added; awaiting CI result).
- [ ] Provision dedicated Monitor database/role and validate backup/restore.
- [x] Increase CPA queue retention from 300 seconds to the documented maximum of 3,600 seconds; config hot reload verified and original config backed up.
- [ ] Stop/disable OMC and Keeper usage subscriptions, verify subscriber disconnect, then start exactly one Monitor pull Collector. CPAMP model-price synchronization may remain active if it does not subscribe to usage.
- [ ] Verify live Collector health, Inbox drain, Processor, Rollup and Dashboard totals after cutover.
