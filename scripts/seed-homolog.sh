#!/usr/bin/env bash
#
# Gives the homolog production's people: replaces its database and profile
# pictures with a consistent copy of production's. Run it from the workstation:
#
#   ./scripts/seed-homolog.sh
#
# Uses ZOIA_HOST, ZOIA_HOMOLOG_HOST and ZOIA_PATH, as deploy.sh does. Re-run it
# whenever the homolog should catch up; whatever changed on the homolog since
# is lost. See docs/adr/0035-homolog-environment.md.
#
# The copy streams from one VM to the other through this machine and is never
# written here. Channels are not copied: production's channel ids name
# production's LiveKit rooms, which the homolog shares.

set -euo pipefail

PROD="${ZOIA_HOST:?set ZOIA_HOST, e.g. zoia@<your-server-ip>}"
HOMOLOG="${ZOIA_HOMOLOG_HOST:?set ZOIA_HOMOLOG_HOST, e.g. zoia@<homolog-vm-ip>}"
DEST="${ZOIA_PATH:-/opt/zoia}"
SEED="server/data/homolog-seed.db"

# The backup holds every password hash and email. Never leave it behind.
cleanup() { ssh "$PROD" "rm -f ${DEST}/${SEED}" || true; }
trap cleanup EXIT

echo "==> backing up production's database"
ssh "$PROD" "cd ${DEST} && docker compose exec -T app node server/bin/keytool.js db:backup ${SEED} >/dev/null"

echo "==> stopping the homolog app"
ssh "$HOMOLOG" "cd ${DEST} && docker compose -f docker-compose.homolog.yml stop app"

echo "==> copying the database and profile pictures"
# The old WAL and shared-memory files belong to the old database; left beside
# the new one, SQLite would replay them into it.
ssh "$PROD" "cat ${DEST}/${SEED}" \
  | ssh "$HOMOLOG" "cd ${DEST}/server/data && umask 077 && cat > zoia.db.new \
      && rm -f zoia.db zoia.db-wal zoia.db-shm && mv zoia.db.new zoia.db"
ssh "$PROD" "tar -C ${DEST}/server/data -cf - avatars" \
  | ssh "$HOMOLOG" "cd ${DEST}/server/data && rm -rf avatars && tar -xf -"

echo "==> starting the homolog app"
ssh "$HOMOLOG" "cd ${DEST} && docker compose -f docker-compose.homolog.yml start app \
  && curl -fsS --retry 20 --retry-delay 2 --retry-all-errors http://127.0.0.1:3000/healthz \
  && echo && echo '==> seeded'"
