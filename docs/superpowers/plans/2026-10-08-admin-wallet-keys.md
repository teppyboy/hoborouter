# Admin Wallet Adjustment + Admin Key Grant/Revoke Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instance-admin-only TOPUP wallet adjustment with idempotent receipts + generic-key admin grant/revoke with audit privacy, per approved spec.

**Architecture:** One forward-only migration adds `admin_wallet_adjustments`; `adjustWalletBalance(db, opts)` in `packages/wallet/src/wallet.ts` OWNS its transaction (FOR UPDATE → claim insert UNIQUE-arbitrated → CAS → ledger → audit → commit; on 23505 it rolls back internally and re-reads the committed claim in a fresh read outside the aborted txn). New privileged routes `admin-wallet-adjust.ts` (incl. user-context endpoint) / `admin-keys.ts`; `audit.ts` workspace branch excludes `admin.wallet.adjust` + `admin.key.*` for non-instance-admins before pagination/count/enrichment. One UI writer owns `users.tsx` (wallet dialog AND key management).

**Tech Stack:** Elysia, Drizzle (bun-sql/Postgres), React 19 + shadcn/ui, Bun test.

**Spec:** `docs/superpowers/specs/2026-10-08-admin-wallet-keys.md` (NORMATIVE, approved)

## Global Constraints

- Integer VND only; ledger append-only; never delete money history (soft `deleted_at` only).
- Adjustment = ONE transaction: lock → claim → compute → CAS → ledger → audit → commit, all or none. No `creditWallet` reuse. Receipt (`balance_before`/`balance_after`/`reserved`/`request_payload`) is computed with real values BEFORE the claim insert — no placeholders, no post-hoc recompute.
- UNIQUE is `(actor_user_id, idempotency_key)`; key 16..128 chars; `delta` signed safe integer ≠ 0; `reason` 1..500 ADMIN-PRIVATE; ledger `memo` = constant `'Admin adjustment'`.
- Replay returns stored receipt `{ ledgerEntryId, balanceBefore, balanceAfter, reserved, workspaceId, replayed:true }`; mismatch → **409 `IDEMPOTENCY_MISMATCH`** via the NEW explicit `WalletErrorCode "idempotency_mismatch"` (the existing union `not_found|ownership|conflict|terminal|invalid|insufficient|overflow` does NOT include it — Task 2 adds it). Overflow → 409 `OVERFLOW`; `balance+delta < reserved` → 409 `INSUFFICIENT`; CAS miss → one retry, else 503.
- **Wallet package layering:** `packages/wallet` MUST NOT import `apps/api` (authz.ts `writeAudit` is forbidden — layering cycle). Audit insertion inside the adjustment transaction uses the exported `auditLog` table from `@hoborouter/db` directly (same columns as `writeAudit` writes: `id`, `actor_user_id`, `workspace_id`, `action`, `target`, `detail`, `created_at`).
- **Transaction ownership:** `adjustWalletBalance(db: Db, opts)` takes ONLY the connection-level `Db` and opens its own transaction via `runInImmediate`. It NEVER accepts a `Tx`: a routine handed an aborted caller transaction cannot roll it back and then re-read outside it — recovery-from-abort must live inside the routine that owns the txn. Callers never wrap it in their own transaction.
- TOPUP wallet only; `walletId`/`userId` never from client. Workspace routes (`keys.ts`) unchanged; instance admin gets nothing there.
- Key plaintext returned once at grant; hashed (`api_keys.key_hash`) otherwise; never logged. Verified generator: `generateApiKey(): { plaintext: string; hash: string; prefix: string }` from `@hoborouter/keys` — store `key_hash=hash`, `key_prefix=prefix`.
- No new dependencies; no runtime secrets; no customer self-credit path.
- Workers never stage/commit. Integration executor (Task 6) makes source+tests-coherent commits, explicit paths only.
- Do not touch: root `package.json` (user edit), existing tested UI files outside `users.tsx`, applied migrations.

## Review Focus

- Same idempotency key reused across two wallets concurrently → exactly one commit, loser replays/mismatches, no partial rows (T3/T6).
- Audit leak via `action=` prefix filter or `before`/`limit` cursor on `/api/v1/audit?workspace_id=X` → excluded before those are applied (T8).
- Reason/actor visible to workspace admin in ledger or audit detail → never (T8).
- Revoke replay or wrong-workspace keyId → idempotent 200 once / 404, single audit row (T9).
- Credit at `MAX_SAFE_INTEGER_MONEY` (9007199254740991) → 409, zero writes (T7).

