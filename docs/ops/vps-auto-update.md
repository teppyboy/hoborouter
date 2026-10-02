# VPS auto-update design (design only — not implemented)

Goal: Hoborouter on a single VPS updates itself safely from a published image,
with a DB backup before migrations, a health-check gate, and one-step rollback.
CPA stays pinned and is updated manually.

## Options considered

1. **Watchtower (containrrr/watchtower)** — auto `pull` + recreate. Rejected:
   upstream is effectively unmaintained (last release 2024, repo dormant;
   community fork `nickfedor/watchtower` exists but adds a new trust
   dependency). No backup, no health gate, no rollback; it just swaps
   containers.
2. **GitHub Actions SSH deploy on tag** — CI pushes to GHCR on tag, then SSHes
   to the VPS and runs a deploy script. Solid, but requires long-lived VPS SSH
   credentials in GitHub secrets.
3. **Webhook pull deploy** — a tiny listener on the VPS triggers the deploy
   script; GitHub sends a release/tag webhook. Avoids stored SSH keys but adds
   an internet-facing service to harden.
4. **systemd timer running `docker compose pull` + deploy script** — no new
   services, no stored cloud credentials, no CI keys on the box. Pull-based,
   polls GHCR hourly. Simplest trust story on a single VPS.

**Recommendation: option 4** — systemd timer + one deploy script. Same
automation as Watchtower with the safety steps Watchtower lacks.

## Build / publish flow

GitHub Actions workflow `.github/workflows/release.yml` (new): on tag push
(`v*`), build `Dockerfile` and push to GHCR:

- image: `ghcr.io/<owner>/hoborouter:<tag>` **and** `ghcr.io/<owner>/hoborouter:latest`
- use digest pinning at deploy time: the deploy script records the digest it
  pulls (`docker inspect --format '{{index .RepoDigests 0}}'`).

`deploy/docker-compose.yml` changes (not this doc's owner — noted for the
compose owner): `hoborouter:` gains `image: ghcr.io/<owner>/hoborouter:latest`
and a `healthcheck` hitting `http://127.0.0.1:3000/healthz` (route already
exists in `apps/api/src/routes/health.ts`). The `build:` block is dropped on
the VPS. `cpa:` stays `eceasy/cli-proxy-api:v8.0.4` pinned by tag+digest;
updates are manual (`docker compose pull cpa`, review changelog, `up -d cpa`).

## Deploy script `deploy/vps-deploy.sh` (new)

Invoked by the timer; idempotent; all state under `/var/lib/hoborouter/`:

1. Pull: `docker compose pull hoborouter`.
2. Record current image: `docker inspect hoborouter --format '{{.Image}}'` →
   `/var/lib/hoborouter/previous-image`.
3. If nothing new, exit 0.
4. **DB backup** — SQLite file lives in the `hoborouter-data` volume at
   `/data/hoborouter.db` (Dockerfile `HBR_DB_PATH`). Before stopping:
   `docker run --rm -v hoborouter-data:/data -v /var/lib/hoborouter/backups:/b alpine cp /data/hoborouter.db /b/backup-$(date +%s).db`
   — plus `VACUUM INTO` via bun if a consistent snapshot is preferred over a
   plain copy (WAL risk). Keep last 10.
5. Migrations are forward-only: `packages/db/src/migrate.ts` runs in one
   transaction with FK check and the populated-`users` preflight; on failure it
   rolls back. Forward-only means the backup is the only rollback path for the
   schema — restoring it is part of step 8.
6. `docker compose up -d hoborouter` (recreates with the new image).
7. **Health gate**: poll `curl -fsS http://127.0.0.1:3000/healthz` for 60 s.
8. On failure: `docker compose up -d --no-deps hoborouter` pinned to the
   previous image from `previous-image`; restore the backup into the volume if
   migrations had altered data; exit non-zero (timer unit goes `failed`,
   visible in `systemctl list-timers` / logs).

## Timer units (new)

`/etc/systemd/system/hoborouter-update.service`:
`ExecStart=/opt/hoborouter/deploy/vps-deploy.sh`,
`WorkingDirectory=/opt/hoborouter/deploy`. User with docker-group membership;
no root.

`hoborouter-update.timer`: `OnCalendar=hourly`,
`Persistent=true`, `RandomizedDelaySec=300`.

## Secrets handling

- Runtime secrets stay in `deploy/.env` (gitignored), loaded via
  `env_file` — unchanged from today.
- GHCR pull on the VPS: `docker login ghcr.io` with a fine-grained PAT
  read:packages stored only in `/root/.docker/config.json` (or a public image;
  if the repo is public, no credential needed at all — prefer that).
- CI needs no VPS credentials (option 4): only `GITHUB_TOKEN` for GHCR push.
- Backup dir `/var/lib/hoborouter/backups`: `chmod 700`, root-owned; DB may
  contain API keys.

## Downtime

Single VPS, single container, no orchestrator: each update is a stop →
migrate → start. Expect **5–20 s** of 502s on `:3000` per update (pull is
pre-done by the script, so no image transfer time in the window). Migrations
here are small SQLite DDL in one transaction, sub-second. Acceptable for a
single-tenant gateway; if not, the later fix is a two-container blue/green
behind a local reverse proxy — out of scope now.

## Interplay with planned PostgreSQL production DB

Current stack is SQLite in a volume with bun:sqlite/Drizzle. When the
production DB moves to Postgres (`packages/db` gains a pg dialect):

- `drizzle.config.ts` and `migrate.ts` swap dialect; migrate.ts is SQLite
  (`bun:sqlite`) today — the backup step becomes
  `pg_dump --format=custom` from a sidecar container instead of file copy, and
  restore is `pg_restore --clean`.
- `VACUUM`/WAL concerns disappear; Postgres backups should run on their own
  timer independent of deploys.
- Compose gains a `db` service or uses a managed Postgres; the health gate and
  rollback flow are unchanged. Migrations remain forward-only, so the
  pre-deploy dump stays mandatory.
- Keep the SQLite backup step in the script until the cutover commit lands.

## Exact files added (when implemented)

| File | Purpose |
| --- | --- |
| `.github/workflows/release.yml` | Build + push image to GHCR on `v*` tags |
| `deploy/vps-deploy.sh` | pull → backup → up → health gate → rollback |
| `deploy/vps-deploy.sh` deps | `docker compose`, `curl`, `date`, alpine cp image |
| `/etc/systemd/system/hoborouter-update.service` | oneshot unit |
| `/etc/systemd/system/hoborouter-update.timer` | hourly schedule |
| `deploy/docker-compose.yml` (owner elsewhere) | add `image:`, `healthcheck`, drop `build:` |

First manual run: `systemctl enable --now hoborouter-update.timer && systemctl start hoborouter-update.service && journalctl -u hoborouter-update.service`.
