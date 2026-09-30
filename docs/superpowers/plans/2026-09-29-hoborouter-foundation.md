# Hoborouter Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **All boxes stay unchecked until an executor actually completes them.**

**Revision:** r4 — r3 fixes retained; closes the three r3 review blockers: (1) Better Auth CLI identity clarified — two distinct packages (`@better-auth/cli@1.4.21` chosen/tested, no adapter/dialect flags on that package; separate `auth@1.7.6` CLI has them and is intentionally unused); (2) `requests.status` gains `pending` in data-model.md as the defined pre-dispatch state with explicit dispatch transitions; (3) `createReservation`/`releaseHold` ownership enforced in-transaction with cross-workspace/snapshot-mismatch negative tests. All boxes remain unchecked. Foundation money scope reduced: **no settlement primitive at all** (reserve/release only); settlement deferred to the Phase 2 gateway plan.

**Goal:** Stand up the Hoborouter foundation — Bun workspace, Vite+-built React 19 SPA served by an Elysia 2 API, Drizzle/`bun:sqlite` WAL schema with Better Auth verified end-to-end, private pinned CPA in Docker Compose with a Phase 0 probe report, keys, catalog/price snapshots, VND wallet + append-only ledger + **reserve/release hold core** (no settlement), and guarded mock top-up — with **paid AI traffic disabled**.

**Architecture:** Approach 3 (risk-limited phased gateway) per the spec. Gateway owns tenancy, money, idempotency; CPA owns provider protocols and lossy usage attestation. Foundation implements **no AI proxy routes, no usage poller, no settlement code, and no automatic CPA settlement of any kind** — those are Phase 2 gateway milestones. The wallet/ledger/reserve-release core is the money-safety substrate, tested standalone.

**Tech Stack:** Bun 1.4 (runtime, test runner), Elysia 2, Drizzle ORM + `bun:sqlite` (WAL), Better Auth **`better-auth@1.7.6` + `@better-auth/drizzle-adapter@1.7.6` (exact, no `^`)** with `@better-auth/cli@1.4.21` (chosen generate CLI — see Task 3 for the two-CLI distinction), Vite+ `vite-plus@1.0.0` standalone CLI (build toolchain, run under Node 24.x pinned via `vp env pin lts` — verified to resolve Node 24.21.0), React 19 (static SPA), Docker Compose + `router-for-me/CLIProxyAPI` (release pinned at execution time, never guessed here).

**Spec:** `docs/architecture/architecture.md` (primary; read with `docs/architecture/data-model.md` and `docs/architecture/api-boundaries.md` — the plan argues from all three; executors read all three plus this plan).

## Global Constraints

- **PAID AI TRAFFIC IS DISABLED FOR THE ENTIRE PLAN.** No `/v1/chat/completions` or `/v1/responses` proxy routes exist in this foundation. Phase 0 probe success alone does NOT authorize paid traffic (architecture.md §8: bounded-loss cap, streaming/abort policy, UNKNOWN review ops, monitoring thresholds are all still `[OPEN — HUMAN]`).
- **Better Auth `users` migration preflight (Task 3, blocking, empirically verified 2026-09-29):** before applying the Better Auth upgrade migration to ANY non-test database, run `SELECT count(*) FROM users`. If `count > 0` → **STOP: preserve the database unchanged and request an operator-authenticated, real-email migration decision.** The migration adds `email TEXT NOT NULL` / `name TEXT NOT NULL` without defaults, which SQLite rejects on a populated table, and there is no legitimate value to invent — do NOT synthesize fake emails and do NOT drop rows. Only fresh DBs and empty-`users` upgrades are supported by the tested path. As of 2026-09-29 no project `*.db`/`*.sqlite` files exist.
- **No settlement in this foundation.** `settleReservation`, refunds, usage-event assignment (`settlement_usage_events` writes), refund operations, and any automatic CPA settlement are **deferred to the Phase 2 plan verbatim from data-model.md §2** (including atomic usage-event assignment and zero-charge behavior). Only `creditWallet`, `createReservation`, and `releaseHold` exist. The schema still declares `settlements`, `settlement_usage_events`, `unknown_resolutions`, `refund_operations` tables and their constraints — that is the preserved architectural spec for Phase 2; no application code touches them.
- Runtime is Bun; builds run under Node. Installed environment: Node v25.8.1, Bun 1.4.0, Docker 29.4.0 (verified). **Node 25 does NOT satisfy `vite-plus@1.0.0` engines (`^22.18.0 || ^24.11.0 || >=26.0.0`)** — Task 0 pins Node 24.x via the standalone `vp` CLI before any `vp` command.
- **Vite+ CLI preflight (VERIFIED 2026-09-29, r3):** the npm/npx-installed `vp` shim **refuses `vp env` (exit 2: "only available in the global `vp` CLI")**. The **standalone** install works: `curl -fsSL https://vite.plus | bash` with `VP_VERSION=1.0.0` → `~/.local/share/vite-plus/bin/vp`. Verified against that standalone v1.0.0: `vp env pin lts` → pins/installs **Node 24.21.0** (writes `.node-version`); `vp env pin 24` (numeric pin) appears in `vp env pin --help`; `vp env exec --node lts <cmd>` appears in `vp env --help`; `vp create vite -- --template react-ts --no-git` **actually ran** and scaffolded a React 19 + TypeScript Vite+ project (React 19.2.x). **Verified LIMITATION: `vp create --directory <DIR>` and `--package-manager bun` were silently IGNORED in v1.0.0** (project landed in `vite-project/` with pnpm). Task 0 works around this and must not rely on those two flags. If the scaffold command shape changes at execution time, STOP and re-verify from `--help`.
- Vite+ is `vite-plus@1.0.0`; if a newer version is current at execution time, re-verify engines and command surface against viteplus.dev before pinning.
- Money: VND integers only, no floats, no subunits. **Every money column carries `CHECK(typeof(col) = 'integer')`** plus positivity checks where required — SQLite INTEGER affinity alone can store non-integral reals and is not trusted. Times: epoch ms integers. IDs: UUID v4.
- Wallet invariants (data-model.md §3): `balance >= 0 AND reserved >= 0 AND balance >= reserved` enforced by check constraints; `available = balance − reserved` derived, never stored.
- Ledger is an append-only **single-wallet event ledger, not double-entry**. Hold release writes NO ledger row. One topup credit per payment. (Settle/refund ledger rows are a Phase 2 concern; their partial unique indexes ship in the schema now per the preserved spec.)
- `sk-hbr-` plaintext shown once, SHA-256 hash stored, never retrievable. Leak scan covers DB file **and WAL/SHM sidecars, captured logs, and error responses**.
- **FK enforcement is per-connection:** `PRAGMA foreign_keys = ON` on every connection in `createDb`, asserted in tests, plus orphan-insert rejection tests.
- No CPA version, tag, or config value is invented anywhere: Task 5 pins the actual latest upstream release at execution time and snapshots its real `config.example.yaml`.
- **No committed CPA secrets or placeholder keys (P1 fix).** No `${VAR}` interpolation is relied upon inside the mounted CPA config unless the pinned release verifiably supports it (verified from pinned release source/docs at execution). Default: config is **rendered at deploy time from environment variables** by a committed render script; rendered config is gitignored. Both CPA secrets (management key, gateway access key) are generated with a CSPRNG (`openssl rand -hex 32` or equivalent) into the gitignored `deploy/.env`. Committed files are tested to contain no secret material.
- CPA is published only on `127.0.0.1:8317` and protected by a 256-bit management key; single-owner self-hosted, no host firewall gate.
- **Phase 0 mock provider runs as a Compose service on `cpa-net`** (not in-process) so the `internal: true` network can reach it at a fixed internal URL (`http://mock-provider:8318`). Its config overlay is rendered only AFTER the pinned release's `config.example.yaml` is fetched, using field paths read verbatim from that snapshot; unconfirmable field paths → UNKNOWN verdict, never an invented path.
- **Private network ≠ egress policy (P1 note):** `internal: true` blocks ALL egress including provider calls. Foundation has zero provider usage so this is correct now. **Phase 2 must revisit:** a later plan needs an explicit egress-capable network design (host-isolated but provider-egress-allowing) and its own review. This plan does not decide it.
- Inbound client headers `X-CPA-TRACE-ID`, `X-Request-Id`, `OpenAI-Request-Id` are stripped at the gateway; only allowlisted CPA response headers forwarded (api-boundaries.md §5).
- **No git operations during authoring or execution.** This repository is Git-backed; task commit steps are replaced by verification commands. Implementers do NOT stage, commit, reset, or push.
- License: no AGPL code or paraphrase from new-api; concept-level reference only (docs/research/new-api.md).
- Mock payment provider is development/demo only: behind auth + feature flag, disabled when `NODE_ENV=production` (api-boundaries.md §3).
- Workspace roles are `owner|admin|member`. **Instance admin is provisioned independently of workspace roles** via an `instance_admins` table (user_id PK, FK → users) with a bootstrap procedure — see Task 3.
- **Do not convert unknown policy decisions into defaults.** Any probe result that cannot be deterministically proven locally is recorded UNKNOWN and paid traffic stays blocked; no executor fills gaps with assumptions.

