#!/usr/bin/env bash
# Build / serve the Crystal Forge dashboard for crystal-forge.service.
#
# Installed as /usr/local/bin/crystal-forge-dashboard. Exists because systemd
# cannot interpolate EnvironmentFile values into `ExecStart=` paths (or into
# `User=`/`WorkingDirectory=`), so the per-machine Node and repo paths have to be
# resolved by something that runs *after* the env file is loaded. That keeps
# deploy/systemd/crystal-forge.service a static, checked-in file.
#
# Usage:  crystal-forge-dashboard build   # production build (ExecStartPre)
#         crystal-forge-dashboard serve   # run the custom server (ExecStart)
#
# Config comes from /etc/default/crystal-forge (see deploy/crystal-forge.env.example).
#
# ── Why a custom server rather than `next start` ────────────────────────────────
# `serve` runs server.ts via tsx — the `pnpm start` equivalent — NOT stock
# `next start`. The custom server owns the HTTP `upgrade` handler that the rest of
# Next can't provide:
#   • /_next/webpack-hmr     → delegated to Next (the dashboard's own HMR)
#   • /app/<slug>/_next/...  → tunneled to the forge container's dev server
#                              (lib/runtime/hmr-proxy.ts), gated by the same
#                              session-auth + per-forge read-ACL as the HTTP
#                              preview proxy.
# That tunnel is what lets a forge run in dev mode (`pnpm dev`, Turbopack Fast
# Refresh) behind the same-origin /app/<slug> proxy and still hydrate + hot-reload.
# `next start` has no upgrade handler, so a dev-mode forge renders but never
# hydrates. See docs/superpowers/specs/2026-06-04-forge-dev-hmr-proxy-design.md.
#
# ── Why `build` is mandatory on every start ─────────────────────────────────────
# The custom server passes dev:false to Next, so it serves the prebuilt .next and
# never compiles on its own. Without a build step a bare `systemctl restart`
# re-serves whatever was last built. See docs/DEPLOY.md "Rebuild on restart".
set -euo pipefail

CONFIG=/etc/default/crystal-forge

CMD="${1:-}"
if [ "$CMD" != build ] && [ "$CMD" != serve ]; then
  echo "usage: $(basename "$0") {build|serve}" >&2
  exit 2
fi

# shellcheck disable=SC1090
[ -r "$CONFIG" ] && . "$CONFIG"

if [ -z "${REPO_DIR:-}" ] || [ ! -d "$REPO_DIR" ]; then
  echo "error: REPO_DIR is unset or not a directory (set it in $CONFIG)" >&2
  exit 1
fi

# nvm installs aren't on systemd's PATH, so the Node bin dir has to be prepended
# explicitly. Everything below invokes $NODE by absolute path anyway; this is for
# child processes (next build shelling out, pnpm, etc.).
if [ -n "${NODE_BIN_DIR:-}" ]; then
  export PATH="$NODE_BIN_DIR:$PATH"
  NODE="$NODE_BIN_DIR/node"
else
  NODE="$(command -v node || true)"
fi

if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "error: node not found (set NODE_BIN_DIR in $CONFIG)" >&2
  exit 1
fi

# Next.js needs Node >= 20.9. Fail clearly here rather than mid-build.
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "error: $NODE is Node ${NODE_MAJOR}.x; Next.js requires >= 20.9." >&2
  exit 1
fi

export NODE_ENV="${NODE_ENV:-production}"
export PORT="${PORT:-3030}"

# cd rather than relying on WorkingDirectory= (which systemd also can't take from
# an env file). Next resolves .env.local and .next relative to cwd.
cd "$REPO_DIR"

NEXT_BIN="$REPO_DIR/node_modules/next/dist/bin/next"
# Use tsx's JS entry (cli.mjs) directly, NOT node_modules/.bin/tsx — that's a
# /bin/sh shim `node` can't execute. Kept as the pnpm-symlinked repo path rather
# than its canonical .pnpm/tsx@<version>/ target so it survives a tsx patch bump.
TSX_CLI="$REPO_DIR/node_modules/tsx/dist/cli.mjs"
SERVER_ENTRY="$REPO_DIR/server.ts"

case "$CMD" in
  build)
    [ -e "$NEXT_BIN" ] || { echo "error: missing $NEXT_BIN — run 'pnpm install'" >&2; exit 1; }
    exec "$NODE" "$NEXT_BIN" build
    ;;
  serve)
    for f in "$TSX_CLI" "$SERVER_ENTRY"; do
      [ -e "$f" ] || { echo "error: missing $f — run 'pnpm install'" >&2; exit 1; }
    done
    exec "$NODE" "$TSX_CLI" "$SERVER_ENTRY"
    ;;
esac
