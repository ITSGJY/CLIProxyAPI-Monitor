#!/usr/bin/env bash
set -Eeuo pipefail
readonly DEPLOY_DIR="/opt/cpa/monitor/deploy/compose"
readonly PG_CONTAINER="personal-cloud-hub-postgres-1"
readonly IMAGE_REPOSITORY="ghcr.io/itsgjy/cliproxyapi-monitor"
fail() { echo "deployment_error: $*" >&2; exit 1; }
[[ $# -eq 1 ]] || fail "expected one SSH command argument"
[[ "$1" =~ ^deploy[[:space:]](sha-[0-9a-f]{7,40})$ ]] || fail "only deploy sha-<commit> is accepted"
readonly IMAGE_TAG="${BASH_REMATCH[1]}"
readonly NEW_IMAGE="${IMAGE_REPOSITORY}:${IMAGE_TAG}"
cd "$DEPLOY_DIR"
[[ -f .env && -f compose.yaml ]] || fail "deployment configuration is missing"
set -a
source ./.env
set +a
[[ "${MONITOR_IMAGE:-}" == "${IMAGE_REPOSITORY}:"* ]] || fail "MONITOR_IMAGE repository mismatch"
[[ -n "${MONITOR_DATABASE_URL:-}" ]] || fail "MONITOR_DATABASE_URL is missing"
case "${ERROR_COLLECTOR_ENABLED:-false}" in
  true)
    [[ "${ERROR_COLLECTOR_ALLOW_PRODUCTION_TARGET:-false}" == "true" ]] || fail "ERROR_COLLECTOR_ALLOW_PRODUCTION_TARGET must be true when error collection is enabled"
    [[ "${ERROR_COLLECTOR_ALLOW_PRODUCTION_DATABASE:-false}" == "true" ]] || fail "ERROR_COLLECTOR_ALLOW_PRODUCTION_DATABASE must be true when error collection is enabled"
    [[ -n "${CPA_MANAGEMENT_KEY:-}" && -n "${CPA_INSTANCE_ID:-}" && -n "${MONITOR_DATABASE_URL_HOST:-}" ]] || fail "error collector production connection settings are incomplete"
    error_collector_enabled=true
    ;;
  false|"")
    error_collector_enabled=false
    ;;
  *)
    fail "ERROR_COLLECTOR_ENABLED must be true or false"
    ;;
esac
install -d -m 700 /var/backups/cliproxyapi-monitor
available_kb="$(df -Pk /var/backups/cliproxyapi-monitor | awk 'NR==2 {print $4}')"
(( available_kb > 1048576 )) || fail "less than 1 GiB free for a database backup"
db_password="$(python3 -c 'import sys,urllib.parse; u=urllib.parse.urlparse(sys.argv[1]); print(urllib.parse.unquote(u.password or ""))' "$MONITOR_DATABASE_URL")"
[[ -n "$db_password" ]] || fail "could not parse database password"
restore_db="monitor_restore_$(date -u +%Y%m%d%H%M%S)_$RANDOM"
backup_file="/var/backups/cliproxyapi-monitor/predeploy-${IMAGE_TAG}-$(date -u +%Y%m%dT%H%M%SZ).dump"
echo "deployment_image=${NEW_IMAGE}"
echo "backup_start=true"
docker exec -e "PGPASSWORD=${db_password}" "$PG_CONTAINER" pg_dump -U cliproxyapi_monitor -d cliproxyapi_monitor -Fc -Z 6 > "$backup_file"
chmod 600 "$backup_file"
test -s "$backup_file" || fail "database backup is empty"
docker exec -i -e "PGPASSWORD=${db_password}" "$PG_CONTAINER" pg_restore --list < "$backup_file" >/dev/null
echo "backup_restore_test_start=true"
docker exec "$PG_CONTAINER" sh -lc 'createdb -U "$POSTGRES_USER" -O cliproxyapi_monitor "$1"' _ "$restore_db"
restore_cleanup() {
  docker exec "$PG_CONTAINER" sh -lc 'dropdb -U "$POSTGRES_USER" --if-exists "$1"' _ "$restore_db" >/dev/null 2>&1 || true
}
trap restore_cleanup EXIT
docker exec -i -e "PGPASSWORD=${db_password}" "$PG_CONTAINER" pg_restore -U cliproxyapi_monitor -d "$restore_db" --exit-on-error --no-owner --no-privileges < "$backup_file"
restored_tables="$(docker exec -e "PGPASSWORD=${db_password}" "$PG_CONTAINER" psql -U cliproxyapi_monitor -d "$restore_db" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
echo "backup_restore_test=passed restored_public_tables=${restored_tables}"
restore_cleanup
trap - EXIT
old_image="$MONITOR_IMAGE"
web_was_running="$(docker inspect --format '{{.State.Running}}' cliproxyapi-monitor-web 2>/dev/null || echo false)"
processor_was_running="$(docker inspect --format '{{.State.Running}}' cliproxyapi-monitor-processor 2>/dev/null || echo false)"
rollup_was_running="$(docker inspect --format '{{.State.Running}}' cliproxyapi-monitor-rollup 2>/dev/null || echo false)"
collector_was_running="$(docker inspect --format '{{.State.Running}}' cliproxyapi-monitor-collector 2>/dev/null || echo false)"
error_collector_was_running="$(docker inspect --format '{{.State.Running}}' cliproxyapi-monitor-error-collector 2>/dev/null || echo false)"
compose_profiles=(--profile collector)
if [[ "$error_collector_enabled" == "true" || "$error_collector_was_running" == "true" ]]; then
  compose_profiles+=(--profile error-collector)
