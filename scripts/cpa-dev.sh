#!/bin/sh
# Local-only CPA development lifecycle. Not a production isolation control.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ENV="$ROOT/deploy/.env"
COMPOSE="docker compose -f $ROOT/deploy/docker-compose.yml"

usage() { echo "usage: $0 {up|down|status|key}" >&2; exit 64; }
[ $# -eq 1 ] || usage

case "$1" in
  up)
    if [ ! -f "$ENV" ]; then
      "$ROOT/scripts/generate-secrets.sh" >/dev/null
    fi
    # shellcheck disable=SC1090
    . "$ENV"
    export CPA_MANAGEMENT_KEY CPA_ACCESS_KEY
    if [ ! -f "$ROOT/deploy/cpa/config.yaml" ]; then
      sh "$ROOT/deploy/cpa/render-config.sh" >/dev/null
    fi
    sh -c "$COMPOSE up -d --wait"
    curl -fsS -m 3 http://127.0.0.1:8317/healthz >/dev/null
    ;;
  down)
    sh -c "$COMPOSE down"
    ;;
  status)
    sh -c "$COMPOSE ps"
    ;;
  key)
    if [ ! -f "$ENV" ]; then
      "$ROOT/scripts/generate-secrets.sh" >/dev/null
    fi
    # shellcheck disable=SC1090
    . "$ENV"
    printf '%s' "$CPA_MANAGEMENT_KEY" | pbcopy
    echo "management key copied to clipboard"
    ;;
  *) usage;;
esac
