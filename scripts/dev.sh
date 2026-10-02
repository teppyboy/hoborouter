#!/bin/bash
# One-command development: backend (:3000) + frontend (:5173) [+ fake CPA :8399].
# Ctrl-C kills both process trees. Dev data lives in .dev/ (gitignored).
set -u
cd "$(dirname "$0")/.."

NO_FAKE_CPA=0
for arg in "$@"; do
  [ "$arg" = "--no-fake-cpa" ] && NO_FAKE_CPA=1
done

# Source .env so users can set HBR_DEV_ADMIN_EMAIL etc. without exporting.
if [ -f .env ]; then set -a; . ./.env; set +a; fi

mkdir -p .dev
if [ ! -f .dev/secret ]; then
  openssl rand -hex 32 >.dev/secret
  chmod 600 .dev/secret
fi
export BETTER_AUTH_SECRET="$(cat .dev/secret)"
export HBR_DB_PATH="${HBR_DB_PATH:-./.dev/hoborouter.sqlite}"
export NODE_ENV=development
export BETTER_AUTH_URL="${BETTER_AUTH_URL:-http://localhost:5173}"
export HBR_DEV_PAYMENTS="${HBR_DEV_PAYMENTS:-1}"

port_busy() { nc -z -G1 127.0.0.1 "$1" 2>/dev/null; }

for port in 3000 5173; do
  if port_busy "$port"; then
    echo "ERROR: port $port is already in use; stop that process first (lsof hangs on this Mac; use nc -z -G1 127.0.0.1 $port to probe)." >&2
    exit 1
  fi
done

# Fake CPA unless a real CPA is configured (or --no-fake-cpa).
CPA_PID=""
if [ -n "${CPA_BASE_URL:-}" ] || [ "$NO_FAKE_CPA" = 1 ]; then
  : # user-provided CPA; nothing to start
  for var in CPA_ACCESS_KEY CPA_MANAGEMENT_KEY; do
    if [ -z "${!var:-}" ]; then
      echo "WARNING: CPA_BASE_URL points at a real CPA but $var is empty; CPA calls will fail with auth errors. Set it in .env."
    fi
  done
else
  if port_busy 8399; then
    echo "ERROR: port 8399 is already in use; needed for the fake CPA. Set CPA_BASE_URL or free the port." >&2
    exit 1
  fi
  export CPA_BASE_URL="http://127.0.0.1:8399"
  export CPA_ACCESS_KEY="${CPA_ACCESS_KEY:-dev-access-key}"
  export CPA_MANAGEMENT_KEY="${CPA_MANAGEMENT_KEY:-dev-mgmt-key}"
  bun tests/fake-cpa.ts > >(sed -u 's/^/[cpa] /') 2>&1 &
  CPA_PID=$!
fi

cleanup() {
  trap - EXIT INT TERM
  [ -n "$API_PID" ] && { pkill -P "$API_PID" 2>/dev/null; kill "$API_PID" 2>/dev/null; }
  [ -n "$WEB_PID" ] && { pkill -P "$WEB_PID" 2>/dev/null; kill "$WEB_PID" 2>/dev/null; }
  [ -n "$CPA_PID" ] && kill "$CPA_PID" 2>/dev/null
  # `bun run` wraps vite one level deeper; catch it directly.
  pkill -f "vite/node/cli.js dev --host localhost --port 5173" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT INT TERM

echo "Dashboard:  http://localhost:5173 (open this URL — sign-in breaks from http://127.0.0.1:5173)"
echo "API docs:   http://localhost:3000/docs"
echo "DB:         $HBR_DB_PATH"
echo "Admin tip:  HBR_DEV_ADMIN_EMAIL=you@example.com bun run dev — sign up with that email to become admin."

NODE_ENV=development PORT=3000 bun --watch apps/api/src/index.ts > >(sed -u 's/^/[api] /') 2>&1 &
API_PID=$!

bun run --cwd apps/web dev --host localhost --port 5173 --strictPort > >(sed -u 's/^/[web] /') 2>&1 &
WEB_PID=$!

wait
