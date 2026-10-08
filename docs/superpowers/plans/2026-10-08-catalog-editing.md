# Catalog Editing (Metadata PATCH vs Financial Revision) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins edit catalog metadata via existing PATCH; financial edits create a successor row (old row immutable, transactional `successor_id` link, successor-only `revision_key`) while pending payments settle original terms.

**Architecture:** One `db.transaction` per revise: lock old row (`for("update")`), replay-check by partial-unique `revision_key`, insert successor, deactivate + link old row, audit. Settlement predicate drops the `plan.active` check; all other gates unchanged.

**Tech Stack:** Elysia, Drizzle/bun-sql (Postgres), React 19 + TanStack, bun test.

**Spec:** `docs/superpowers/specs/2026-10-08-catalog-editing.md` (NORMATIVE, user-approved).

## Global Constraints

- All money integer VND; USD stored as exact decimal text; never recompute history from current prices. Old financial terms are immutable — no deletes, no edits to superseded money fields.
- `rate_limit_per_minute` stays a live PATCH field (live-RPM carve-out, spec §1): excluded from revise bodies, still direct-editable on the authoritative row via PATCH.
- No dependency additions. No new runtime secrets. No customer self-credit. No money-history deletion.
- Forward-only migration; never edit applied migrations; register in `packages/db/drizzle/meta/_journal.json`.
- `revision_key` on SUCCESSOR row only; `successor_id` on superseded row only, same transaction. Never both rows keyed (partial unique index forbids it).
- No promo revise endpoint, no same-code alias/reset.
- Workers never stage/commit. The integration executor (Task 4) makes source+tests-coherent commits per task unit.

## Ownership & Barriers (corrected)

| Owner                                                                        | Exclusive files                                                                                            |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **DB/schema owner (D, single writer across catalog AND admin-wallet plans)** | `packages/db/src/schema.ts`, `packages/db/drizzle/0014_catalog_revision_columns.sql`, journal entry idx 14 |
| Backend (A)                                                                  | `packages/payments/src/credit.ts`, `apps/api/src/routes/admin-bundles.ts`                                  |
| Catalog UI (B)                                                               | `apps/web/src/pages/admin/bundles.tsx` ONLY                                                                |
| Integration (C)                                                              | coherent commits, cross-cutting checks                                                                     |

- **D1 (single DB writer):** `schema.ts` and `_journal.json` have exactly one writer at a time. This plan's Task 1 = migration `0014_catalog_revision_columns` at **idx 14** (after applied idx 13 `0013_api_keys_purpose`). The admin-wallet plan's `0015_admin_wallet_adjustments` at **idx 15** runs AFTER Task 1 lands, performed by the SAME owner D. Verify the journal's actual last idx at execution time before writing either entry; never run both in parallel.
- **Barrier A1:** A's Task 2 needs D's Task 1 columns. **Barrier B1:** B's Task 3 needs A's Task 2 endpoints.
- **Promo ownership:** `apps/api/src/admin-promotions.ts`/promo helpers are owned by the unified-promos server lane; promo financial replacement UI waits for that handoff. This plan touches NO promo file. Catalog UI owns `admin/bundles.tsx`; admin-controls UI owns `admin/users.tsx` — no overlapping UI writers.

## Review Focus

1. Distinct-payload replay on a superseded row must 409, not create a second successor — Task 2 test.
2. Audit-write failure must roll back successor + link (no half revision) — Task 2 test.
3. Suspended workspace / non-pending payment must still fail settlement after predicate change — Task 2 test.
4. Concurrent revise + purchase: exactly one sellable row, no double spend — Task 2 concurrency test.
5. Money sent through metadata PATCH (or vice versa) would corrupt terms — Task 3 dialog split test.

---

### Task 1: Schema columns + migration 0014 (Owner D)

**Files:**

- Modify: `packages/db/src/schema.ts` (`creditBundles` ~line 262, `subscriptionPlans` ~line 315)
- Create: `packages/db/drizzle/0014_catalog_revision_columns.sql`
- Modify: `packages/db/drizzle/meta/_journal.json` (idx 14, tag `0014_catalog_revision_columns`, `when` after idx 13; verify actual journal at execution)
- Test: `packages/db/test/catalog-revision-schema.test.ts`

