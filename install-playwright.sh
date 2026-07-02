#!/usr/bin/env bash
#
# install-playwright.sh — install the Chromium build + OS libraries Playwright
# needs to drive a headless browser locally (used for forge HMR / React
# hydration debugging via the repro scripts).
#
# Browser binaries install into the INVOKING user's ~/.cache/ms-playwright (the
# deps step uses sudo for apt, the download step does NOT — so browsers don't
# land in root's home). Pins to the repo's local Playwright version. Re-runnable.
#
#   ./install-playwright.sh
#
set -euo pipefail

cd "$(dirname "$0")"
REPO="$(pwd)"
PW="$REPO/node_modules/.bin/playwright"

if [ ! -x "$PW" ]; then
  echo "error: $PW not found — run 'pnpm install' in the repo first." >&2
  exit 1
fi

echo "==> Playwright $("$PW" --version)"

echo "==> [1/2] Installing OS dependencies for Chromium (apt, needs sudo)…"
sudo "$PW" install-deps chromium

echo "==> [2/2] Downloading Chromium browser build as '$USER' (→ ~/.cache/ms-playwright)…"
"$PW" install chromium

echo "==> Verifying headless launch…"
node -e "const{chromium}=require('@playwright/test');chromium.launch({headless:true}).then(b=>b.close()).then(()=>console.log('OK: chromium launches headless')).catch(e=>{console.error('FAILED:',e.message);process.exit(1);});"

echo "==> Done. Browsers in: ${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
