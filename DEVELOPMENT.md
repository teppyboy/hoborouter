# Development

Prereqs: [Bun](https://bun.sh) 1.4+, Docker, `openssl`.

## Run it

One command (backend + frontend + fake CPA, dev Postgres in container `hbr-dev-pg`):

```sh
bun install
HBR_DEV_ADMIN_EMAIL=you@example.com bun run dev
```

`scripts/dev.sh` starts the dev Postgres (`hbr-dev-pg`, named volume, `127.0.0.1:55433`, password `postgres`, database `hoborouter`) and exports `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55433/hoborouter` unless already set. Then sign up at http://localhost:5173 with that exact email — you're instance admin. Ctrl-C stops everything (backend, vite, fake CPA). Sessions survive restarts (fixed secret in gitignored `.dev/secret`). Set `CPA_BASE_URL` (e.g. in `.env`) to use a real CPA instead of the fake.

### Manual

1. Terminal 0 — dev Postgres (`scripts/dev.sh` does this idempotently):

   ```sh
   docker run -d --name hbr-dev-pg -p 127.0.0.1:55433:5432 \
     -e POSTGRES_PASSWORD=postgres -v hbr-dev-pgdata:/var/lib/postgresql/data \
     postgres:17-alpine
   ```

2. Terminal 1 — backend (API on http://localhost:3000, auto-restarts on file changes):

   ```sh
   NODE_ENV=development \
   BETTER_AUTH_URL=http://localhost:5173 \
   BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
   DATABASE_URL="postgres://postgres:postgres@127.0.0.1:55433/hoborouter" \
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

- PostgreSQL everywhere. `DATABASE_URL` (a `postgres://...` URL) is required; `createDb` refuses anything else (`packages/db/src/client.ts`).
- Dev: container `hbr-dev-pg` on `127.0.0.1:55433` (above). Tests: `hbr-test-pg` on `127.0.0.1:55432` (`bun run db:test:up`). E2E: `hbr-e2e-pg` on `127.0.0.1:55434`.
- Secret: a fresh `BETTER_AUTH_SECRET` each start invalidates sessions on restart. For persistent dev, export a fixed one once per shell (`export BETTER_AUTH_SECRET=$(openssl rand -hex 32)`) and omit the inline one.
- Migrating from an old SQLite file (read-only source; verifies counts, money bounds, and wallet/ledger consistency before committing):

  ```sh
  DATABASE_URL=postgres://... bun run db:copy-from-sqlite --from <sqlite file>
  ```

## Instance admin

Needed for admin pages and marking payments paid. Two paths:

- Dev convenience: start the backend with `HBR_DEV_ADMIN_EMAIL=you@example.com` and `NODE_ENV=development`, then sign up with that exact email — the account is created as instance admin.
- Any environment: `scripts/bootstrap-instance-admin.ts` upserts the email from `HBR_BOOTSTRAP_INSTANCE_ADMIN_EMAIL` into `instance_admins` (uses `DATABASE_URL`).

## AI gateway (optional)

Dashboard works without this. The gateway routes (`/v1/chat/completions`, `/v1/responses`) are ON by default (`HBR_GATEWAY_ENABLED=0` disables) and need a CLIProxyAPI (CPA) instance.

- Point at an existing CPA:

  ```sh
  CPA_BASE_URL=http://127.0.0.1:8317 CPA_ACCESS_KEY=... CPA_MANAGEMENT_KEY=... bun --watch apps/api/src/index.ts
  ```

- Or run a local CPA container (Docker, CPA only): `scripts/cpa-dev.sh up` (also: `status`, `down`; `key` copies the management key to the clipboard). It generates `deploy/.env` secrets and `deploy/cpa/config.yaml` if missing, then waits for http://127.0.0.1:8317/healthz.

### Real CPA

Set in `.env` (dev.sh warns at startup if `CPA_BASE_URL` is set but a key is missing):

- `CPA_BASE_URL` — your CPA base URL (e.g. `http://127.0.0.1:8317`).
- `CPA_ACCESS_KEY` — one of the `api-keys` entries in `deploy/cpa/config.yaml`.
- `CPA_MANAGEMENT_KEY` — the plaintext management key. `config.yaml` stores only its bcrypt hash; use the original plaintext you set (or `scripts/cpa-dev.sh key`).

If either key is wrong, admin pages show `CPA_AUTH_FAILED` with e.g. "CPA rejected CPA_MANAGEMENT_KEY (401)" — fix the variable, not the code.

### Expose a model under your own ID

Clients send your public ID; the gateway translates it to the upstream CPA model.

1. Admin → **Models**: create a model with Public ID `hoborouter/auto` (what clients send), tick **published**.
2. Admin → **Models**: open the model → **Routing**: add a mapping with Upstream model `z-ai/glm-5.3-flash` (pick from CPA's model list). The provider label is cosmetic — requests always go to the single CPA.
3. Admin → **Models**: open the model → **Pricing** (or Admin → **Pricing**): add a price for the model.
4. Call it:

   ```sh
   curl -H "Authorization: Bearer sk-hbr-..." localhost:3000/v1/chat/completions \
     -d '{"model":"hoborouter/auto","messages":[{"role":"user","content":"hi"}]}'
   ```

   The upstream request carries `z-ai/glm-5.3-flash`; responses, streams, and `/v1/models` all show `hoborouter/auto`.

## Prompt caching

Global toggle: instance admin, Admin → Settings (`prompt_caching_enabled` in `instance_settings`, default on). Per-model override: model Details → Prompt caching (`inherit`/`on`/`off`, default `inherit`; effective = override, else global).

Requests are sent to the provider identically either way (`cache_control` markers are never stripped). Only billing differs: ON bills cached tokens at the model's `cached_input` rate; OFF bills all input at the full input rate — the usage log keeps the provider-reported cached token count and records `caching: "off"` in `raw_payload`.

## Payments in dev

Top-ups are provider `manual` in every environment: a workspace member creates a pending top-up, and an INSTANCE ADMIN marks it paid (Admin → Payments) after confirming the money out-of-band. There is no dev self-complete endpoint and no env gate for creating top-ups. The legacy signed mock webhook is still readable/completable via the admin endpoint (`HBR_MOCK_PAYMENTS` only gates the legacy `/webhooks/payments/mock` route).

## Become admin in dev

See [Instance admin](#instance-admin): `HBR_DEV_ADMIN_EMAIL=you@example.com` + `NODE_ENV=development`, then sign up with that exact email.

## Fake CPA for local AI calls

`bun run dev` starts it automatically on http://127.0.0.1:8399 when `CPA_BASE_URL` is unset. To run it standalone:

```sh
bun tests/fake-cpa.ts   # listens on http://127.0.0.1:8399
```

Start the backend with `CPA_BASE_URL=http://127.0.0.1:8399 CPA_ACCESS_KEY=<any>` so gateway calls route to it.

## E2E UI check

Isolated stack (fake CPA :8399, API :3099, vite :5199, throwaway Postgres `hbr-e2e-pg` on 55434, fresh database each up):

```sh
bun run e2e                   # up, full sweep, down (one command)
# or manually:
bun run e2e:up
bun tests/e2e/ui.ts           # full sweep, ~1 min
bun run e2e:down
```

Iterate on one area only: `E2E_ONLY='gateway|overview' bun tests/e2e/ui.ts` (regex over step names).

## Tests & type check

```sh
bun run db:test:up                            # start the test Postgres (hbr-test-pg, 127.0.0.1:55432)
PORT=3998 bun run test                        # stop your dev backend first (port 3000 conflict)
node_modules/.bin/tsc -p apps/api/tsconfig.json --noEmit   # API type check
cd apps/web && node_modules/.bin/tsc -b                    # web type check
```

## Troubleshooting

- Port 3000 in use: `lsof -nP -iTCP:3000 -sTCP:LISTEN`
- 403 "invalid origin" on signup: `BETTER_AUTH_URL` must equal the URL in the browser bar.
- Postgres container not ready: `docker logs hbr-dev-pg` (tests: `docker logs hbr-test-pg`).

## Cloudflare Turnstile (optional, off by default)

Bot protection for `/sign-in/email` and `/sign-up/email`, enabled only when both sides are configured:

- `VITE_TURNSTILE_SITE_KEY` — build-time env for the web image (frontend widget)
- `TURNSTILE_SECRET_KEY` — API env (Better Auth `captcha` plugin, provider `cloudflare-turnstile`, reads the `x-captcha-response` header)

When either is unset, auth behaves exactly as before. The frontend widget is skipped on localhost/127.0.0.1/::1, so local dev never needs it. For staging, Cloudflare's test keys work: site `1x00000000000000000000AA`, secret `1x0000000000000000000000000000000AA` (always passes).

## Legal pages

Terms of Service (`/terms`) and Privacy Policy (`/privacy`) are public pages rendered from the markdown source of truth at `apps/web/src/pages/legal/content/`. Operator-specific facts (operator name, contact email, effective date) are written directly in those markdown files — there are no build-time `VITE_LEGAL_*` variables.