**Interfaces (Produces):** `creditBundles.revision_key: text` nullable, `creditBundles.successor_id: text` nullable self-FK → `creditBundles.id`; same two columns on `subscriptionPlans`; partial unique indexes `cb_revision_key_uq` / `sp_revision_key_uq` = `uniqueIndex(...).on(t.revision_key).where(sql\`revision_key IS NOT NULL\`)`.

**Test style — REAL migrated-DB behavior, NOT migration-SQL/source-string assertions.** Run against the migrated test PG (`bun run db:test:up`):

- [ ] **Step 1: Failing behavior tests** (insert against the actual migrated DB):
  - `two rows with equal non-null revision_key violate cb_revision_key_uq` (insert two bundle rows, same non-null `revision_key` → expect unique violation; same for `sp_revision_key_uq` on plans).
  - `multiple rows with NULL revision_key coexist` (uniqueness is partial).
  - `successor_id FK rejects a bogus id` (insert bundle with `successor_id` not in `credit_bundles` → FK violation).
  - `new rows default revision_key and successor_id to NULL` (plain insert → both columns null).
  - `aborted transaction leaves no revision columns written` (tx: insert successor-like row, then throw → rollback → row absent).
- [ ] **Step 2:** `bun run db:test:up && PORT=3998 bun test packages/db/test/catalog-revision-schema.test.ts` → FAIL (columns absent).
- [ ] **Step 3:** Implement schema fields + forward migration `ALTER TABLE ... ADD COLUMN revision_key text, ADD COLUMN successor_id text REFERENCES <table>(id)` + `CREATE UNIQUE INDEX ... WHERE revision_key IS NOT NULL`; journal idx 14.
- [ ] **Step 4:** Re-run Step 2 → PASS. `node_modules/.bin/tsc -p apps/api/tsconfig.json --noEmit` → clean.

### Task 2: Revise endpoints + settlement predicate (Owner A)

**Files:**

- Modify: `apps/api/src/routes/admin-bundles.ts` (after existing `.patch` chains, ~lines 342/~534)
- Modify: `packages/payments/src/credit.ts` (plan branch ~lines 391-435)
- Test: `tests/catalog-revision.test.ts`, `tests/catalog-edit-settlement.test.ts`

**Interfaces:**

- Consumes: Task 1 columns; existing `guard` (session+instance-admin), `writeAudit`, create-validator bodies, `bundleFieldError`, `posInt`/`nonNegInt`, `resolveMixedBundleAmounts` from `admin-bundles.ts`.
- Produces:
  - `POST /api/v1/admin/bundles/:id/revise` body = bundle create shape minus `rate_limit` → `201 {data: successor}` | `200 {data: successor}` replay | `200 {data: old}` no-op | `404` | `409 {error:"RESOURCE_SUPERSEDED"}`.
  - `POST /api/v1/admin/subscription-plans/:id/revise` body = plan create shape (NO `rate_limit_per_minute`) → same codes.
  - `computeRevisionKey(adminUserId: string, resourceId: string, canonicalBody: string): string` → `rev:${adminUserId}:${resourceId}:${sha256hex}`; `canonicalize(body: Record<string, unknown>): string` = JSON with recursively sorted keys — both exported for tests.
- Transaction (single `db.transaction`, spec §4): lock old `for("update")` → replay lookup by key → 409 if old `active=false` (no key match) → no-op guard (canonical body identical → return old) → insert successor (`active=true`, new uuid, full money fields incl. USD group + FX snapshot via `resolveMixedBundleAmounts`, `revision_key=key`) → `UPDATE old SET active=false, successor_id=new.id` → `writeAudit(tx, {kind:"bundle.revise"|"plan.revise", detail:{old_id,new_id,before,after}})` → commit.
- Settlement change in `credit.ts`: delete `active` from the plan select (~line 402) and the `if (!plan.active)` throw (~lines 413-415). Missing-plan, `payment.status !== "pending"`, workspace-suspension, wallet, expiry, CAS, and bundle path unchanged.

