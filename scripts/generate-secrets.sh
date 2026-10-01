#!/bin/sh
# Task 5: generate CSPRNG secrets into gitignored deploy/.env.
# Values are never printed to stdout or logs.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ENV="$ROOT/deploy/.env"

if [ -f "$ENV" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "deploy/.env already exists; set FORCE=1 to regenerate" >&2
  exit 1
fi

command -v openssl >/dev/null || { echo "openssl required" >&2; exit 1; }

umask 077
{
  echo "CPA_MANAGEMENT_KEY=$(openssl rand -hex 32)"
  echo "CPA_ACCESS_KEY=$(openssl rand -hex 32)"
} > "$ENV"
chmod 600 "$ENV"
echo "wrote deploy/.env (secrets not printed)"
