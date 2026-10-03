# Deployment

Docker Compose runs three services: `db` (postgres:17-alpine, named volume
`hbr-pgdata`), `hoborouter` (this app: API + web dist, Bun runtime, image
`ghcr.io/teppyboy/hoborouter:${HBR_IMAGE_TAG:-latest}`), and `cpa` (the
CLIProxyAPI container the app proxies through; compose sets
`CPA_BASE_URL=http://cpa:8317`, the service name on the compose network; `127.0.0.1`
would point at the app container itself). `DATABASE_URL` is built in compose from
`POSTGRES_PASSWORD`: `postgres://hoborouter:${POSTGRES_PASSWORD}@db:5432/hoborouter`.

## First deploy

1. `scripts/generate-secrets.sh` — creates gitignored `deploy/.env` with `CPA_MANAGEMENT_KEY` and `CPA_ACCESS_KEY`. Add `POSTGRES_PASSWORD` (required — compose refuses to start without it), `BETTER_AUTH_SECRET` (`openssl rand -hex 32`, min 32 chars), and `BETTER_AUTH_URL` (public URL; `HBR_BASE_URL` is also accepted — `apps/api/src/auth.ts` throws at startup in production without one). payOS credentials are optional. Names are documented in `deploy/.env.example`.
2. Ensure `deploy/cpa/config.yaml` exists (`sh deploy/cpa/render-config.sh`) — this MUST happen before `up`. If it's missing, Docker creates an empty **directory** at that bind-mount path and CPA fails to start.
3. Run compose from inside `deploy/`: `docker compose up -d --wait`. The VPS needs only the `deploy/` files (`docker-compose.yml`, `.env`, `cpa/config.yaml`, `cpa/auths/`, `vps-deploy.sh`, `systemd/`) — never the repo, since the compose file only pulls the published image.
4. `hoborouter` is published on `127.0.0.1:3000` only. Terminate TLS in a reverse proxy (Caddy/nginx) that forwards to `127.0.0.1:3000`; never expose the port directly. Minimal Caddyfile:

   ```
   example.com {
     reverse_proxy 127.0.0.1:3000
   }
   ```

   No `flush_interval -1` tuning is needed: streamed gateway responses send
   `x-accel-buffering: no`, so Caddy does not buffer SSE.

5. First admin: set `HBR_BOOTSTRAP_INSTANCE_ADMIN_EMAIL` in `deploy/.env`
   before the first start, then sign up in the web UI with that exact email —
   it becomes the instance admin. Applies only while the instance has zero
   admins (any `NODE_ENV`); if the user already exists it is granted at the
   next startup. The image contains no `scripts/` directory.

### Pulling the image

The GHCR package is private like the repo. Pulling needs `docker login
ghcr.io` with a token that has `read:packages`, or make the package public in
GitHub package settings. Tag pushes (`v*`) publish `ghcr.io/teppyboy/hoborouter:<tag>`
and `:latest` via `.github/workflows/release.yml`.

## Backups

Postgres lives in the named volume `hbr-pgdata`. Back up with `pg_dump`:

```sh
docker compose exec -T db pg_dump -U hoborouter -Fc hoborouter > backup-$(date +%F).dump
```

Schedule daily; verify a restore into a scratch volume quarterly:

```sh
docker compose exec -T db pg_restore -U hoborouter --clean --dbname hoborouter < backup-<date>.dump
```

### Hardening

The `hoborouter` service drops all Linux capabilities (`cap_drop: [ALL]`), sets `no-new-privileges`, and caps processes (`pids_limit: 512`) and memory (`mem_limit: 1g`). Uploaded avatars live in the `hoborouter-data` volume at `/data/avatars` (the image sets `HBR_AVATAR_DIR=/data/avatars`).

## payOS top-ups (optional, webhook-credited)

payOS adds self-service instant top-ups next to the manual flow. Everything
below assumes a working production deploy (reverse proxy + public HTTPS per
"First deploy").

### Environment variables

All three go into gitignored `deploy/.env`, copied from
`deploy/.env.example`:

| Variable | Meaning |
| --- | --- |
| `PAYOS_CLIENT_ID` | payOS client ID from the payOS dashboard |
| `PAYOS_API_KEY` | payOS API key from the payOS dashboard |
| `PAYOS_CHECKSUM_KEY` | payOS checksum key; signs checkout requests and verifies webhooks (HMAC-SHA256) |

payOS is enabled **only when all three are set**; any one missing leaves
manual as the only payment method (`payosConfigFromEnv()` in
`packages/payments/src/provider.ts`).

### Required public URL

`BETTER_AUTH_URL` (or fallback `HBR_BASE_URL`) must be the instance's public
HTTPS base URL — production startup fails without one, and the payOS
return/cancel redirects are built from it. The app is published on
`127.0.0.1:3000` only; TLS terminates in the reverse proxy.

### payOS dashboard webhook URL

Point the payOS dashboard webhook at:

```text
https://<your-domain>/webhooks/payments/payos
```