- [ ] **Step 1: Failing tests** (names = behavior; migrated test PG):
      `replay returns same successor with 200 and no second row` · `distinct payload on superseded row rejects 409 RESOURCE_SUPERSEDED` · `concurrent distinct revisions yield one active successor and one 409` · `no-op identical body returns current row without successor` · `linkage invariant: old.successor_id=new.id, new.revision_key=request key, old.revision_key IS NULL` · `audit failure rolls back successor, link and audit` · `pending bundle payment settles OLD credit_vnd/bonus_vnd; new purchase uses successor; old row inactive` · `pending plan payment settles after deactivation; suspended workspace and non-pending still fail` · `concurrent revise + purchase sees exactly one of old/new; ledger payment_id dedup prevents double credit/charge` · `cancel/resume flips only canceled_at; paid renewal adopts paid-for plan via plan_id CAS`.
- [ ] **Step 2:** `PORT=3998 bun test tests/catalog-revision.test.ts tests/catalog-edit-settlement.test.ts` → FAIL (404 routes / active predicate).
- [ ] **Step 3:** Implement endpoints + key helpers + `credit.ts` predicate removal.
- [ ] **Step 4:** Re-run Step 2 → PASS. Also `node_modules/.bin/tsc -p apps/api/tsconfig.json --noEmit`.

### Task 3: Admin catalog edit UI (Owner B — `admin/bundles.tsx` only)

**Files:**

- Modify: `apps/web/src/pages/admin/bundles.tsx`
- Test: `tests/admin-catalog-edit-ui.test.tsx`

**Interfaces:**

- Consumes: existing PATCH endpoints (name/active/RPM) and Task 2 revise endpoints.
- Produces: edit dialog routing by field group — name/active (+`rate_limit_per_minute` for plans) submit PATCH; money fields submit `POST .../revise`; renders successor on 201/200 replay, "unchanged" on no-op, 409 `RESOURCE_SUPERSEDED` as "already superseded, reload".

- [ ] **Step 1: Failing test** — `money fields issue revise not PATCH` · `metadata fields issue PATCH not revise` · `409 shows superseded message`. Behavior assertions only (no CSS/source text).
- [ ] **Step 2:** `PORT=3998 bun test tests/admin-catalog-edit-ui.test.tsx` → FAIL.
- [ ] **Step 3:** Implement dialog split following existing admin page patterns.
- [ ] **Step 4:** Re-run Step 2 → PASS; `cd apps/web && node_modules/.bin/tsc -b`.

### Task 4: Integration (Owner C — commits here, workers never stage)

- [ ] **Step 1:** Verify journal actual order: applied idx 13 → `0014_catalog_revision_columns` (this plan) → `0015_admin_wallet_adjustments` (admin plan, same owner D, strictly after). No index/name collisions.
- [ ] **Step 2:** Coherent commits, source+tests together, explicit paths only: Task 1 files (`feat(db): catalog revision columns 0014`), Task 2 files+tests (`feat: catalog financial revision with successor rows and settlement fix`), Task 3 files+test (`feat: admin catalog edit dialog with revise split`).
- [ ] **Step 3:** `PORT=3998 bun run test` (all), `bun run check`, `bun run lint`.
- [ ] **Step 4:** Confirm promo scope untouched: no `admin-promotions.ts`, promo helper, promo UI, or promo endpoint changes. Report unified-promos handoff as blocker for any promo replacement surface work.

## Out of scope (deferred)

- Promo replacement UI/helper — owned by `2026-10-08-unified-promos.md` (server) and its later handoff. Promo snapshot settlement (spec test 8) is already-covered existing behavior.

## Self-review

Spec §1→Task 2 cancel/resume test + RPM carve-out in Global Constraints; §2→credit.ts edit + settlement tests; §3→Task 1 + linkage test; §4→Task 2 transaction + replay/409/no-op/concurrency tests; §5→no-promo-revise guard Task 4; §6→ownership table; §7 tests 1-7→Task 2, test 8→existing behavior; §8→Review Focus 2,3. Signature consistency: `computeRevisionKey`/`canonicalize` used only in Task 2 + its tests. Single DB writer barrier stated (D1).
