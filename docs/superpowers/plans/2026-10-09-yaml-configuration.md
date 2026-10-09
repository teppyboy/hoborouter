# Unified YAML Startup Configuration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans, task-by-task, checkbox tracking.

**Goal:** Optional YAML startup config + env, merged per-field (explicit env > YAML > optional default), validated once after merge, injected explicitly. Per approved spec `docs/superpowers/specs/2026-10-09-yaml-configuration.md` (NORMATIVE).

**Tech Stack:** Bun.YAML.parse (builtin), Zod 4 (existing apps/api dep). No new dependencies.

**Global constraints:**
- Loader lives in `apps/api/src/config/` (API-owned). Packages never import apps/api.
- `process.env` mutation forbidden anywhere in the new code; resolved config passed as explicit parameters.
- Errors: field path + code only — no parser text, file content, or values.
- Env presence = `Object.hasOwn`; present-empty = present-invalid, no YAML fallback; wrong-typed explicit env = fail, no fallback.
- Requiredness after merge. Production: `auth.secret` ≥ 32 chars, `database.url` postgres://. Partial OAuth/payOS/SMTP/captcha group = startup fail; all-absent = feature disabled.
- Standalone helper unit behavior preserved (`readOAuthCredentials`, `payosConfigFromEnv`, `sendVerificationEmail` env-map tests unchanged); startup-gate partial-fail is the documented behavioral change.
- Workers never stage/commit; integration executor commits, explicit paths only.
- Do NOT touch: root `package.json` (user edit, currently stashed — see isolation record), applied migrations, DB-admin config, deploy/cpa/config.yaml, historical money snapshots.

## Caller / seam map (verified at HEAD 9dc5ff9)

| Seam | File | Current | Planned ownership |
|---|---|---|---|
| Entry | `apps/api/src/index.ts:9-24` | `createDb()` / env reads | loader first; `createDb(cfg.database.url)`; pass cfg down |
| App | `apps/api/src/app.ts:104-152` | `deps.db ?? createDb()`, `payosConfigFromEnv()` | accept resolved cfg via `AppDeps`; payOS cfg from merged config |
| Auth | `apps/api/src/auth.ts:50-80` | env reads incl. secret/baseURL/trusted_origins | accept resolved auth config param (env fallback kept for direct tests) |
| OAuth | `apps/api/src/oauth-config.ts:45` | env-map helper, partial → warn+disable | signature unchanged; startup gate adds merged partial-fail |
| SMTP | `apps/api/src/email.ts:364` | `sendVerificationEmail(args, env)` | signature unchanged; enable-pair validated at startup gate |
| payOS | `packages/payments/src/provider.ts:64` | `payosConfigFromEnv(env)` | signature unchanged; caller passes merged env/config record |
| Public config | `apps/api/src/routes/public-config.ts:35-39` | turnstile site key env | reads resolved config via deps |

## Tasks

### Task 1 — Loader core (Owner A)
**Files:** create `apps/api/src/config/loader.ts`, `apps/api/src/config/schema.ts`, `apps/api/src/config/aliases.ts`; tests `tests/config-loader.test.ts`.
- Zod strict schema (unknown key → `CONFIG_UNKNOWN_KEY`), alias table from spec.
- Resolve: read `HBR_CONFIG_FILE` (explicit missing → fail; default absent → OK), 1 MiB cap, `Bun.YAML.parse` in try/catch (redact), per-field merge `Object.hasOwn(env, k) ? env : yamlValue ?? default`, then full-schema validation. Return frozen resolved config + merged env record (no `process.env` writes).
- Tests: full matrix items 1–8, 11–13 of spec test list.

### Task 2 — Startup gate: groups & production requirements (Owner A)
**Files:** `apps/api/src/config/gate.ts`; tests in `tests/config-loader.test.ts` (extend).
- After merge: required-secret-missing, prod secret ≥32, postgres URL, partial group detection (OAuth pairs, payOS triple, SMTP enable-pair + user/password pair, captcha secret-without-site-key), prod SMTP `none` refusal.
- Tests: matrix items 9–10 + feature-off cases.

### Task 3 — Wire startup (Owner B, after A)
**Files:** `apps/api/src/index.ts`, `apps/api/src/app.ts` (AppDeps), `apps/api/src/auth.ts` (optional resolved param), `apps/api/src/routes/public-config.ts`.
- `index.ts`: `const cfg = await loadConfig()` → `createDb(cfg.database.url)` → `buildApp({ db, cfg })`. No behavior change when env-only.
- Tests: `tests/config-startup.test.ts` — env-only == current behavior; config supplied via deps overrides env reads.

### Task 4 — Example file + isolation (Owner C, parallel)
**Files:** `config.yaml.example` (all groups, placeholders only), `.gitignore` += `/config.yaml`, `docs/ops/` note: file path, Docker mount server-only, NODE_ENV stays env.
- No source changes.

### Task 5 — Integration (Owner I)
- Full `PORT=3998 bun run test` + `bun run check` + type checks. Coherent commits, explicit paths: new config files, tests, wiring, example/ops docs.

## Review focus

- Present-but-empty env value never falls back to YAML (required AND optional).
- Partial payOS/SMTP group fails startup (not silently disabled) while all-absent stays disabled.
- No test asserts on source file contents; helper unit tests still pass untouched.
- No new dependency in package.json; no `process.env` mutation in diff.

## Barriers

- B0: Task 2 needs Task 1 schema; Task 3 needs Tasks 1–2 exports; Task 4 independent.
