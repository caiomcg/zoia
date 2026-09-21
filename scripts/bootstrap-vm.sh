#!/usr/bin/env bash
#
# Prepares a fresh Debian 12 VM to run Zoia. Run it ON the VM:
#
#   ssh zoia@192.168.31.60 'bash -s' < scripts/bootstrap-vm.sh
#
# Idempotent — safe to re-run.

set -euo pipefail

DEST="${ZOIA_PATH:-/opt/zoia}"

# On a freshly provisioned VM, cloud-init is often still running its own apt
# work, and it holds the dpkg lock. Without this wait the script dies on
# "Could not get lock /var/lib/apt/lists/lock" the first time it is run.
echo "==> waiting for cloud-init to finish"
if command -v cloud-init >/dev/null; then
  sudo cloud-init status --wait >/dev/null 2>&1 || true
fi

echo "==> waiting for the apt lock"
for _ in $(seq 1 60); do
  if ! sudo fuser /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock >/dev/null 2>&1; then
    break
  fi
  sleep 5
done

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
sudo mkdir -p "$DEST/server/data"
sudo chown -R "$USER:$USER" "$DEST"

echo
echo "==> done"
docker --version
docker compose version
echo
echo "Log out and back in for docker group membership to take effect."
echo "Next: run scripts/gen-env.sh, then ./deploy.sh from your workstation."