fi

python3 - "$DEPLOY_DIR/.env" "$NEW_IMAGE" <<'PY'
import os, sys, tempfile
path, image = sys.argv[1:]
with open(path, encoding="utf-8") as source:
    lines = source.readlines()
for index, line in enumerate(lines):
    if line.startswith("MONITOR_IMAGE="):
        lines[index] = "MONITOR_IMAGE=" + image + "\n"
        break
else:
    raise SystemExit("MONITOR_IMAGE entry is missing")
fd, temporary = tempfile.mkstemp(prefix=".env.", dir=os.path.dirname(path), text=True)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        output.writelines(lines)
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY
# Exported shell variables outrank Compose's --env-file values. Keep the
# in-memory value aligned with the atomically updated .env before Compose runs.
export MONITOR_IMAGE="$NEW_IMAGE"
rollback_application() {
  echo "deployment_failed=true; restoring_previous_image=${old_image}" >&2
  python3 - "$DEPLOY_DIR/.env" "$old_image" <<'PY'
import os, sys, tempfile
path, image = sys.argv[1:]
with open(path, encoding="utf-8") as source:
    lines = source.readlines()
for index, line in enumerate(lines):
    if line.startswith("MONITOR_IMAGE="):
        lines[index] = "MONITOR_IMAGE=" + image + "\n"
        break
else:
    raise SystemExit("MONITOR_IMAGE entry is missing during rollback")
fd, temporary = tempfile.mkstemp(prefix=".env.rollback.", dir=os.path.dirname(path), text=True)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        output.writelines(lines)
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY
  export MONITOR_IMAGE="$old_image"
  services=()
  if [[ "$web_was_running" == "true" ]]; then services+=(web); fi
  if [[ "$processor_was_running" == "true" ]]; then services+=(processor); fi
  if [[ "$rollup_was_running" == "true" ]]; then services+=(rollup); fi
  if [[ "$collector_was_running" == "true" ]]; then services+=(collector); fi
  if [[ "$error_collector_was_running" == "true" && "$error_collector_enabled" == "true" ]]; then
    services+=(error-collector)
  else
    docker compose --profile error-collector --env-file .env -f compose.yaml stop error-collector >/dev/null 2>&1 || true
  fi
  if (( ${#services[@]} > 0 )); then
    docker compose "${compose_profiles[@]}" --env-file .env -f compose.yaml up -d "${services[@]}" || true
  fi
}
echo "image_pull_start=true"
pull_services=(web processor rollup)
if [[ "$collector_was_running" == "true" ]]; then pull_services+=(collector); fi
if [[ "$error_collector_enabled" == "true" || "$error_collector_was_running" == "true" ]]; then pull_services+=(error-collector); fi
if ! docker compose "${compose_profiles[@]}" --env-file .env -f compose.yaml pull "${pull_services[@]}"; then
  rollback_application
  fail "image pull failed; previous application image restored"
fi
echo "database_migration_start=true"
if ! docker compose --env-file .env -f compose.yaml run --rm --no-deps web node scripts/migrate.mjs; then
  rollback_application
  fail "database migration failed; previous application image restored; inspect migration logs and backup"
fi
echo "application_rollout_start=true"
rollout_services=(web processor rollup)
if [[ "$collector_was_running" == "true" ]]; then rollout_services+=(collector); fi
if [[ "$error_collector_enabled" == "true" ]]; then
  rollout_services+=(error-collector)
elif [[ "$error_collector_was_running" == "true" ]]; then
  docker compose "${compose_profiles[@]}" --env-file .env -f compose.yaml stop error-collector || {
    rollback_application
    fail "could not stop the disabled error collector"
  }
fi
if ! docker compose "${compose_profiles[@]}" --env-file .env -f compose.yaml up -d "${rollout_services[@]}"; then
  rollback_application
  fail "application rollout failed; previous application image restored"
fi
healthy=false
for attempt in $(seq 1 60); do
  state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' cliproxyapi-monitor-web 2>/dev/null || true)"
  collector_state=healthy
  if [[ "$collector_was_running" == "true" ]]; then
    collector_state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' cliproxyapi-monitor-collector 2>/dev/null || true)"
  fi
  error_collector_state=healthy
  if [[ "$error_collector_enabled" == "true" ]]; then
    error_collector_state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' cliproxyapi-monitor-error-collector 2>/dev/null || true)"
  fi
  if [[ "$state" == "healthy" && "$collector_state" == "healthy" && "$error_collector_state" == "healthy" ]] && curl -fsS --max-time 5 http://127.0.0.1:15300/login >/dev/null; then
    healthy=true
    break
  fi
  sleep 2
done
if [[ "$healthy" != true ]]; then
  log_services=(web processor rollup)
  if [[ "$collector_was_running" == "true" ]]; then log_services+=(collector); fi
  if [[ "$error_collector_enabled" == "true" || "$error_collector_was_running" == "true" ]]; then log_services+=(error-collector); fi
  docker compose "${compose_profiles[@]}" --env-file .env -f compose.yaml logs --tail 80 "${log_services[@]}" >&2 || true
  rollback_application
  fail "new application did not become healthy; previous application image restored"
fi
find /var/backups/cliproxyapi-monitor -type f -name 'predeploy-*.dump' -mtime +14 -delete
echo "deployment_result=success"
echo "deployed_image=${NEW_IMAGE}"
echo "database_backup=${backup_file}"
docker compose "${compose_profiles[@]}" --env-file .env -f compose.yaml ps
