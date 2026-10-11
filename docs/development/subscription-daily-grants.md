# Subscription daily grants

Policy for once-per-UTC-day subscription credit, implemented in
`packages/wallet/src/subscription.ts` (`applySubscriptionDailyGrant`), the
gateway funding selector (`packages/wallet/src/billing.ts`), and the plan
admin API (`apps/api/src/routes/admin-bundles.ts`). Migration 0019.

## Authoring

- `subscription_plans.daily_grant_vnd` (integer VND, NOT NULL, default 0,
  CHECK `sp_daily_grant_vnd`). 0 = no daily grant.
- Settable at plan creation and revisable through the successor flow
  (omitted = carried over from the old row); rejected on PATCH (frozen
  financial term, same contract as `credit_per_period_vnd`).
- USD-per-day is authored as VND through the admin mixed-currency catalog
  (e.g. 5 USD/day at a 26,000 VND/USD snapshot = `130000`). The column is a
  money column: frozen once authored, never recomputed.

## Grant policy

1. **Lazy, once per UTC calendar day.** The grant runs inside the gateway
   funding transaction (`reserveRequest` with a funding arg) whenever the
   workspace has an active unexpired subscription. Never by a scheduler.
2. **No catch-up.** Only the CURRENT UTC day of the funding transaction is
   granted; days without a gateway funding transaction get no row and no
   credit.
3. **No grant at settlement.** Plan settlement (wallet ensure, expiry,
   extend, period credit) writes no daily grant. The purchase day's grant
   arrives with the first funding transaction.
4. **Cancel/expiry.** A canceled-but-unexpired subscription keeps receiving
   grants through `current_period_end`. At period end the lazy expiry
   forfeits unused grant credit exactly like any other subscription-wallet
   credit, and no new day is granted.
5. **Terms snapshot.** The grant row freezes `plan_id` and `amount`; later
   plan revisions never reshape past grants.

## Money and concurrency invariants

- Ledger is append-only: one `credit` row, kind
  `subscription_daily_grant`, memo `daily grant YYYY-MM-DD`; `balance_after`
  chains from the wallet CAS.
- Idempotency is layered: the subscription wallet is locked FOR UPDATE
  first (serializes concurrent funding transactions), the gate is re-read
  after the lock, and `UNIQUE(workspace_id, subscription_id, grant_day)` on
  `subscription_daily_grants` is the storage-layer arbiter. The gate row's
  `ledger_entry_id` FK forces credit-before-gate, so a lost gate insert
  rolls the credit back. Concurrent touches credit exactly once.
- Amounts are integer VND bounded by `MAX_SAFE_INTEGER_MONEY` (DB CHECK
  `sdg_amount`); no floats anywhere in the path.

## Boundary with existing behavior

- Lazy expiry (O5) still runs first in the funding path; an expired period
  forfeits leftover credit and grants nothing.
- Plans with `daily_grant_vnd = 0` behave exactly as before; the grant call
  is a no-op and funding selection is unchanged.
- Prepaid throughput, bundles, promo codes, and plain top-ups are untouched.
