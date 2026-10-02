# Development

Prereqs: [Bun](https://bun.sh) 1.4+, `openssl`. No Docker needed for development (Docker Compose in `deploy/` is production only — see `docs/deployment.md`).

## Run it

One command (backend + frontend + fake CPA, persistent dev data in `.dev/`):

```sh
bun install
HBR_DEV_ADMIN_EMAIL=you@example.com bun run dev
```

Then sign up at http://localhost:5173 with that exact email — you're instance admin. Ctrl-C stops everything (backend, vite, fake CPA). Sessions survive restarts (fixed secret + `./.dev/hoborouter.sqlite`). Set `CPA_BASE_URL` (e.g. in `.env`) to use a real CPA instead of the fake.

### Manual

1. Terminal 1 — backend (API on http://localhost:3000, auto-restarts on file changes):

   ```sh
   NODE_ENV=development \
   BETTER_AUTH_URL=http://localhost:5173 \
   BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
   bun --watch apps/api/src/index.ts
   ```

2. Terminal 2 — frontend (Vite dev server; proxies `/api`, `/v1`, `/webhooks` to :3000):

   ```sh
   bun run --cwd apps/web dev --host 127.0.0.1 --port 5173 --strictPort
   ```

3. Open http://localhost:5173 and sign up.
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

## Payments in dev

Mock top-ups are on by default. As owner, self-mark paid: add `HBR_DEV_PAYMENTS=1` (only works with `NODE_ENV=development` or `test`).

## Become admin in dev

Start the backend with `HBR_DEV_ADMIN_EMAIL=you@example.com` and `NODE_ENV=development`, then sign up in the UI with that exact email — the account is created as an instance admin.

## Fake CPA for local AI calls

`bun run dev` starts it automatically on http://127.0.0.1:8399 when `CPA_BASE_URL` is unset. To run it standalone:

```sh
bun tests/fake-cpa.ts   # listens on http://127.0.0.1:8399
```

Start the backend with `CPA_BASE_URL=http://127.0.0.1:8399 CPA_ACCESS_KEY=<any>` so gateway calls route to it.

## E2E UI check

Isolated stack (fake CPA :8399, API :3099, vite :5199, fresh SQLite each up):

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
bun run test                                  # stop your dev backend first (port 3000 conflict)
bunx tsc -p apps/api/tsconfig.json --noEmit   # API type check
cd apps/web && bunx tsc -b                    # web type check
```

## Troubleshooting

- Port 3000 in use: `lsof -nP -iTCP:3000 -sTCP:LISTEN`
- 403 "invalid origin" on signup: `BETTER_AUTH_URL` must equal the URL in the browser bar.

## Cloudflare Turnstile (optional, off by default)

Bot protection for `/sign-in/email` and `/sign-up/email`, enabled only when both sides are configured:

- `VITE_TURNSTILE_SITE_KEY` — build-time env for the web image (frontend widget)
- `TURNSTILE_SECRET_KEY` — API env (Better Auth `captcha` plugin, provider `cloudflare-turnstile`, reads the `x-captcha-response` header)

When either is unset, auth behaves exactly as before. The frontend widget is skipped on localhost/127.0.0.1/::1, so local dev never needs it. For staging, Cloudflare's test keys work: site `1x00000000000000000000AA`, secret `1x0000000000000000000000000000000AA` (always passes).

## Legal pages

Terms of Service (`/terms`) and Privacy Policy (`/privacy`) are public pages rendered from the markdown source of truth at `apps/web/src/pages/legal/content/`. Operator-specific facts (`{{OPERATOR_NAME}}`, `{{CONTACT_EMAIL}}`, `{{EFFECTIVE_DATE}}`) come from `VITE_LEGAL_OPERATOR_NAME`, `VITE_LEGAL_CONTACT_EMAIL`, and `VITE_LEGAL_EFFECTIVE_DATE` (visible `[operator name]`-style placeholders when unset).
