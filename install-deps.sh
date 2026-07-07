#!/bin/bash
# Installs and configures Docker CE + nginx on a fresh Ubuntu (noble/24.04) box,
# matching the setup on this production host, then installs the repo's Node deps
# (which compiles node-pty from source — see build-essential note below).
#
# Node + pnpm must already be present (installed per-user via fnm/corepack); this
# script does NOT install them. Run it as the checkout owner, NOT via sudo — it
# elevates apt steps with sudo itself. Running the whole thing as root would
# compile node deps as root (bad ownership), so it refuses to run as root.
set -euo pipefail
cd "$(dirname "$0")"

# Refuse to run as root. The apt/docker/nginx steps are elevated with sudo
# below; the pnpm step must run as the checkout owner. Mirrors the root guard in
# create-forge-systemd.sh and install-gh-runner.sh.
if [ "$(id -u)" -eq 0 ]; then
  echo "error: do not run this with sudo / as root." >&2
  echo "       Run it as the user that owns the checkout, e.g.:" >&2
  echo "           ./install-deps.sh" >&2
  echo "       It calls sudo itself for the apt / docker / nginx steps." >&2
  exit 1
fi
SUDO="sudo"

echo "==> Updating apt and installing prerequisites"
# build-essential is required on Linux: node-pty ships prebuilt binaries only for
# macOS/Windows, so on Ubuntu it must compile from source at 'pnpm install' time
# (needs gcc/g++/make). The macOS dev machine never hits this.
$SUDO apt-get update -qq
$SUDO apt-get install -y ca-certificates curl build-essential

echo "==> Adding Docker's official apt repository"
$SUDO install -m 0755 -d /etc/apt/keyrings
$SUDO curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
$SUDO chmod a+r /etc/apt/keyrings/docker.asc

ARCH="$(dpkg --print-architecture)"
CODENAME="$(. /etc/os-release && echo "$VERSION_CODENAME")"
echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${CODENAME} stable" \
  | $SUDO tee /etc/apt/sources.list.d/docker.list > /dev/null

echo "==> Installing Docker CE"
$SUDO apt-get update -qq
$SUDO apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

echo "==> Enabling Docker and adding $USER to the docker group"
$SUDO systemctl enable --now docker
if ! groups "$USER" | grep -qw docker; then
  $SUDO usermod -aG docker "$USER"
  echo "    Added $USER to the docker group — log out/in (or run 'newgrp docker') for it to take effect."
fi

echo "==> Installing nginx (Ubuntu distro package)"
$SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y nginx
$SUDO systemctl enable --now nginx

echo "==> Configuring ufw (80/tcp, 443/tcp, 22/tcp)"
if command -v ufw > /dev/null; then
  $SUDO ufw allow 22/tcp || true
  $SUDO ufw allow 80/tcp comment 'HTTP->HTTPS redirect' || true
  $SUDO ufw allow 443/tcp comment 'Crystal Forge HTTPS' || true
  $SUDO ufw status
else
  echo "    ufw not found — skipping firewall rules"
fi

echo "==> Installing project Node dependencies (compiles node-pty from source)"
if ! command -v pnpm > /dev/null; then
  echo "    Skipping 'pnpm install' — pnpm not found on PATH."
  echo "    Install Node + pnpm (fnm/corepack) for this user, then run 'pnpm install'."
else
  # Wipe node_modules for a reproducible, clean build. No-op on a fresh box
  # (dir doesn't exist); on a re-run it forces node-pty to recompile instead of
  # pnpm reporting "Already up to date" and skipping the native build. Cheap:
  # pnpm re-links from its global store, so this does not re-download packages.
  # Paired with the install (never wipe without reinstalling) and only ever
  # targets the repo-local dir (script cd's to its own dir at the top).
  rm -rf node_modules
  pnpm install
fi

echo "==> Versions installed"
docker --version
docker compose version
nginx -v

echo "==> Done. nginx site config and TLS certs are not managed by this script —"
echo "    copy/restore /etc/nginx/sites-available/crystal-forge (and registry, if used) and certs separately."
