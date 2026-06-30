#!/usr/bin/env bash
#
# create-forge-systemd.sh — install/refresh the systemd unit that runs the
# Crystal Forge dashboard on a server (PILOT / PROD style host).
#
# ─────────────────────────────────────────────────────────────────────────────
# WHAT THIS SETS UP
# ─────────────────────────────────────────────────────────────────────────────
# The dashboard is served by a *custom Node server* (`server.ts`, run via tsx),
# NOT by stock `next start`. The custom server matters because it owns the HTTP
# `upgrade` handler that the rest of Next can't provide:
#
#   • `/_next/webpack-hmr`      → delegated to Next (the dashboard's own HMR)
#   • `/app/<slug>/_next/...`   → tunneled to the forge container's dev server
#                                 (lib/runtime/hmr-proxy.ts), gated by the same
#                                 session-auth + per-forge read-ACL as the HTTP
#                                 preview proxy.
#
# That tunnel is what lets a forge run in **dev mode** (`pnpm dev`, Turbopack
# Fast Refresh) behind the same-origin `/app/<slug>` proxy and still hydrate +
# hot-reload. Plain `next start` has no upgrade handler, so the forge HMR socket
# can't connect and a dev-mode forge renders but never hydrates. See
# docs/superpowers/specs/2026-06-04-forge-dev-hmr-proxy-design.md.
#
# The dashboard itself still runs as a PRODUCTION build (NODE_ENV=production):
# the custom server passes `dev:false` to Next, so it serves the prebuilt
# `.next`. Hence the build in ExecStartPre is mandatory — `next start`/the custom
# prod server never compile on their own, so without a fresh build a bare
# `systemctl restart` would re-serve a stale build.
#
# ─────────────────────────────────────────────────────────────────────────────
# WHAT ELSE IS NEEDED FOR FORGE HOT-RELOAD (not done by this script)
# ─────────────────────────────────────────────────────────────────────────────
#   1. Forge containers must run `pnpm dev` (set in lib/services/runtime.ts).
#      Existing forges only pick this up after a stop → start from the UI.
#   2. nginx in front of the dashboard must pass WebSocket upgrades through:
#         proxy_http_version 1.1;
#         proxy_set_header Upgrade $http_upgrade;
#         proxy_set_header Connection "upgrade";
#      (one-time, non-per-forge addition to the existing location block).
#
# ─────────────────────────────────────────────────────────────────────────────
# USAGE
# ─────────────────────────────────────────────────────────────────────────────
#   bash create-forge-systemd.sh          # install + reload + enable + restart
#   bash create-forge-systemd.sh --print  # print the generated unit, change nothing
#
# Privileged steps (writing the unit, daemon-reload, restart) use `sudo` and
# will prompt for a password. Run it as the user that OWNS the checkout and whose
# Node/nvm install should run the service (paths are resolved from that user's
# environment, then baked as absolute paths into the unit).
#
# Re-running is safe and idempotent: the previous unit is backed up to
# /etc/systemd/system/crystal-forge.service.bak-<timestamp> before overwrite.
#
# Roll back with:
#   sudo cp /etc/systemd/system/crystal-forge.service.bak-<ts> \
#           /etc/systemd/system/crystal-forge.service
#   sudo systemctl daemon-reload && sudo systemctl restart crystal-forge
#
set -euo pipefail

# Must run as the checkout owner, NOT via sudo. Running as root resolves root's
# Node (often an old system node) and bakes User=root into the unit. The script
# elevates only the few privileged steps with sudo itself.
if [[ "${EUID}" -eq 0 ]]; then
  echo "error: do not run this with sudo / as root." >&2
  echo "       Run it as the user that owns the checkout, e.g.:" >&2
  echo "           ./create-forge-systemd.sh" >&2
  echo "       It will call sudo itself for writing the unit and restarting." >&2
  exit 1
fi

SERVICE_NAME="crystal-forge.service"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}"
PORT="${PORT:-3030}"

