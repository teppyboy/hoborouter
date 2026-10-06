# USD Bundle and Subscription Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins author bundle/plan prices and credit in USD; members see USD-first prices and VND equivalents; checkout snapshots server-side FX while accounting remains integer VND.

**Architecture:** Add nullable USD text fields and catalog-creation FX snapshots; leave legacy VND rows intact. Freeze credit/bonus VND when an admin creates the item, preserving the existing settlement pipeline. Resolve USD purchase prices using payment settings inside each payment insertion transaction; expose the same canonical rate to catalog/display clients.

**Tech Stack:** Bun 1.4+, TypeScript, Elysia, Drizzle/PostgreSQL, React/TanStack Query; existing dependencies only.

**Spec:** `docs/superpowers/specs/2026-10-04-usd-bundle-subscription-pricing-design.md`

## Global Constraints

- Customer wallet and ledger amounts remain integer VND; no float money math.
- Forward-only additive migrations; never rewrite historical amounts or applied migrations.
- Server owns price resolution; member requests carry item ID and provider, never authoritative amounts. Currency toggles need not send currency because they do not alter checkout.
- PayOS receives integer VND; snapshot USD input text and the checkout FX rate.
- Reuse `parseUsdCents`, `usdCentsToVndCeiling`, `readPaymentLimits`, and `resolveTopupAmount`.
- No new dependencies, real provider calls, automatic dev-stack restart, worker commits/pushes, or unrelated cleanup.
- Parent makes focused conventional commits after verification. Do not push or release without a current owner instruction.

## Resolved Storage and FX Decisions

Use nullable catalog fields, not a second wallet currency. Bundle columns: `price_usd`, `credit_usd`, `bonus_usd`, `creation_fx_rate_vnd_per_usd`. Plan columns: `price_usd`, `credit_per_period_usd`, `creation_fx_rate_vnd_per_usd`. All USD values are validated decimal text, not SQL floats.

Legacy rows have all these columns NULL and retain exactly their original VND behavior. No backfill at a fabricated historical rate. USD rows store canonical USD texts and VND price/credit/bonus at creation. Credit and bonus are immutable fixed VND grants thereafter; a later FX change affects the purchase price, never already-promised VND grants. Explain this in the editor and member cards. Credit USD equivalents for members use the current canonical rate and the actual frozen VND grant, not an untrue promise that changing FX reprices credit.

On catalog GET, return `usd_vnd_rate` in the existing `{data}` envelope. For USD rows, `price_vnd` in the response is the current server-resolved quote, not the stored creation-time fallback; never UPDATE catalog rows to make this quote. A checkout uses its transaction-time FX read, so the quote may change between listing and purchase. Persisted payment amount and FX remain authoritative.

Use payment settings FX for catalog and wallet display. Do not change gateway usage pricing's independent historical FX snapshots or model-pricing environment configuration.

## Review Focus

- FX changes after listing: checkout owns a new snapshot; UI labels VND quotes as estimates until payment creation.
- FX changes after creation/payment: frozen credits, old payments, and ledger history never change.
- Mixed/missing currency fields: reject incomplete or ambiguous USD/VND admin inputs before any insert.
- Zero bonus/credit versus zero price: permit zero grants consistently with existing bundle rules, reject zero prices; preserve existing subscription settlement constraints.
- Replay/concurrent checkout and spend: separate purchases retain distinct IDs; settlement replay never double-credits and existing reservation safety never double-spends.

## Parallel Execution Schedule

**Scope:** This plan covers the approved USD bundle/subscription change only. CPA controls, E2E reduction, and release/image publication are separate work; do not expand these lanes to unrelated backlog items.

**Topology:** Multi-seam: persistence, admin authoring API, checkout/quote API, admin editor, member/public presentation, and integration each have independently testable contracts. Use up to four concurrent writers after the foundation barrier; more writers would duplicate decisions or overlap files. Fresh task reviews can overlap other independent implementation lanes. Ballpark: 90–180 minutes with working dependencies/test DB; infrastructure or money-regression failures extend this estimate.

