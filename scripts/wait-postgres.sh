#!/bin/bash
# Wait until the Postgres TCP server inside a container accepts queries.
#
# pg_isready -U postgres probes the unix socket, so it succeeds against the
# init-phase temporary server and reports ready before the final TCP server
# exists (v0.4.0 CI failure). Probe TCP from inside the container instead;
# container logs are dumped only on failure.
#
# Usage: wait-postgres.sh <container-name>
container="${1:?usage: wait-postgres.sh <container-name>}"
for _ in $(seq 1 60); do
  # Command tested inside if: no premature exit on not-ready-yet.
  if docker exec "$container" psql -h 127.0.0.1 -U postgres \
    -d postgres -tAc 'select 1' >/dev/null 2>&1; then
    exit 0
  fi
  sleep 1
done
echo "$container not ready after 60 attempts; container logs:" >&2
docker logs "$container"
exit 1
