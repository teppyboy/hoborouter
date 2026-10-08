# Catalog editing: metadata PATCH vs financial revision (bundles, plans, promos)

Status: NORMATIVE SPEC — awaiting written user approval. No implementation before approval.
Supersedes `catalog-revisions-final.md`. HEAD at writing: `5d632aa2`.

## 1. Renewal semantics — verified, unchanged

- Cancel/resume (`packages/wallet/src/subscription.ts:231-245`) only flips `canceled_at` via CAS: informational, no money, no new plan terms.
- Real paid renewal = a NEW plan payment → `credit.ts:391-435` → `extendOrCreateSubscription` (`subscription.ts:402-445`), which CAS-updates `subscriptions.plan_id` to the NEW payment's plan. Each renewal adopts the plan the customer just paid for; existing subscriptions are never retroactively rewritten.
- `rate_limit_per_minute` is live-read at gateway admission (`v1-gateway.ts:493`) and admin-editable on existing plans (`admin-bundles.ts:542-570`). **RPM is NOT part of frozen replacement terms** — it stays a live, direct-edit field via PATCH on whichever row is authoritative. No plan "terms frozen" claim without this carve-out.

## 2. Settlement predicate — exact change, no broad bypass

Current check `credit.ts:413-414` rejects `plan.active=false`. REQUIRED replacement:

```text
settlePlanPayment(tx, payment):
  plan = select from subscription_plans where id = payment.subscription_plan_id  -- by payment FK, no active filter
  if (!plan) fail                                   -- missing plan still fails; rows are never hard-deleted in practice
  if (payment.status !== 'pending') fail            -- existing replay gate upstream; unchanged
  -- workspace suspension / wallet-missing / expiry / CAS checks inside creditWallet
  -- and extendOrCreateSubscription are UNCHANGED
  -- 'active' is no longer consulted for settlement:
  -- deactivation means "stop new sales", not "void paid pending entitlements"
```

Bundle path already has no active check (`credit.ts:361-390`) — unchanged.

## 3. Revision identity — successor carries the key; old row carries a transactional successor link

Replay/supersede arbitration needs a persistent, uniquely-arbitrated marker. A unique index is the only DB-level arbitration; audit detail alone cannot enforce it.

Schema (forward-only migration, registered in `packages/db/src/drizzle/meta/_journal.json`):

- `credit_bundles` and `subscription_plans` both gain:
  - `revision_key: text` — **present only on the SUCCESSOR row**; null on rows never created by a revision. Partial unique index per table: `uniqueIndex("cb_revision_key_uq").on(t.revision_key).where(sql\`revision_key IS NOT NULL\`)`(and`sp_revision_key_uq`).
  - `successor_id: text` — **present only on the SUPERSEDED row**; nullable self-FK to the same table's id. Not unique-indexed (uniqueness carries no arbitration weight — the `revision_key` index does that); each superseded row is written at most once, when it is replaced.
- Key format: `rev:{adminUserId}:{resourceId}:{sha256(canonical(body))}`, computed server-side. The key encodes the replay payload, so key match ⇔ payload match; no separate payload comparison is needed.

**Prohibited: assigning the same `revision_key` to both the old and new rows.** Both rows share each partial unique index, so two rows with one key violate it — the final draft's two-sided assignment is impossible. Only the successor row holds `revision_key`; the old row is linked via `successor_id`, set in the SAME transaction as the successor insert.

Deterministic linkage invariant: for every superseded row, `successor_id` MUST reference the unique active successor that replaced it, and that successor's `revision_key` MUST be the key of the request that performed the replacement. Both facts are written in one transaction — never derived by lookup.

## 4. Revision transaction (single `db.transaction`)