### Dependency waves

1. **Foundation — two parallel workers.** `schema` implements the migration/schema portion of Task 1; `usd-format` implements the exact USD text formatter from Task 3. Each gets its own focused tests and fresh review. Parent verifies and commits each independently. Neither worker owns application routes/UI.
2. **Product — four parallel workers from the same committed foundation.** `admin-api` completes Task 1 authoring; `checkout-api` owns Task 2; `admin-ui` owns the editor portion of Task 3; `member-ui` owns billing/public presentation. UI workers use mocked, fixed contracts; they do not wait for backend implementation. Checkout worker seeds USD catalog rows through Drizzle in its isolated tests because admin-api implementation is not yet integrated. Real admin-create-to-checkout coverage belongs to integration.
3. **Candidate gates — rolling fresh reviews.** When a lane finishes, inspect its durable diff/test report, launch one fresh read-only reviewer for spec compliance and quality in that exact candidate worktree. Review schema/checkout money paths at higher rigor. Other independent lanes keep moving. Findings go back only to the lane's sole writer; re-review only changed findings/diff.
4. **Integration — one integration-only worker after accepted handoffs.** Parent applies/rechecks accepted patches and creates small commits serially. Integration worker starts from those commits, exercises real admin creation through catalog/checkout/settlement, fixes only cross-lane mismatches, and adds E2E coverage. It must not rebuild component implementations or refactor unrelated files.
5. **Final gates — parallel independent checks/reviews.** Run API/web typechecks, full tests, and lint/build with separate outputs and no competing writes to shared generated files. E2E uses its isolated stack; only one process owns its ports. Fresh accounting/security and UI/spec reviewers inspect the frozen integrated candidate in parallel. Parent resolves findings, reruns affected checks, commits each coherent fix, and reports actual results.

### Exclusive ownership board

Worktree paths below are logical allocation labels, not paths to create blindly. Record the allocator's actual cwd, branch, base ref, run ID, and manifest before each writer starts. All workers use fresh contexts; native Pi only, no Claude Code/CLI fallback.

| Lane | Exclusive write paths | Dependency | Focused gate | Durable handoff |
| --- | --- | --- | --- | --- |
| `schema` | `packages/db/src/schema.ts`, `packages/db/drizzle/0008_catalog_usd_pricing.sql`, `packages/db/drizzle/meta/_journal.json`, new `tests/catalog-usd-schema.test.ts` | Approved plan | Migrated legacy fixtures; valid/invalid USD groups; direct DB constraint rejection | `schema` report + patch + allocator manifest |
| `usd-format` | `apps/web/src/lib/format.ts`, new `tests/usd-amount-format.test.ts` | Approved formatter contract | Exact string formatting: `5` = `$5.00`, `9.9` = `$9.90`, `0009.99` = `$9.99`; no floating-point rounding | `usd-format` report + patch + manifest |
| `admin-api` | `apps/api/src/routes/admin-bundles.ts`, `apps/api/test/catalog-usd-pricing.test.ts` | Reviewed/committed foundation | Task 1 API red/green, authorization, legacy CRUD, immutable grants | `admin-api` report + patch + manifest |
| `checkout-api` | `apps/api/src/routes/bundles.ts`, `apps/api/src/routes/payments.ts`, `apps/api/src/routes/dashboard.ts`, `apps/api/src/routes/public-catalog.ts`, `apps/api/test/catalog-usd-purchase.test.ts`, `apps/api/test/wallet-usd.test.ts`, `apps/api/test/public-catalog.test.ts` | Reviewed/committed foundation | Task 2 seeded products, both fake providers, canonical FX, cap, snapshots, concurrent replay | `checkout-api` report + patch + manifest |
| `admin-ui` | `apps/web/src/pages/admin/bundles.tsx`, `tests/admin-bundles-usd-ui.test.tsx`, existing `tests/admin-bundles-ui.test.ts` only if behavior expectations require it | Reviewed/committed foundation; fixed admin API contract | USD/VND form controls, exact POST bodies, invalid input, accessible labels, legacy table | `admin-ui` report + patch + manifest |
| `member-ui` | `apps/web/src/pages/billing/bundles.tsx`, `apps/web/src/lib/public-queries.ts`, `apps/web/src/pages/public/pricing.tsx`, `tests/bundles-usd-toggle-ui.test.tsx`, `tests/business-display.test.tsx` | Reviewed/committed foundation; fixed quote API contract | USD prices without wallet rate, current VND quotes, actual grants, toggles, sections, cancel behavior, public price | `member-ui` report + patch + manifest |
| `integration` | new `apps/api/test/catalog-usd-flow.test.ts`, relevant billing area in `tests/e2e/ui.ts`; cross-lane corrections only after exclusive ownership transfer | All accepted component commits | Actual admin-create/purchase/settle flow; isolated fake-provider E2E | Integration report + small categorized patches |
| Reviewers | No source writes | Frozen respective candidate | Cited spec/quality findings and test-evidence gaps | Separate lane-qualified review report |

