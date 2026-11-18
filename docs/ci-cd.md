# GitHub CI/CD and Oracle Production Deployment

## Pipeline

`lint.yml` is the single CI/CD workflow. Every push and pull request runs the validation gate:

- Node.js 24 and pnpm 10 with frozen lockfile
- Collector unit tests, PostgreSQL 17 integration tests and OMC SQLite import tests
- ESLint, TypeScript and Next.js production build
- disposable PostgreSQL migrations and authenticated Playwright browser acceptance
- PostgreSQL 17 container restart durability test

Pushes to `main` and `feat/phase6-legacy-import`, plus manual workflow dispatches, then build and publish an immutable `sha-<7>` image to GHCR for both `linux/amd64` and `linux/arm64`. The workflow checks the ARM64 manifest/runtime and launches a container smoke test.

Production deployment runs only after every validation and image job succeeds:

- Push to `main`: automatic production deployment.
- Feature branch: build and publish only; use `workflow_dispatch` with `deploy_production=true` to deploy that exact tested commit.
- Pull requests: validation only; no GHCR push and no production secrets.
- A production concurrency group prevents overlapping deployments.- `main` is protected: pull requests must be up to date and pass both the PostgreSQL 17 restart check and the full test / browser-acceptance check. Force pushes and branch deletion are disabled; conversation resolution is required.
- The `production` GitHub Environment permits deployment only from `main` and `feat/phase6-legacy-import`.

## Restricted deployment access

GitHub Actions uses three repository secrets:

- `MONITOR_DEPLOY_HOST`: the Oracle public IPv4 address.
- `MONITOR_DEPLOY_SSH_KEY`: dedicated Ed25519 key, not the administrator SSH key.
- `MONITOR_DEPLOY_KNOWN_HOSTS`: pinned SSH host key; strict host-key checking is enabled.

The key is installed for the locked `monitor-deploy` account. Its `authorized_keys` entry uses OpenSSH `restrict` and a forced command. Arbitrary shell commands, PTY, port forwarding and agent forwarding are rejected. The forced command can invoke only `/usr/local/sbin/cliproxyapi-monitor-deploy` through a single sudoers rule.

Do not reuse this key for interactive administration. Rotate it by replacing the GitHub secret and the corresponding authorized key together.

## Deployment transaction

1. Validate the requested image tag against the fixed GHCR repository.
2. Verify at least 1 GiB free disk space.
3. Create a PostgreSQL custom-format backup before migrations.
4. Run `pg_restore --list`, restore the backup into a temporary database, verify it and drop the temporary database.
5. Pull the immutable Web / Processor / Rollup image.
6. Execute the reviewed SQL migration runner as a separate one-off container.
7. Roll out Web / Processor / Rollup and wait for the Web healthcheck plus `/login` response.
8. Retain recent backups for 14 days and print the deployed image and Compose status.

If image pull, migration or application health fails, the deployment helper restores the previous application image. Database migrations are forward-only; the helper never attempts an unsafe automatic schema downgrade. A backup is retained for manual recovery.

## Database and service boundaries

- The application database is the dedicated `cliproxyapi_monitor` database and role in the existing PostgreSQL 17 container.
- Cloudreve's database, role, Redis and data volume are not modified.
- The production Collector remains a separate opt-in Compose profile and uses native RESP `SUBSCRIBE usage`; it does not use destructive FIFO LPOP.
- Web, Processor and Rollup are deployed by the pipeline. Collector is enabled only after the production database and dashboard have passed their initial acceptance.
- Nginx and DNS are managed separately from the application rollout so a deployment cannot overwrite Beszel's existing `monitor.gjy666.eu.cc` site.

## Operator commands

From GitHub Actions, use **CI CD → Run workflow**, select the feature branch and set `deploy_production=true` to deploy that exact revision after all checks pass.

To inspect the production stack on the server:

```bash
cd /opt/cpa/monitor/deploy/compose
docker compose --env-file .env -f compose.yaml ps
docker compose --env-file .env -f compose.yaml logs --tail 100 web processor rollup
```

To inspect retained database backups:

```bash
ls -lh /var/backups/cliproxyapi-monitor/
```