## Review Focus

1. **Integer money corruption via float/number coercion** — a reader expects `balance`, `reserved`, `cap_amount`, prices to round-trip as exact integers; any `Number.parseFloat`/float arithmetic on VND is a defect. Test: Task 8 fuzz assertion (explicitly **sequential**, see P2 note), zero negative/fractional balances after 500 sequential operations; the separate two-connection gate in Task 8 covers concurrency.
2. **Ledger append-only violation** — a reader expects ledger rows never updated or deleted; corrections are new referencing rows only. Test: Task 8 attempt UPDATE/DELETE on `ledger_entries` → must fail (trigger).
3. **Plaintext key leakage** — a reader expects no `sk-hbr-` plaintext in any stored row, log line, list response, or error. Test: Task 4 scan of DB file **+ WAL/SHM sidecars + captured request logs + error responses** across create/list/revoke flows; plaintext appears ONLY in the single creation response.
4. **CPA exposure to host/Internet** — a reader expects CPA unreachable from the host network namespace even though bridge-network IPs are host-routable. Test: Task 5 reachability from a Compose peer (must succeed) and from the host namespace (must fail), with `internal: true` network and no published ports.
5. **Mock top-up double credit** — a reader expects duplicate webhook replay to produce exactly one ledger credit per payment. Test: Task 9 replay + `UNIQUE(provider, provider_reference)` assertions.

---

### Task 0: Bun workspace scaffold + Vite+ toolchain pin

**Depends on:** nothing (first task).

**Files:**

- Create: `package.json` (workspace root), `tsconfig.base.json`, `.gitignore`, `vite.config.ts`
- Create: `apps/web/` (Vite+ React scaffold), `apps/api/` (Bun+Elysia package), `packages/shared/` (shared TS types/constants package)
- Test: `tests/toolchain/toolchain.test.ts`

**Interfaces:**

- Produces: workspace layout `apps/*`, `packages/*`; root scripts via `vp run`; shared package `@hoborouter/shared` exporting `const VND_CURRENCY = 'VND'` and `type EpochMs = number`. Every later task consumes these paths and package names.

- [ ] **Step 1: Vite+ CLI preflight (BLOCKING — verified baseline, re-run to confirm).** The npm/npx-installed `vp` shim exits 2 on `vp env` (verified) — install the **standalone** CLI first: `curl -fsSL https://vite.plus | bash` with `VP_VERSION=1.0.0`, then put `~/.local/share/vite-plus/bin` first on PATH and confirm `which vp` → `~/.local/share/vite-plus/bin/vp`. Capture verbatim: `vp --version` (expect v1.0.0), `vp env --help`, `vp env pin --help`, `vp create --help`, `vp test --help`. Verified reference point (2026-09-29): `vp env pin lts` valid; numeric pin (`vp env pin 24`) shown in help; `vp create vite -- --template react-ts --no-git` actually scaffolded React 19; **`--directory` and `--package-manager` silently ignored in v1.0.0**. If local output diverges from this baseline (newer vp, changed flags), re-verify each needed flag from `--help` and a throwaway scaffold run; any unconfirmable command shape → STOP and report, no guessing.
- [ ] **Step 2: Pin Node.** From the repo root run `vp env pin lts` (verified to pin Node 24.21.0 and write `.node-version`; prefer the explicit numeric form `vp env pin 24` only if it ran in the throwaway preflight). Then **verify the managed Node via the actual PATH/shim, not prose**: enable managed mode (`vp env on`) or use `vp env print` to obtain the shim PATH, and assert `command -v node` resolves inside the Vite+ managed bin directory and `node -v` reports 22.18+/24.x (NOT 25.x). If the shell cannot resolve the managed shim, invoke Node 24 explicitly for every build command as `vp env exec --node 24.21.0 node <args>` (form verified in `vp env --help`) and record that in the task notes.
- [ ] **Step 3: Write failing toolchain test** `tests/toolchain/toolchain.test.ts` (imports `VND_CURRENCY` from `@hoborouter/shared`, per viteplus.md tests import from `vite-plus/test`):
  ```ts
  import { test, expect } from "vite-plus/test";
  import { VND_CURRENCY } from "@hoborouter/shared";
  test("workspace layout exists", () => {
    expect(VND_CURRENCY).toBe("VND");
  });
  ```