**No overlapping writers:** Task text below defines requirements, while this board defines ownership. For example, the schema work is not also assigned to admin-api, and `format.ts` is not also assigned to either UI worker. When an interface must change, parent updates the written contract and transfers ownership before sending dependent fixes.

### Commit checkpoints — mandatory

Every small independently verifiable change is committed immediately after its tests/review pass; never wait for a whole wave to bulk-commit. Workers return uncommitted candidate patches; parent alone stages explicit paths and commits. A broken partial implementation is preserved as a handoff, not committed as finished product. Do not make artificial one-line commits that separate a migration from its schema/tests or implementation from its regression test.

| Checkpoint | Commit subject | Atomic contents |
| --- | --- | --- |
| D1 | `docs: specify USD catalog pricing` | Approved spec only |
| D2 | `docs: plan parallel USD pricing work` | This implementation/orchestration plan only |
| F1 | `feat(db): add USD catalog metadata` | Forward migration, journal, schema, direct DB behavior tests; migration compatibility body |
| F2 | `feat(web): format exact USD catalog amounts` | Formatter and focused tests |
| A1 | `feat(api): author USD bundle and plan amounts` | Admin input validation, transaction snapshots/audit, API tests |
| C1 | `feat(api): snapshot USD catalog checkout` | Manual/PayOS price resolution, payment snapshot/replay tests |
| C2 | `fix(api): unify catalog payment FX quotes` | Member/public quoted catalog fields, wallet rate, corresponding tests |
| U1 | `feat(web): author catalog amounts in USD` | Admin editor and interaction tests |
| U2 | `feat(web): use USD bundle and plan prices` | Billing display/toggles/grants/cancellation regression tests |
| U3 | `feat(web): show USD public plan prices` | Public type/query/display changes and tests |
| I1 | `test: cover USD catalog purchase lifecycle` | Cross-component integration behavior |
| I2 | `test(e2e): cover USD catalog checkout` | Relevant E2E flow, no unrelated reductions |

Split C1/C2 only if each intermediate state passes its applicable checks: `bundles.ts` is shared within that single lane. Otherwise record why a single atomic commit is necessary instead of committing a broken state. Split U2/U3 because their implementation files are separate. Any later fix gets its own `fix:` commit plus regression test, not an amend/squash/history rewrite. No `git add -A`, push, tag, or image publication.

### Runtime and recovery contract

