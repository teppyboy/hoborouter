# BMC alignment — gap analysis and feature roadmap

Compares the owner's BMC (`docs/business/bmc.md`) against the shipped product
(`docs/STATUS.md`, `docs/requirements.md`). Rules: additive only, no deletions,
integer-VND money invariants hold. Sequenced after auth hardening; coordinated
with the responsive/mobile work.

## Part A — Gap analysis by BMC block

### 1. Customer Segments — IT students / devs / chatbot builders

- **Has:** full dashboard for paying gateway users; workspaces with roles (fits group customers); in-app Chat page.
- **Missing:** nothing for people who are _not yet signed in_ — no landing page, no public pricing, no integration guide. A student's first touch is a login wall.
- **Outside software:** campus marketing, student communities (Facebook groups, Discord), word of mouth.

### 2. Value Proposition — cheaper, fast multi-provider integration, QR payment

- **Has:** per-model USD pricing + markup charged in VND (cheaper-margins are an admin pricing choice); OpenAI-compatible `/v1/*` gateway over many providers via CPA; payOS QR + manual admin top-ups.
- **Missing:** the value props are invisible to prospects (no public pricing page, no quickstart). `hoborouter/auto` public id exists but is a plain single-route model — no routing algorithm (BMC claims routing as a key resource/activity).
- **Outside software:** price competitiveness = supplier (CPA upstream) negotiation.

### 3. Channels — website, Facebook/Threads, Telegram/email support

- **Has:** web app at hoborouter.tretrauit.me; legal pages.
- **Missing:** support/channel links (Telegram, email, Facebook, Threads) are not configurable or displayed anywhere; no public-facing marketing pages.
- **Outside software:** actually running the social channels, posting, ad budget.

### 4. Customer Relationships — self-service, tech support, promos for new + loyal customers

- **Has:** self-service dashboard + OpenAPI `/docs`; audit log.
- **Missing:** quickstart/docs page in-product; no promotions of any kind (no signup bonus, no promo codes, no top-up bonuses); no structured support-intake.
- **Outside software:** answering support chats, designing promo campaigns.

### 5. Revenue Streams — pay-as-you-go, chatbot-integration support fee, group subscription

- **Has:** PAYG billing end-to-end (reservations, idempotent settlement, ledger).
- **Missing:** paid integration-support product (no lead/intake flow); no subscription or prepaid bundles for groups.
- **Outside software:** pricing the support service; negotiating group deals.

### 6. Key Resources — servers, AI sources, routing algorithm, payment APIs, team

