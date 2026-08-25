#!/usr/bin/env bash
#
# install.sh — install/upgrade the Crystal Forge systemd units on this host.
#
# Components:
#   dashboard  crystal-forge.service — the Next dashboard, served by the custom
#              server.ts (see scripts/dashboard.sh for why not `next start`).
#              Brings the shared Postgres container up, rebuilds from the working
#              tree, then serves. Enabled, so it auto-starts on boot.
#   backup     crystal-forge-backup.{service,timer} — nightly 02:30 dump of every
#              forge DB + the dashboard DB with grandfather-father-son retention.
#              See scripts/pg-restore-runbook.md.
#
# Usage:
#   ./deploy/install.sh                  # install/upgrade BOTH, enable, restart
#   ./deploy/install.sh --dashboard      # dashboard only
#   ./deploy/install.sh --backup         # backup only
#   ./deploy/install.sh --backup --run-now   # ...and take a backup immediately
#   ./deploy/install.sh --print          # show what would be installed, change nothing
#
# Idempotent — safe to re-run to pick up updated scripts/units. Per-machine config
# in /etc/default/crystal-forge{,-backup} is written once and never clobbered.
#
# Run as the user that OWNS the checkout and whose Node/nvm install should run the
# dashboard — NOT under sudo. Running as root would resolve root's Node (often an
# old system one) and bake User=root into the unit. Privileged steps call sudo
# themselves. Existing units are backed up to <unit>.bak-<timestamp> first.
#
# Roll back with:
#   sudo cp /etc/systemd/system/crystal-forge.service.bak-<ts> \
#           /etc/systemd/system/crystal-forge.service
#   sudo systemctl daemon-reload && sudo systemctl restart crystal-forge
set -euo pipefail

if [ "${EUID}" -eq 0 ]; then
  echo "error: do not run this with sudo / as root." >&2
  echo "       Run it as the user that owns the checkout, e.g.:" >&2
  echo "           ./deploy/install.sh" >&2
  echo "       It calls sudo itself for the privileged steps." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="$(id -un)"

UNIT_DIR=/etc/systemd/system
SHARE_DIR=/usr/local/share/crystal-forge
BIN_DIR=/usr/local/bin

DO_DASHBOARD=0
DO_BACKUP=0
RUN_NOW=0
PRINT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dashboard) DO_DASHBOARD=1 ;;
    --backup)    DO_BACKUP=1 ;;
    --run-now)   RUN_NOW=1 ;;
    --print)     PRINT=1 ;;
    -h|--help)   sed -n '2,31p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
    *) echo "error: unknown argument '$1' (try --help)" >&2; exit 2 ;;
  esac
  shift
done
# No component flags = both.
if [ "$DO_DASHBOARD" -eq 0 ] && [ "$DO_BACKUP" -eq 0 ]; then
  DO_DASHBOARD=1
  DO_BACKUP=1
fi

# ── resolve the dashboard's per-machine values ────────────────────────────────
# Only needed for the dashboard, and only on FIRST install (the env file is never
# overwritten), but resolve early so a bad Node fails before anything is written.
if [ "$DO_DASHBOARD" -eq 1 ]; then
  NODE_PATH_BIN="$(command -v node || true)"
  if [ -z "$NODE_PATH_BIN" ]; then
    echo "error: 'node' not found on PATH. Run as the user whose Node should run the service." >&2
    exit 1
  fi
  NODE_BIN_DIR="$(dirname "$(readlink -f "$NODE_PATH_BIN")")"
  NODE_MAJOR="$("$NODE_BIN_DIR/node" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$NODE_MAJOR" -lt 20 ]; then
    echo "error: $NODE_BIN_DIR/node is Node ${NODE_MAJOR}.x; Next.js requires >= 20.9." >&2
    echo "       Select a newer node (e.g. 'nvm use 24') and re-run as that user." >&2
    exit 1
  fi
  for f in node_modules/next/dist/bin/next node_modules/tsx/dist/cli.mjs server.ts; do
    if [ ! -e "$REPO_ROOT/$f" ]; then
      echo "error: required file missing: $REPO_ROOT/$f. Run 'pnpm install' first." >&2
      exit 1
    fi
  done
