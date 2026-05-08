#!/usr/bin/env bash
# Crystal Forge dev launcher.
#
# Brings up Docker (Desktop, on macOS), the Postgres container from
# docker-compose.yml, applies any pending Prisma migrations, then runs the
# Next.js dev server in the foreground. Postgres keeps running between
# launches; the dev server stops when you Ctrl+C.

set -euo pipefail
cd "$(dirname "$0")"

PG_CONTAINER="crystal-forge-pg"
DEV_PORT=3000
URL="http://localhost:${DEV_PORT}"

step() { printf '\n==> %s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# --- preflight -------------------------------------------------------------
[[ -f docker-compose.yml && -d prisma ]] \
  || fail "Run this from the Crystal Forge repo root."
[[ -f .env.local ]] \
  || fail ".env.local missing. Copy .env.example to .env.local and fill in secrets (see README)."
[[ -d node_modules ]] \
  || fail "node_modules missing. Run 'pnpm install' first (see README)."

# --- phase 1: docker daemon ------------------------------------------------
if ! docker info >/dev/null 2>&1; then
  if [[ "$(uname)" != "Darwin" ]]; then
    fail "Docker daemon is not running. Start it (or your container runtime) and re-run."
  fi
  step "Docker isn't running -- starting Docker Desktop"
  open -a Docker
  printf '    waiting for Docker'
  for i in $(seq 1 45); do
    if docker info >/dev/null 2>&1; then printf ' ok\n'; break; fi
    printf '.'
    sleep 2
    if [[ $i -eq 45 ]]; then
      printf '\n'
      fail "Timed out waiting for Docker. If you use OrbStack/Colima, start it manually."
    fi
  done
fi

# --- phase 2: port collision -----------------------------------------------
DEV_PID=$(lsof -nP -iTCP:${DEV_PORT} -sTCP:LISTEN -t 2>/dev/null || true)
[[ -z "$DEV_PID" ]] \
  || fail "Port ${DEV_PORT} is already in use by PID ${DEV_PID}. Stop it first."

# --- phase 3: postgres -----------------------------------------------------
PG_HEALTH=$(docker inspect -f '{{.State.Health.Status}}' "$PG_CONTAINER" 2>/dev/null || echo missing)
if [[ "$PG_HEALTH" == "healthy" ]]; then
  step "Postgres (${PG_CONTAINER}) is already healthy -- reusing"
else
  step "Starting Postgres (${PG_CONTAINER})"
  docker compose up -d postgres >/dev/null
  printf '    waiting for healthcheck'
  for i in $(seq 1 30); do
    if [[ "$(docker inspect -f '{{.State.Health.Status}}' "$PG_CONTAINER" 2>/dev/null)" == "healthy" ]]; then
      printf ' ok\n'
      break
    fi
    printf '.'
    sleep 1
    if [[ $i -eq 30 ]]; then
      printf '\n'
      printf '\nRecent Postgres logs:\n' >&2
      docker logs --tail 50 "$PG_CONTAINER" >&2
      fail "Postgres did not become healthy."
    fi
  done
fi

# --- phase 4: apply pending migrations -------------------------------------
step "Applying any pending Prisma migrations"
pnpm prisma migrate deploy

# --- phase 5: banner + dev server ------------------------------------------
WIDTH=42
hr() { printf '%s' "$1"; printf '═%.0s' $(seq 1 $WIDTH); printf '%s\n' "$2"; }
pad() {
  local s="$1"
  printf '║%s%*s║\n' "$s" $((WIDTH - ${#s})) ""
}

echo
hr "╔" "╗"
pad ""
pad "  Crystal Forge -- starting dev server"
pad "  -> $URL"
pad ""
hr "╚" "╝"
echo
echo "Press Ctrl+C to stop the dev server. Postgres remains running."
echo

exec pnpm dev