## Parallel Execution

| Owner                                                               | Exclusive files                                                                                                                    |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **A DB/schema (= owner D of the catalog plan; SAME single writer)** | `packages/db/src/schema.ts`, `packages/db/drizzle/0015_admin_wallet_adjustments.sql`, journal idx 15                               |
| **B wallet domain**                                                 | `packages/wallet/src/wallet.ts`, `tests/wallet-adjust.test.ts`, `tests/wallet-concurrency.test.ts`                                 |
| **C API wallet route + user context**                               | `apps/api/src/routes/admin-wallet-adjust.ts`, `tests/admin-wallet-adjust-api.test.ts`                                              |
| **D API keys + audit**                                              | `apps/api/src/routes/admin-keys.ts`, `apps/api/src/routes/audit.ts`, `tests/admin-keys-api.test.ts`, `tests/audit-privacy.test.ts` |
| **F UI (one writer)**                                               | `apps/web/src/pages/admin/users.tsx`, `tests/admin-wallet-ui.test.tsx`, `tests/admin-keys-ui.test.tsx`                             |
| **I Integration**                                                   | `apps/api/src/app.ts` (route registration), coherent commits, full checks                                                          |

**Barriers:**

- **B0 (single schema writer, corrected):** the catalog plan's `0014_catalog_revision_columns` (idx 14) MUST land first; owner A then registers `0015_admin_wallet_adjustments` at **idx 15**. A owns `schema.ts` + `_journal.json` alone during its window — no simultaneous writers; verify the journal's ACTUAL last idx at execution before appending. The catalog lane must not touch the journal while Task 1 runs.
- B1: B needs A's `adminWalletAdjustments` export. B2: C needs B's `adjustWalletBalance`. B3: D is independent of B/C. B4: F consumes C/D frozen contracts (below) and can start in parallel. B5: I registers `adminWalletAdjustRoutes(db, auth)` + `adminKeysRoutes(db, auth)` in the `routeGroups` array (`app.ts:126-165`, near `auditRoutes(db, auth)` at line 129) — registration owned SEPARATELY by integration, never by lane workers.

---

### Task 1 (Owner A, after catalog 0014): Migration + schema

**Files:** Create `packages/db/drizzle/0015_admin_wallet_adjustments.sql`; Modify `packages/db/src/schema.ts` (after `ledgerEntries`, ~line 136+); Modify `packages/db/drizzle/meta/_journal.json` (idx 15, tag `0015_admin_wallet_adjustments`).

**Interfaces (Produces):** `adminWalletAdjustments` pgTable export: `id` text PK (`crypto.randomUUID`), `actor_user_id` text NOT NULL, `idempotency_key` text NOT NULL, `wallet_id` text NOT NULL FK wallets.id, `workspace_id` text NOT NULL FK workspaces.id, `delta` bigint NOT NULL, `reason` text NOT NULL, `balance_before` bigint NOT NULL, `balance_after` bigint NOT NULL, `reserved` bigint NOT NULL, `ledger_entry_id` text NULL FK ledger_entries.id, `request_payload` jsonb NOT NULL, `created_at` bigint NOT NULL; `uniqueIndex("admin_wallet_adjustments_actor_key").on(t.actor_user_id, t.idempotency_key)`.

**Test style — REAL migrated-DB behavior, NOT migration-SQL/source-string assertions.** Against the migrated test PG (`bun run db:test:up`):

- [ ] **Step 1: Failing behavior tests** `tests/admin-wallet-schema.test.ts`:
  - `claim row with valid wallet/workspace FKs inserts with null ledger_entry_id` (plain insert → persists; `ledger_entry_id` null by default).
  - `duplicate (actor_user_id, idempotency_key) violates admin_wallet_adjustments_actor_key` (two inserts, same actor+key, different wallets → unique violation; same actor + different key OK; different actor + same key OK).
  - `FK rejects bogus wallet_id / workspace_id / ledger_entry_id` (each → FK violation).
  - `ledger_entry_id FK satisfied by in-txn ledger insert` (tx: insert ledger row, insert claim, update claim.ledger_entry_id → commit → non-null; aborted tx → no claim row).
  - `aborted transaction leaves no claim row` (tx: insert claim, throw → rollback → absent).
