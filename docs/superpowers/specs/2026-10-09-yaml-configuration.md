# Unified YAML Startup Configuration — Design (NORMATIVE, approved)

Status: approved by user (env-per-field > YAML > optional defaults, requiredness evaluated **after merge** across all startup config). Scope: apps/api startup config only. No product source changes in the prep commit.

## Goal

One typed startup config for the API: optional YAML file + environment variables, merged per-field, validated once after merge, injected explicitly. Env-only deployments keep today's behavior exactly.

## Non-goals

- No remote reload/watch, no interpolation, no includes, no secret stores, no provider network calls at config load.
- No replacement of DB-admin config (payment methods, catalog, pricing/markup, branding) or historical money snapshots. `HBR_USD_VND_RATE` stays a default for new usage records only — never overrides stored `upstream_cost_usd_micro` / `usd_vnd_exchange_rate`.
- Docker/compose fields (`POSTGRES_PASSWORD`, `HBR_IMAGE_TAG`, ports) and test-only DB URL stay outside the app config file.
- `NODE_ENV` remains a runtime env security-mode selector, never set from YAML.
- CPA's own third-party YAML (`deploy/cpa/config.yaml`) untouched.

## Architecture

- New loader owned by **apps/api** (`apps/api/src/config/`), parsed with `Bun.YAML.parse` + existing `zod` (direct dep of apps/api). No new dependencies, no new framework.
- Load once at startup in `apps/api/src/index.ts`; resolved config passed as explicit parameters. **Injection preferred; `process.env` mutation forbidden** in the loader and in callers' new seams.
- Packages never import apps/api. `packages/db` `createDb` receives the resolved database URL explicitly (existing `createDb(url)` param — caller passes merged value).
- Existing env-map helpers keep their standalone behavior (regression tests that call them with an env record directly are preserved): `readOAuthCredentials`/`oauthProviderFlags` (oauth-config.ts:45), `payosConfigFromEnv` (packages/payments/src/provider.ts:64), `sendVerificationEmail(..., env)` (email.ts:364), `createAuth` reads env (auth.ts:50) — the loader resolves values first; a startup pass validates merged semantics (see partial rules).

## File resolution

