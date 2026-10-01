#!/bin/bash
# Isolated E2E stack: fake CPA :8399, API :3099, vite :5199, headless Chrome :9399.
# Never touches the owner's dev servers (:3000/:5173). Kills only saved PIDs.
# Usage: e2e-stack.sh up|down|restart
set -u
DIR=/tmp/hbr-e2e
mkdir -p "$DIR"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIDFILE="$DIR/pids"

CPA_PORT=8399
API_PORT=3099
WEB_PORT=5199
CDP_PORT=9399

CPA_ACCESS_KEY="${CPA_ACCESS_KEY:-e2e-access-key}"
CPA_MANAGEMENT_KEY="${CPA_MANAGEMENT_KEY:-e2e-mgmt-key}"
export CPA_ACCESS_KEY CPA_MANAGEMENT_KEY
export HBR_DEV_ADMIN_EMAIL=admin@e2e.test
export NODE_ENV=development
export BETTER_AUTH_URL="http://127.0.0.1:$WEB_PORT"
export HBR_API_URL="http://127.0.0.1:$API_PORT"
# Stable secret so vite HMR restarts don't invalidate sessions mid-run.
BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-e2e-secret-0123456789abcdef0123456789abcdef}"

wait_http() { # url name tries
  local i=0
  while [ "$i" -lt "$2" ]; do
    if curl -sf -o /dev/null "$1"; then echo "$2 up: $1"; return 0; fi
    i=$((i + 1)); sleep 0.5
  done
  echo "TIMEOUT waiting for $1 (see $DIR logs)" >&2
  return 1
}

start_one() { # name logfile cmd...
  local name=$1 log=$2; shift 2
  nohup "$@" >"$log" 2>&1 &
  echo "$name=$!" >>"$PIDFILE"
}

check_ports() {
  # lsof hangs on this Mac (OrbStack NFS mount), so probe with nc instead.
  local rc=0
  for port in $CPA_PORT $API_PORT $WEB_PORT $CDP_PORT; do
    if nc -z -G1 127.0.0.1 "$port" 2>/dev/null; then
      echo "ERROR: port $port already in use" >&2
      rc=1
    fi
  done
  return $rc
}

up() {
  check_ports || { echo "aborting: E2E ports occupied; run: scripts/e2e-stack.sh down" >&2; exit 1; }
  : >"$PIDFILE"
  rm -f "$DIR/e2e.sqlite" "$DIR/e2e.sqlite-wal" "$DIR/e2e.sqlite-shm" # fresh DB

  start_one cpa "$DIR/cpa.log" bun "$ROOT/scripts/dev-fake-cpa.ts"
  start_one api "$DIR/api.log" env \
    NODE_ENV=development \
    PORT=$API_PORT \
    HBR_DB_PATH="$DIR/e2e.sqlite" \
    BETTER_AUTH_URL="$BETTER_AUTH_URL" \
    BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" \
    CPA_BASE_URL="http://127.0.0.1:$CPA_PORT" \
    CPA_ACCESS_KEY="$CPA_ACCESS_KEY" \
    CPA_MANAGEMENT_KEY="$CPA_MANAGEMENT_KEY" \
    HBR_DEV_ADMIN_EMAIL="$HBR_DEV_ADMIN_EMAIL" \
    HBR_DEV_PAYMENTS=1 \
    HBR_GATEWAY_ENABLED=1 \
    bun "$ROOT/apps/api/src/index.ts"
  start_one web "$DIR/web.log" env \
    HBR_API_URL="$HBR_API_URL" \
    bun run --cwd "$ROOT/apps/web" dev --host 127.0.0.1 --port $WEB_PORT --strictPort
  CHROME=""
  for c in "/Applications/Chromium.app/Contents/MacOS/Chromium" "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
    [ -x "$c" ] && CHROME="$c" && break
  done
  if [ -z "$CHROME" ]; then echo "no Chrome/Chromium found" >&2; down; exit 1; fi
  start_one chrome "$DIR/chrome.log" "$CHROME" \
    --headless=new --remote-debugging-port=$CDP_PORT \
    --user-data-dir=/tmp/hbr-e2e/chrome-profile --no-first-run --no-default-browser-check \
    --disable-gpu about:blank

  wait_http "http://127.0.0.1:$CPA_PORT/healthz" 40 || { down; exit 1; }
  wait_http "http://127.0.0.1:$API_PORT/healthz" 60 || { down; exit 1; }
  wait_http "http://127.0.0.1:$WEB_PORT/" 60 || { down; exit 1; }
  wait_http "http://127.0.0.1:$CDP_PORT/json/version" 40 || { down; exit 1; }
  echo "E2E stack up. CPA_ACCESS_KEY=$CPA_ACCESS_KEY admin=$HBR_DEV_ADMIN_EMAIL"
}

down() {
  # vite spawns through two wrapper levels; catch the e2e-port vite directly
  # even when the pidfile is already gone.
  pkill -f "vite/node/cli.js dev --host 127.0.0.1 --port $WEB_PORT" 2>/dev/null
  [ -f "$PIDFILE" ] || return 0
  # `bun run dev` spawns vite as a child; kill children first so nothing
  # keeps the port after the wrapper exits.
  while IFS='=' read -r name pid; do
    pkill -P "$pid" 2>/dev/null
    kill "$pid" 2>/dev/null && echo "stopped $name ($pid)"
  done <"$PIDFILE"
  rm -f "$PIDFILE"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  restart) down; sleep 1; up ;;
  *) echo "usage: $0 up|down|restart" >&2; exit 2 ;;
esac