1. Compute the revision key from the authenticated admin + old row id + canonical body.
2. `for("update")` the old row. 404 if missing.
3. Replay check: if a row with `revision_key = key` already exists → return that successor row, **200 replay** (not 201). No writes.
4. If old row is `active=false` (and no key match) → **409 `RESOURCE_SUPERSEDED`**.
5. Insert the successor row (`active=true`, new id, full money fields, `revision_key = key`). The partial unique index arbitrates concurrent same-key replays.
6. `UPDATE old SET active=false, successor_id = new.id` (same transaction).
7. `writeAudit` `*.revise` `{ old_id, new_id, before, after }`.
8. COMMIT. Any failure rolls back successor insert, successor link, and audit together.

Concurrent distinct revisions serialize on the old-row `for("update")` lock; the loser observes `active=false` → 409. Never a second active replacement. No-op guard: identical body to the current row returns the current row unchanged, no successor created.

Metadata edits (name/active/plan-RPM) stay on existing PATCH paths: direct update + audit, no revision machinery.

## 5. Promo corrections (replacement, not revision)

- Replacement promo MUST use a NEW plaintext code → new `code_hash` (`promo_codes` unique index, `schema.ts:491`). No same-code aliasing, no counter resets, no expiry/max_uses edits. PATCH stays `name`/`active` only (`admin-promotions.ts`), aligned with `2026-10-08-unified-promos.md` §6.
- Pending percent payments keep captured discount: `payments` snapshots `promo_code_id`/`promo_kind`/`original_amount_vnd`/`discount_vnd` at creation (`payments.ts:151,158,186-192`; CHECK `payments_voucher_snapshot`, `schema.ts:236-243`); settlement (`credit.ts:186-191`) reads only the snapshot. Deactivation/supersession never touches pending payments.
- No promo revise endpoint: create-new only.

## 6. Interfaces (implementation-phase ownership)

| Change                                                                                                                                                 | File                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `POST /api/v1/admin/bundles/:id/revise`, `POST /api/v1/admin/subscription-plans/:id/revise` (create validators reused, full money fields, no-op guard) | `apps/api/src/routes/admin-bundles.ts`      |
| Settlement predicate per §2                                                                                                                            | `packages/payments/src/credit.ts`           |
| `revision_key` + `successor_id` + partial unique indexes                                                                                               | `packages/db/src/schema.ts` + new migration |
| Edit dialog (metadata PATCH vs financial revise)                                                                                                       | `apps/web/src/pages/admin/bundles.tsx`      |
| No promo revise endpoint                                                                                                                               | — (create-new only)                         |

## 7. Behavior tests (root `tests/`, required before merge)

1. Pending bundle payment on old id settles with OLD `credit_vnd`/`bonus_vnd`; new purchase uses the new row; old row inactive.
2. Pending plan payment settles after revision (§2 predicate); workspace-suspended / missing-plan / non-pending still fail.
3. Cancel/resume flips only `canceled_at`; paid renewal adopts paid-for plan via `plan_id` CAS; no retroactive rewrite.
4. Concurrent purchase + revise: purchase sees exactly one of old/new; no half state.
5. Replay: same revise request twice → one successor row, second call 200 replay. Distinct payload on a superseded row → 409 `RESOURCE_SUPERSEDED`. Concurrent distinct revisions → one active successor, one 409.
6. Linkage invariant: after revision, old row `successor_id` = successor id, successor `revision_key` = request key, old row `revision_key` IS NULL. Audit-failure injection rolls back successor + link + audit.
7. Money invariants: no double credit, no double charge, no concurrent double-spend across revise+settle race (ledger `payment_id` dedup per memo).
8. Promo: superseded/deactivated code does not affect pending percent payment (snapshot terms settle) or prior fixed redemptions; new code = new hash, new counters.

## 8. Residual risks

- §2 settlement change touches the billing path — tests 2 and 7 are the gate.
- Schema addition is 4 columns + 2 partial unique indexes; justified because the unique index IS the replay/supersede arbitration.
- `successor_id` chains are not queryable as "full history" without recursion; the audit `*.revise` events remain the human-readable history.
