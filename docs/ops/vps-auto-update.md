# VPS auto-update runbook

Hoborouter on a single VPS updates itself from a published GHCR image via a
systemd timer running `deploy/vps-deploy.sh`: pull → Postgres backup →
recreate → health gate → rollback on failure. CPA stays pinned and is updated
manually.

## Publish flow

`.github/workflows/release.yml` on tag push (`v*`): runs tests (against a
Postgres 17 service container), then logs in to ghcr.io with the workflow
`GITHUB_TOKEN` and pushes `ghcr.io/teppyboy/hoborouter:<tag>` and
`:latest`.

## Deploy script `deploy/vps-deploy.sh`

Invoked by the systemd timer; idempotent; all state under
`/var/lib/hoborouter/`.

1. Single-instance lock: atomic `mkdir` at `$LOCK_FILE`. Contention exits
   non-zero. A stale lock older than 2 hours (crashed run) is removed
   automatically.
2. Pull: `docker compose pull hoborouter`. The running container's image ID
   is compared with the pulled tag's image ID
   (`docker image inspect <tag> --format '{{.Id}}'`); if equal, exit 0 —
   nothing to do. (The container's image ID only changes at `compose up`.)
3. **DB backup before restart** (Postgres, compose service `db`):
   `docker compose exec -T db pg_dump -U hoborouter -Fc hoborouter >
   $BACKUP_DIR/hoborouter-<ts>.dump`. If the dump fails or is empty, the
   deploy aborts with a non-zero exit and the container is NOT restarted.
   Last 10 backups are kept. SQLite backup support was removed — the DB is
   Postgres only.
4. `docker compose up -d hoborouter` (recreates with the new image).
5. **Health gate**: poll `curl -fsS http://127.0.0.1:3000/healthz` for
   `$HEALTH_TIMEOUT` (default 90 s).
6. On failure: rollback restores the **image** — the previous image ID is
   retagged to `ghcr.io/teppyboy/hoborouter:${HBR_IMAGE_TAG:-latest}` and
   `docker compose up -d --no-deps hoborouter` recreates the container from
   it. Exit non-zero (the timer unit goes `failed`, visible in
   `systemctl list-timers` / `journalctl`).

### DB restore is manual

Migrations are forward-only, so the script never touches the database on
rollback. If a deploy corrupted data, restore by hand from the newest dump:

```sh
docker compose exec -T db pg_restore -U hoborouter --clean --dbname hoborouter \
  < /var/lib/hoborouter/backups/hoborouter-<ts>.dump
```

The rollback message printed by the script echoes this exact command with the
actual backup path.

## Timer units

`/etc/systemd/system/hoborouter-update.service`:
`ExecStart=/opt/hoborouter/deploy/vps-deploy.sh`,
`WorkingDirectory=/opt/hoborouter/deploy`, `Type=oneshot`,
`TimeoutStartSec=600` (bounds one deploy run). User with docker-group
membership; no root.

`hoborouter-update.timer`: `OnCalendar=*:0/15` (every 15 minutes),
`Persistent=true`, `RandomizedDelaySec=120`.

## Secrets handling

- Runtime secrets stay in `deploy/.env` (gitignored), loaded via `env_file`.
- GHCR pull on the VPS: the package is private like the repo, so `docker login ghcr.io` with a PAT that has `read:packages` — or make the package public in GitHub package settings.
- CI needs no VPS credentials: only the built-in `GITHUB_TOKEN` for GHCR push.
- Backup dir `/var/lib/hoborouter/backups`: `chmod 700`; dumps may contain
  API keys.

## Downtime

Single VPS, single container, no orchestrator: each update is stop → migrate
→ start. Expect **5–20 s** of 502s on `:3000` per update (the pull is done
before the restart, so no image transfer inside the window). Acceptable for a
single-tenant gateway; if not, the later fix is blue/green behind a local
reverse proxy — out of scope.

First manual run:
`systemctl enable --now hoborouter-update.timer && systemctl start hoborouter-update.service && journalctl -u hoborouter-update.service`.
