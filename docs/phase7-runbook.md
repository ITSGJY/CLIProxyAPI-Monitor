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
7. Production Collector deployment in native RESP Subscription mode, verifying that Monitor, OMC and Keeper all receive the same broadcast; retain explicit FIFO pull only as a compatibility path when no other subscriber exists.

## Deployment topology

- Web, Processor and Rollup run from one immutable GHCR image in Docker Compose.
- They join the existing `personal-cloud-hub_default` network and connect to a dedicated Monitor database in the existing PostgreSQL 17 container. They do not use Cloudreve's database or role.
- CPA binds its RESP/management listener to `127.0.0.1:8317`. The Collector therefore runs in a dedicated Docker Compose `collector` profile using `network_mode: host`; this lets it reach CPA loopback without exposing port 8317. Production pins `COLLECTOR_MODE=subscribe` and `COLLECTOR_ALLOW_PULL_FALLBACK=false`; it joins the native `SUBSCRIBE usage` broadcast stream alongside OMC/Keeper and never consumes the FIFO queue.
- The Collector is an independent broadcast subscriber and can coexist with OMC and Keeper. FIFO pull is disabled in production because it is destructive and unsafe while any other Usage subscriber is connected.
- CPA v8 sends `{"support_refresh":true}` immediately after `SUBSCRIBE usage` and can send `{"refresh":true}` control frames later. These are control notifications, not usage records; the Collector must ignore them before Inbox persistence. Regression tests cover both frames.
- CI builds and publishes immutable `sha-*` image tags. The production host pulls the exact pinned tag; it does not run Node/pnpm builds.

## Current production observations (read-only preflight)

- Existing PostgreSQL: PostgreSQL 17 container in `personal-cloud-hub` project, network `personal-cloud-hub_default`, current container address `172.20.0.4`.
- Existing database/role: `cloudreve`; no Monitor database or role exists yet.
- CPA listener: `127.0.0.1:8317`; usage statistics are enabled.
- CPA `redis-usage-queue-retention-seconds` was 300 seconds and has been increased to the documented maximum of 3,600 seconds (1 hour) through the v8 Management API hot-reload path. The original config is backed up at `/opt/cpa/cliproxyapi/config.yaml.phase7-precutover.bak`. See the [official Redis Usage Queue specification](https://help.router-for.me/management/redis-usage-queue).
- OMC is currently configured with `OMCPA_USAGE_INGEST_MODE=subscribe` and logs `usage ingest subscribed`. CPA Usage Keeper's documentation explicitly requires subscription mode when multiple collectors share one CPA instance; its process also has active connections to CPA.
- Official CPA RESP documentation states that while at least one `SUBSCRIBE usage` client is connected, events are broadcast to all subscribers and are not stored in the FIFO queue. Monitor now joins that broadcast stream by default; explicit FIFO pull is only a compatibility option when no subscribers remain.
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

The Collector is excluded from the default Compose profile. Keep it disabled until the dedicated Monitor database, backup/restore and production deployment are verified. At deployment, set `COLLECTOR_ENABLED=true`, `COLLECTOR_MODE=subscribe`, `COLLECTOR_ALLOW_PULL_FALLBACK=false`, `CPA_ALLOW_PRODUCTION_TARGET=true`, and `COLLECTOR_ALLOW_PRODUCTION_DATABASE=true` in `.env`, then run `docker compose --profile collector --env-file .env -f compose.yaml up -d collector`. OMC and Keeper remain active broadcast subscribers.

## Production safety invariants

- Historical import may target production only with both `--allow-production-target` and `PHASE6_IMPORT_ALLOW_PRODUCTION_TARGET=true`; the policy accepts only the exact `postgres` host, `cliproxyapi_monitor` role and `cliproxyapi_monitor` database. Never target Cloudreve or another database.
- Do not run `drizzle-kit push` against production. Use the reviewed SQL migration runner.
- Back up the new Monitor database before migrations and before cutover.
- Keep Cloudreve's existing database, role, data volume and Redis untouched.
- Do not publish CPA port 8317 or change its bind address to make Docker networking easier.
- Prefer RESP subscription while OMC/Keeper remain active; all subscribers receive the broadcast. The stream is at-most-once with no replay, so every disconnect is recorded as a gap. Do not select FIFO pull while any other subscriber is active. The FIFO queue has a one-hour retention window and is not an unlimited outage buffer.
- A pull interrupted after CPA LPOP but before Inbox commit is an explicit ingestion gap; do not describe this delivery boundary as lossless.
- Keep Collector, Processor, Rollup and web database pools within the documented connection budget.

## Current status

- [x] Phase 6 history import and source/target reconciliation.
- [x] Phase 6 PostgreSQL 17 CI, import tests, lint, typecheck and Next build.
- [x] Phase 7 PostgreSQL backend-failure reconnection and committed-Inbox process-restart tests.
- [x] Phase 7 seven-day empty-pull audit retention, expired Processor lease reclamation and duplicate-event tests.
- [x] Added a GitHub Actions PostgreSQL 17 container restart durability test.
- [x] Phase 7 browser acceptance in GitHub Actions (login and Overview/Explore/Records pages; API errors and console errors checked).
- [x] Phase 7 immutable Docker image build and container smoke test (GHCR image built and launched).
- [ ] Provision dedicated Monitor database/role and validate backup/restore.
- [x] Increase CPA queue retention from 300 seconds to the documented maximum of 3,600 seconds; config hot reload verified and original config backed up.
- [ ] Deploy the Monitor Collector in `auto`/`subscribe` mode, verify the CPA SUBSCRIBE acknowledgement and event flow, then verify OMC/Keeper continue receiving the same broadcast. Do not disable their subscribers for this mode.
- [ ] Use explicit `pull` mode only if SUBSCRIBE is unavailable and all other subscribers are confirmed stopped; then ensure exactly one FIFO consumer. CPAMP price synchronization may remain active if it does not consume the usage queue.
- [ ] Verify live Collector health, Inbox drain, Processor, Rollup and Dashboard totals after cutover.
