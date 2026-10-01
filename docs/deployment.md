# Deployment

Docker Compose runs two services: `hoborouter` (this app: API + web dist, Bun runtime) and `cpa` (the CLIProxyAPI / cliproxyapi container the app proxies through at `http://cpa:8317`).

## First deploy

1. `scripts/generate-secrets.sh` — creates gitignored `deploy/.env` with `CPA_MANAGEMENT_KEY` and `CPA_ACCESS_KEY`. Add `BETTER_AUTH_SECRET` (`openssl rand -hex 32`), `BETTER_AUTH_URL` (public URL, required when `NODE_ENV=production`), and payOS credentials if using real payments. Names are documented in `deploy/.env.example`.
2. Ensure `deploy/cpa/config.yaml` exists (`sh deploy/cpa/render-config.sh`).
3. From `deploy/`: `docker compose up -d --wait`.
4. `hoborouter` is published on `127.0.0.1:3000` only. Terminate TLS in a reverse proxy (Caddy/nginx) that forwards to `127.0.0.1:3000`; never expose the port directly.

## Backups

SQLite lives in the named volume `hoborouter-data` at `/data/hoborouter.db` (WAL mode). Copy safely with the `.backup` command, not `cp`, so WAL frames are checkpointed:

```sh
docker compose exec hoborouter bun -e '
const {Database} = require("bun:sqlite");
new Database("/data/hoborouter.db").exec("VACUUM INTO \"/tmp/backup.db\"");
' && docker compose cp hoborouter:/tmp/backup.db ./backup-$(date +%F).db
```

Alternative from a host with sqlite3 against a stopped container's volume: `sqlite3 /path/hoborouter.db ".backup '/path/backup.db'"`. Schedule daily; verify restore into a scratch volume quarterly.

## payOS webhook URL

Point the payOS dashboard webhook at `https://<your-domain>/api/webhooks/payos` (confirm the exact path in `apps/api/src/routes/payments.ts` before going live). The URL must be publicly reachable over HTTPS.

## Enabling the gateway

`HBR_GATEWAY_ENABLED` defaults to `0` (paid traffic off). Before setting it to `1`:

1. Billing audit: verify wallet debit, USD→VND rate (`HBR_USD_VND_RATE`), and per-request max-output-token cap (`HBR_DEFAULT_MAX_OUTPUT_TOKENS`) behave correctly against a staging instance.
2. Confirm CPA credentials rotate cleanly and `CPA_BASE_URL` resolves inside the compose network.
3. QA gates: key auth, insufficient-credit path, and audit log entries all verified end to end.
4. Set `HBR_GATEWAY_ENABLED=1` in `deploy/.env` and `docker compose up -d` to recreate.

## Upgrade / migration policy

- Forward-only: schema migrations never roll back. Ship additive migrations; deprecate before removing.
- Preflight: before `docker compose up` with a new image, back up the DB (above) and run the migration against a copy of the volume.
- Never auto-run destructive migrations. Any `DROP`/column-type change is a reviewed, manually executed step with a verified backup and a documented rollback plan (restore backup + previous image tag).

## Rebuild

```sh
docker compose build hoborouter
docker compose up -d hoborouter
```

The image is built from the repo-root multi-stage `Dockerfile` (oven/bun:1.4; web built with `bunx vp build`; runtime `bun apps/api/src/index.ts`).