- Before launch, discover executable native agents and exact available model IDs. Use a capable fast worker for clear contracts and a strong reviewer for money/concurrency; no guessed model names.
- One coordinated async workflow owns all delegated stages. Launch children only inside it; stable keys and `runs.all` for independent components, `runs.run` for dependent stages. Integration waits for parent acceptance/committed foundation and component results, not merely child success messages. Bind each durable report through `output`, returning actual output references, patch artifacts, and worktree manifests.
- Managed allocation needs a clean source. Preserve existing `.worktrees/` artifacts and untracked unrelated files; no deletion, restore, stash, or force cleanup. Commit approved docs first. If old artifacts prevent allocation, resolve that preflight explicitly before writing; do not silently share the dirty checkout.
- Track progress in a plan-specific ledger: exact base/head, lane ownership, run IDs, actual worktree paths, red/green commands/results, review verdicts, patch hashes, parent commit IDs, unresolved findings, and next gate. Resume completed work from that ledger/Git, never redispatch completed tasks after compaction.
- Use native terminal notifications; no status/log polling or sleeps merely to wait. Keep safe independent lanes moving. If only work is running, yield until notification.
- On timeout/tooling/runtime failure, stop that lane, preserve partial diff and exact error/run/cwd/branch/ref, inspect authoritative status, and try a bounded same-protocol resume only after ownership is clear. Do not repeat the earlier full-task timeout pattern or silently switch to foreground/CLI execution.
- Parent re-runs focused tests on each applied candidate. Branch-wide testing is done on an integration worktree so concurrent checks cannot mutate component candidates. Review evidence is advisory, never a replacement for tests.

---

### Task 1: Add USD catalog authoring and immutable VND grants

**Files:**
- Modify: `packages/db/src/schema.ts`, `packages/db/drizzle/meta/_journal.json`
- Create: `packages/db/drizzle/0008_catalog_usd_pricing.sql`
- Modify: `apps/api/src/routes/admin-bundles.ts`
- Create: `apps/api/test/catalog-usd-pricing.test.ts`

**Interfaces:**
- Existing VND POST bodies remain supported unchanged.
- Bundle USD POST body: `{name: string, price_usd: string, credit_usd: string, bonus_usd?: string}`.
- Plan USD POST body: `{name: string, price_usd: string, credit_per_period_usd: string, period_days?: number, rate_limit_per_minute?: number}`.
- Reject bodies mixing USD and VND money fields. USD bundle bonus defaults to `"0"`.
- Admin GET returns added nullable fields. PATCH still permits only existing name/active/rate-limit edits, never money/FX fields.

- [ ] **Step 1: Write failing API tests.** Create USD bundle at FX `26001`: price `"0.01"` becomes `261`, credit `"5"` becomes `130005`, bonus `"0"` becomes `0`. Create plan with price `"9.99"` and credit `"12"`: price becomes `259750`, credit `312012`. Assert USD texts and creation FX saved, no wallet/ledger writes. Reject `"0"` price, `"1.001"`, `"1e2"`, signs, oversized text/conversion, incomplete and mixed bodies. Retain legacy create and immutable PATCH assertions.
- [ ] **Step 2: Run red.** `PORT=3998 bun test apps/api/test/catalog-usd-pricing.test.ts`; expected missing USD contract/schema failures, not DB connectivity failures.
- [ ] **Step 3: Implement schema and admin branch.** Add nullable text and positive/bounded FX columns; DB CHECKs enforce valid complete currency groups and two-decimal USD syntax (price positive; credits non-negative). Append migration journal entry. Read FX within the catalog creation transaction. Reuse exact existing parsers; handle zero credit/bonus explicitly because `usdCentsToVndCeiling(0n, rate)` returns NULL. Validate VND grants and sums against safe DB money bounds. Store all snapshot fields and audit them. Never apply the payment cap to catalog credit size; payment cap belongs to checkout.
- [ ] **Step 4: Verify green and migration compatibility.** `PORT=3998 bun test apps/api/test/catalog-usd-pricing.test.ts apps/api/test/bundles-routes.test.ts`; then API typecheck. Migrated existing VND fixtures must retain identical values.
- [ ] **Step 5: Parent commits.** Follow checkpoints F1 and A1 separately: migration/schema/DB tests first, admin API/regression tests later. Include additive migration/legacy compatibility in the F1 commit body.

### Task 2: Resolve USD purchases and expose canonical quotes

**Files:**
- Modify: `apps/api/src/routes/bundles.ts`, `apps/api/src/routes/payments.ts`
- Modify: `apps/api/src/routes/dashboard.ts`, `apps/api/src/routes/public-catalog.ts`
- Create: `apps/api/test/catalog-usd-purchase.test.ts`
- Modify: `apps/api/test/wallet-usd.test.ts`, `apps/api/test/public-catalog.test.ts`
- Existing regression gates: `tests/bundles-settlement.test.ts`, `tests/subscription-settlement.test.ts`, `tests/subscription-funding.test.ts`

