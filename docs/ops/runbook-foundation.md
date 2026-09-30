# Runbook — CPA local development

CPA runs on `127.0.0.1:8317` with a generated 256-bit management key. This is a single-owner local setup, not production isolation. Paid AI traffic remains disabled. Use `scripts/cpa-dev.sh up|down|status`.

## Local setup and operations

From the repository root:

```sh
bun install
cp deploy/.env.example deploy/.env
bun run dev
```

`deploy/.env` is gitignored. Set these values there as appropriate:

- `HBR_DB_PATH` — SQLite path; defaults to `:memory:`.
- `HBR_WEB_DIST` — web distribution override.
- `HBR_MOCK_PAYMENTS` and `HBR_MOCK_PAYMENTS_WEBHOOK_KEY` — development/demo
  only; mock payments require `HBR_MOCK_PAYMENTS=on`, a non-empty key, and a
  non-production `NODE_ENV`.
- `CPA_MANAGEMENT_KEY` and `CPA_ACCESS_KEY` — CPA credentials.
- `HBR_BOOTSTRAP_INSTANCE_ADMIN_EMAIL` — optional bootstrap admin email.

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

### Verify paid routes remain disabled

```sh
curl -fsS http://localhost:3000/openapi.json | grep -E 'v1/(chat/completions|responses)' && exit 1 || true
curl -i http://localhost:3000/v1/chat/completions
```

The first command must find no paid proxy route. The second must not return a
working paid route (404 is expected). The exact banner is:

> PAID AI TRAFFIC DISABLED — Phase 0 probe does not authorize it; see architecture.md §8 open human decisions.

Mock payment routes are for local development/demo only; never enable them in
production.