The URL must be publicly reachable over HTTPS (payOS calls it server-side).
The route is live only while the three `PAYOS_*` vars are set — it returns
404 otherwise. Incoming payloads are signature-verified with
`PAYOS_CHECKSUM_KEY`; a valid webhook is the **sole credit path** for payOS
payments (idempotent replays return 200 without a second credit; bad
signature, unknown order, or amount mismatch return 400 with no wallet
change). Route implementation: `apps/api/src/routes/webhooks-payos.ts`.

### Return / cancel URLs

Both are set by the backend to the same display-only page:
`<BETTER_AUTH_URL>/billing/payments?payment=<id>`. The browser redirect back
from payOS is informational only — status is never read from query
parameters; the billing UI polls the backend, and only the webhook credits
the wallet.

### Secret (checksum/API) key handling

Treat `PAYOS_CHECKSUM_KEY`, `PAYOS_API_KEY`, and `PAYOS_CLIENT_ID` like the
other deploy secrets:

- live only in gitignored `deploy/.env` (see `scripts/generate-secrets.sh`
  conventions); never in the repo, Dockerfiles, or CI logs;
- never in API responses — `GET /api/v1/payment-methods` exposes only the
  boolean `payos: true/false`, and a failed checkout returns a generic 502
  with no upstream body or credential material;
- rotate in the payOS dashboard, then update `deploy/.env` and restart the
  container (below).

### Local testing with the fake server

No payOS account, webhook tunnel, or live charge is needed to develop or
CI-test the payOS path:

1. `bun run db:test:up` (test Postgres on 127.0.0.1:55432).
2. `PORT=3998 bun run test` —
   `apps/api/test/payments-payos.test.ts` injects a fake payOS `fetch`
   (no network, no real credentials) and asserts the signed checkout
   request, return/cancel URLs, 502-on-failure, and that creating never
   moves the wallet; `apps/api/test/webhooks-payos.test.ts` posts locally
   HMAC-signed webhook payloads and asserts credit, idempotent replays, and
   no wallet change on bad signature/amount mismatch;
   `tests/credits-payos-ui.test.tsx` covers the UI provider gating.
3. `POST /webhooks/payments/payos` is 404 when the `PAYOS_*` env is unset,
   so unconfigured dev instances never expose the route.

### Production restart

After adding the three `PAYOS_*` vars (and confirming `BETTER_AUTH_URL`) to
`deploy/.env`, recreate the container from inside `deploy/` so compose picks
up the new env:

```sh
docker compose up -d
```

Editing `.env` does not affect a running container; `up -d` recreates
`hoborouter` only when its environment changed. Then set the webhook URL in
the payOS dashboard and run one small test top-up through the billing UI to
confirm the webhook credits the wallet.

## Paid gateway

`HBR_GATEWAY_ENABLED` defaults to ON. Set `HBR_GATEWAY_ENABLED=0` in `deploy/.env` and `docker compose up -d` to disable paid traffic. Before relying on it in production:

1. Billing audit: verify wallet debit, USD→VND rate (`HBR_USD_VND_RATE`), and per-request max-output-token cap (`HBR_DEFAULT_MAX_OUTPUT_TOKENS`) behave correctly against a staging instance.
2. Confirm CPA credentials rotate cleanly and `CPA_BASE_URL` resolves from the `hoborouter` container.
3. QA gates: key auth, insufficient-credit path, and audit log entries all verified end to end.

## Payments: manual top-ups, admin-completed

Top-ups are provider `manual` in every environment: a workspace member creates a pending payment via `POST /api/v1/workspaces/:id/payments`, and an INSTANCE ADMIN (only) completes it with `POST /api/v1/admin/payments/:id/complete` after confirming the money out-of-band (Admin → Payments → mark paid). There is no customer self-completion path and no dev-only completion endpoint. payOS setup (credentials, dashboard webhook URL, local fake-server testing, production restart) is covered in "payOS top-ups" above. Legacy provider `mock` rows are still readable and admin-completable; the legacy signed webhook route is gated by `HBR_MOCK_PAYMENTS` and only enabled when `HBR_MOCK_PAYMENTS_WEBHOOK_KEY` is set.

## Upgrade / migration policy

- Forward-only: schema migrations never roll back. Ship additive migrations; deprecate before removing.
- Preflight: before `docker compose up` with a new image, back up the DB (above) and run the migration against a copy of the volume.
- Never auto-run destructive migrations. Any `DROP`/column-type change is a reviewed, manually executed step with a verified backup and a documented rollback plan (restore backup + previous image tag).
- On a VPS with the systemd timer (`docs/ops/vps-auto-update.md`), updates pull the new image, take a `pg_dump` backup, recreate the container, and gate on `/healthz` with image rollback.

## Local build

The compose file has no `build:` block: production only ever pulls the published GHCR image, so a VPS holding just `deploy/` never fails trying to build. To test a locally built image instead:

```sh
docker build -t ghcr.io/teppyboy/hoborouter:local .   # from the repo root (multi-stage Dockerfile: oven/bun:1.4; web built with vp build; runtime bun apps/api/src/index.ts)
HBR_IMAGE_TAG=local docker compose up -d hoborouter   # from deploy/, after adding HBR_IMAGE_TAG=local to .env
```

Tag push (`v*`) publishes real images via `.github/workflows/release.yml`; revert `.env` to `HBR_IMAGE_TAG=latest` (or delete the line) afterwards.