- **Has:** CPA data plane, Postgres, payments stack, admin tooling.
- **Missing:** the routing algorithm (block 7 lists it too). Also no business analytics to manage upstream cost (you can't negotiate suppliers without knowing margin per model).
- **Outside software:** ops/marketing/tech personnel.

### 7. Key Activities — operate infra, marketing, supplier negotiation, routing, QR settlement

- **Has:** infra ops (healthchecks, backups, compose), QR/manual payment settlement.
- **Missing:** routing optimization; business dashboard (revenue, upstream cost, margin) that feeds supplier negotiation and marketing decisions.
- **Outside software:** ad campaigns, supplier deals.

### 8. Key Partners — AI providers, cloud, ad platforms

- **Has:** CLIProxyAPI integration (providers via CPA), Docker deploy.
- **Missing:** nothing software-side that blocks this. Cost/margin visibility (above) is what makes partner decisions informed.
- **Outside software:** contracts, ad accounts.

### 9. Cost Structures — AI integration, backend infra, personnel, marketing

- **Has:** usage_logs store `upstream_cost_usd_micro` + `charged_vnd` per request — the raw data for cost structure already exists.
- **Missing:** no aggregated view (revenue, upstream cost, gross margin by model/day, top-ups, active users). Everything else is bookkeeping outside the app.

## Part B — Prioritized feature roadmap

Legend: blocks = BMC blocks served. All DB changes are additive forward
migrations registered in `packages/db/drizzle/meta/_journal.json`. No
dependency additions.

### P1 (do first — makes the value proposition visible and honest)

**P1-1. Public landing + pricing page** (blocks 1, 2, 3)

- Behaviour: unauthenticated `/` landing (hero: cheap AI via OpenAI-compatible API, "no Visa — pay by QR", CTA signup) and `/pricing` (published models with prices converted to VND at the instance rate + markup, refreshed from the same catalog the dashboard uses). Signed-in users hitting `/` keep the Overview route (no behavior change for existing users — landing lives at `/welcome` or `/` pre-auth; owner choice, default: `/` shows landing only when logged out).
- API/DB: new additive routes `apps/api/src/routes/public-catalog.ts`: `GET /api/v1/public/catalog` (published models + current prices) and `GET /api/v1/public/instance` (display name, support links, usd_vnd_rate-derived VND prices). No DB change (reuse `instance_settings`).
- Money-safety: read-only; prices displayed must be computed with the same catalog helpers (`@hoborouter/catalog`) as billing — never a second price path.
- Tests: public catalog route returns only published+priced models and no upstream model ids; VND conversion matches billing math; 404/empty handling.
- Hours: ~10 (API 3, pages 5, tests 2).
- Files: NEW `apps/api/src/routes/public-catalog.ts`; NEW `apps/web/src/pages/public/{landing,pricing}.tsx`; `apps/web/src/router.tsx` (add public routes); NEW `apps/web/src/lib/public-queries.ts`. Touches no WIP-owned file except `router.tsx` (after auth workflow lands).

**P1-2. Quickstart / integration docs page** (blocks 1, 2, 4)

- Behaviour: `/docs/quickstart` (in-app public page, distinct from OpenAPI `/docs`): curl + OpenAI SDK (Python/JS) + coding-agent config examples hitting `/v1/chat/completions`, key creation steps, QR top-up walkthrough. Static content, base URL from public instance config.
- API/DB: none (static page; reuses P1-1 public config route).
- Money-safety: n/a.
- Tests: route renders; copy-able snippets present (UI smoke test only).
- Hours: ~6.
- Files: NEW `apps/web/src/pages/public/quickstart.tsx` (+ content module); `apps/web/src/router.tsx` (one public route).

**P1-3. Configurable support/channel links** (blocks 3, 4)

- Behaviour: admin sets email/Telegram/Facebook/Threads URLs in Admin → Settings; they render in the auth pages footer and a Help entry in the app shell footer area.
- API/DB: extend `admin-settings` (new additive settings keys, e.g. `support_*` in `instance_settings`) + expose via P1-1 `GET /api/v1/public/instance`. No schema change.
- Money-safety: n/a.
- Tests: admin write + unauthenticated read round-trip; settings validation (URL shape).
- Hours: ~5.
- Files: `apps/api/src/routes/admin-settings.ts`, NEW `apps/api/src/routes/public-catalog.ts` (shared with P1-1), `apps/web/src/pages/admin/settings.tsx`, small footer component NEW `apps/web/src/components/support-links.tsx`. Note: `routes/public-config.ts` is WIP-owned — do not touch it; use the new public-catalog route instead.

**P1-4. Automatic routing for `hoborouter/auto`** (blocks 2, 6, 7)

- Behaviour: requests for public id `hoborouter/auto` resolve at request entry to the cheapest healthy published model that satisfies the request (capability + context-window fit; health = CPA health + recent success rate from usage_logs). Response records the model actually used; user sees the real model in logs. Admin can mark models `auto_eligible`.
- API/DB: additive column `models.auto_eligible boolean not null default false` (forward migration). Resolution lives in a NEW `apps/api/src/auto-resolve.ts`; `v1-gateway.ts` calls it before estimation when `public_id === 'hoborouter/auto'` (keep the existing single-route auto model working if no candidate resolves).
- Money-safety: resolve to ONE concrete model before reservation, then bill through the unchanged existing reservation/settlement path — the customer is billed exactly the price of the model actually used; no markup changes, no retroactive repricing. Reservation cap uses the chosen model's price (cheapest-first keeps holds honest).
- Tests: picks cheapest eligible; excludes unhealthy/disabled/unpublished; capability/context filtering; billing uses the resolved model's price snapshot; fallback when nothing eligible; concurrent requests resolve independently.
- Hours: ~14.
- Files: NEW `apps/api/src/auto-resolve.ts`; `apps/api/src/routes/v1-gateway.ts` (hook only); `packages/catalog/src/*` (helper query); NEW migration file; `apps/web/src/pages/admin/models.tsx` (auto_eligible toggle); tests in `tests/`.

### P2 (monetization depth)

**P2-1. Promotions: signup bonus + promo codes** (blocks 4, 5)

- Behaviour: (a) one-time signup credit granted to a workspace on first user signup, gated behind verified email (works with the auth hardening flow); (b) admin creates promo codes (amount, max uses, expiry); users redeem in Billing → Credits. Reshape note: top-up _bonus tiers_ deferred to P3 — pure % bonuses on top-ups are cheapest to add once this ledger plumbing exists, and are more abuse-prone.
- API/DB: new tables `promo_codes` (id, code_hash or unique code, amount_vnd, max_uses, uses, expires_at, created_at) and `promo_redemptions` (promo_code_id, workspace_id, ledger_entry_id; UNIQUE(promo_code_id, workspace_id)); extend `creditWallet` with an `adjustment` credit path carrying an idempotency key.
- Money-safety: credit runs inside `runInImmediate` with wallet lock; redemption insert (unique constraint) + ledger adjustment + balance CAS in ONE transaction → no double credit on retry/race; `balance_after` audit intact; append-only ledger untouched otherwise. Regression tests: double-redeem rejected, concurrent redeem single-credit, expired/maxed code rejected.
- Tests (money invariants): concurrent redemption, duplicate submit, signup bonus granted exactly once per workspace.
- Hours: ~14.
- Files: NEW migration; `packages/wallet/src/wallet.ts` (add `creditAdjustment`); NEW `apps/api/src/routes/promotions.ts` (member redeem) + NEW `apps/api/src/routes/admin-promotions.ts`; `apps/web/src/pages/billing/credits.tsx` (redeem box); NEW `apps/web/src/pages/admin/promotions.tsx`; `apps/web/src/router.tsx` + `app-shell.tsx` nav (coordinate with responsive work — nav item is one line, apply after responsive lands).

**P2-2. Admin business dashboard** (blocks 6, 7, 9)

- Behaviour: Admin → Business: revenue (charged VND), upstream cost USD/VND, gross margin by model and by day, top-ups by day, active users, top workspaces — from existing `usage_logs` + `ledger_entries`, date-range picker. Read-only.
- API/DB: NEW `GET /api/v1/admin/business` aggregating with SQL (no new tables; index additions allowed if needed — additive only).
- Money-safety: read-only aggregates; must sum `charged_vnd` as stored (never recompute from current prices) — matches the "never recompute history" invariant.
- Tests: aggregation correctness vs seeded usage/ledger rows; admin-only authz.
- Hours: ~10.
- Files: NEW `apps/api/src/routes/admin-business.ts`; NEW `apps/web/src/pages/admin/business.tsx`; `apps/web/src/router.tsx` + `app-shell.tsx` admin nav.

**P2-3. Paid chatbot-integration support request form** (blocks 4, 5)

- Behaviour: public `/support/integration` form (contact, workspace optional, project description); creates a lead visible in Admin; admin marks handled. Quote/price stays manual (owner negotiates) — this is lead capture, not payment.
- API/DB: new table `support_leads` (id, contact_email, contact_channel, workspace_id nullable, message, status enum open/handled, created_at, handled_by). New public POST route with Zod + rate limit; admin list/update route.
- Money-safety: no wallet interaction by design (charging for services via wallet would need a debit contract — out of scope; ledger is for AI usage + credits).
- Tests: validation, rate limiting, admin authz, status transitions.
- Hours: ~8.
- Files: NEW migration; NEW `apps/api/src/routes/support-leads.ts` + NEW `apps/api/src/routes/admin-support-leads.ts`; NEW `apps/web/src/pages/public/support-request.tsx` + NEW `apps/web/src/pages/admin/leads.tsx`; router + admin nav.

### P3 (larger bets)

**P3-1. Group prepaid bundles vs group subscription** (block 5)

- Recommendation: **prepaid bundles first** ("nạp 200k tặng X" style fixed-amount bundles purchasable per workspace via existing payment pipeline) — reuses payments + promotions ledger plumbing (P2-1), ships in ~8h. Full recurring subscriptions (monthly included credit, auto-renew) are a second billing engine (periodic grants, settlement order vs wallet) — ~40h+; do only after bundles prove demand. DECISION NEEDED from owner (see Questions).
- Money-safety for bundles: bundle purchase is a `payments` row + `topup` ledger entry (existing idempotent one-topup-per-payment guard covers it); bonus part is an `adjustment` entry keyed on the payment id.

**P3-2. Vietnamese UI language** (blocks 1, 3)

- Full i18n touches every page — conflicts with the responsive sweep and every feature above. Recommend: P1-1 landing/pricing written in Vietnamese-first copy (primary segment is VN students), dashboard stays English until features stabilize, then a dedicated i18n pass (~40h+, own agent, after everything else). DECISION NEEDED.

**P3-3. Top-up bonus tiers** (block 4) — deferred from P2-1; small (~4h) once promo plumbing exists; config in admin settings, bonus credited as `adjustment` keyed on the topup payment.

**Rejected/reshaped candidates:**

- _Subscription as P1/P2 (new-api style)_: reshaped to P3 — heaviest build, least validated demand; bundles deliver the BMC "group package" revenue line with existing machinery.
- _Full marketing/site CMS_: rejected — static public pages (P1-1) cover the channel need; a CMS is speculative scaffolding.

## Part C — Execution plan (small agents, disjoint files)

All work starts **after** the auth-hardening workflow lands (it owns `router.tsx`, `app-shell.tsx`, `public-config.ts`, `admin-extra.ts`, auth/settings pages). Agents A and B run **in parallel** (disjoint files); C, D, E are sequenced after the responsive sweep because they touch `app-shell.tsx` nav / page layout classes; F runs last.

| #   | Agent              | Scope (owned files)                                                                                                                                                                                                                       | Depends on                                                                           | Test gate (red→green)                                                                                          |
| --- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| A   | Public marketing   | NEW `routes/public-catalog.ts`, NEW `pages/public/{landing,pricing,quickstart,support-request}.tsx`, NEW `lib/public-queries.ts`, `components/support-links.tsx`, `router.tsx` (public routes only)                                       | auth hardening; parallel with B                                                      | new tests: public catalog excludes unpublished/upstream ids; VND display math == billing math; form validation |
| B   | Auto routing       | NEW `auto-resolve.ts`, `routes/v1-gateway.ts` (resolution hook), `packages/catalog/src/*` helper, NEW migration (models.auto_eligible), `pages/admin/models.tsx` (toggle), `tests/auto-routing.test.ts`                                   | parallel with A (no shared files)                                                    | billing test asserting charge == resolved model's price, cheapest-first, unhealthy excluded, fallback          |
| C   | Promotions         | NEW migration (promo tables), `packages/wallet/src/wallet.ts` (`creditAdjustment`), NEW `routes/promotions.ts` + `routes/admin-promotions.ts`, `pages/billing/credits.tsx`, NEW `pages/admin/promotions.tsx`, nav line in `app-shell.tsx` | responsive sweep (app-shell); A for redeem-page shell pattern                        | money-invariant tests: no double credit (concurrent + duplicate), expiry/max-uses, signup bonus once           |
| D   | Business dashboard | NEW `routes/admin-business.ts`, NEW `pages/admin/business.tsx`, router/admin-nav                                                                                                                                                          | C optional; can parallel C if C's app-shell edit is deferred to its own micro-commit | aggregation tests vs seeded ledger/usage; authz test                                                           |
| E   | Support leads      | NEW migration (support_leads), NEW `routes/support-leads.ts` + `routes/admin-support-leads.ts`, NEW `pages/admin/leads.tsx`, `components/support-links.tsx` link-in (A's component)                                                       | A (component), parallel with D                                                       | rate-limit, validation, authz, status transition tests                                                         |
| F   | i18n / VN copy     | everything — full-sweep agent, own phase                                                                                                                                                                                                  | all above                                                                            | existing suite green with locales; snapshot-free behavior tests only                                           |

Conflict rules: one writer per file per agent; `router.tsx`/`app-shell.tsx` edits
are limited to additive route/nav entries and land only when that agent owns the
phase (C/D/E serialize on them). No agent touches `auth.ts`, `email.ts`,
`public-config.ts`, `admin-extra.ts` (auth WIP) or the responsive sweep's UI
files (`button.tsx`, `dialog.tsx`, `page.tsx`, `index.html`, `index.css`,
layout classes) — new pages follow the responsive conventions once the sweep
merges.

## Owner decisions required

1. **Group revenue shape**: prepaid bundles first (recommended) or commit to full monthly subscriptions now? (P3-1)
2. **Language**: Vietnamese copy on public pages now, dashboard i18n later (recommended) — or full VN dashboard in the first pass?
3. **Signup bonus policy**: amount (e.g. 10.000 ₫) and gate — verified email only, or verified email + first top-up? Affects abuse exposure and P2-1 test fixtures.
