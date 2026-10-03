# Runbook — CPA local development

CPA runs on `127.0.0.1:8317` with a generated 256-bit management key. This is a single-owner local setup, not production isolation. Use `scripts/cpa-dev.sh up|down|status`.

## Local setup and operations

From the repository root:

```sh
bun install
cp deploy/.env.example deploy/.env
bun run dev
```

`deploy/.env` is gitignored. Set these values there as appropriate:

- `DATABASE_URL` — PostgreSQL URL. `bun run dev` starts the dev Postgres (`hbr-dev-pg`, `127.0.0.1:55433`) and exports it automatically; set it only to point elsewhere.
- `HBR_WEB_DIST` — web distribution override.
- `HBR_MOCK_PAYMENTS` and `HBR_MOCK_PAYMENTS_WEBHOOK_KEY` — legacy signed mock webhook only (`HBR_MOCK_PAYMENTS=off` disables the route; the signed webhook is enabled only when its key is set). New top-ups are provider `manual` and never use it.
- `CPA_MANAGEMENT_KEY` and `CPA_ACCESS_KEY` — CPA credentials.
- `HBR_BOOTSTRAP_INSTANCE_ADMIN_EMAIL` — optional bootstrap admin email.

### Add a provider via the CPA web UI

```sh
scripts/cpa-dev.sh up
scripts/cpa-dev.sh key
```

Open http://127.0.0.1:8317/management.html and paste the key. Add API-key providers directly. OAuth providers use the published callback ports; keep the browser on this local machine.

### Compose lifecycle

Start and stop CPA with the development helper:

```sh
scripts/cpa-dev.sh up
scripts/cpa-dev.sh down
```

Manual teardown (including failed-run cleanup):

```sh
docker compose -f deploy/docker-compose.yml down -v
```

CPA is intentionally published on loopback only; no PF or host-isolation
probe is required.

### Verify the paid gateway

The gateway routes are ON by default (`HBR_GATEWAY_ENABLED=0` disables). Smoke-check:

```sh
curl -i http://localhost:3000/v1/chat/completions
```

Without a key this must return an auth error, not 404. With a key and balance it proxies to CPA.

## Payments

Top-ups are provider `manual` in every environment: a member creates the pending payment and an instance admin marks it paid (Admin → Payments). There is no dev self-completion path. The legacy signed mock webhook is local/demo only; never enable it in production.
