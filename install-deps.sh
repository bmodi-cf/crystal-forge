#!/bin/bash
# Installs and configures Docker CE + nginx on a fresh Ubuntu (noble/24.04) box,
# matching the setup on this production host.
set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo"
fi

echo "==> Updating apt and installing prerequisites"
$SUDO apt-get update -qq
$SUDO apt-get install -y ca-certificates curl

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

echo "==> Versions installed"
docker --version
docker compose version
nginx -v

echo "==> Done. nginx site config and TLS certs are not managed by this script —"
echo "    copy/restore /etc/nginx/sites-available/crystal-forge (and registry, if used) and certs separately."