- [ ] **Step 4: Red run** — `vp test tests/toolchain/toolchain.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 5: Implement scaffold.** Root `package.json` with Bun workspaces (`"workspaces": ["apps/*", "packages/*", "tests"]`), `vite.config.ts` per viteplus.dev/guide/monorepo (root config with `lint`/`fmt` blocks). Scaffold `apps/web` with the VERIFIED command `vp create vite -- --template react-ts --no-git`: because `--directory` is silently ignored in v1.0.0 (verified), run it in a throwaway temp dir and move the generated `vite-project/` contents into `apps/web/`, deleting the throwaway. Record the actual scaffold output (package manager used — v1.0.0 chose pnpm; the workspace root stays Bun-managed, so run `bun install` at the root after the move). Do NOT rely on `--package-manager bun`. `apps/api` as a plain Bun package (`bun add elysia` → Elysia 2.x), `packages/shared` exporting `VND_CURRENCY` and `EpochMs`.
- [ ] **Step 6: Green** — `vp test` PASS; `vp check` (fmt+lint+typecheck) exits 0; `bun run apps/api/src/index.ts` smoke (a `console.log` entry) exits 0 under Bun. The web build runs under the pinned managed Node (verified shim resolution or `vp env exec` per Step 2 notes), never Node 25.
- [ ] **Step 7: NO commit.** Repository has no `.git`; git init is a pending human decision. Verification output above is the task's completion record.

> **Note (human decision, 2026-09-29):** the user explicitly approved the prerelease pin `elysia@2.0.0-exp.64` in `apps/api/package.json`. Do not silently downgrade to Elysia 1. Task 1 acceptance additionally REQUIRES compatibility tests for `@elysiajs/openapi` and `@elysiajs/static` against this prerelease before any check-off.

---

### Task 1: Elysia 2 API skeleton — health, OpenAPI, static SPA serving

> **Amendment (human decision, 2026-09-29, user-approved):** `@elysiajs/static` is replaced by a native `Bun.file` static helper in `apps/api/src/static-spa.ts` (~50 lines, no new dep). Scout evidence (isolated probe): `@elysiajs/static@1.4.10` hard-imports `NotFoundError`, removed from `elysia@2.0.0-exp.64` (module-load crash), and also imports undeclared `fast-decode-uri-component`; no 2.x/experimental release exists. Elysia pin stays `2.0.0-exp.64` (no downgrade). All other Task 1 acceptance criteria unchanged: SPA fallback, MIME, API-vs-static 404 semantics, dotfile/traversal/symlink rejection via realpath containment. Additionally verified during implementation: the OpenAPI spec JSON is served via `specPath: '/openapi.json'` (plugin default puts spec at `${path}/json`); docs UI mounted at `/docs`.

**Depends on:** Task 0.

**Files:**

- Create: `apps/api/src/index.ts`, `apps/api/src/app.ts`, `apps/api/src/routes/health.ts`
- Modify: `apps/web/vite.config.ts` (build output to `apps/web/dist`)
- Test: `apps/api/test/app.test.ts`

**Interfaces:**

- Produces: `buildApp(): Elysia` in `apps/api/src/app.ts` — the single app factory every later route task mounts into; `GET /healthz` → `{ status: 'ok' }`; static file serving of `apps/web/dist` at `/` (SPA fallback to `index.html`); OpenAPI document served at `/openapi.json` (Elysia's `@elysiajs/openapi` plugin with `path: '/openapi.json'`).
- Consumes: workspace layout from Task 0.

- [ ] **Step 1: Failing test** `apps/api/test/app.test.ts` (Bun test):
  - `GET /healthz` → status 200, body `{status:'ok'}`.
  - `GET /openapi.json` → 200, JSON body has `openapi` key and a `paths` entry for `/healthz`.
  - With a fixture `dist/index.html` written to the served dir → `GET /` returns its contents; `GET /some/spa/route` returns `index.html` (SPA fallback).
- [ ] **Step 2: Red run** — `bun test apps/api/test/app.test.ts` → FAIL.
- [ ] **Step 3: Implement** `buildApp()` mounting health router, `@elysiajs/openapi`, and static plugin (`@elysiajs/static` with SPA fallback; dist dir overridable via `process.env.HBR_WEB_DIST` so tests inject fixtures).
- [ ] **Step 4: Green run** — `bun test apps/api/test/app.test.ts` → PASS. Also the confirmed `vp build` command for `apps/web` succeeds and `apps/web/dist/index.html` exists.
- [ ] **Step 5: NO commit.**

---

### Task 2: Drizzle schema + `bun:sqlite` WAL migrations (core tables)

**Depends on:** Task 0.

**Files:**

- Create: `packages/db/src/client.ts`, `packages/db/src/schema.ts`, `packages/db/src/migrate.ts`, `packages/db/drizzle/` (generated migrations + snapshots)
- Test: `packages/db/test/schema.test.ts`

**Interfaces:**

- Produces: `createDb(path: string): Database` (opens `bun:sqlite`, `PRAGMA journal_mode = WAL`, `PRAGMA busy_timeout = 5000`, **`PRAGMA foreign_keys = ON`**); `migrate(db: Database): void` (runs pending Drizzle migrations — including the Better Auth migration artifact produced in Task 3 once it exists; until then it applies the non-auth migrations); full typed schema exports named exactly per data-model.md §2: `users, sessions, accounts, verifications, workspaces, workspaceMembers, instanceAdmins, apiKeys, wallets, ledgerEntries, payments, paymentEvents, modelBindings, priceSnapshots, requests, reservations, usageEvents, settlements, settlementUsageEvents, unknownResolutions, refundOperations, auditLog` (auth tables created via the Better Auth migration in Task 3; this task creates the non-auth tables).
- Consumes: `@hoborouter/shared`.

**Money-column constraint rule (P1 fix):** every money column (`balance`, `reserved`, `cap_amount`, `amount`, `price_input`, `price_output`, `price_input_per_1m`, `price_output_per_1m`, `charged_*` when Phase 2 enables them) is declared with `CHECK(typeof(col) = 'integer')` plus domain checks (`balance >= 0`, `reserved >= 0`, `balance >= reserved`, ledger `amount > 0`). SQLite INTEGER affinity is NOT relied upon to reject reals.

- [ ] **Step 1: Failing tests** `packages/db/test/schema.test.ts` (Bun test against an in-memory-file SQLite):
  1. `migrate` runs cleanly twice (idempotent).
  2. Pragmas: `journal_mode` returns `wal`; `foreign_keys` returns `1` **on a fresh connection from `createDb`**.
  3. **Orphan FK rejection:** inserting a `wallets` row with nonexistent `workspace_id`, a `ledger_entries` row with nonexistent `wallet_id`, and a `reservations` row with nonexistent `wallet_id`/`price_snapshot_id` each → throws.
  4. Wallet check constraints: `balance = -1` → throws; `reserved > balance` → throws; **`balance = 1.5` → throws (typeof CHECK)**; same for `reserved`.
  5. `ledgerEntries` partial unique indexes: second `kind='topup'` row with same `payment_id` → throws; ledger row with `amount = 0` or negative → throws (CHECK `amount > 0`); `refund` row with NULL `original_ledger_entry_id` → throws (check `kind != 'refund' OR original_ledger_entry_id IS NOT NULL`).
  6. Schema-spec uniqueness for Phase 2 tables (constraints ship now, code comes later): second `kind='settle'` ledger row with same `reservation_id` → throws; `settlements.reservation_id` UNIQUE; `settlementUsageEvents.usage_event_id` UNIQUE; `unknownResolutions.resolution_key` UNIQUE and `request_id` UNIQUE; `refundOperations.operation_key` UNIQUE and `original_ledger_entry_id` UNIQUE.
  7. `reservations.gateway_request_id` UNIQUE; `paymentEvents` UNIQUE `(provider, provider_reference)`.
  8. **Append-only trigger:** `UPDATE ledger_entries SET amount = 1` and `DELETE FROM ledger_entries` → SQLite error (trigger `RAISE(ABORT)`).
- [ ] **Step 2: Red run** — `bun test packages/db/test/schema.test.ts` → FAIL.
- [ ] **Step 3: Implement** schema exactly per data-model.md §2 (columns, kinds, directions, FKs, partial unique indexes, check constraints, typeof money CHECKs, append-only trigger) and `migrate.ts` using Drizzle's `bun:sqlite` migrator. All times epoch ms INTEGER, money INTEGER.
- [ ] **Step 4: Green run** — `bun test packages/db/test/schema.test.ts` → PASS. Migration snapshot files exist under `packages/db/drizzle/`.
- [ ] **Step 5: NO commit.**

---

### Task 3: Better Auth on Drizzle/`bun:sqlite` + instance admin + workspaces + RBAC

**Depends on:** Tasks 1, 2.

**Files:**

- Create: `apps/api/src/auth.ts` (Better Auth instance + config), `apps/api/src/db/bridge.ts` (Better Auth ↔ Drizzle adapter wiring per Better Auth's Drizzle adapter docs), `apps/api/src/routes/workspaces.ts`, `apps/api/src/routes/members.ts`, `apps/api/src/authz.ts` (role-check middleware), `apps/api/src/routes/audit.ts`
- Create (generated, committed): `packages/db/src/auth-schema.ts` (Better Auth CLI output), `packages/db/drizzle/000X_better_auth.sql` (generated migration)
- Modify: `apps/api/src/app.ts` (mount auth + workspace routes), `packages/db/src/migrate.ts` (applies the generated Better Auth migration)
- Test: `apps/api/test/auth.test.ts`, `apps/api/test/rbac.test.ts`, `packages/db/test/betterauth-migration.test.ts`

**Better Auth migration wiring (r3 — exact versions, tested command, one canonical schema module):**

1. Pin **exact** versions (verified to exist on npm 2026-09-29): `better-auth@1.7.6` and `@better-auth/drizzle-adapter@1.7.6` in `apps/api/package.json` (exact, no `^`).
   **Two distinct CLI packages (P1 fix — do not conflate them):**
   - `@better-auth/cli@1.4.21` — the generate CLI **chosen for this plan**. Its `generate --help` exposes only `--config`, `--output`, `--yes`, `--cwd`; it has **no `--adapter`/`--dialect` flags** (scoped to this package only). It was installed and exercised: the Task 3 generate command was actually run against better-auth@1.7.6 and produced a Drizzle sqlite-table schema. Record the version mismatch vs better-auth@1.7.6 in the task notes.
   - `auth@1.7.6` — a **separate npm CLI package** that exposes `--adapter` and `--dialect` flags on its `generate` command. It exists but is **intentionally unused by this plan** (untested here; the tested command below uses `@better-auth/cli@1.4.21`). Do NOT claim `@better-auth/cli` is "the current" or the only Better Auth CLI, and do NOT claim `--adapter`/`--dialect` flags are absent from all Better Auth CLIs — they are absent only from `@better-auth/cli@1.4.21`.
     If a newer `@better-auth/cli` is current at execution, re-verify its `generate --help` first.
2. `apps/api/src/auth.ts` exports the Better Auth config with `database: drizzleAdapter(db, { provider: 'sqlite', schema: { ...schema, user: schema.users } })` and `user: { modelName: 'users' }` — the adapter (drizzle) and dialect (sqlite) are declared HERE in the config, which is why the chosen `@better-auth/cli@1.4.21` needs no adapter/dialect flags (that package's `generate --help` offers only `--config`, `--output`, `--yes`, `--cwd`). The `user: schema.users` alias is REQUIRED (tested): drizzleAdapter looks up singular model key `user`, while the canonical export key is `users`.
3. **ORDERING (P1 fix — run this generate BEFORE editing `schema.ts` in step 4):** the CLI loads `apps/api/src/auth.ts`, which imports `packages/db/src/schema.ts`; if `schema.ts` already imports the not-yet-generated `./auth-schema`, config load fails with a missing-module error. The Task 2 placeholder `users` (still present in `packages/db/src/schema.ts`) satisfies `schema.users` here, so `auth.ts` compiles pre-edit. Generate (TESTED command, verified in an isolated /tmp sandbox with better-auth@1.7.6 + cli@1.4.21; AFTER pin/install, invoke via bun so the config can resolve `bun:sqlite` — `@better-auth/cli` runs the config under Node/jiti and FAILS via `bunx` with `Cannot find module 'bun:sqlite'`): `bun node_modules/@better-auth/cli/dist/index.mjs generate --config apps/api/src/auth.ts --output packages/db/src/auth-schema.ts --yes`.
4. NOW edit the canonical schema module: `packages/db/src/schema.ts` **deletes its Task 2 placeholder `users` table**, then imports and re-exports the four auth tables from `packages/db/src/auth-schema.ts` (CLI output) — `import { users, session, account, verification } from './auth-schema'; export { users, session, account, verification };` — plus all app tables, and exports one combined `schema` object. ALL FOUR must be re-exported (tested: exporting only `users` makes drizzle-kit drop `session`/`account`/`verification` from the diff; bare `export *` breaks FK builders like `users.id.references(...)` because the scope-local binding is missing). That SAME `schema` module is passed to `drizzle(db, { schema })` in the client, to `drizzleAdapter`, and to the Drizzle migration generator — one source of truth, no duplicated table definitions.
5. Turn the generated schema into a Drizzle migration committed under `packages/db/drizzle/` via `drizzle-kit generate` with a drizzle config whose `schema` points at `packages/db/src/schema.ts` (the canonical module). `packages/db/src/migrate.ts` applies that migration like any other; the app's auth instance uses the SAME `auth-schema.ts` via `schema.ts`.
6. **Verify the generated artifact explicitly (blocking):** after wiring, assert the generated `auth-schema.ts` exports Drizzle `sqliteTable` definitions for `users`, `session`, `account`, `verification` and that the migration (drizzle-kit 0002) **CREATEs `session`, `account`, `verification` and ALTERs `users`** (adds `name`, `email`, `email_verified`, `image`, `created_at`, `updated_at` + `users_email_unique`); it does NOT create `users` — that table already exists from Task 2. No drop/recreate of `users`: row identity and all FKs are preserved. **If the pinned Better Auth's generated schema is incompatible with `bun:sqlite`/Drizzle's dialect, STOP and report — do not hand-roll a replacement auth system without a decision.**

**Instance-admin provisioning (P1 fix — independent of workspace roles):**

- Schema: `instance_admins (user_id TEXT PK FK → users(id) ON DELETE CASCADE, created_at, added_by NULL)`.
- Bootstrap: `scripts/bootstrap-instance-admin.ts` — reads `HBR_BOOTSTRAP_INSTANCE_ADMIN_EMAIL` env, upserts the matching user's id into `instance_admins` (idempotent; run once per deployment by the operator).
- `requireInstanceAdmin()` middleware checks ONLY the `instance_admins` table. Workspace `owner` never grants instance admin; instance admin is not granted any workspace role implicitly (route matrix: instance admin gets `—` on ws-scoped routes).
- Tests: workspace owner is 403 on instance-admin routes; instance admin is 403 on ws-scoped routes; bootstrap script is idempotent.

- [ ] **Step 1: Pin versions + generate schema + write failing migration test** `packages/db/test/betterauth-migration.test.ts` — run the exact tested generate command (step 3 above), then assert after `migrate()` (BOTH on a fresh DB and on a DB upgraded from the Task 2 snapshot with an **empty `users` table**) that `users` gained the auth columns, `session`/`account`/`verification` exist, foreign-key integrity holds (`PRAGMA foreign_key_check` empty), and a user+session round-trips (insert via `auth.api.signUpEmail`, fetch session via `auth.api.getSession` with the returned cookie). This test IS the architecture Phase 1 gate. STOP on incompatibility per wiring rule 6. Sandboxed verification (2026-09-29): fresh and empty-users upgrade both apply; signUp/signIn/getSession round-trip passes; no project `*.db`/`*.sqlite` files exist. **A populated-`users` DB is a STOP** (see Global Constraints) — no destructive experiments on any project DB.
- [ ] **Step 2: Red run** — `bun test packages/db/test/betterauth-migration.test.ts` → FAIL (migration not yet wired).
- [ ] **Step 3: Implement** migrate wiring, auth instance, bridge, instance-admin bootstrap script, and workspace routes with the full route matrix from api-boundaries.md §2 (member/admin/owner/instance-admin, ws vs global scope, 403 on insufficient role, no cross-workspace reads) + audit writes on role mutations.
- [ ] **Step 4: Red→green RBAC tests** `apps/api/test/rbac.test.ts`: for each matrix row restricted to foundation routes that exist (workspaces CRUD, members, audit read, admin routes 403-for-non-instance-admins), a member/owner/instance-admin request asserts the matrix outcome (✓ → expected code; — → 403). Include the cross-role instance-admin tests above. Write failing assertions first, then verify PASS.
- [ ] **Step 5: Green run** — `bun test packages/db/test apps/api/test` → ALL PASS.
- [ ] **Step 6: NO commit.**

---

### Task 4: `sk-hbr-` API keys — hashed, shown once, revocable, workspace-bound

**Depends on:** Task 3.

**Files:**

- Create: `packages/keys/src/keys.ts`, `apps/api/src/routes/keys.ts`
- Test: `packages/keys/test/keys.test.ts`, `apps/api/test/keys-routes.test.ts`

**Interfaces:**

- Produces: `generateApiKey(): { plaintext: string; hash: string; prefix: string }` — plaintext format `sk-hbr-` + 32 hex chars; `hash` = SHA-256 hex of plaintext; `prefix` = `sk-hbr-…<last4>`. `hashApiKey(plaintext: string): string`.
- Routes (**explicit workspace binding, P1 fix**): every key route takes the workspace explicitly and enforces membership + role against THAT workspace:
  - `POST /api/workspaces/:wsId/keys` (admin/owner of `:wsId`) → response contains plaintext exactly once.
  - `GET /api/workspaces/:wsId/keys` (admin/owner of `:wsId`) → list without plaintext (prefix + status only), rows filtered to `:wsId`.
  - `DELETE /api/workspaces/:wsId/keys/:keyId` (admin/owner of `:wsId`; key's `workspace_id` must equal `:wsId` else 404) → immediate revocation.
    These are the foundation's key routes; the api-boundaries.md `/api/keys` shorthand is realized as the workspace-scoped routes above (console UI supplies `:wsId`). Any later alias route must reuse the same authz.
- Consumes: Task 3 authz middleware.

- [ ] **Step 1: Failing tests.** `packages/keys/test/keys.test.ts`: format matches `^sk-hbr-[0-9a-f]{32}$`; hash = SHA-256 of plaintext; two generations differ. `apps/api/test/keys-routes.test.ts`:
  - Member role of `:wsId` → 403 on all three routes.
  - **Cross-workspace denial:** admin of workspace A → 403 on `GET/POST/DELETE` under workspace B's `:wsId`; owner of A cannot revoke a key whose `workspace_id` is B (404/403 asserted).
  - POST response contains plaintext; subsequent `GET` response contains no plaintext.
  - **Leak scan (P2 fix):** after create + list + revoke flows, scan (a) the DB file, (b) the `-wal` and `-shm` sidecar files, (c) all captured response bodies including 4xx error responses, (d) captured server log output — assert the plaintext appears ONLY in the single creation response and nowhere else.
  - Revoked key → status `revoked` and `revoked_at` set.
- [ ] **Step 2: Red run** — `bun test packages/keys/test apps/api/test/keys-routes.test.ts` → FAIL.
- [ ] **Step 3: Implement** per interfaces. Store `key_hash` (UNIQUE), `key_prefix`, never plaintext.
- [ ] **Step 4: Green run** — same command → PASS.
- [ ] **Step 5: NO commit.**

---

### Task 5: Local CPA

CPA publishes only on `127.0.0.1:8317`, uses a generated 256-bit management key, and is operated with `scripts/cpa-dev.sh up|down|status`. Paid AI traffic remains disabled.

### Task 6: Phase 0 CPA probe stage — probe report, paid traffic still disabled

**Depends on:** Task 5.

**Files:**

- Create: `probes/phase0/probe.ts` (script, not shipped runtime code), `probes/phase0/mock-provider.ts` (deterministic local OpenAI-compatible provider with a per-path request counter — run as a **Compose service**, see below), `probes/phase0/mock-provider.compose.yml` (overlay adding the `mock-provider` service to the Task 5 stack), `probes/phase0/REPORT.md` (output), `probes/phase0/run.sh`

**Mock reachability (r3):** the mock runs as its own Compose service on `cpa-net` with a fixed internal URL `http://mock-provider:8318` (counter readable via `GET http://mock-provider:8318/__count` from inside the network, e.g. via the gateway service or a `docker compose exec` curl). An in-process mock is unreachable from an `internal: true` container — that design is forbidden here.

