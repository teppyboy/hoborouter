# Hoborouter

PAID AI TRAFFIC DISABLED — Phase 0 probe does not authorize it; see architecture.md §8 open human decisions.

## Setup

```sh
bun install
cp deploy/.env.example deploy/.env
```

Set secrets in `deploy/.env` before starting CPA. Never commit `deploy/.env`.

## Run and test

```sh
bun run dev
bun test
bunx tsc --noEmit -p apps/api
```

CPA runs on `127.0.0.1:8317` with a generated 256-bit management key. Use `scripts/cpa-dev.sh up|down|status`. Paid AI traffic remains disabled; production use requires explicit approval.

## Environment

- `HBR_DB_PATH` — SQLite database path; defaults to `:memory:`.
- `HBR_WEB_DIST` — web build directory override.
- `HBR_MOCK_PAYMENTS` — set to `on` for development/demo only; disabled in production.
- `HBR_MOCK_PAYMENTS_WEBHOOK_KEY` — non-empty mock webhook key when mock payments are enabled.
- `CPA_MANAGEMENT_KEY` — CPA management API key.
- `CPA_ACCESS_KEY` — CPA access key.
- `HBR_BOOTSTRAP_INSTANCE_ADMIN_EMAIL` — bootstrap instance-admin email, when configured.
- `NODE_ENV` — set to `production` to disable mock payments.
