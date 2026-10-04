# Xkiro pricing page — layout reference only

Source: **user reference** — https://xkiro.com/dashboard/pricing, observed
authenticated by the parent. These are **observations of another product's
UI**, not hoborouter decisions, not claims to copy, and not owner-approved
pricing or quota values.

## Observed layout (Xkiro, USD)

- Monthly paid tiers: Pro **$5**, Pro+ **$10**, Max **$20**, Ultra **$100**,
  Power **$200**.
- Billing-period toggle: monthly / quarterly (**−10%**) / yearly (**−20%**).
- Card per plan: current-plan badge + price model.
- Dual limits per paid tier:
  - 5-hour budgets: **$5 / $10 / $20 / $100 / $200**
  - 7-day budgets: **$35 / $70 / $140 / $700 / $1400**
- Model / free-token quota display per tier.
- Feature comparison table.
- Pay-as-you-go wallet is **separate** from subscriptions; premium models
  excluded from some entitlements.

## What this reference is for

Layout/UX inspiration only: tier-card composition, billing-period toggle
placement, current-plan badge, dual-budget limit display, comparison table,
wallet separation.

## What must NOT be copied

- **No tier prices.** Never invent hoborouter tier prices or copy Xkiro's
  $5/$10/$20/$100/$200 ladder, and never reuse marketing claims (e.g. "30×
  value" style).
- **No automatic quarter/year discount feature** exists in hoborouter; building
  one is not approved by this note.
- **No rolling-window budgets are approved** (Xkiro's 5-hour/7-day windows are
  their design, not ours).

## Hoborouter invariants that always override this reference

- All customer money is **integer VND**; upstream costs are USD micros with
  recorded `usd_vnd_exchange_rate` / `markup` / `charged_vnd` — never recompute
  history from current prices.
- Period credit model with **15 RPM default**, top-up fallback, expiring
  credits, append-only ledger (`wallet.balance` is a snapshot only).
- Manual payments credited only by instance admins.
