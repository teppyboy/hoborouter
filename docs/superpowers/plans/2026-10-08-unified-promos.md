# Unified Promos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One user promo input on the credits page driven by server-side kind, canonical code normalization, side-effect-free preview, and fixed-kind redeem guard — per the approved spec.

**Architecture:** Single shared API helper module owns normalization + verbatim hashing; all four consumers (admin create, preview, redeem, payment creation) call it. Preview is a read-only, member+ scoped route. Fixed redeem gains a kind guard; percent stays checkout-only. Web collapses to preview → confirm/discount.

**Tech Stack:** Bun + Elysia + Drizzle/Postgres; React 19 + TanStack Query; bun test.

**Spec:** `docs/superpowers/specs/2026-10-08-unified-promos.md` (NORMATIVE, user-approved).

## Global Constraints

- Integer VND only; no float money; client never computes money (`computePercentDiscountVnd` is server-only, `apps/api/src/payment-creation.ts:132`).
- Ledger/redemptions append-only; NO migration, no schema change (spec §9 OUT). Verified journal: last applied idx 13 `0013_api_keys_purpose`; catalog revision migration is `0014` (idx 14) and admin wallet `0015` (idx 15), both registered by the single DB/schema owner of those plans — this lane creates NONE and touches no journal.
- No dependency additions, no runtime secrets, no customer self-credit, no deleted money history.
- `hashPromoCode` hashes its argument verbatim (never re-normalized inside); helper adoption + verbatim-hash change land in the SAME commit.
- Existing lock orders (workspace → promo → wallet) unchanged; preview takes no locks/writes.
- **Ownership:** this lane's server owner (A) exclusively owns `apps/api/src/admin-promotions.ts` and the promo helpers; promo FINANCIAL REPLACEMENT UI (create-new-code replacement form) waits for this handoff — the catalog lane touches no promo file and vice versa.
- Workers never stage/commit. Integration executor (Task 5) makes source+tests-coherent commits, explicit paths only.

## Review Focus

- Case/whitespace variant of an existing code must resolve to the SAME promo (hash identity) — Task 5 consistency test.
- Uppercase expansion (ß→SS) can push a valid-length code over bounds — rejected deterministically (Task 1 unit test).
- Preview must persist nothing (no rows, no locks, no `uses` change) even on error paths (Task 2 test).
- Percent code at redeem and fixed code at checkout both stay non-crediting with exact statuses (Task 2/3 regressions).
- Concurrent payment creations with the same percent voucher consume exactly once; replay gives no second credit (Task 3, existing invariants kept).

## Ownership

- **Owner A — server** (exclusive): `apps/api/src/promo-code.ts` (new), `apps/api/src/routes/promotions.ts`, `apps/api/src/routes/admin-promotions.ts` + promo helpers, `apps/api/src/payment-creation.ts`, `apps/api/src/routes/payments.ts` (boundary map only), Task 1–3 tests.
- **Owner B — web** (exclusive): `apps/web/src/pages/billing/credits.tsx`, `apps/web/src/components/redeem-promo.tsx`, `apps/web/src/pages/admin/promotions.tsx`, Task 4 tests.
- **Owner C — integration** (exclusive): `tests/promo-consistency.test.ts`, commits, full `bun run check` + `PORT=3998 bun run test`.
- **Barrier:** B may start in parallel (Task 2 contract is frozen below); B's contract-conformance fixes wait on A's routes. C starts only after A and B pass their own checks.

---

### Task 1 (Owner A): canonical promo-code helper

**Files:** Create `apps/api/src/promo-code.ts`. Test: `tests/promo-normalize.test.ts`.

**Interfaces (Produces):** `normalizePromoCode(raw: string): string | null` and `hashPromoCode(code: string): string` (SHA-256 of the argument, verbatim — no internal re-normalization). `InvalidPromoReason = "empty" | "invalid_characters" | "too_long"` via `normalizePromoCodeWithReason(raw: string): { code: string } | { reason: InvalidPromoReason }` for admin error text.