**Interfaces:**

- Produces: `REPORT.md` answering, on the pinned release only: (a) does `X-CPA-TRACE-ID` appear on response for success/error/non-stream cases? (b) usage queue: `GET /v0/management/usage-queue?count=10` and `GET /v8/management/observability/usage/queue` — payload schema verbatim, pop (not peek) confirmed by second call returning fewer/empty (upstream source already indicates pop for both; probe confirms on the pinned binary); (c) does any payload field carry the execution UUID (`Record.RequestID`) or only the trace ID? (d) retry-disable: with the pinned config's retry fields set to 0 (exact field paths read from the PINNED release's `config.example.yaml` — research verifies `routing.retry.request-retry` and `requests.bootstrap-retries` exist on main; confirm exact paths/spelling on the pinned tag), count provider attempts for one failing request via the mock provider's counter — must be exactly 1, else the pinned release is REJECTED for paid traffic; (e) client-supplied `X-CPA-TRACE-ID`/`X-Request-Id` spoof attempt → server value unaffected; **(f) streaming: one streaming completion against the mock (`stream: true`) → SSE chunks received, `X-CPA-TRACE-ID` presence on the streamed response recorded, usage queue receives a completion record; (g) client disconnect: start a streaming request then abort the client connection mid-stream → record what the mock's counter and the usage queue show (attempt counted? completion record present/absent?). (f) and (g) are REQUIRED for the Phase 0 gate (architecture.md §122 requires stream/disconnect coverage); if the mock cannot deterministically serve streaming, or (g) cannot be observed deterministically, verdicts (f)/(g) are recorded UNKNOWN and the report states Phase 0 acceptance is NOT met — paid traffic stays blocked** (architecture.md Phase 0 gate row explicitly requires success/error/stream/disconnect header probes).
- Consumes: Task 5 running CPA.