- [ ] **Step 2:** `bun run db:test:up && PORT=3998 bun test tests/admin-wallet-schema.test.ts` → FAIL (table absent).
- [ ] **Step 3:** Implement table + migration + journal entry idx 15 (verify journal last idx = 14 from catalog plan first).
- [ ] **Step 4:** Re-run Step 2 → PASS. `node_modules/.bin/tsc -p apps/api/tsconfig.json --noEmit` → clean.

### Task 2 (Owner B): `adjustWalletBalance` + concurrency tests

**Files:** Modify `packages/wallet/src/wallet.ts`; Test `tests/wallet-adjust.test.ts`, `tests/wallet-concurrency.test.ts`.

**Interfaces:** Consumes `lockWallet(tx, walletId)`, `runInImmediate(db, fn, {walletId})`, `overflowCheckedAdd(name, a, b)`, `WalletError`, `MAX_SAFE_INTEGER_MONEY` (all in `wallet.ts`); `auditLog`, `adminWalletAdjustments`, `ledgerEntries`, `wallets` from `@hoborouter/db`. NO import from `apps/api`.

**Produces (exact signature):**
`adjustWalletBalance(db: Db, opts: { actorUserId: string; idempotencyKey: string; walletId: string; workspaceId: string; delta: number; reason: string }): Promise<{ ledgerEntryId: string; balanceBefore: number; balanceAfter: number; reserved: number; workspaceId: string; replayed: boolean }>` — `Db` only; routine owns the transaction. Adds `"idempotency_mismatch"` to `WalletErrorCode`.

§3 sequence exactly: lock (step 2) → read wallet (balance/reserved/version) → INSERT claim with REAL `balance_before`/`reserved`/`request_payload` (complete receipt computed before insert) → compute (`credit`: `overflowCheckedAdd` vs `MAX_SAFE_INTEGER_MONEY` → `overflow`; `debit`: `balance+delta >= reserved` else `insufficient`) → CAS `UPDATE wallets SET balance, version+1 WHERE id AND balance=? AND version=?` (0 rows → throw `conflict`) → ledger insert (`direction`=sign, `kind='adjustment'`, `amount=|delta|`>0, `balance_after`, `memo='Admin adjustment'`) → set `ledger_entry_id` → insert `auditLog` row (`action='admin.wallet.adjust'`, `detail={delta, reason}`) directly in the same txn → commit.

On 23505 at claim insert: the routine's own transaction aborts and rolls back ALL its writes; it then re-reads the committed claim by `(actor_user_id, idempotency_key)` in a FRESH read (new transaction on `db`) — `request_payload` JSON-equal → return stored receipt `replayed:true`; mismatched → throw `new WalletError("idempotency_mismatch", ...)` (mapped by the API to 409 `IDEMPOTENCY_MISMATCH`). Replay path is read-only; no re-execution.

- [ ] **Step 1: Failing tests** `tests/wallet-adjust.test.ts`: T1a (credit/debit: persisted before/after/reserved, one ledger row `amount=|delta|`>0, one `auditLog` row, `ledger_entry_id` non-null post-commit); T1b (audit-failure injection → ALL writes rolled back — inject via a real DB failure, e.g. audit insert violating `audit_log.workspace_id` FK, then assert claim/ledger/wallet unchanged); T2 (replay identical → stored receipt incl. `reserved`, `replayed:true`, single ledger row; changed delta/reason/workspace → `idempotency_mismatch`, zero writes); T7 (`balance=MAX_SAFE_INTEGER_MONEY` credit → `overflow`, zero writes). `tests/wallet-concurrency.test.ts`: T3 (same key, two wallets, parallel → one commits, loser replay/mismatch, no partial rows); T4 (parallel with `settleRequest` → no lost update); T5 (parallel with `reserveRequest` hold → `reserved` untouched, breaching debit → `insufficient`); T6 (N parallel identical → exactly one ledger row).
- [ ] **Step 2:** `bun run db:test:up && PORT=3998 bun test tests/wallet-adjust.test.ts tests/wallet-concurrency.test.ts` → FAIL.
- [ ] **Step 3:** Implement per signature above.