**Interfaces:**
- Keep purchase POST bodies `{provider?: "manual" | "payos"}`; no USD input for members buying fixed products.
- Extend internal `PayosPurchase` with optional `priceUsd?: string`, supplied only from the server catalog row.
- `makePayosPaymentCreator(...)(workspaceId, userId, amount, purchase?, usdAmountText?)` keeps its existing signature. Resolve `purchase?.priceUsd` for USD catalog items, otherwise existing top-up/VND behavior.
- Member bundle/plan and public plan GET envelopes add `usd_vnd_rate: number`; rows add Task 1 USD fields and current quoted `price_vnd`.
- Wallet `usd_vnd_rate` reads `readPaymentLimits(db).usdVndRate`, not `HBR_USD_VND_RATE`.

- [ ] **Step 1: Write failing tests.** Create USD products at `26000`; change FX to `27001`; purchase both via manual and fake PayOS. For USD `"9.99"`, assert payment/provider amount `269740`, `input_currency="USD"`, `input_amount_text="9.99"`, FX `27001`. Assert cap overflow creates no payment/audit/provider call, forged client amounts cannot control charge, legacy payment snapshots remain VND. Assert quotes and wallet rate agree despite conflicting environment FX. Verify prior pending amounts remain unchanged after another FX edit.
- [ ] **Step 2: Run red.** `PORT=3998 bun test apps/api/test/catalog-usd-purchase.test.ts apps/api/test/wallet-usd.test.ts`; expected missing USD snapshots/canonical rate assertions.
- [ ] **Step 3: Implement transaction-time resolution.** Manual purchase receives catalog USD text and calls `resolveTopupAmount` inside its insert transaction. PayOS does the same for `purchase.priceUsd` (remove existing rule forcing all purchases to NULL USD input). Persist amount, USD snapshot, deadline, FK, audit from the one resolved result. Preflight checks outside the insert transaction must not reject based on stale fallback VND prices. Keep provider failure mapping and top-up behavior unchanged. Add quoted catalog fields using server exact conversion/current payment settings; update public plan type accordingly.
- [ ] **Step 4: Verify no money regressions.** In new tests settle USD-created bundle/plan payments concurrently with duplicate references; assert one grant and unchanged fixed credit at creation FX. Run `PORT=3998 bun test apps/api/test/catalog-usd-purchase.test.ts apps/api/test/bundles-routes.test.ts apps/api/test/payments-payos.test.ts apps/api/test/subscription-member.test.ts apps/api/test/wallet-usd.test.ts apps/api/test/public-catalog.test.ts tests/bundles-settlement.test.ts tests/subscription-settlement.test.ts tests/subscription-funding.test.ts`; then API typecheck.
- [ ] **Step 5: Parent commits.** Follow checkpoints C1 and C2 with focused verification before each. The checkout-api lane owns both; split its shared-file patch only into independently passing states.

### Task 3: Make admin and member USD controls real

**Files:**
- Modify: `apps/web/src/pages/admin/bundles.tsx`, `apps/web/src/pages/billing/bundles.tsx`
- Modify: `apps/web/src/lib/format.ts`, `apps/web/src/lib/public-queries.ts`, `apps/web/src/pages/public/pricing.tsx`
- Create: `tests/admin-bundles-usd-ui.test.tsx`
- Modify: `tests/bundles-usd-toggle-ui.test.tsx`, `tests/business-display.test.tsx`

**Interfaces:**
- Add `formatUsdAmountText(text: string): string` in `lib/format.ts`: validated decimal text to `$` text with two decimal digits using string operations, no Number money conversion.
- Add nullable USD metadata to UI catalog interfaces; GET response interfaces include optional `usd_vnd_rate` for older backend compatibility.
- Member authored USD price uses exact `price_usd`; VND toggle uses server `price_vnd` quote. Legacy price conversion and all credits use canonical FX plus stored VND grants.

