#!/usr/bin/env bash
#
# Crystal Forge Postgres backup — grandfather-father-son (GFS) rotation.
#
# Runs from the dashboard host against the single shared Postgres container
# (crystal-forge-pg), which holds the dashboard DB plus every per-forge DB.
# Each night produces ONE archive containing:
#   - globals.sql          global objects (roles, incl. every <db>_app login role)
#   - <db>.dump            one custom-format (-Fc) dump per non-template database
#   - SHA256SUMS           integrity manifest
#
# The nightly archive lands in daily/ and is HARDLINKED into weekly/ and
# monthly/ (first run of each ISO week / calendar month), so the three tiers
# prune independently without storing three copies. Promotion is catch-up based
# (keyed on ISO week / year-month), so a missed night never punches a hole in a
# tier.
#
# Restore examples are in scripts/pg-restore-runbook.md.

set -euo pipefail

# ---- config ---------------------------------------------------------------
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/crystal-forge}"
PG_CONTAINER="${PG_CONTAINER:-crystal-forge-pg}"
PG_SUPERUSER="${PG_SUPERUSER:-crystal}"

# retention, in days, per tier
DAILY_KEEP_DAYS="${DAILY_KEEP_DAYS:-31}"     # ~1 month
WEEKLY_KEEP_DAYS="${WEEKLY_KEEP_DAYS:-183}"  # ~6 months
MONTHLY_KEEP_DAYS="${MONTHLY_KEEP_DAYS:-730}" # ~2 years
# ---------------------------------------------------------------------------

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { printf '%s  ERROR: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; exit 1; }

DATE="$(date +%F)"                 # YYYY-MM-DD
CUR_WEEK="$(date +%G-W%V)"         # ISO year + ISO week, e.g. 2026-W31
CUR_MONTH="$(date +%Y-%m)"         # calendar year-month

# psql/pg_dump run inside the container (local socket auth = trust for the
# superuser), so no password handling is needed on the host.
pg() { docker exec -i "$PG_CONTAINER" "$@"; }

docker inspect -f '{{.State.Running}}' "$PG_CONTAINER" 2>/dev/null | grep -qx true \
  || die "container '$PG_CONTAINER' is not running"

mkdir -p "$BACKUP_ROOT"/{daily,weekly,monthly}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/crystal-forge-$DATE"
mkdir -p "$STAGE"

# ---- 1. global objects (roles etc.) --------------------------------------
log "dumping globals"
pg pg_dumpall -U "$PG_SUPERUSER" --globals-only > "$STAGE/globals.sql" \
  || die "pg_dumpall --globals-only failed"

# ---- 2. per-database custom-format dumps ---------------------------------
mapfile -t DBS < <(pg psql -U "$PG_SUPERUSER" -d postgres -tAc \
  "SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn ORDER BY 1")
[ "${#DBS[@]}" -gt 0 ] || die "no databases returned"

for db in "${DBS[@]}"; do
  log "dumping $db"
  pg pg_dump -U "$PG_SUPERUSER" -Fc -d "$db" > "$STAGE/$db.dump" \
    || die "pg_dump of '$db' failed"
  # integrity check: a valid custom-format archive must list cleanly
  pg pg_restore -l < "$STAGE/$db.dump" > /dev/null \
    || die "dump of '$db' failed integrity check (pg_restore -l)"
done
log "dumped ${#DBS[@]} databases"

# ---- 3. manifest + archive -----------------------------------------------
( cd "$STAGE" && sha256sum globals.sql ./*.dump > SHA256SUMS )

ARCHIVE="crystal-forge-$DATE.tar"
tar -cf "$WORK/$ARCHIVE" -C "$WORK" "crystal-forge-$DATE"

# atomic publish into daily/
mv -f "$WORK/$ARCHIVE" "$BACKUP_ROOT/daily/$ARCHIVE"
DAILY_PATH="$BACKUP_ROOT/daily/$ARCHIVE"
log "wrote $DAILY_PATH ($(du -h "$DAILY_PATH" | cut -f1))"

# ---- 4. promote to weekly / monthly (hardlink, catch-up keyed) -----------
promote() {
  local tier="$1" key="$2" marker="$BACKUP_ROOT/$1/.last"
  if [ ! -f "$marker" ] || [ "$(cat "$marker")" != "$key" ]; then
    ln -f "$DAILY_PATH" "$BACKUP_ROOT/$tier/$ARCHIVE"
    printf '%s\n' "$key" > "$marker"
    log "promoted to $tier ($key)"
  fi
}
promote weekly  "$CUR_WEEK"
promote monthly "$CUR_MONTH"

# ---- 5. prune each tier independently ------------------------------------
prune() {
  local tier="$1" days="$2" n
  n="$(find "$BACKUP_ROOT/$tier" -maxdepth 1 -type f -name 'crystal-forge-*.tar' -mtime "+$days" -print -delete | wc -l)"
  [ "$n" -eq 0 ] || log "pruned $n archive(s) from $tier (older than ${days}d)"
}
prune daily   "$DAILY_KEEP_DAYS"
prune weekly  "$WEEKLY_KEEP_DAYS"
prune monthly "$MONTHLY_KEEP_DAYS"

log "backup complete"