- [ ] **Step 1: Failing unit tests** (pure function behavior): legacy 32-hex normalized value byte-identical to old `trim().toUpperCase()` hash; `" abCd1234 "` ≡ `"ABCD1234"` one hash; interior space/punctuation preserved verbatim; ß→SS; 64-codepoint / 128-byte boundary accepted, 65 codepoints and 129 bytes rejected AFTER uppercase; ZWSP/ZWNJ/U+0000/bidi control rejected (`/[\p{C}]/u`); whitespace-only → `null`.
- [ ] **Step 2:** `PORT=3998 bun test tests/promo-normalize.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement both exports: outer Unicode trim only, whole-string `toUpperCase()`, reject `/[\p{C}]/u`, bounds after uppercase via `[...code].length` (1–64) and `TextEncoder` byteLength (≤128).
- [ ] **Step 4:** Re-run → PASS.

### Task 2 (Owner A): adopt helper + preview + fixed-kind guard

**Files (Modify):** `routes/promotions.ts` (delete local `normalizePromoCode` — conflicts with canonical; add kind guard; add preview route), `routes/admin-promotions.ts` (import helper; `hashPromoCode` from `promo-code.ts`; body gains optional `code`), `payment-creation.ts` + `routes/payments.ts` (imports move to `promo-code.ts`; `PROMO_APPLY_STATUS.invalid_code` message drops "32 hex"). Tests: `tests/promo-preview.test.ts`, extend `tests/topup-promo-ui.test.ts` server parts.

**Interfaces:**

- Kind guard: immediately after the redeem promo row lock, `if (promo.kind !== "fixed") return jsonError(409, "PROMO_WRONG_KIND", "This code is a topup discount; apply it at checkout")` — before any other state access.
- Preview: `POST /api/v1/workspaces/:id/promotions/preview`, body `{ code: string, original_amount_vnd?: number }`; session + `wsRole` member+; 200 fixed → `{ kind: "fixed", promo_id, name, amount_vnd }`; 200 percent → `{ kind: "percent", promo_id, name, percent_bp, max_discount_vnd, discount_vnd?, final_due_vnd? }` (money fields only when `original_amount_vnd` is a positive safe integer, computed via `computePercentDiscountVnd`); errors 400 `INVALID_CODE`/`INVALID_AMOUNT`, 401, 404 `NOT_FOUND` (unknown + non-member masking), 409 `PROMO_INACTIVE|PROMO_EXPIRED|PROMO_EXHAUSTED|ALREADY_REDEEMED`. Read-only: no transaction, no `.for("update")`, no writes.
- Admin create: `code` absent → `generatePromoCode()` unchanged; present → normalize (admin-visible reason on failure, 400 `INVALID_CODE`); normalized hash already exists → 400 `CODE_EXISTS`; plaintext in 201 response only.

- [ ] **Step 1: Failing tests** (migrated test PG): preview shapes incl. cap math vs `computePercentDiscountVnd`; side-effect-free (row counts unchanged, incl. on 404/409); 401 unauthenticated; 404 non-member; `original_amount_vnd` ≤ 0 / non-integer → 400; redeem percent → 409 `PROMO_WRONG_KIND` with NO ledger/redemption row and `uses` unchanged (not 500); admin create with variant of existing code → 400 `CODE_EXISTS`; mixed-case/Unicode admin code creation + redeem round-trip; legacy 32-hex still redeems (hash unchanged).
- [ ] **Step 2:** `bun run db:test:up && PORT=3998 bun test tests/promo-preview.test.ts` → FAIL.
- [ ] **Step 3:** Implement per interfaces; same commit adopts helper across all four consumers + verbatim hash.
- [ ] **Step 4:** Re-run → PASS.

### Task 3 (Owner A): money/auth/concurrency regressions

**Files (Test):** `tests/promo-regressions.test.ts` (new; migrated test PG via `bun run db:test:up`).

- [ ] **Step 1: Failing tests:** replay → 409 + no second credit; concurrent last-slot redemptions → exactly one credit (two parallel transactions, one unique-gate rollback); two concurrent payment creations with one percent voucher → exactly one consumed; fixed code at checkout → 409 `not_percent`; payment idempotency with promo attached → no double charge; suspended workspace rejected at preview too (member+ but inactive ws).
- [ ] **Step 2:** Run → FAIL where behavior is new; existing invariants must already pass. Fix Task 2 code if any fail. PASS.

### Task 4 (Owner B): single-input credits UI + admin code field

**Files (Modify):** `apps/web/src/pages/billing/credits.tsx` (remove `PROMO_CODE_PATTERN` at line 227 and 32-hex copy at lines 99, 526; one input + Apply → preview), `apps/web/src/components/redeem-promo.tsx` (reduce to preview-confirm flow or delete + move into credits), `apps/web/src/pages/admin/promotions.tsx` (optional "custom code" input; render server `INVALID_CODE`/`CODE_EXISTS` errors inline). Tests: `tests/promo-ui.test.tsx`, `tests/topup-promo-ui.test.tsx`, `tests/admin-promotions-ui.test.tsx`.

**Interfaces consumed:** Task 2 preview route contract verbatim; redeem endpoint unchanged; payment creation `promo_code` unchanged. NOTE: promo financial REPLACEMENT flow (superseded-code creation UI) is NOT here — it waits for the post-implementation handoff to the catalog lane.

- [ ] **Step 1: Failing UI tests:** fixed preview → "Redeem X₫ credit?" → explicit confirm → redeem success shows new balance; percent preview shows server `discount_vnd`/`final_due_vnd`, re-previews on amount change, proceeds via existing topup with `promo_code`; unknown code renders server 404 message (no 32-hex client gate); mixed-case input accepted; admin custom code validation errors render inline; `autocomplete=off` kept. Behavior tests only — no source/CSS assertions.
- [ ] **Step 2:** `PORT=3998 bun test tests/promo-ui.test.tsx` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS + `bun run lint`.

### Task 5 (Owner C, integration): commits + cross-route consistency

**Files:** `tests/promo-consistency.test.ts` (new).

- [ ] **Step 1: Failing test:** same code created via admin (mixed case + outer whitespace variant, and a supplied custom code) resolves to ONE `code_hash` through preview, redeem, and payment creation; helper adoption proven by legacy hash equality.
- [ ] **Step 2:** Run → fix cross-boundary drift only. PASS.
- [ ] **Step 3:** Coherent source+tests commits, explicit paths (workers stage nothing): `feat: canonical promo code normalization helper` → `feat: unified promo normalization, preview, fixed-kind guard` → `test: promo money invariant regressions` → `feat: single-input promo UI with server preview` → `test: promo cross-route hash consistency`.
- [ ] **Step 4:** Barriers check: no `apps/web` files in Owner A commits, no API files in Owner B commits, no `admin-promotions.ts` edits from catalog lane; journal still ends at idx 13 + later 0014/0015 from their single owner (no promo migration). Then `node_modules/.bin/tsc -p apps/api/tsconfig.json --noEmit` && `cd apps/web && node_modules/.bin/tsc -b` && `bun run check` && `PORT=3998 bun run test`.

## Self-review

Spec §2→Task 2 guard; §3→Task 1 + same-commit adoption (Task 2); §4→Task 2 preview; §5→Task 2 (admin `code`, checkout unchanged); §6→no change here, catalog sequenced post-handoff (Global Constraints); §7→Task 4; §8 tests 1–7→Tasks 2/3/5 (test 7 catalog-side, out of scope); §9 OUT honored (no migration lane). Types consistent: single `normalizePromoCode` spelling everywhere; no DB writes in preview. No staging by workers; commits consolidated in Task 5.
