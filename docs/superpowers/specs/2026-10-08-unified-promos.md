# Unified promos: one user input, server-kind-driven

Status: NORMATIVE SPEC — awaiting written user approval. No implementation before approval.
Supersedes design artifacts `unified-promo-final.md` (v2). HEAD at writing: `5d632aa2`.

## 1. Current state (verified)

- `promo_codes` stores hashed `code_hash`, `kind: fixed|percent`; `promo_redemptions` has UNIQUE(promo_code_id, workspace_id) + gate `pr_one_gate` (`packages/db/src/schema.ts:458-520`).
- Fixed redeem: POST `/api/v1/workspaces/:id/promotions/redeem` (`apps/api/src/routes/promotions.ts:49-191`); tx with lock order workspace → promo → wallet; replay → 409.
- Percent at topup: `promo_code` on payment creation (`apps/api/src/routes/payments.ts:297,336-340,389-396`) via `applyPromoToTopup` (`apps/api/src/payment-creation.ts:187-283`).
- Admin create: CSPRNG-only 32-hex codes (`admin-promotions.ts:49-55`), hash stored, plaintext shown once.
- Normalization today: `trim().toUpperCase()` + `/^[A-F0-9]{32}$/`; hash = SHA-256 of normalized value.

## 2. Bug fix — redeem must reject percent codes with an exact status

Current behavior: redeem has NO kind check. A percent row has `amount_vnd = NULL`; `Number(null) = 0` reaches `creditWallet`, which throws `WalletError("invalid")` (`packages/wallet/src/wallet.ts:26-31`); the tx rolls back and the request surfaces as an unhandled **HTTP 500**. No credit, no burned use, no ledger row (rollback is atomic).

REQUIRED: redeem MUST check `promo.kind !== "fixed"` immediately after the promo row lock and return **HTTP 409 `PROMO_WRONG_KIND`** ("This code is a topup discount; apply it at checkout") before any other state access. All other redeem behavior is unchanged.

## 3. Canonical normalization — one helper, no case-sensitive exception

One exported helper `normalizePromoCode(raw: string): string | null` in a single shared API module. Consumed by admin create, preview, redeem, AND payment creation. `hashPromoCode(normalized)` MUST hash its argument verbatim — the normalized value is hashed exactly once, never re-normalized inside the hash. Helper adoption and the verbatim-hash change MUST land in the same commit.

Rules (all MUST):

1. Input MUST be a string; non-strings rejected at the trust boundary (Zod).
2. Trim OUTER whitespace only (Unicode edge whitespace). Interior characters — spaces and punctuation included — are preserved verbatim. No NFKC, no interior collapse.
3. Reject if ANY codepoint matches `/[\p{C}]/u` (Unicode categories Cc, Cf, Cs, Co, Cn): control chars U+0000–001F and U+007F, ZWSP/ZWNJ/ZWJ, bidi controls, surrogates, unassigned. Interior spaces and visible punctuation are NOT in `\p{C}` and are allowed. (Whitespace is preserved; only `\p{C}` is rejected.)
4. Whole-string Unicode uppercase, applied unconditionally: `code.toUpperCase()` (locale-independent per ECMAScript). No ASCII-only exception, no case-sensitive path.
5. Validate bounds AFTER uppercase: 1–64 normalized codepoints (`[...code].length`) AND ≤ 128 UTF-8 bytes (`TextEncoder` byteLength). Uppercase expansion (ß→SS) counts against the bounds; a code exceeding bounds only after uppercase is rejected — deterministically, same input ⇒ same verdict.
6. Result is the normalized string. Same normalized string ⇒ same hash ⇒ same promo. Variants differing only by case or outer whitespace normalize identically.
7. Legacy compat: for any 32-hex code, trim+toUpperCase is the identity on the normalized value, so SHA-256 output is byte-identical to today's hashes. No migration of existing rows.
8. Collisions: `promo_codes.code_hash` UNIQUE. A variant normalizing to an existing hash IS that promo. Admin create answers **400 `CODE_EXISTS`**; user-facing paths resolve to the existing promo. Strings failing rules 3/5 are invalid input (**400 `INVALID_CODE`**), never hashed.

## 4. One user input on the credits page

One input, one Apply → POST `/api/v1/workspaces/:id/promotions/preview`, body `{ code: string, original_amount_vnd?: number }`.

- Authorization REQUIRED: session + `wsRole` member+ (same as redeem). Preview is NOT an open enumeration path: no unauthenticated or cross-workspace access; unknown/invalid answers use the same uniform 404 masking as redeem; the endpoint adds no information a member cannot obtain by attempting redeem. No new rate-limit infra; same session/authz pipeline as sibling routes.
- Side-effect-free: read-only SELECT. No transaction writes, no row lock, no `uses` increment, no redemption row.
- `kind === "fixed"` → UI shows "Redeem X₫ credit?" → explicit confirm → existing redeem endpoint. Preview never credits.
- `kind === "percent"` → discount preview per topup amount (re-preview on amount change) → user proceeds through the existing payment-creation flow with `promo_code`. Percent never credits a wallet directly.

Preview responses (MUST):