fi

if [ "$PRINT" -eq 1 ]; then
  echo "# Would install as user: $RUN_USER"
  echo "# From checkout:         $REPO_ROOT"
  [ "$DO_DASHBOARD" -eq 1 ] && {
    echo "# Node bin dir:          $NODE_BIN_DIR"
    echo
    echo "# ---- $UNIT_DIR/crystal-forge.service ----"
    cat "$REPO_ROOT/deploy/systemd/crystal-forge.service"
    echo "# ---- $UNIT_DIR/crystal-forge.service.d/10-local.conf ----"
    printf '[Service]\nUser=%s\n' "$RUN_USER"
  }
  [ "$DO_BACKUP" -eq 1 ] && {
    echo "# ---- $UNIT_DIR/crystal-forge-backup.service ----"
    cat "$REPO_ROOT/deploy/systemd/crystal-forge-backup.service"
    echo "# ---- $UNIT_DIR/crystal-forge-backup.timer ----"
    cat "$REPO_ROOT/deploy/systemd/crystal-forge-backup.timer"
  }
  exit 0
fi

# Back up an existing unit before overwriting it (never overwrite blindly).
backup_unit() {
  local unit="$1"
  if sudo test -f "$UNIT_DIR/$unit"; then
    local dst="$UNIT_DIR/$unit.bak-$(date +%Y%m%d-%H%M%S)"
    sudo cp "$UNIT_DIR/$unit" "$dst"
    echo "  backed up existing $unit -> $dst"
  fi
}

echo ">> Installing Crystal Forge units from $REPO_ROOT"
echo "   user: $RUN_USER"
echo

# ── shared: the postgres guard, used as ExecStartPre by both units ────────────
sudo install -D -m 0755 "$REPO_ROOT/scripts/ensure-postgres.sh" "$BIN_DIR/crystal-forge-ensure-postgres"
echo "  -> $BIN_DIR/crystal-forge-ensure-postgres"

# ── dashboard ─────────────────────────────────────────────────────────────────
if [ "$DO_DASHBOARD" -eq 1 ]; then
  echo ">> dashboard"
  sudo install -D -m 0755 "$REPO_ROOT/scripts/dashboard.sh" "$BIN_DIR/crystal-forge-dashboard"
  sudo install -D -m 0644 "$REPO_ROOT/docs/DEPLOY.md" "$SHARE_DIR/DEPLOY.md"
  echo "  -> $BIN_DIR/crystal-forge-dashboard"
  echo "  -> $SHARE_DIR/DEPLOY.md"

  ENV_DST=/etc/default/crystal-forge
  if sudo test -f "$ENV_DST"; then
    echo "  -> $ENV_DST (kept existing config)"
  else
    # Seed from the example with this host's real paths substituted in.
    sudo install -D -m 0644 "$REPO_ROOT/deploy/crystal-forge.env.example" "$ENV_DST"
    sudo sed -i \
      -e "s|^REPO_DIR=.*|REPO_DIR=$REPO_ROOT|" \
      -e "s|^NODE_BIN_DIR=.*|NODE_BIN_DIR=$NODE_BIN_DIR|" \
      "$ENV_DST"
    echo "  -> $ENV_DST (new — REPO_DIR=$REPO_ROOT, NODE_BIN_DIR=$NODE_BIN_DIR)"
  fi

  backup_unit crystal-forge.service
  sudo install -m 0644 "$REPO_ROOT/deploy/systemd/crystal-forge.service" "$UNIT_DIR/"
  echo "  -> $UNIT_DIR/crystal-forge.service"

  # Per-forge env files (prod mode). Each <slug>.env here is bind-mounted
  # read-only at /app/.env inside that forge's container, so prod secrets live
  # on this host only — never in the image, the registry, or the dashboard DB.
  # 0700 on the directory is what keeps the keys private on this host; the files
  # inside must be 0644, since a bind-mounted root-owned 0600 file is unreadable
  # by an image that runs as a non-root USER. Created empty; admins add files.
  FORGE_ENV_DIR=/etc/crystal-forge/forge-env
  # shellcheck disable=SC1090
  [ -r "$ENV_DST" ] && . "$ENV_DST"
  sudo mkdir -p "$FORGE_ENV_DIR"
  sudo chmod 0700 "$FORGE_ENV_DIR"
  echo "  -> $FORGE_ENV_DIR (per-forge env files)"

  # User= can't come from an EnvironmentFile, so it goes in a drop-in generated
  # from whoever ran this. Everything else stays in the static unit + env file.
  printf '# Generated by deploy/install.sh — host-specific overrides.\n[Service]\nUser=%s\n' "$RUN_USER" \
    | sudo install -D -m 0644 /dev/stdin "$UNIT_DIR/crystal-forge.service.d/10-local.conf"
  echo "  -> $UNIT_DIR/crystal-forge.service.d/10-local.conf (User=$RUN_USER)"
