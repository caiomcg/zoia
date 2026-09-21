#!/usr/bin/env bash
#
# Prepares a fresh Debian 12 VM to run Zoia. Run it ON the VM:
#
#   ssh zoia@192.168.31.50 'bash -s' < scripts/bootstrap-vm.sh
#
# Idempotent — safe to re-run.

set -euo pipefail

DEST="${ZOIA_PATH:-/opt/zoia}"

echo "==> updating packages"
sudo apt-get update -qq
sudo apt-get install -y -qq ca-certificates curl gnupg qemu-guest-agent rsync dnsutils

echo "==> installing docker"
if ! command -v docker >/dev/null; then
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg \
    | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  echo "    already installed: $(docker --version)"
fi

echo "==> enabling services"
sudo systemctl enable --now docker qemu-guest-agent

echo "==> adding $USER to the docker group"
sudo usermod -aG docker "$USER"

echo "==> creating $DEST"
sudo mkdir -p "$DEST"
sudo chown "$USER:$USER" "$DEST"

echo
echo "==> done"
docker --version
docker compose version
echo
echo "Log out and back in for docker group membership to take effect."
echo "Next: run scripts/gen-env.sh, then ./deploy.sh from your workstation."
