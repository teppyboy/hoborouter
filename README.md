# Hoborouter

Self-hosted AI gateway and control plane: users, workspaces, API keys, model
catalog, VND wallet billing, payments, usage logs, and a dashboard, proxying
through CLIProxyAPI (CPA).

## Setup

Requires Bun 1.4+ and Docker (dev/test databases run as Postgres containers).

```sh
bun install
cp deploy/.env.example deploy/.env
```

Set secrets in `deploy/.env` before starting CPA. Never commit `deploy/.env`.

## Run and test

```sh
HBR_DEV_ADMIN_EMAIL=you@example.com bun run dev   # dev stack + dev Postgres (hbr-dev-pg, 127.0.0.1:55433)
bun run db:test:up                                # test Postgres (hbr-test-pg, 127.0.0.1:55432)
PORT=3998 bun run test                            # unit/integration against the test Postgres
E2E_CPA_PORT=8499 bun run e2e                     # E2E UI sweep (hbr-e2e-pg, 127.0.0.1:55434)
node_modules/.bin/tsc -p apps/api/tsconfig.json --noEmit
```

`DATABASE_URL` (a `postgres://...` URL) is required; the DB layer refuses
anything else. One-time copy of an old SQLite database into Postgres:

```sh
DATABASE_URL=postgres://... bun run db:copy-from-sqlite --from <sqlite file>
```

CPA runs on `127.0.0.1:8317` with a generated 256-bit management key. Add providers: `scripts/cpa-dev.sh up`, `scripts/cpa-dev.sh key`, then open http://127.0.0.1:8317/management.html and paste the key. API-key providers save directly; OAuth providers require the local callback ports.

## Environment

- `DATABASE_URL` — PostgreSQL URL, required everywhere (dev, tests, production).
- `HBR_WEB_DIST` — web build directory override.
- `HBR_MOCK_PAYMENTS` / `HBR_MOCK_PAYMENTS_WEBHOOK_KEY` — legacy signed mock webhook only; new top-ups are provider `manual` and never use it.
- `PAYOS_CLIENT_ID` / `PAYOS_API_KEY` / `PAYOS_CHECKSUM_KEY` — optional payOS instant top-ups; all three (from the payOS dashboard) or payOS stays off. Webhook URL `https://<your-domain>/webhooks/payments/payos` is set in the payOS dashboard; return/cancel redirects come from `BETTER_AUTH_URL`/`HBR_BASE_URL`. Setup: `docs/deployment.md` → "payOS top-ups".
- `TURNSTILE_SECRET_KEY` / `TURNSTILE_SITE_KEY` — optional Cloudflare Turnstile on sign-in/sign-up (both set = on); the site key reaches the SPA at runtime via `/api/v1/public-config`, the secret never leaves the server. Legacy `VITE_TURNSTILE_SITE_KEY` is a fallback only.
- `SMTP_HOST` / `HBR_EMAIL_FROM` — optional email verification over plain SMTP (no third-party provider); both together switch it on. `SMTP_PORT` (default 587; 465 → `ssl`), `SMTP_USER` + `SMTP_PASSWORD` (paired), `HBR_SMTP_SECURE` = `starttls` (default) / `ssl` / `none` (dev-only, refused in production), `HBR_EMAIL_FROM` accepts a display form. Verification never blocks sign-in. Setup + SPF/DKIM notes: `docs/deployment.md` → "Auth".
- `CPA_MANAGEMENT_KEY` — CPA management API key.
- `CPA_ACCESS_KEY` — CPA access key.
- `HBR_IDLE_TIMEOUT_S` — API idle timeout, 1–255 s (default 255).
- `HBR_BOOTSTRAP_INSTANCE_ADMIN_EMAIL` — first admin: the user who signs up with this email becomes instance admin; ignored once an admin exists.
- `NODE_ENV` — top-ups complete only via the instance admin (`POST /api/v1/admin/payments/:id/complete`); there is no dev self-complete path.

See `deploy/.env.example` for the full annotated list.
