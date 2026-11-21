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

## Current production observations (2026-11-20)

- PostgreSQL 17 is running in personal-cloud-hub-postgres-1. Monitor uses its dedicated cliproxyapi_monitor database and least-privilege cliproxyapi_monitor role; Cloudreve data/role are not used.
- CPA management/RESP listener remains bound to 127.0.0.1:8317. The Usage Collector runs in host-network collector profile and subscribes to usage; it never LPOPs while OMC/Keeper subscribers are active.
- OMC v0.4.8 remains in subscribe mode. CPA Usage Keeper remains an independent Usage broadcast subscriber.
- The current deployed immutable image is ghcr.io/itsgjy/cliproxyapi-monitor:sha-7f871e9 (initial Phase 5.5 release: sha-4a7d173). Web, Processor, Rollup, Usage Collector and Error Collector are running; Web and both Collectors have healthy Docker healthchecks.
- Usage Collector health reports healthy, recentFullBatchCount=0 and capacityWarning=false. The false-positive was fixed by counting only resp/http FIFO Pull attempts; RESP SUBSCRIBE broadcast events are excluded.
- The Error Collector uses a separate host-network process and RESP connection for SUBSCRIBE errors. It is enabled for CPA instance oracle-primary with ERROR_CORRELATION_WINDOW_MS=120000. ERROR_COLLECTOR_ALLOW_PRODUCTION_TARGET and ERROR_COLLECTOR_ALLOW_PRODUCTION_DATABASE are explicit production opt-ins. Its database health API currently reports healthy=true/status=collecting.
- The current error subscription session was acknowledged at 2026-11-20 14:12:23.848335 UTC; coverage_through advances via PostgreSQL clock_timestamp(). No live error notification had arrived at the final verification time; no synthetic error was injected.
- OMC historical import is complete: the source snapshot contained 17,170 Usage rows, 112 historical price versions and 156 error events. A post-import exact overlap reconciliation removed 42 successful rows that matched oracle-primary across timestamp, provider, model, status, auth_index and token buckets; five unmatched OMC-only rows from subscription gaps were retained. Final legacy Usage count is 17,128. Historical Usage and Error records share legacy-oh-my-cpa-default; live ingestion remains oracle-primary.
- Historical Rollup was rebuilt with a 120-day daily lookback. After duplicate correction, the daily aggregate reconciles to 17,178 total requests (17,128 retained imported + 50 live), 2,764 errors (2,761 historical Usage errors + 3 live Usage errors) and 74,385,946,498 cost nanos.
- The Records API was exercised against imported historical records: eventId 16021 returned one HTTP 400 credential/time-window-associated error at 1ms; eventId 17113 returned one HTTP 402 error at 652ms. Both had provider/model matches and historical_import coverage. auth_index and auth_id were not exposed. There are 703 historical candidate pairs after overlap correction.
- Public entrypoint https://cpa-monitor.gjy666.eu.cc/login returned HTTP 200 through Cloudflare. Production deployment branch allowlist was temporarily extended for the cutover and then restored to main and feat/phase6-legacy-import.

## Operational commands

Run from /opt/cpa/monitor/deploy/compose for read-only operational checks:

```bash
docker compose --profile collector --profile error-collector --env-file .env -f compose.yaml ps
docker exec cliproxyapi-monitor-collector node scripts/collector-health.mjs
docker exec cliproxyapi-monitor-error-collector node scripts/error-collector-health.mjs
curl -fsS http://127.0.0.1:15300/login >/dev/null
```

For a new release, use the GitHub Actions CI CD workflow with deploy_production=true from a branch explicitly permitted by the production Environment. The installed deployment helper performs the database backup/restore rehearsal, reviewed migration, pinned-image rollout and health-gated rollback. Do not bypass the helper with an ad-hoc docker compose pull/up or drizzle-kit push. Usage and Error Collectors remain separate profiles and processes.

## Production safety invariants

- Historical import may target production only with both `--allow-production-target` and `PHASE6_IMPORT_ALLOW_PRODUCTION_TARGET=true`; the policy accepts only the exact `postgres` host, `cliproxyapi_monitor` role and `cliproxyapi_monitor` database. Never target Cloudreve or another database.
- Do not run `drizzle-kit push` against production. Use the reviewed SQL migration runner.
- Back up the new Monitor database before migrations and before cutover.
- Keep Cloudreve's existing database, role, data volume and Redis untouched.
- Do not publish CPA port 8317 or change its bind address to make Docker networking easier.
- CPA `management.secret-key` is stored as a bcrypt hash in `config.yaml`; RESP clients must use the corresponding plaintext management secret from a trusted existing client configuration, never copy the hash into `CPA_MANAGEMENT_KEY`. Keep the Monitor `.env` restricted to mode `0600`.
- Prefer RESP subscription while OMC/Keeper remain active; all subscribers receive the broadcast. The stream is at-most-once with no replay, so every disconnect is recorded as a gap. Do not select FIFO pull while any other subscriber is active. The FIFO queue has a one-hour retention window and is not an unlimited outage buffer.
- A pull interrupted after CPA LPOP but before Inbox commit is an explicit ingestion gap; do not describe this delivery boundary as lossless.
- Keep Collector, Processor, Rollup and web database pools within the documented connection budget.

## Current status

- [x] Phase 6 historical Usage import and source/target reconciliation: 17,170 source rows, 42 exact live-overlap duplicates removed, 17,128 retained, 112/112 price versions, 0 skipped.
- [x] Phase 5.5 Error Events import: 156/156 events, 0 skipped/failed, 156 reconciled.
- [x] Historical Usage/Error same-instance credential/time-window correlation: 703 candidate pairs after overlap correction; production Records API smoke tests returned matching evidence without exposing credential identifiers.
- [x] Phase 5.5 migration 0011 applied to PostgreSQL 17; pre-deploy backup and isolated restore test passed (22 public tables restored).
- [x] Full GitHub Actions run 44750179409 succeeded for initial Phase 5.5 deployment; follow-up run 44759282422 also passed tests, PostgreSQL 17 restart durability, ARM64/AMD64 builds, multi-architecture manifest, image smoke test and Oracle production deployment.
- [x] Production image sha-7f871e9 deployed. Web, Processor, Rollup, Usage Collector, Error Collector and PostgreSQL 17 are running; Web and both Collectors report healthy.
- [x] Usage remains native RESP SUBSCRIBE; Error Collector independently subscribes to errors. No errors LPOP or Usage FIFO consumer was introduced. Usage capacityWarning is false; health reporting now excludes RESP SUBSCRIBE from FIFO full-batch counts.
- [x] Daily Rollup backfill expanded to 120 days; 444 daily groups refreshed and totals reconciled to 17,178 requests, 2,764 errors (2,761 historical + 3 live) and 74,385,946,498 cost nanos.
- [x] External login endpoint https://cpa-monitor.gjy666.eu.cc/login returns HTTP 200; Production deployment allowlist restored to its original two branches.
- [ ] Observe the first naturally occurring live CPA errors notification and verify it is persisted under oracle-primary. The live errors subscription is healthy, but received_count remained zero at final verification; no synthetic production error was injected.