# Repo root = the directory this script lives in (so it targets *this* checkout).
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Resolve the Node install of the *invoking* user (nvm isn't on systemd's PATH,
# so everything must be baked in as absolute paths).
NODE_PATH_BIN="$(command -v node || true)"
if [[ -z "${NODE_PATH_BIN}" ]]; then
  echo "error: 'node' not found on PATH. Run as the user whose Node should run the service." >&2
  exit 1
fi
NODE_BIN_DIR="$(dirname "$(readlink -f "${NODE_PATH_BIN}")")"
NODE="${NODE_BIN_DIR}/node"

# Next.js needs Node >= 20.9. Fail clearly now rather than during the build.
NODE_MAJOR="$("${NODE}" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if (( NODE_MAJOR < 20 )); then
  echo "error: ${NODE} is Node ${NODE_MAJOR}.x; Next.js requires >= 20.9." >&2
  echo "       Select a newer node (e.g. 'nvm use 24') and re-run as that user." >&2
  exit 1
fi

# tsx CLI (runs server.ts) and the Next CLI (production build), resolved through
# the repo's node_modules so the unit doesn't depend on PATH/corepack at runtime.
# Use the JS entry (cli.mjs) directly, NOT node_modules/.bin/tsx — that's a
# /bin/sh shim that `node` can't execute. Kept as the (pnpm-symlinked) repo path
# rather than its canonical .pnpm/tsx@<version>/ target so it survives a tsx
# patch bump without re-running this script; `node` follows the symlink fine.
TSX_CLI="${REPO_DIR}/node_modules/tsx/dist/cli.mjs"
NEXT_BIN="${REPO_DIR}/node_modules/next/dist/bin/next"
SERVER_ENTRY="${REPO_DIR}/server.ts"

for f in "${TSX_CLI}" "${NEXT_BIN}" "${SERVER_ENTRY}"; do
  if [[ -z "${f}" || ! -e "${f}" ]]; then
    echo "error: required file missing: '${f}'. Run 'pnpm install' in ${REPO_DIR} first." >&2
    exit 1
  fi
done

RUN_USER="$(id -un)"

# Generate the unit. NOTE the custom-server ExecStart (tsx server.ts) — this is
# the whole point: it's what makes the forge-HMR upgrade tunnel exist.
read -r -d '' UNIT <<EOF || true
# Managed by create-forge-systemd.sh — re-run that script to regenerate.
[Unit]
Description=Crystal Forge dashboard (custom server: HTTP + forge-HMR WS tunnel)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${REPO_DIR}
# Next loads .env.local from WorkingDirectory automatically.
Environment=NODE_ENV=production
Environment=PORT=${PORT}
Environment=PATH=${NODE_BIN_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# App listens on loopback only; nginx terminates TLS and proxies to it (incl.
# WebSocket upgrades for /app/<slug>/_next/webpack-hmr).
#
# Rebuild from source before every (re)start. The custom server runs Next with
# dev:false in production, which serves the prebuilt .next and never compiles on
# its own — so without this a bare restart would re-serve a stale build. Build is
# mandatory: if it fails the service won't start rather than serve stale output.
# The build can take 1-2 min, during which the service is down; raise the start
# timeout (default 90s) to cover it.
TimeoutStartSec=600
ExecStartPre=${NODE} ${NEXT_BIN} build
# Custom server (server.ts via tsx). Replaces \`next start\` so the dashboard owns
# the upgrade handler that tunnels forge dev-server HMR. \`pnpm start\` is the
# package.json equivalent; invoked directly here to avoid a pnpm/corepack layer.
ExecStart=${NODE} ${TSX_CLI} ${SERVER_ENTRY}
Restart=always
RestartSec=3
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF

if [[ "${1:-}" == "--print" ]]; then
  echo "# Would write to ${UNIT_PATH}:"
  echo "${UNIT}"
  exit 0
fi

echo ">> Installing ${SERVICE_NAME}"
echo "   repo:     ${REPO_DIR}"
echo "   user:     ${RUN_USER}"
echo "   node:     ${NODE}"
echo "   tsx:      ${TSX_CLI}"
echo "   port:     ${PORT}"
echo

# Back up an existing unit (never overwrite blindly).
if sudo test -f "${UNIT_PATH}"; then
  BACKUP="${UNIT_PATH}.bak-$(date +%Y%m%d-%H%M%S)"
  sudo cp "${UNIT_PATH}" "${BACKUP}"
  echo ">> Backed up existing unit to ${BACKUP}"
fi

# Write the new unit, reload, enable, restart.
printf '%s\n' "${UNIT}" | sudo tee "${UNIT_PATH}" >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1 || true
echo ">> Restarting ${SERVICE_NAME} (rebuilds first; may take 1-2 min)…"
sudo systemctl restart "${SERVICE_NAME}"

echo
sudo systemctl status "${SERVICE_NAME}" --no-pager | head -n 12 || true
echo
echo ">> Done. Tail logs with:  journalctl -u ${SERVICE_NAME} -f"
echo ">> Reminder: stop→start each forge from the UI so it boots in dev mode,"
echo ">>           and ensure nginx forwards WebSocket upgrade headers."