- 200 fixed: `{ kind: "fixed", promo_id, name, amount_vnd }`.
- 200 percent: `{ kind: "percent", promo_id, name, percent_bp, max_discount_vnd, discount_vnd?, final_due_vnd? }` — discount fields present only when `original_amount_vnd` is a positive safe-integer VND; computed server-side by `computePercentDiscountVnd`. The client never computes money.

Preview errors (exact): **400 `INVALID_CODE`** | **400 `INVALID_AMOUNT`** (`original_amount_vnd` ≤ 0 or non-integer) | **401** unauthenticated | **404 `NOT_FOUND`** unknown code or non-member (uniform masking) | **409 `PROMO_INACTIVE` | `PROMO_EXPIRED` | `PROMO_EXHAUSTED` | `ALREADY_REDEEMED`**.

Stale previews are advisory only; redemption/topup revalidates every gate under FOR UPDATE inside the money transaction.

## 5. API contract

| Endpoint                                        | Change                                                                  | Errors (exact)                                                                                                                                             |
| ----------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ----------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST `/api/v1/workspaces/:id/promotions/redeem` | §2 kind guard only; input `{ code: string }` unchanged                  | new **409 `PROMO_WRONG_KIND`**; all existing codes unchanged                                                                                               |
| POST `.../promotions/preview`                   | new, per §4                                                             | per §4                                                                                                                                                     |
| Payment creation `promo_code`                   | unchanged                                                               | **400** invalid; **404** unknown; **409 `not_percent`** (fixed code at checkout)                                                                           |
| POST `/api/v1/admin/promotions`                 | gains optional `code?: string`; absent → CSPRNG legacy 32-hex unchanged | **400 `INVALID_CODE`** with admin-visible reason (too short/long, invalid characters after normalization, only controls/whitespace); **400 `CODE_EXISTS`** |

Admin create: hash stored; plaintext in the create response only; never in GET/PATCH/audit (`safePromo` already omits `code_hash`). Admin UI surfaces validation errors inline.

Voucher consumed at payment creation even if the payment later expires unpaid — existing approved behavior, KEPT.

## 6. Promo edit/revision — owned by the catalog-editing spec

Financial definition (kind, amount_vnd, percent_bp, max_discount_vnd, code_hash) is immutable. Revision = create a NEW promo row and deactivate the old one; replacement MUST use a NEW plaintext code (new `code_hash`). PATCH stays `name`/`active` only. Old codes keep working pending redemptions; redemption history FK intact; no deletes. Normative details: `2026-10-08-catalog-editing.md`.

## 7. Web (credits.tsx + redeem-promo.tsx)

One input, one Apply button → preview. Confirm (fixed) or discount (percent). Remove hard-coded 32-hex pattern/copy (`credits.tsx:99,126,526,713`); render server error strings; `RedeemPromo` reduced to the same preview-confirm flow or removed. `autocomplete=off` kept.

## 8. Required regression tests (root `tests/`)

1. Redeem percent code → **409 `PROMO_WRONG_KIND`**; assert NO ledger row, NO redemption row, `uses` unchanged, and NOT a 500.
2. Preview: fixed + percent shapes incl. cap/integer-VND math vs `computePercentDiscountVnd`; byte-level side-effect-free (no rows/locks persisted); unauthenticated → 401; non-member → 404; `original_amount_vnd` ≤ 0 / non-integer → 400.
3. Normalization helper (unit): legacy 32-hex normalized value identical pre/post change; mixed case + outer-whitespace variants share one hash; interior space/punctuation preserved verbatim; ß→SS uppercased deterministically; bounds AFTER uppercase (65 codepoints / 129 UTF-8 bytes rejected, boundary accepted); control/Cf (ZWSP, ZWNJ, U+0000, bidi) rejected; non-ASCII code IS case-insensitive (no exception path); empty/whitespace-only rejected.
4. Cross-route consistency: same normalized code via admin create, preview, redeem, payment creation resolves to one `code_hash`/promo; `hashPromoCode` receives the normalized value exactly once.
5. Collision: admin create with a case/whitespace variant of an existing code → 400 `CODE_EXISTS`.
6. Money invariants: replay → 409 + no second credit; concurrent last-slot race → exactly one credit; percent double-apply on concurrent payment creations → exactly one consumed; fixed code at checkout → 409; payment idempotency with promo attached → no double charge.
7. Revision: financial-field PATCH → 400 (catalog-editing ownership); deactivate + new row → old redemptions/redemption history intact.

## 9. Scope

IN: §2 kind guard, §3 canonical helper, §4 preview, §5 admin code input, §6 alignment, §7 UI, §8 tests.
OUT: DB schema changes, migrations, new rate-limit infra, NFKC/interior stripping, changing unpaid-expiry voucher consumption, checkout separation.

## 10. Residual risks

- Short/low-entropy admin codes (approved; bounded by once-per-workspace + confirm).
- Uppercase expansion can push a valid-looking code over bounds (deterministic rejection; admin error names the reason).
- Preview adds one member-authenticated read path; enumeration surface identical to redeem (uniform 404), no new unauthenticated access.
- `hashPromoCode` verbatim-hash change must land in the same commit as helper adoption (test 4 covers).
