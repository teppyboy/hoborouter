# Development

## Prerequisites

- [Bun](https://bun.sh) 1.4+
- Docker (for the CPA proxy container)
- openssl (for secrets generation)

## Setup

1. `bun install`
2. `scripts/generate-secrets.sh` — writes `deploy/.env` (gitignored) with CPA keys. Or `cp deploy/.env.example deploy/.env` and fill in values.
3. `scripts/cpa-dev.sh up` — starts the CPA container on `127.0.0.1:8317` and health-checks it. `scripts/cpa-dev.sh key` copies the management key for the CPA web UI (`http://127.0.0.1:8317/management.html`).

## Run

Two processes, two terminals:

1. `bun run dev` (root `vp dev`) — API + web dev server with proxy.
2. API listens on `:3000`; web dev server proxies `/api` to it.

The API defaults to an in-memory SQLite DB. Point it at a file with `HBR_DB_PATH=./hoborouter.db` in `deploy/.env` (sourced by dev tooling) or export it directly.

## Tests

```sh
bun test          # or: bun run test (vp run bun-test)
```

Type-check only: `bunx tsc -p apps/api/tsconfig.json --noEmit`.

## CPA

`cpa` is the service name for CLIProxyAPI (cliproxyapi). In compose it is reachable at `http://cpa:8317`; locally at `http://127.0.0.1:8317`. The API locates it via `CPA_BASE_URL`.

## Gateway flag

Paid gateway routes are disabled by default. Enable locally with `HBR_GATEWAY_ENABLED=1` in the environment. Never enable mock payments (`HBR_MOCK_PAYMENTS=on` + `HBR_MOCK_PAYMENTS_WEBHOOK_KEY`, non-production `NODE_ENV`) outside dev/demo.

## Mock / dev payments

Set in `deploy/.env`:

- `HBR_MOCK_PAYMENTS=on`
- `HBR_MOCK_PAYMENTS_WEBHOOK_KEY=<any non-empty string>`

Mock webhook routes are then mounted for local demo top-ups. See `docs/ops/runbook-foundation.md`.