fi

# ── backup ────────────────────────────────────────────────────────────────────
if [ "$DO_BACKUP" -eq 1 ]; then
  echo ">> backup"
  sudo install -D -m 0755 "$REPO_ROOT/scripts/pg-backup.sh" "$BIN_DIR/crystal-forge-pg-backup"
  sudo install -D -m 0644 "$REPO_ROOT/scripts/pg-restore-runbook.md" "$SHARE_DIR/pg-restore-runbook.md"
  echo "  -> $BIN_DIR/crystal-forge-pg-backup"
  echo "  -> $SHARE_DIR/pg-restore-runbook.md"

  ENV_DST=/etc/default/crystal-forge-backup
  if sudo test -f "$ENV_DST"; then
    echo "  -> $ENV_DST (kept existing config)"
  else
    sudo install -D -m 0644 "$REPO_ROOT/deploy/crystal-forge-backup.env.example" "$ENV_DST"
    echo "  -> $ENV_DST (new — edit to override container/paths/retention)"
  fi

  backup_unit crystal-forge-backup.service
  backup_unit crystal-forge-backup.timer
  sudo install -m 0644 "$REPO_ROOT/deploy/systemd/crystal-forge-backup.service" "$UNIT_DIR/"
  sudo install -m 0644 "$REPO_ROOT/deploy/systemd/crystal-forge-backup.timer" "$UNIT_DIR/"
  echo "  -> $UNIT_DIR/crystal-forge-backup.{service,timer}"

  # Resolve BACKUP_ROOT from config (if overridden there) so we create the right dir.
  BACKUP_ROOT=/var/backups/crystal-forge
  # shellcheck disable=SC1090
  [ -r "$ENV_DST" ] && . "$ENV_DST"
  sudo mkdir -p "$BACKUP_ROOT"
  echo "  -> $BACKUP_ROOT (backup destination)"
fi

# ── activate ──────────────────────────────────────────────────────────────────
echo
sudo systemctl daemon-reload

if [ "$DO_BACKUP" -eq 1 ]; then
  sudo systemctl enable --now crystal-forge-backup.timer
  echo ">> crystal-forge-backup.timer enabled"
fi

if [ "$DO_DASHBOARD" -eq 1 ]; then
  sudo systemctl enable crystal-forge.service >/dev/null 2>&1 || true
  echo ">> Restarting crystal-forge.service (rebuilds first; may take 1-2 min)…"
  sudo systemctl restart crystal-forge.service
fi

if [ "$RUN_NOW" -eq 1 ] && [ "$DO_BACKUP" -eq 1 ]; then
  echo ">> Taking an initial backup now…"
  sudo systemctl start crystal-forge-backup.service
  sudo ls -1 "$BACKUP_ROOT"/daily/*.tar 2>/dev/null | tail -1 || true
fi

echo
[ "$DO_DASHBOARD" -eq 1 ] && sudo systemctl status crystal-forge.service --no-pager | head -n 12 || true
echo
[ "$DO_BACKUP" -eq 1 ] && { echo ">> Timer schedule:"; systemctl list-timers crystal-forge-backup.timer --no-pager || true; }
echo
echo ">> Done. Logs:  journalctl -u crystal-forge.service -f"
if [ "$DO_DASHBOARD" -eq 1 ]; then
  echo ">> Reminder: stop→start each forge from the UI so it boots in dev mode,"
  echo ">>           and ensure nginx forwards WebSocket upgrade headers."
fi
