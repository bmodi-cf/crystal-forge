#!/usr/bin/env bash
#
# Install (or upgrade) the Crystal Forge Postgres backup on this host:
# a nightly systemd timer that dumps every forge database plus the dashboard DB
# with grandfather-father-son retention. See scripts/pg-restore-runbook.md.
#
# Idempotent — safe to re-run to pick up an updated script/units. Per-machine
# config in /etc/default/crystal-forge-backup is written once and never clobbered.
#
# Usage:
#   sudo deploy/install-backup.sh            # install/upgrade + enable timer
#   sudo deploy/install-backup.sh --run-now  # ...and take a backup immediately
#
# Prerequisite: the shared Postgres container (default: crystal-forge-pg) is
# running. Override its name and other settings in /etc/default/crystal-forge-backup.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BIN_DST=/usr/local/bin/crystal-forge-pg-backup
DOC_DST=/usr/local/share/crystal-forge/pg-restore-runbook.md
ENV_DST=/etc/default/crystal-forge-backup
UNIT_DIR=/etc/systemd/system

RUN_NOW=0
[ "${1:-}" = "--run-now" ] && RUN_NOW=1

# Need root to write /usr/local, /etc, and enable the unit.
if [ "$(id -u)" -ne 0 ]; then
  echo "Root required; re-running under sudo..." >&2
  exec sudo -E bash "$0" "$@"
fi

echo "Installing Crystal Forge backup from: $REPO_ROOT"

install -D -m 0755 "$REPO_ROOT/scripts/pg-backup.sh"          "$BIN_DST"
install -D -m 0644 "$REPO_ROOT/scripts/pg-restore-runbook.md" "$DOC_DST"
install -m 0644 "$REPO_ROOT/deploy/systemd/crystal-forge-backup.service" "$UNIT_DIR/"
install -m 0644 "$REPO_ROOT/deploy/systemd/crystal-forge-backup.timer"   "$UNIT_DIR/"
echo "  -> $BIN_DST"
echo "  -> $DOC_DST"
echo "  -> $UNIT_DIR/crystal-forge-backup.{service,timer}"

if [ ! -f "$ENV_DST" ]; then
  install -D -m 0644 "$REPO_ROOT/deploy/crystal-forge-backup.env.example" "$ENV_DST"
  echo "  -> $ENV_DST (new — edit to override container/paths/retention)"
else
  echo "  -> $ENV_DST (kept existing config)"
fi

# Resolve BACKUP_ROOT from config (if set there) so we create the right dir.
BACKUP_ROOT=/var/backups/crystal-forge
# shellcheck disable=SC1090
[ -f "$ENV_DST" ] && . "$ENV_DST"
mkdir -p "$BACKUP_ROOT"
echo "  -> $BACKUP_ROOT (backup destination)"

systemctl daemon-reload
systemctl enable --now crystal-forge-backup.timer

if [ "$RUN_NOW" -eq 1 ]; then
  echo "Taking an initial backup now..."
  systemctl start crystal-forge-backup.service
  echo "Latest archives:"
  ls -1 "$BACKUP_ROOT"/daily/*.tar 2>/dev/null | tail -1 || true
fi

echo
echo "Done. Timer schedule:"
systemctl list-timers crystal-forge-backup.timer --no-pager || true