### Task 3 (Owner C): Adjust route + admin user-context endpoint

**Files:** Create `apps/api/src/routes/admin-wallet-adjust.ts`; Test `tests/admin-wallet-adjust-api.test.ts`.

**Interfaces:** Consumes Task 2 `adjustWalletBalance`; `requireSession` (`authz.ts:25`), `requireInstanceAdmin` (`authz.ts:67`), `jsonError` (`authz.ts:11`); db pattern from `admin-user-edit.ts`. Resolves the workspace's `kind='topup'` wallet (unique `wallets_workspace_kind`); absent → 404; never reads `walletId` from body.

**Produces:**

- `adminWalletAdjustRoutes(db: Db, auth: BetterAuthInstance): Elysia` containing:
  - `POST /api/v1/admin/workspaces/:workspaceId/wallet/adjust` body `{ delta, reason, idempotencyKey }` → `{ ledgerEntryId, balanceBefore, balanceAfter, reserved, workspaceId, replayed }`; errors 400/401/403/404/409 `INSUFFICIENT|OVERFLOW|IDEMPOTENCY_MISMATCH`/503 (map `WalletError` codes; `idempotency_mismatch` → 409 `IDEMPOTENCY_MISMATCH`).
  - `GET /api/v1/admin/users/:userId/context` (the admin context endpoint for the UI): instance-admin-only; returns `{ memberships: [{ workspaceId, workspaceName, role }], wallets: [{ workspaceId, kind: 'topup', balance, reserved }] }` — the explicit workspace picker source; the key panel fetches Task 4's `GET /api/v1/admin/workspaces/:id/keys` per membership. Registered together with the adjust route in Task 6 (registration owned by integration, not by C).

- [ ] **Step 1: Failing tests** `tests/admin-wallet-adjust-api.test.ts`: T8 auth negatives (workspace owner/member non-instance-admin → 403; instance admin non-member → 200; anonymous → 401); T10 subscription-wallet-only workspace → 404; body validation (delta 0/float, reason length, key <16/>128 → 400); context endpoint returns memberships + topup balances and is 403 for non-instance-admin.

### Task 4 (Owner D): Admin keys routes + audit privacy

**Files:** Create `apps/api/src/routes/admin-keys.ts`; Modify `apps/api/src/routes/audit.ts` (workspace branch, ~lines 166–174); Tests `tests/admin-keys-api.test.ts`, `tests/audit-privacy.test.ts`.

**Interfaces:** Consumes `generateApiKey()` → `{ plaintext, hash, prefix }` (`@hoborouter/keys`), model-existence check pattern (`keys.ts:313-321`), `apiKeys` + `api_key_model_permissions` schema exports. Produces: `adminKeysRoutes(db: Db, auth: BetterAuthInstance): Elysia` with:

- `GET /api/v1/admin/workspaces/:workspaceId/keys` — generic-purpose only (`purpose='generic'`): id, name, key_prefix, status, created_at, last_used_at, modelIds; no hash/plaintext.
- `POST .../keys` body `{ name, modelIds? }` — every modelId must exist in `models`; empty/absent = unrestricted (surfaced in UI confirm); one txn: insert key (`purpose='generic'`, `key_hash=hash`, `key_prefix=prefix`) + allowlist rows + audit `admin.key.grant` `{keyId, modelIds}`; response includes `plaintext` ONCE.
- `POST .../keys/:keyId/revoke` body `{ reason }` REQUIRED; key not in `:workspaceId` → 404; terminal `status='revoked'`, `revoked_at=now`; already revoked → 200 `{status:'revoked'}` no second audit; first revoke audits `admin.key.revoked` `{keyId, reason}`.
- Audit change: in the `wsId` branch, when requester is NOT instance admin, add an SQL predicate excluding `action='admin.wallet.adjust'` and `action LIKE 'admin.key.%'` to `filters` BEFORE the `before`/`action` filters, count, and `enrich` — zero such rows in any query variant; instance-admin path unchanged.