- `HBR_CONFIG_FILE` explicit path; default `config.yaml` in the working directory. Absent default file = env-only (today's behavior). **Explicitly configured missing file = startup error.**
- Size cap 1 MiB. Unknown keys rejected (strict). Malformed YAML fails; error messages carry field paths/codes only — never parser text, file content, or values.

## Merge & validation (the contract)

- Precedence per field: **explicit env > YAML > optional default**.
- Env presence = `Object.hasOwn(env, KEY)`; a present-but-empty env value is **present and invalid** — required field fails, optional field fails; **no YAML fallback** for present env.
- Type-mismatched explicit env value (e.g. non-integer port) = failure, no fallback.
- All requiredness decided **after merge**: any required secret missing from both env and YAML fails startup with the selected field path only.
- Production hard requirements: `auth.secret` (env `BETTER_AUTH_SECRET`/`AUTH_SECRET`) length ≥ 32; `database.url` a `postgres://` URL. No fake/default secret values accepted in production.
- Feature-conditional requiredness: SMTP (HOST+FROM enable-pair; USER+PASSWORD both-or-omit), Turnstile, payOS (all three of CLIENT_ID/API_KEY/CHECKSUM_KEY) are required **only when their feature is active**; all-absent = feature disabled (current meaning preserved).
- **Partial credentials fail at startup after merge**: if any member of an enabling group is present (env or YAML) but the group is incomplete — OAuth provider id/secret pair, payOS triple, SMTP pair, captcha secret-without-site-key — startup fails. Previously partial OAuth only warned+disabled; that changes at the new startup gate. Standalone helper calls (old env map, tests) keep warn/disable behavior; this behavioral change is documented here as intentional and applies to the startup path only.

## YAML shape & aliases

snake_case tree mapping to exact env aliases (full inventory: scout artifact `3a9f0801-.../config/application-inventory.md`):

| YAML path                                                                 | Env alias                                                                                        | Type / default                               |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `server.port`                                                             | `PORT`                                                                                           | int, 3000                                    |
| `server.idle_timeout_s`                                                   | `HBR_IDLE_TIMEOUT_S`                                                                             | int 1–255, 255                               |
| `server.web_dist`                                                         | `HBR_WEB_DIST`                                                                                   | string, apps/web/dist                        |
| `server.avatar_dir`                                                       | `HBR_AVATAR_DIR`                                                                                 | string, ./data/avatars                       |
| `database.url`                                                            | `DATABASE_URL`                                                                                   | string (postgres://), required               |
| `auth.secret`                                                             | `BETTER_AUTH_SECRET` / `AUTH_SECRET`                                                             | string, ≥32 in prod                          |
| `auth.base_url`                                                           | `BETTER_AUTH_URL` / `HBR_BASE_URL`                                                               | string; required in prod                     |
| `auth.trusted_origins`                                                    | `HBR_TRUSTED_ORIGINS`                                                                            | YAML array of strings (env: comma-separated) |
| `auth.oauth.<google/discord/github>.client_id` / `.client_secret`         | `HBR_OAUTH_<ID>_{CLIENT_ID,CLIENT_SECRET}`                                                       | strings, pair                                |
| `bootstrap.instance_admin_email`                                          | `HBR_BOOTSTRAP_INSTANCE_ADMIN_EMAIL`                                                             | string, opt                                  |
| `email.smtp.host` / `.from` / `.port` / `.secure` / `.user` / `.password` | `SMTP_HOST` / `HBR_EMAIL_FROM` / `SMTP_PORT` / `HBR_SMTP_SECURE` / `SMTP_USER` / `SMTP_PASSWORD` | string/int/enum, opt pair                    |
| `captcha.turnstile.site_key` / `.secret_key`                              | `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY`                                                    | strings, opt                                 |
| `cpa.base_url` / `.access_key` / `.management_key`                        | `CPA_BASE_URL` / `CPA_ACCESS_KEY` / `CPA_MANAGEMENT_KEY`                                         | strings; keys server-only                    |
| `gateway.enabled`                                                         | `HBR_GATEWAY_ENABLED`                                                                            | bool, false                                  |
| `billing.usd_vnd_rate`                                                    | `HBR_USD_VND_RATE`                                                                               | int, 26000 (new-record default only)         |
| `payments.payos.client_id` / `.api_key` / `.checksum_key`                 | `PAYOS_CLIENT_ID` / `PAYOS_API_KEY` / `PAYOS_CHECKSUM_KEY`                                       | strings, triple                              |
| `payments.mock.enabled` / `.webhook_key`                                  | `HBR_MOCK_PAYMENTS` / `HBR_MOCK_PAYMENTS_WEBHOOK_KEY`                                            | bool/string, dev                             |

IDs, URLs, secrets are quoted strings; ports ints. All values are env-equivalent scalars — no expressions.

## Secrets & operations

- Example file ships with every group present, placeholder values only — never real credentials.
- Real `config.yaml` is gitignored; in Docker it is mounted server-only (never web bundle, never browser). Secret handling rules of AGENTS.md apply (never logged in full; CPA management key admin-only).
- Errors: field path + stable code (e.g. `CONFIG_MISSING_REQUIRED`, `CONFIG_INVALID_VALUE`, `CONFIG_FILE_UNREADABLE`, `CONFIG_UNKNOWN_KEY`, `CONFIG_FILE_TOO_LARGE`), redacted.

## Test matrix (specified now, implemented in plan)

env-only == current behavior; YAML-only; per-field env-over-YAML; empty-env present-invalid (required fail, optional fail, no YAML fallback); explicit-env-wrong-type no fallback; required secret missing both → fail with field path; partial OAuth/payOS/SMTP group fail at startup; all-absent feature disabled; strict unknown key; malformed YAML redacted; 1 MiB cap; explicit missing file fails, default absent OK; boolean/int coercion; standalone helper unit tests unchanged; auth/admin/payment regression suites unaffected.
