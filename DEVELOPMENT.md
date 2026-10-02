# Development

Prereqs: [Bun](https://bun.sh) 1.4+, `openssl`. No Docker needed for development (Docker Compose in `deploy/` is production only — see `docs/deployment.md`).

## Run it

1. Install deps (repo root):

   ```sh
   bun install
   ```

2. Terminal 1 — backend (API on http://localhost:3000, auto-restarts on file changes):

   ```sh
   NODE_ENV=development \
   BETTER_AUTH_URL=http://localhost:5173 \
   BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
   bun --watch apps/api/src/index.ts
   ```

3. Terminal 2 — frontend (Vite dev server; proxies `/api`, `/v1`, `/webhooks` to :3000):

   ```sh
   bun run --cwd apps/web dev --host 127.0.0.1 --port 5173 --strictPort
   ```

4. Open http://localhost:5173 and sign up.
   - API docs: http://localhost:3000/docs · spec: `/openapi.json` · health: `/healthz`

Why `BETTER_AUTH_URL=http://localhost:5173`: the browser talks to the frontend origin; Better Auth checks the request origin against it.

## Database

- Default: in-memory SQLite. Accounts vanish on every backend restart — including `--watch` restarts when you edit files.
- Persist: add `HBR_DB_PATH=./hoborouter-dev.sqlite` (gitignored; migrations run automatically).
- Never point `HBR_DB_PATH` at a production DB.
- Secret: a fresh `BETTER_AUTH_SECRET` each start invalidates sessions on restart. For persistent dev, export a fixed one once per shell (`export BETTER_AUTH_SECRET=$(openssl rand -hex 32)`) and omit the inline one.

## Instance admin

Needed for admin pages and marking payments paid. Sign up first, then (backend may be stopped or running — SQLite WAL; requires a persistent DB file):

```sh
bun -e 'import {Database} from "bun:sqlite"; import {bootstrapInstanceAdmin} from "./apps/api/src/instance-admin.ts"; console.log(bootstrapInstanceAdmin(new Database("hoborouter-dev.sqlite"), "you@example.com"))'
```

## AI gateway (optional)

Dashboard works without this. The gateway routes (`/v1/chat/completions`, `/v1/responses`) are ON by default (`HBR_GATEWAY_ENABLED=0` disables) and need a CLIProxyAPI (CPA) instance.

- Point at an existing CPA:

  ```sh
  CPA_BASE_URL=http://127.0.0.1:8317 CPA_ACCESS_KEY=... CPA_MANAGEMENT_KEY=... bun --watch apps/api/src/index.ts
  ```

- Or run a local CPA container (Docker, CPA only): `scripts/cpa-dev.sh up` (also: `status`, `down`; `key` copies the management key to the clipboard). It generates `deploy/.env` secrets and `deploy/cpa/config.yaml` if missing, then waits for http://127.0.0.1:8317/healthz.

## Payments in dev

Mock top-ups are on by default. As owner, self-mark paid: add `HBR_DEV_PAYMENTS=1` (only works with `NODE_ENV=development` or `test`).

## Become admin in dev

Start the backend with `HBR_DEV_ADMIN_EMAIL=you@example.com` and `NODE_ENV=development`, then sign up in the UI with that exact email — the account is created as an instance admin.

## Fake CPA for local AI calls

Run a fake CPA instead of the real one:

```sh
bun scripts/dev-fake-cpa.ts   # listens on http://127.0.0.1:8399
```

Start the backend with `CPA_BASE_URL=http://127.0.0.1:8399 CPA_ACCESS_KEY=<any>` so gateway calls route to it.

## E2E UI check

Isolated stack (fake CPA :8399, API :3099, vite :5199, fresh SQLite each up):

```sh
scripts/e2e-stack.sh up
bun scripts/e2e-ui.ts          # full sweep, ~7 min
scripts/e2e-stack.sh down
```

Iterate on one area only: `E2E_ONLY='gateway|overview' bun scripts/e2e-ui.ts` (regex over step names).

## Tests & type check

```sh
bun run test                                  # stop your dev backend first (port 3000 conflict)
bunx tsc -p apps/api/tsconfig.json --noEmit   # API type check
cd apps/web && bunx tsc -b                    # web type check
```

## Troubleshooting

- Port 3000 in use: `lsof -nP -iTCP:3000 -sTCP:LISTEN`
- 403 "invalid origin" on signup: `BETTER_AUTH_URL` must equal the URL in the browser bar.