- [ ] **Step 1: Failing tests.** `tests/admin-keys-api.test.ts` (T9): unknown modelId → 400; `plaintext` only in grant response, absent from GETs and captured logs; revoke idempotent (one audit row); wrong-workspace revoke → 404; revoked key rejected at gateway; instance admin non-member calling workspace key route (`keys.ts`) → 403 unchanged. `tests/audit-privacy.test.ts` (T8-audit): workspace admin/owner `?workspace_id=X` with bare / `action=admin.` / `action=admin.wallet.adjust` / `before`+`limit` variants → zero privileged rows, no reason/delta/actor email; same query as instance admin → full record.

### Task 5 (Owner F, one writer): Users UI — wallet dialog AND key management

**Files:** Modify `apps/web/src/pages/admin/users.tsx`; Tests `tests/admin-wallet-ui.test.tsx`, `tests/admin-keys-ui.test.tsx`.

**Interfaces (consumes frozen C/D contracts):** `GET /api/v1/admin/users/:userId/context` (workspace picker), `POST /api/v1/admin/workspaces/:id/wallet/adjust`, `GET|POST /api/v1/admin/workspaces/:id/keys`, `POST .../keys/:keyId/revoke`.

- [ ] **Step 1: Failing tests** `tests/admin-wallet-ui.test.tsx`: "Adjust wallet" dialog opens from users row; EXPLICIT workspace picker renders all memberships from context (never one-wallet assumption), showing workspace name + topup balance + reserved; credit/debit toggle + positive amount composing signed `delta`; required reason; confirm step `balanceBefore → balanceAfter`; post-submit shows before/after + link to the ledger entry. Actor email/reason render ONLY from the audit route, never workspace data.
- [ ] **Step 2: Failing tests** `tests/admin-keys-ui.test.tsx`: key panel per selected workspace lists generic keys (prefix/status/created/last_used/modelIds, no secrets); grant form with name + optional model allowlist + explicit confirmed-intent step ("shown once, cannot be recovered") rendering plaintext with copy button; after dismissal plaintext never re-renders; revoke requires a reason, already-revoked → success message; wrong-workspace/404 renders error. Behavior assertions only (no CSS/source text).
- [ ] **Step 3:** Implement both dialogs following existing `Dialog`/`useState` patterns in `users.tsx`. No new account or subscription features.
- [ ] **Step 4:** `PORT=3998 bun test tests/admin-wallet-ui.test.tsx tests/admin-keys-ui.test.tsx` → PASS; `cd apps/web && node_modules/.bin/tsc -b` → clean.

### Task 6 (Owner I, integration): Registration + coherent commits + full gate

- [ ] **Step 1:** Register `adminWalletAdjustRoutes(db, auth)` + `adminKeysRoutes(db, auth)` in `routeGroups` (`app.ts:126-165`). Registration is owned HERE only.
- [ ] **Step 2:** Coherent source+tests commits, explicit paths (never `git add -A`; lane workers stage nothing): `feat(db): admin_wallet_adjustments claim table (0015)` → `feat(wallet): idempotent admin adjustWalletBalance` → `feat(api): admin wallet adjust route` → `feat(api): admin key grant/revoke + privileged audit scoping` → `feat(web): admin wallet + key management dialogs on users page` → `feat(api): wire admin wallet + admin keys routes`.
- [ ] **Step 3:** `bun run db:test:up && PORT=3998 bun run test` → all PASS (T1–T10); `bun run check` → clean.

## Self-Review

- Spec §1/§2/§3→Tasks 1/2; §4→Task 3; §5→Task 5 (wallet dialog AND key UI); §6→Task 4 audit; §7→Task 4 keys; §8 T1–T10 mapped; §9 files match owner table. No gaps.
- Types consistent: `adjustWalletBalance(db: Db, ...)` (Task 2) matches Task 3 consumption; `idempotency_mismatch` added explicitly to `WalletErrorCode` (Task 2) and mapped in Task 3; receipt fields incl. `reserved` verbatim from spec §2/§4.
- Layering: wallet package imports only `@hoborouter/db` + own module — no `apps/api` import, no cycle; audit via exported `auditLog` table in-txn.
- Migration: single schema writer barrier B0 — idx 14 (catalog) then idx 15 (here), journal actual last idx verified at execution; no applied migration edited; index name `admin_wallet_adjustments_actor_key` new.
- Not done here (deliberate): no source implementation, no installs, no services, no staging — plan only.
