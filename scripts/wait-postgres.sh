#!/bin/bash
# Wait until the Postgres TCP server inside a container accepts queries.
#
# pg_isready -U postgres probes the unix socket, so it succeeds against the
# init-phase temporary server and reports ready before the final TCP server
# exists (v0.4.0 CI failure). Probe TCP from inside the container instead;
# container logs are dumped only on failure.
#
# Usage: wait-postgres.sh <container-name>
#
# A single successful probe is not enough: the TCP server can accept one
# query and still flap (CI run 37590822468 saw a mid-suite connection
# close ~38s after the job's Postgres was declared ready). Require three
# consecutive probes 1s apart so readiness means the server is stable.
container="${1:?usage: wait-postgres.sh <container-name>}"
consecutive=0
for _ in $(seq 1 60); do
  # Command tested inside if: no premature exit on not-ready-yet.
  if docker exec "$container" psql -h 127.0.0.1 -U postgres \
    -d postgres -tAc 'select 1' >/dev/null 2>&1; then
    consecutive=$((consecutive + 1))
    # 3 stable probes * 1s fit well inside the 60-attempt budget.
    if [ "$consecutive" -ge 3 ]; then
      exit 0
    fi
  else
    consecutive=0
  fi
  sleep 1
done
echo "$container not ready after 60 attempts; container logs:" >&2
docker logs "$container"
exit 1
