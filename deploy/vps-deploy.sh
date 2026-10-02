#!/usr/bin/env bash
# VPS auto-update deploy: pull hoborouter image, backup DB, restart, health
# gate, rollback on failure. CPA is never pulled or restarted (manual updates).
# See docs/ops/vps-auto-update.md. Env overrides (COMPOSE_DIR, BACKUP_DIR,
# LOCK_FILE, HEALTH_URL, HEALTH_TIMEOUT, HBR_IMAGE_TAG, DOCKER, CURL)
# exist so tests can shim docker/curl.
set -euo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-/opt/hoborouter/deploy}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/hoborouter/backups}"
LOCK_FILE="${LOCK_FILE:-/var/lib/hoborouter/deploy.lock}"
STATE_DIR="${STATE_DIR:-/var/lib/hoborouter}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/healthz}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-90}"
IMAGE="ghcr.io/teppyboy/hoborouter:${HBR_IMAGE_TAG:-latest}"
DOCKER="${DOCKER:-docker}"
CURL="${CURL:-curl}"
KEEP_BACKUPS=10
LOCK_STALE_MIN=120

# Single-instance lock via atomic mkdir (portable; flock is Linux-only).
if ! mkdir "$LOCK_FILE" 2>/dev/null; then
  # Stale lock from a crashed run: older than $LOCK_STALE_MIN minutes is dead.
  if [ -n "$(find "$LOCK_FILE" -maxdepth 0 -mmin +$LOCK_STALE_MIN 2>/dev/null)" ]; then
    echo "vps-deploy: removing stale lock ($LOCK_FILE)" >&2
    rmdir "$LOCK_FILE" 2>/dev/null || true
    mkdir "$LOCK_FILE"
  else
    echo "vps-deploy: another deploy is running ($LOCK_FILE)" >&2
    exit 1
  fi
fi
trap 'rmdir "$LOCK_FILE"' EXIT

mkdir -p "$BACKUP_DIR" "$STATE_DIR"
chmod 700 "$BACKUP_DIR" 2>/dev/null || true

cd "$COMPOSE_DIR"

# The running container's image ID is stable across `pull`; only `compose up`
# changes it. Compare it against the pulled tag's image ID.
prev_image="$("$DOCKER" inspect hoborouter --format '{{.Image}}')"

"$DOCKER" compose pull hoborouter

new_image="$("$DOCKER" image inspect "$IMAGE" --format '{{.Id}}')"
if [ "$new_image" = "$prev_image" ]; then
  echo "vps-deploy: image unchanged, nothing to do"
  exit 0
fi

# Backup BEFORE restart. Migrations are forward-only: backup is the only
# rollback path for the schema (packages/db/src/migrate.ts).
timestamp="$(date +%s)"
backup_file="$BACKUP_DIR/hoborouter-$timestamp.dump"
if ! "$DOCKER" compose exec -T db pg_dump -U hoborouter -Fc hoborouter > "$backup_file"; then
  echo "vps-deploy: pg_dump failed, aborting before restart" >&2
  exit 1
fi
[ -s "$backup_file" ] || { echo "vps-deploy: backup missing/empty, aborting" >&2; exit 1; }

# Keep last $KEEP_BACKUPS backups.
find "$BACKUP_DIR" -name 'hoborouter-*.dump' -type f | sort -r | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f

"$DOCKER" compose up -d hoborouter

deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if "$CURL" -fsS -o /dev/null "$HEALTH_URL"; then
    echo "vps-deploy: updated to $new_image, healthy"
    exit 0
  fi
  sleep 2
done

echo "vps-deploy: health check failed after $HEALTH_TIMEOUT s, rolling back" >&2
"$DOCKER" tag "$prev_image" "$IMAGE"
"$DOCKER" compose up -d --no-deps hoborouter
echo "vps-deploy: rolled back to $prev_image" >&2
echo "vps-deploy: backup at $backup_file — DB restore is manual (migrations are" >&2
echo "  forward-only, never auto-restore):" >&2
echo "  docker compose exec -T db pg_restore -U hoborouter --clean --dbname hoborouter < '$backup_file'" >&2
exit 1
