#!/usr/bin/env bash
#
# Deploy to the Proxmox VM.
#
#   ./deploy.sh              deploy to $ZOIA_HOST
#   ./deploy.sh --homolog    deploy to the homolog VM, $ZOIA_HOMOLOG_HOST
#   ./deploy.sh --dry-run    show what would change, transfer nothing
#
# Configure the targets with ZOIA_HOST / ZOIA_HOMOLOG_HOST (user@host) and
# ZOIA_PATH. The homolog runs only the app, from docker-compose.homolog.yml;
# see docs/adr/0035-homolog-environment.md.

set -euo pipefail

DRY_RUN=""
HOMOLOG=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN="--dry-run" ;;
    --homolog) HOMOLOG=1 ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

if [[ -n "$HOMOLOG" ]]; then
  HOST="${ZOIA_HOMOLOG_HOST:?set ZOIA_HOMOLOG_HOST, e.g. zoia@<homolog-vm-ip>}"
  COMPOSE="docker compose -f docker-compose.homolog.yml"
else
  HOST="${ZOIA_HOST:?set ZOIA_HOST, e.g. zoia@<your-server-ip>}"
  COMPOSE="docker compose"
fi
DEST="${ZOIA_PATH:-/opt/zoia}"

[[ -n "$DRY_RUN" ]] && echo "dry run — nothing will be transferred"

cd "$(dirname "$0")"

# Fail before touching the server, not halfway through.
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  echo "warning: working tree has uncommitted changes" >&2
fi

echo "==> deploying to ${HOST}:${DEST}"

# The excludes are load-bearing:
#   .env          secrets live only on the server
#   server/data   the database (zoia.db: every account and device) and the
#                 pictures. --delete without this exclude would wipe it and
#                 lock out every user, including you.
#   desktop       the server never runs the desktop app, and the directory
#                 holds a gitignored .pairing-token (a live credential) plus
#                 ~400MB of built exes and a vendored ffmpeg once anyone has
#                 made a build. rsync reads the working tree, not git, so
#                 .gitignore does not protect any of it.
#   caddy/sites   sites that exist on that server only, such as the route
#                 to the homolog VM. --delete would remove them.
rsync -az --delete $DRY_RUN \
  --exclude '.git' \
  --exclude 'desktop' \
  --exclude 'node_modules' \
  --exclude '.env' \
  --exclude 'server/data' \
  --exclude 'caddy/sites' \
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
# the key store, so minting fails with EACCES. caddy/sites likewise, or adding
# a site to it needs sudo.
mkdir -p server/data caddy/sites

# --remove-orphans stops containers for services that no longer exist in the
# compose file. Without it the LiveKit ingress, replaced by the SFU's own
# WHIP endpoint, would have kept running after it was removed from here.
${COMPOSE} up -d --build --remove-orphans
${COMPOSE} ps
REMOTE

echo "==> waiting for the app to report healthy"
if [[ -n "$HOMOLOG" ]]; then
  # The homolog VM has no caddy: its app is published on :3000, and the
  # production caddy is what puts TLS in front of it.
  ssh "$HOST" "curl -fsS --retry 20 --retry-delay 2 --retry-all-errors \
    http://127.0.0.1:3000/healthz" \
    && echo "" && echo "==> deployed"
  exit 0
fi
# Through caddy, not :3000 — the app publishes no host port, and this also
# exercises TLS and the proxy route, which is the path that serves users.
ssh "$HOST" "set -a; . ${DEST}/.env; set +a; \
  curl -fsS --retry 20 --retry-delay 2 --retry-all-errors \
    --resolve \"\$PUBLIC_HOST:443:127.0.0.1\" \
    \"https://\$PUBLIC_HOST/healthz\"" \
  && echo "" && echo "==> deployed"