- [ ] **Step 1: Write failing behavior tests.** Admin USD-default editor submits exact Task 1 USD strings, rejects invalid decimals, preserves period/rate controls, and can explicitly choose legacy VND mode. Member price `"9.99"` displays `$9.99` even without a wallet FX response; toggling shows catalog quoted VND, not creation fallback. Assert buy request contains provider only. Assert separated sections, active cancellation, canceled/expired states, and USD public subscription prices. Assert currency field labels via accessible controls, never source/CSS text.
- [ ] **Step 2: Run red.** `bun test tests/admin-bundles-usd-ui.test.tsx tests/bundles-usd-toggle-ui.test.tsx tests/business-display.test.tsx`; expected old VND editor/display failures.
- [ ] **Step 3: Implement minimum UI changes.** Add editor currency selection defaulting USD with price/credit/bonus decimal strings; retain VND mode for compatibility. Add proper label/input associations. Explain fixed VND credit derived at creation; table shows authored USD prices and actual grant equivalents. Member page prefers catalog-envelope FX (available without wallet), shows exact USD catalog prices by default, and labels VND estimates until payment creation. Preserve provider selection, existing split sections and cancellation; no new route/dependency. Public subscription cards show USD authored prices and retain VND equivalents; model token prices are untouched.
- [ ] **Step 4: Verify green.** `bun test tests/admin-bundles-usd-ui.test.tsx tests/admin-bundles-ui.test.ts tests/bundles-usd-toggle-ui.test.tsx tests/billing-bundles-ui.test.tsx tests/billing-subscription-ui.test.tsx tests/business-display.test.tsx`; then `cd apps/web && node_modules/.bin/tsc -b`.
- [ ] **Step 5: Parent commits.** Follow checkpoints F2, U1, U2, and U3. Commit formatter, admin editor, member billing, and public plans as separate tested units; do not batch all UI files.

### Task 4: Integrate, verify, and review

**Files:** Product changes from Tasks 1–3 only; amend test coverage in the relevant owning files if a regression is found. No unrelated CPA/E2E cleanup.

**Interfaces:** Test-only fake PayOS and test PostgreSQL. Existing workspace reservations and ledger replay gates remain authoritative.

- [ ] **Step 1: Run the full gates.** Ensure test PostgreSQL is running without restarting dev. Run `bun run check`, `node_modules/.bin/tsc -p apps/api/tsconfig.json --noEmit`, web `tsc -b`, `PORT=3998 bun run test`, `bun run build`. Long-running gates use background tasks and terminal notifications.
- [ ] **Step 2: Verify real UI flow using isolated E2E stack.** Set `E2E_CPA_PORT=8499`; test USD admin creation, member USD/VND toggle, manual/fake-PayOS checkout, subscription cancellation, narrow viewport and accessible control labels. Add behavior coverage to the existing bundle/subscription area in `tests/e2e/ui.ts` if absent; do not reduce unrelated E2E coverage. Never call real providers.
- [ ] **Step 3: Fresh native review.** Read-only reviewer checks spec coverage, exact conversion, grants frozen at creation, transaction snapshots, legacy compatibility, no concurrent double credit/double charge/double spend, authorization, and additive migration. Parent resolves findings with targeted regression tests.
- [ ] **Step 4: Commit any coherent fixes and report evidence.** Explicitly stage paths. List actual gate outcomes and remaining blockers; do not claim release/image success. No push/tag/image publishing in this plan.

## Execution Handoff

Execute using the dependency waves and exclusive ownership board above: two foundation workers, then up to four independent product workers, rolling fresh reviews, one integration-only worker, and parallel final gates. Native Pi only; no Claude Code. The user explicitly requested maximum useful subagent parallelism and commits for every small change; these override the generic sequential-writer skill recipe, never the one-writer-per-worktree safety rule. Parent owns serial acceptance, integration, explicit-path commits, and all publication authority. Await owner approval of this written parallel plan before launching implementation; after approval, continue through all ready stages without asking to continue between tasks.
