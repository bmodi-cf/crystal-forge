#!/usr/bin/env bash
# Bring the shared Postgres container up and wait for it to be healthy.
#
# Installed as /usr/local/bin/crystal-forge-ensure-postgres and used as an
# ExecStartPre by BOTH units:
#   - crystal-forge.service        (dashboard: a dead DB means every request 500s)
#   - crystal-forge-backup.service (nightly dump runs *inside* the pg container)
#
# Why it exists: docker-compose.yml deliberately gives postgres NO restart policy
# (only the registry gets `restart: unless-stopped`), on the assumption that
# forge-launch.sh starts it. But both units above are systemd-managed, so after an
# *unplanned* reboot they'd run against a DB nothing had started. That's exactly
# what happened 2026-07-28: the dashboard came up on a dead DB and every request
# failed with Prisma `DatabaseNotReachable`. Each unit now declares this need
# itself instead of relying on a human having run forge-launch.sh, or on some
# other unit having happened to start pg first.
#
# Idempotent: a healthy container is reused untouched. Deliberately does NOT run
# `prisma migrate deploy` — migrations stay a manual step so a restart can never
# silently change the schema.
set -euo pipefail

CONFIG=/etc/default/crystal-forge

# Config precedence: environment already set by systemd's EnvironmentFile wins,
# then $CONFIG, then the built-in defaults below. Capture the pre-set values
# before sourcing so the file can't clobber a more specific unit's setting.
_env_repo_dir="${REPO_DIR:-}"
_env_pg_container="${PG_CONTAINER:-}"
# shellcheck disable=SC1090
[ -r "$CONFIG" ] && . "$CONFIG"
REPO_DIR="${_env_repo_dir:-${REPO_DIR:-}}"
PG_CONTAINER="${_env_pg_container:-${PG_CONTAINER:-crystal-forge-pg}}"

TIMEOUT="${PG_HEALTH_TIMEOUT:-60}"

# Fallback for running straight out of a checkout (./scripts/ensure-postgres.sh)
# rather than from the installed copy, where $CONFIG supplies REPO_DIR.
if [ -z "$REPO_DIR" ]; then
  _here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  [ -f "$_here/../docker-compose.yml" ] && REPO_DIR="$(cd "$_here/.." && pwd)"
fi

if [ -z "$REPO_DIR" ] || [ ! -f "$REPO_DIR/docker-compose.yml" ]; then
  echo "[ensure-postgres] cannot locate docker-compose.yml; set REPO_DIR in $CONFIG" >&2
  exit 1
fi
cd "$REPO_DIR"

state=$(docker inspect -f '{{.State.Status}}' "$PG_CONTAINER" 2>/dev/null || echo missing)
health=$(docker inspect -f '{{.State.Health.Status}}' "$PG_CONTAINER" 2>/dev/null || echo missing)

if [ "$state" = running ] && [ "$health" = healthy ]; then
  echo "[ensure-postgres] $PG_CONTAINER already healthy — reusing"
  exit 0
fi

# A stopped/created container blocks `compose up` with a name conflict. Data
# lives in the named volume crystal-forge-pgdata, so removing the *container* is
# safe — but only ever touch one that isn't running.
if [ "$state" != missing ] && [ "$state" != running ]; then
  echo "[ensure-postgres] removing stale container (state: $state)"
  docker rm -f "$PG_CONTAINER" >/dev/null
fi

echo "[ensure-postgres] starting $PG_CONTAINER"
docker compose up -d postgres >/dev/null

for ((i = 1; i <= TIMEOUT; i++)); do
  if [ "$(docker inspect -f '{{.State.Health.Status}}' "$PG_CONTAINER" 2>/dev/null)" = healthy ]; then
    echo "[ensure-postgres] healthy after ${i}s"
    exit 0
  fi
  sleep 1
done

echo "[ensure-postgres] did not become healthy within ${TIMEOUT}s; recent logs:" >&2
docker logs --tail 50 "$PG_CONTAINER" >&2
exit 1
