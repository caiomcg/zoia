#!/usr/bin/env bash
#
# Deploy to the Proxmox VM.
#
#   ./deploy.sh              deploy to $ZOIA_HOST
#   ./deploy.sh --dry-run    show what would change, transfer nothing
#
# Configure the target with ZOIA_HOST (user@host) and ZOIA_PATH.

set -euo pipefail

HOST="${ZOIA_HOST:-zoia@192.168.31.60}"
DEST="${ZOIA_PATH:-/opt/zoia}"

DRY_RUN=""
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN="--dry-run"
  echo "dry run — nothing will be transferred"
fi

cd "$(dirname "$0")"

# Fail before touching the server, not halfway through.
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  echo "warning: working tree has uncommitted changes" >&2
fi

echo "==> deploying to ${HOST}:${DEST}"

# The excludes are load-bearing:
#   .env          secrets live only on the server
#   server/data   the invite-key store. --delete without this exclude would
#                 wipe it and lock out every user, including you.
rsync -az --delete $DRY_RUN \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.env' \
  --exclude 'server/data' \
  --exclude 'server/public/vendor' \
  --exclude 'coverage' \
  --itemize-changes \
  ./ "${HOST}:${DEST}/"

if [[ -n "$DRY_RUN" ]]; then
  echo "==> dry run complete"
  exit 0
fi

echo "==> rebuilding and restarting"
ssh "$HOST" bash -seu <<REMOTE
cd "${DEST}"

if [[ ! -f .env ]]; then
  echo "error: ${DEST}/.env is missing. Copy .env.example and fill it in." >&2
  exit 1
fi

# Create the key-store mount point as this user. If docker creates it first it
# is owned by root, and the container — which runs unprivileged — cannot write
# the key store, so minting fails with EACCES.
mkdir -p server/data

docker compose up -d --build
docker compose ps
REMOTE

echo "==> waiting for the app to report healthy"
# Through caddy, not :3000 — the app publishes no host port, and this also
# exercises TLS and the proxy route, which is the path that serves users.
ssh "$HOST" "set -a; . ${DEST}/.env; set +a; \
  curl -fsS --retry 20 --retry-delay 2 --retry-connrefused \
    --resolve \"\$PUBLIC_HOST:443:127.0.0.1\" \
    \"https://\$PUBLIC_HOST/healthz\"" \
  && echo "" && echo "==> deployed"
