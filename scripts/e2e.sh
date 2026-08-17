#!/usr/bin/env bash
# Run the Playwright e2e suite against an ISOLATED database and port.
#
# Why this isn't a `pnpm e2e` script any more
# ───────────────────────────────────────────
# tests/e2e/global-setup.ts re-seeds the database before the suite runs — that's
# deliberate (vitest's withCleanDb truncates everything, so back-to-back
# `pnpm test && <e2e>` would otherwise leave Playwright with an empty DB). It
# used to inherit DATABASE_URL verbatim, so on a machine where the working copy
# IS the live deployment (the pilot), running it wiped the real dashboard DB:
# forges, users, promotion history. `playwright.config.ts` compounded it with
# `reuseExistingServer`, which pointed the suite at the live dashboard instead
# of starting its own.
#
# The suite is only needed when standing up a new Crystal Forge server or a
# fresh local instance, so it lives here rather than in package.json — too easy
# to fire off `pnpm e2e` from muscle memory or a tab-complete.
#
# What this does
#   • refuses to run when it looks like a live deployment (override with the
#     flag below, which is safe now — the DB is isolated either way)
#   • rewrites DATABASE_URL to a dedicated "<db>_e2e" database
#   • pins the dev server to E2E_PORT (default 3300), never reusing a server
#
# global-setup.ts independently refuses any database not ending in "_e2e", so
# `pnpm exec playwright test` straight from the shell can't wipe the dev DB
# either.
#
# Usage:  ./scripts/e2e.sh [--i-understand-this-seeds-the-db] [playwright args]
#         E2E_PORT=3400 ./scripts/e2e.sh forge-open.spec.ts
set -euo pipefail

cd "$(dirname "$0")/.."

FORCE=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --i-understand-this-seeds-the-db) FORCE=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done

# ── Refuse on what looks like a live deployment ────────────────────────────────
live_reasons=()
if systemctl is-active --quiet crystal-forge.service 2>/dev/null; then
  live_reasons+=("crystal-forge.service is active")
fi
# Compare the last colon-separated field of ss's Local Address:Port column, so
# this catches 0.0.0.0:80 and [::]:80 alike without matching :8080.
if ss -ltn 2>/dev/null | awk 'NR>1 { n = split($4, a, ":"); if (a[n] == "80") found = 1 } END { exit !found }'; then
  live_reasons+=(":80 is in use")
fi

if [ ${#live_reasons[@]} -gt 0 ] && [ "$FORCE" -ne 1 ]; then
  printf 'REFUSING: %s' "${live_reasons[0]}"
  [ ${#live_reasons[@]} -gt 1 ] && printf ' and %s' "${live_reasons[1]}"
  printf ' — this looks like a live deployment.\n'
  echo "Re-run with --i-understand-this-seeds-the-db to override."
  echo "(The suite seeds an isolated <db>_e2e database, never the dev DB.)"
  exit 1
fi

# ── Derive the isolated database URL ───────────────────────────────────────────
if [ ! -f .env.local ]; then
  echo "REFUSING: .env.local not found; cannot resolve DATABASE_URL." >&2
  exit 1
fi

raw="$(grep -m1 '^DATABASE_URL=' .env.local | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')"
if [ -z "$raw" ]; then
  echo "REFUSING: DATABASE_URL is not set in .env.local." >&2
  exit 1
fi

base="${raw%%\?*}"          # strip ?schema=public
query="${raw#"$base"}"      # ...and keep it for later
dbname="${base##*/}"
case "$dbname" in
  *_e2e) ;;
  *) base="${base%/*}/${dbname}_e2e" ;;
esac
E2E_DATABASE_URL="${base}${query}"
E2E_DBNAME="${base##*/}"

PORT="${E2E_PORT:-3300}"

echo "[e2e] using ${E2E_DBNAME} on :${PORT}"

DATABASE_URL="$E2E_DATABASE_URL" E2E_PORT="$PORT" \
  exec pnpm exec playwright test "${ARGS[@]}"