**Mock provider requirement (P1 fix, r3-revised):** probe (d) MUST use the `mock-provider` Compose service — a deterministic HTTP server counting requests per path — wired into the rendered CPA config as an `openai-compatibility` provider group with base-url `http://mock-provider:8318`. **The overlay mechanism is: `render-config.sh` gains an overlay mode invoked AFTER the pinned release's `config.example.yaml` has been fetched and snapshotted (Task 5 Step 1); the overlay sets ONLY fields whose exact paths have been read verbatim from the pinned snapshot.** If the pinned snapshot does not contain a provider-routing mechanism with verifiable field paths, or retry field paths cannot be confirmed on the pinned tag, the corresponding verdict is recorded **UNKNOWN** and the report states: "Phase 0 acceptance NOT met; paid traffic remains blocked." **No real provider credentials are configured anywhere. No verdict may claim a provider-attempt result without the deterministic mock + counter + pinned config path — PASS requires the counter as evidence, not inferred routing.**

- [ ] **Step 1: Write probe script + mock provider** hitting the real pinned CPA through its public API with the gateway access key and the internal management key; every result written as verbatim JSON into REPORT.md; each question (a)–(g) gets an explicit PASS/FAIL/UNKNOWN verdict line with the exact evidence (config field path, counter value, response headers). **PASS requires the mock counter / captured response as direct evidence — a PASS without counter evidence is a report defect.**
- [ ] **Step 2: Run probe** — `bash probes/phase0/run.sh` (starts the `mock-provider` service on `cpa-net` via the Compose overlay, renders the probe config from Task 5's renderer AFTER the pinned example snapshot exists, runs CPA, executes (a)–(g), tears down). No paid provider traffic, no real provider credentials.
- [ ] **Step 3: Write REPORT.md** with verdicts. Hard rule printed at top: **"Phase 0 probe success does NOT authorize paid AI traffic"** (architecture.md §8 open decisions remain). Any UNKNOWN verdict prints: paid traffic stays blocked until deterministically resolved.
- [ ] **Step 4: NO commit.**

---

### Task 7: Published catalog + immutable price snapshots

**Depends on:** Tasks 3, 4.

**Files:**

- Create: `apps/api/src/routes/admin-models.ts`, `apps/api/src/routes/v1-models.ts`, `packages/catalog/src/snapshot.ts`
- Test: `apps/api/test/models.test.ts`, `packages/catalog/test/snapshot.test.ts`

**Interfaces:**

- Produces: `publishSnapshot(db, {bindingId, priceInput, priceOutput, now}): { snapshotId: string }` — inserts immutable `price_snapshots` row. Routes: `GET/POST/PUT /api/admin/models` (instance admin, global scope; writes audit_log; POST/PUT publish a new snapshot); `GET /v1/models` + `GET /v1/models/:id` (Bearer `sk-hbr-` key auth) → published bindings visible to the key's workspace (workspace-specific ∪ global), **CPA alias field never present in any response body**; `GET /api/workspaces/:id/models` (member+, read-only view). Disabled binding stops serving immediately (no cache beyond request lifetime).
- Consumes: Task 2 schema, Task 3 authz, Task 4 key auth.

- [ ] **Step 1: Failing tests.** `packages/catalog/test/snapshot.test.ts`: publish returns id; snapshot rows immutable (trigger `RAISE(ABORT)` on UPDATE/DELETE asserted). `apps/api/test/models.test.ts`: member can read own-ws model view; workspace admin/owner cannot POST /api/admin/models (403); instance admin can; `/v1/models` response JSON stringified contains no `cpa_alias` value for any binding; revoked key → 401; disabled binding absent from `/v1/models` on the next request.
- [ ] **Step 2: Red run** → FAIL.
- [ ] **Step 3: Implement** per interfaces. Key auth middleware: hash Bearer token, lookup `api_keys.key_hash`, check status + workspace.
- [ ] **Step 4: Green run** → PASS.
- [ ] **Step 5: NO commit.**

---

### Task 8: VND wallet + append-only ledger + reserve/release hold core (NO settlement)

**Depends on:** Tasks 2, 7 (price snapshot id needed on reservations).

**Files:**

- Create: `packages/wallet/src/wallet.ts`, `packages/wallet/src/ledger.ts`, `packages/wallet/src/reservation.ts`
- Test: `packages/wallet/test/wallet.test.ts`, `packages/wallet/test/reservation.test.ts`, `packages/wallet/test/ledger.test.ts`

**Scope (P1 scope fix):** this task implements ONLY `creditWallet`, `createReservation`, `releaseHold`, `getWallet`. **No `settleReservation`, no refund code, no usage-event assignment, no settlement primitive, no automatic CPA settlement.** Settlement — including atomic usage-event assignment via `settlement_usage_events` and zero-charge behavior — is specified verbatim in data-model.md §2 and deferred to the Phase 2 gateway plan, which owns wiring it to real proxy routes.

**Interfaces (all money = integer VND; all functions take an open `Database` and run in `BEGIN IMMEDIATE` transactions):**

- `creditWallet(db, {walletId, amount, kind: 'topup', paymentId, memo})` → `{ ledgerEntryId, balanceAfter }` (partial-unique-guarded, one credit per payment; `amount` positive integer enforced by wallet code AND `amount > 0` CHECK).
- `createReservation(db, {walletId, workspaceId, gatewayRequestId, apiKeyId, modelBindingId, endpoint, mode, priceSnapshotId, capAmount, estimatedInputTokens, now})` → `{reservationId, requestId} | {error: 'insufficient'}` — one transaction: insert request + reservation rows, then `UPDATE wallets SET reserved = reserved + :cap, version = version + 1 WHERE id = :wallet_id AND balance - reserved >= :cap`; affected rows must be 1 else rollback → `insufficient`. **The `requests` row (data-model.md §2) requires `workspace_id`, `api_key_id`, `model_binding_id`, `endpoint` (`/v1/chat/completions`|`/v1/responses`), `mode` (`stream`|`non-stream`) — all five are explicit arguments here, no invented derived values:** `workspaceId` and `apiKeyId` come from the trusted authenticated API key (the key's `workspace_id` and key id), `modelBindingId`/`endpoint`/`mode` from the validated inbound request; the caller (Phase 2 route) supplies them from auth context, and `createReservation` itself derives nothing silently. Insert the `requests` row first with `status = 'pending'` (pre-dispatch; `pending` is defined in data-model.md §2 — on actual dispatch it transitions to `ok|client_abort|upstream_error|unknown`; a reservation that never dispatches stays `pending` or is cleaned/released without paid dispatch) — **no dispatch of any kind happens in this function; no paid traffic exists in this foundation.**
- `releaseHold(db, {reservationId, apiKeyId, workspaceId, now})` → decreases `reserved` by cap (precondition `reserved >= cap`, affected rows 1), CAS `reservations.status held|unknown → released`, **writes no ledger row**. **Scope validation (P1 fix):** the caller must also pass the authenticated `apiKeyId` and `workspaceId`; in the same transaction the reservation is joined to its request row and validated: `reservations.wallet_id` belongs to `workspaceId`, the request's `workspace_id` = `workspaceId`, and `reservations.api_key_id` = the authenticated key id (all must match else `404/403`-equivalent ownership error). Only rows whose linked wallet/request/key are all in the caller's workspace and whose `reservations.status` is `held` (or `unknown` for the CAS) are releasable.
- `getWallet(db, walletId)` → `{balance, reserved, available, version}`.

**createReservation ownership validation (P1 fix — all in the one transaction, before any wallet mutation; every ID is independent caller input and none is trusted):**

1. Authenticated key: `api_keys` row for `apiKeyId` exists, `status = 'active'`, and `workspace_id = workspaceId`; `workspaceId` itself comes from the authenticated key/session, never from the caller's assertion.
2. Wallet: `wallets` row for `walletId` exists and `wallets.workspace_id = workspaceId`.
3. Request workspace: the inserted `requests.workspace_id = workspaceId` and `requests.api_key_id = apiKeyId` (insert with the validated values, not caller-passed copies).
4. Model binding: `model_bindings` row for `modelBindingId` exists with `status = 'published'`, and `(workspace_id IS NULL OR workspace_id = workspaceId)` (global bindings serve every workspace; workspace bindings only their own).
5. Immutable snapshot binding: `price_snapshots` row for `priceSnapshotId` exists and `price_snapshots.binding_id = modelBindingId` — the snapshot must be a snapshot OF the named binding; mismatch → ownership error.
6. `gatewayRequestId` ownership/uniqueness: it becomes the `requests.id` PK, so insert collision → unique violation (`one reservation per gateway_request_id`, data-model.md §3 invariant 2) → conflict error; the caller must own the generated request id (it is created in this transaction, never accepted from a client header — inbound trace-id headers are stripped per api-boundaries.md §5).
   Any check failing → rollback with a typed error (no partial insert, no wallet change).

- [ ] **Step 1: Failing tests** (Bun test):
  1. Reservation: available = balance; reserve cap → `available` drops by cap, `reserved` rises; reserve cap+1 with available cap → `{error:'insufficient'}` and wallet unchanged. The inserted `requests` row carries `workspace_id`, `api_key_id`, `model_binding_id`, `endpoint`, `mode` exactly as passed, has `status = 'pending'`, and the reservation's `gateway_request_id` equals the request row id.
     1b. **Ownership negatives (P1 fix):** each must fail with rollback, no request/reservation rows, wallet unchanged: (a) wallet from workspace B while authenticated key is workspace A; (b) API key whose `workspace_id` ≠ `workspaceId` (or revoked key); (c) model binding belonging to workspace B (non-global) when `workspaceId` = A; (d) disabled (not `published`) binding; (e) `priceSnapshotId` belonging to a DIFFERENT binding than `modelBindingId` (snapshot/binding mismatch); (f) duplicate `gatewayRequestId` → conflict error and no second reservation row. Positive control: same-workspace wallet + global binding + matching snapshot succeeds.
  2. **Concurrency gate (architecture Phase 1):** two parallel `createReservation` of > balance/2 against one wallet, via two connections on the same file DB (WAL) under `Promise.all` → exactly one succeeds, one `insufficient`; zero negative balances.
  3. **Fuzz (explicitly SEQUENTIAL — P2 honesty fix):** 500 sequential mixed reserve/release ops with random amounts ≤ cap → final invariant `balance >= 0 AND reserved >= 0 AND balance >= reserved` holds after every commit; every ledger `balance_after` equals the wallet balance at that row's creation. The test name and comments state "sequential"; concurrency claims are limited to the two-connection gate in test 2.
  4. Release: `reserved` returns to available; ledger row count unchanged (NO cash row for hold release); double release → `terminal` error. **Scope negatives (P1 fix):** release with an authenticated key id that is not the reservation's `api_key_id` → ownership error, `reserved` unchanged; release with `workspaceId` ≠ the request's/workspace's workspace → ownership error; release of a non-`held` (already `released`) reservation → `terminal` error.
  5. Append-only: `UPDATE ledger_entries ...` and `DELETE FROM ledger_entries ...` → SQLite error (trigger `RAISE(ABORT)`).
  6. Integer discipline: `creditWallet` and `createReservation` reject non-integers, floats, and `!Number.isSafeInteger` amounts before any SQL (unit assertions on the error paths).
- [ ] **Step 2: Red run** — `bun test packages/wallet/test` → FAIL.
- [ ] **Step 3: Implement** per interfaces. Checked integer arithmetic: reject non-integers and `!Number.isSafeInteger` before any SQL; overflow-checked version increments.
- [ ] **Step 4: Green run** — `bun test packages/wallet/test` → ALL PASS including the concurrency gate.
- [ ] **Step 5: NO commit.**

---

### Task 9: Guarded mock payment — payOS-shaped webhook, verified event, idempotent top-up

**Depends on:** Tasks 4, 8.

**Files:**

- Create: `apps/api/src/routes/payments.ts`, `apps/api/src/routes/webhooks-mock.ts`, `packages/payments/src/mock-signature.ts`, `packages/payments/src/credit.ts`
- Test: `apps/api/test/payments.test.ts`, `apps/api/test/webhooks-mock.test.ts`, `packages/payments/test/mock-signature.test.ts`

**Interfaces:**

- Produces: `signMockPayload(payload: object, key: string): string` — HMAC-SHA256 hex over sorted-key JSON (lexicographic keys, separators `,`/`:`, UTF-8, no whitespace); `verifyMockSignature(raw: string, key: string): boolean`. Routes: `POST /api/workspaces/:wsId/payments` (member+ of `:wsId`, workspace-bound like Task 4) → creates `payments` row (status pending, provider `mock`, amount positive-integer VND, unique `provider_order_code`) + returns mock provider link `/webhooks/payments/mock?order=<code>` (dev/demo only); `GET /api/workspaces/:wsId/payments/:id` (member+, own ws only); `POST /webhooks/payments/mock` (feature-flagged: enabled only when `HBR_MOCK_PAYMENTS=on` AND `NODE_ENV !== 'production'`; otherwise 404) → verify signature → insert `payment_events` (UNIQUE `(provider, provider_reference)`) → call `creditWallet(...kind:'topup')` in one transaction → 2XX only after durable commit; amount validated server-side against the payments row.
- Consumes: Task 8 `creditWallet`, Task 4 auth, Task 2 schema.

- [ ] **Step 1: Failing tests.**
  - Signature: valid signature verifies; flipped byte fails; reordered JSON keys verify identically (canonicalization); empty key → reject at config load (non-empty key required).
  - Webhook: valid signed event for a pending payment → wallet credited exactly `amount`, ledger `kind='topup'` row with `payment_id`, payment status `succeeded`; **duplicate replay of the same webhook → one credit total** (balance unchanged on second call, still 2XX); amount mismatch (event amount ≠ order amount) → rejected, no credit, payment not succeeded; invalid signature → 400, no insert; webhook when feature flag off → 404; webhook when `NODE_ENV=production` → 404 even with flag on.
  - **Cross-workspace denial:** member of ws A → 403 on `GET /api/workspaces/B/payments/:id` even when the payment id exists.
  - DB uniqueness: manual second `payment_events` insert with same `(provider, provider_reference)` → throws.
- [ ] **Step 2: Red run** — `bun test apps/api/test/payments.test.ts apps/api/test/webhooks-mock.test.ts packages/payments/test` → FAIL.
- [ ] **Step 3: Implement** per interfaces. Handler never writes ledger rows inline — only via `creditWallet`.
- [ ] **Step 4: Green run** → PASS.
- [ ] **Step 5: NO commit.**

---

### Task 10: Security hardening pass + foundation test suite green + minimal docs

**Depends on:** Tasks 1–9.

**Files:**

- Modify: `apps/api/src/app.ts` (global header-strip + error-shape plugins)
- Create: `apps/api/src/plugins/strip-headers.ts`, `apps/api/src/plugins/errors.ts`, `README.md` (minimal: run/test commands, paid-traffic-disabled banner, env vars), `docs/ops/runbook-foundation.md` (compose up/down, env, probe rerun, "how to verify paid traffic is still disabled")
- Test: `apps/api/test/security.test.ts`, plus full-suite run

**Interfaces:**

- Produces: `stripUntrustedHeaders` plugin (removes inbound `X-CPA-TRACE-ID`, `X-Request-Id`, `OpenAI-Request-Id` on all routes); errors (4xx/5xx) return `{error: {code, message, request_id}}`; native 3xx responses preserve `Location` and `Set-Cookie`; 204, 304, and HEAD responses remain bodyless. `X-HBR-Request-Id` response header set on handled requests. Runbook documents `HBR_MOCK_PAYMENTS`, `HBR_WEB_DIST`, `CPA_MANAGEMENT_KEY`, `CPA_ACCESS_KEY`, `HBR_BOOTSTRAP_INSTANCE_ADMIN_EMAIL`, DB path env.
- Consumes: all prior tasks.

- [ ] **Step 1: Failing security tests.** Request with all three stripped headers → handler-visible context has none of them; successful/static and error responses carry UUID `X-HBR-Request-Id`; error response shape asserted on 404 and 403 routes (`{error:{code,message,request_id}}`), plus 500 redaction/no stack. Native 302 preserves `Location` and multiple `Set-Cookie`; 304 and HEAD responses stay bodyless. **No 402 test — no route in this foundation returns 402** (wallet logic is package-only; the 402-bearing proxy route is Phase 2). `GET /openapi.json` does not document any `/v1/chat/completions` or `/v1/responses` POST route (paid traffic disabled, machine-checked).
- [ ] **Step 2: Red run** → FAIL.
- [ ] **Step 3: Implement** plugins; wire into `buildApp()`.
- [ ] **Step 4: Full suite green** — `bun test` (workspace root) → ALL PASS; `vp check` → exit 0.
- [ ] **Step 5: Docs.** README + runbook include the banner: "PAID AI TRAFFIC DISABLED — Phase 0 probe does not authorize it; see architecture.md §8 open human decisions." README accurately describes this as a Git-backed repository.
- [ ] **Step 6: NO commit.**

---

## DEFERRED — separate future plans (NOT in this plan)

1. **Gateway plan (Phase 2):** `/v1/chat/completions` + `/v1/responses` non-streaming proxy, strict usage poller (persist-before-next-poll), two-ID correlation, reservation→settle state machine, **the settlement primitive** — `settleReservation` with atomic usage-event assignment (`settlement_usage_events` in the settlement transaction, `UNIQUE(usage_event_id)`) and fully-specified zero-charge behavior (per data-model.md §2: settlement requires `0 <= charged_total <= cap`; the zero-charge case must be defined as either reject or settle-without-debit preserving the one-settlement invariant — Phase 2 plan decides and tests it) — plus UNKNOWN review UI + admin resolve/refund routes, and the egress-capable network design replacing `internal: true` for provider calls. Launch gated on §8 human decisions — all still open.
2. **Streaming plan (Phase 3):** SSE routes + client-abort billing policy — blocked on `[OPEN — HUMAN]` abort decision; Phase 2 rejects `stream:true` with 400 until then.
3. **Dashboard plan (Phase 4):** React console UI (keys, wallet, ledger, requests/usage, Vercel-style logs), key shown-once UX, UNKNOWN review UI.
4. **Real payments plan (Phase 5):** payOS (+ VNPay/MoMo) real webhook canonicalization — research `docs/research/vietnam-payments.md` re-verified at integration time.

## Execution notes

- Estimated effort: Tasks 0–2 ≈ half a day; Tasks 3–4 ≈ half a day (Better Auth CLI pinning may add time on first run); Tasks 5–6 ≈ half a day (Docker + probe flakiness may add time); Tasks 7–9 ≈ one day; Task 10 ≈ two hours.
- If any red/green check cannot run (tool drift, Better Auth incompatibility, CPA release surface change, unconfirmable CLI syntax), STOP that task and report findings — do not substitute an unapproved design and do not convert an UNKNOWN into a default.
