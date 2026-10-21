#!/usr/bin/env sh
# Starts a single-node ScyllaDB on 127.0.0.1:9042 for the message store's
# tests (ADR 0035), and waits until it answers CQL. CI only.
set -eu

docker run -d --name scylla -p 9042:9042 scylladb/scylla:2025.1 \
  --smp 1 --memory 750M --overprovisioned 1 --developer-mode 1

for _ in $(seq 1 60); do
  if docker exec scylla cqlsh -e 'SELECT now() FROM system.local' >/dev/null 2>&1; then
    exit 0
  fi
  sleep 5
done

docker logs scylla | tail -50
echo 'ScyllaDB did not come up in five minutes' >&2
exit 1
