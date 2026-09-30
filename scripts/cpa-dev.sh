#!/bin/sh
# Local-only CPA development lifecycle. Not a production isolation control.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ENV="$ROOT/deploy/.env"
COMPOSE="docker compose -f $ROOT/deploy/docker-compose.yml"

usage() { echo "usage: $0 {up|down|status}" >&2; exit 64; }
[ $# -eq 1 ] || usage

case "$1" in
  up)
    if [ ! -f "$ENV" ]; then
      "$ROOT/scripts/generate-secrets.sh" >/dev/null
    fi
    # shellcheck disable=SC1090
    . "$ENV"
    export CPA_MANAGEMENT_KEY CPA_ACCESS_KEY
    sh "$ROOT/deploy/cpa/render-config.sh" >/dev/null
    sh -c "$COMPOSE up -d --wait"
    curl -fsS -m 3 http://127.0.0.1:8317/healthz >/dev/null
    ;;
  down)
    sh -c "$COMPOSE down -v"
    ;;
  status)
    sh -c "$COMPOSE ps"
    ;;
  *) usage;;
esac
