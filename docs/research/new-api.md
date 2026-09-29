# Research: QuantumNous/new-api as architectural/product reference

## What investigated

Primary sources: official repo `github.com/QuantumNous/new-api` (README.md, AGENTS.md, `.agents/rules/billing.md`, `pkg/billingexpr/expr.md`, `service/quota.go`, middleware listing) and official docs `docs.newapi.pro/en/docs` (API keys, Quota & Top Up, Subscription, Pricing/Model Marketplace, Group Management, full management-API route list). Repo was cloned to a temp dir and key billing docs read directly. No AGPL code copied or ported; research-only for a private university assignment.

Key primary links:

- Repo: https://github.com/QuantumNous/new-api
- AGENTS.md (stack + layout): https://github.com/QuantumNous/new-api/blob/main/AGENTS.md
- Billing conventions: https://github.com/QuantumNous/new-api/blob/main/.agents/rules/billing.md
- Billing expression design doc: https://github.com/QuantumNous/new-api/blob/main/pkg/billingexpr/expr.md
- Docs home: https://docs.newapi.pro/en/docs
- Token docs: https://docs.newapi.pro/en/docs/guide/feature-guide/user/token
- Topup docs: https://docs.newapi.pro/en/docs/guide/feature-guide/user/topup
- Subscription docs: https://docs.newapi.pro/en/docs/guide/feature-guide/user/subscription
- Pricing/marketplace docs: https://docs.newapi.pro/en/docs/guide/feature-guide/user/pricing
- Group docs: https://docs.newapi.pro/en/docs/guide/feature-guide/admin/group

### Findings by area (concise)

**Virtual tokens (API keys)** — `model/token.go` + token management API. Token = virtual key with: own quota limit or unlimited, expiry, model restriction list, IP whitelist (IP/CIDR, assumes trusted proxy), group binding (`auto` group supported), per-key auto-group ordering, cross-group retry switch. Docs: keys page. Confidence: high (docs + source structure).

**Users / groups** — Users have role (common/user), group field; tokens and channels also carry group. Groups are the isolation unit: a user/token only reaches channels whose group matches; group carries a billing multiplier (groupRatio) and per-group model access. `auto` group picks available group in priority order, with per-token override order and cross-group failover. Admin "prefill group" APIs exist (`/api/management/groups/prefill_group`). Groups are admin-configurable (Group Management page; group ratio settings in system settings). Confidence: high.

**Wallet / quota** — Quota is the internal unit ("Consumption = actual token count × model multiplier" per docs). One wallet per user; tokens optionally sub-budget it. `QuotaPerUnit` converts quota ↔ USD (expression system: quota = exprOutput($/1M) / 1,000,000 × QuotaPerUnit × groupRatio). Quota math is centralized in `common/quota_math.go` with saturation at int32 and JS-safe `MaxWalletQuota` for wallet conversions. Top-up via redemption codes, EPay, Stripe, Creem, Waffo; referral reward quota with transfer-to-balance. Confidence: high.

**Pre-consume / settlement / refunds** — The most load-bearing mechanism:

1. Request arrives → estimate cost → `PreConsumeTokenQuota` → `TryReserveTokenQuota` does atomic check+deduct (prevents concurrent overdraw). Estimation runs the pricing expression with locally estimated input tokens, zero output.
2. `quota_setting.pre_consume_multiplier` (default 1) scales token-priced reservations. Wallet trust bypass: `quota_setting.trust_quota_usd` (default 10 USD; wallet AND token must exceed threshold; subscriptions/tasks excluded).
3. Settlement (`PostConsumeQuota` / `TryTieredSettle`) re-evaluates the frozen billing snapshot with actual usage; delta settles against the user + token wallet. Negative quota = refund (`IncreaseUserQuota`). `totalTokens == 0` (upstream timeout) forces quota 0 so the pre-consumed amount is refunded but a log is still recorded.
4. Safety invariants (from `.agents/rules/billing.md`): never produce a negative charge from overflow; bound user-controlled multipliers (image n ≤ 128, max_tokens limits, video durations); central rounding via quota_math helpers; saturation events audited into log `other.admin_info.quota_saturation`.
5. Image/task quantity: pre-consume reserves requested count, settlement uses actual upstream count; client abort cannot reduce charge below requested.
   Confidence: high (read directly from expr.md, billing.md, quota.go analysis).

**Plans (subscriptions)** — Periodic quota packages (daily/weekly/monthly cycles); purchase via payment providers; purchase pays for included quota/privileges for a duration; auto-renew toggle; billing settles against subscription balance (`PostConsumeUserSubscriptionDelta`) before/instead of wallet. Admin subscription management pages exist. Docs are thin on internals; internals inferred from source structure. Confidence: medium-high (user-facing docs direct; settlement path from quota.go).

**Records / logs** — `RecordConsumeLog` per request; log `other` JSON carries billing metadata (`billing_mode`, `expr_b64`, `matched_tier`, `request_rules` trace, `admin_info.quota_saturation` — admin-only field stripped from non-admin views). Frontend renders request-rule traces from logs. Additional log APIs: user self logs, stats, token-scoped logs, admin search/delete. Confidence: high.

**Pricing / models** — Two regimes: legacy ratio tables (model ratio, completion ratio, cache ratios, per-call price) marked deprecated; new **billing expression system** (`pkg/billingexpr`): one expr-lang expression per model, coefficients are real $/1M tokens, variables p/c/cr/cc/cc1h/img/ai/ao/img_cr with AST-introspected auto-exclusion, `len` for tier conditions, `tier()`/`fixed()`/`param()`/`header()`/time functions, request-rule multipliers after `|||`, task-plugin usage facts via `u("key")`. Migration API `POST /api/option/model_pricing/convert` with preview snapshot. Model marketplace `/pricing` shows platform prices (may differ from upstream), tiers, per-1M/1K toggle. Confidence: high.

**Channels** — Upstream adapters (OpenAI/Anthropic/Gemini/Azure/Bedrock/Vertex/DeepSeek/Qwen etc.), group assignment, priority/weight, multi-key mode, retries, channel affinity, auto-disable/enable, balance update, fetch-models, tag management, per-channel tests. `relaykit/` is a standalone Go module for protocol DTO/conversion across the four text protocols. Confidence: high.

**Payments** — Providers: EPay (domestic CN), Stripe, Creem, Waffo + admin redemption codes. Webhook routes: stripe-webhook, creem-webhook, epay-notify; user-pay, user-amount, topup-info endpoints. Also subscription purchase + payment compliance module (`controller/payment_compliance.go`). Confidence: high (API route list is direct evidence).

**Admin** — Management REST surface is large and documented: channel, token, user, group, redemption, model management (with upstream sync), option/system-settings (ratio config, model pricing with versioned `expected_version` optimistic locking), statistics, tasks, vendors, logs, 2FA, passkeys, OAuth (github/discord/linuxdo/oidc/telegram/wechat), setup wizard, payment. Casbin authz in `service/authz/`. Confidence: high.

**Rate limits** — `middleware/rate-limit.go` (global, IP-based), `middleware/model-rate-limit.go` (per-model limits), `common/limiter/` with Redis Lua script (`rate_limit.lua`) for distributed token bucket/sliding-window; `common/rate-limit.go` config. File sizes suggest focused implementations; exact algorithm per limiter not read in depth. Confidence: medium (existence direct; exact semantics not read).

**SQLite / Redis** — SQLite is the zero-config default (Docker quick start mounts `/data` for SQLite persistence); PostgreSQL/MySQL via `SQL_DSN`. Redis optional via `REDIS_CONN_STRING` for cache/rate limiting across cluster; cluster-deployment doc exists. GORM-based models. Confidence: high (README direct for SQLite/DSN; Redis specifics partly interpretation).

**Jobs / async** — `gopool` goroutine pool for async work (notify, logging); async tasks (image/video/Midjourney) with task plugins (`plugins/tasks/` JS plugins run via `pkg/jsplugin/`), task polling/`GET /v1/tasks/{taskId}`; batched DB writes for quota updates (common pattern from one-api lineage; batch update mechanism present but not read in detail). Confidence: medium.

**Frontend** — React 19 + TypeScript, Rsbuild 2, TanStack Router/Query/Table, Zustand, Base UI, Tailwind CSS 4, Bun package manager, i18next with flat JSON locales (7+ languages), Electron desktop wrapper (`electron/`). Console pages: keys, topup, subscription, pricing/marketplace, leaderboard, logs, admin. Confidence: high (AGENTS.md direct).

## Files changed

- None in working repo (research-only). Findings stored in this file (subagent artifact output path).

## Decisions

- Treat expr-based billing + pre-consume/settle/refund as the reference architecture for our own design; reimplement conceptually, do not port AGPL code.
- **License (verified against primary sources, independently audited):** the repo `LICENSE` is verbatim **AGPL-3.0** (https://raw.githubusercontent.com/QuantumNous/new-api/main/LICENSE). The repo `NOTICE` adds **Additional Terms under AGPLv3 Section 7**: modified versions must preserve the attribution "Frontend design and development by New API contributors." in legal/about/footer locations (https://github.com/QuantumNous/new-api/blob/main/NOTICE). Vendor docs additionally describe a **Usage-Based Dual Licensing** model — AGPLv3 by default, with a mandatory Commercial License "in specific commercial scenarios, or when you require rights beyond AGPLv3" (https://github.com/QuantumNous/new-api-docs/blob/main/docs/en/wiki/project-introduction.md). This is the vendor's own description of terms; it is not a legal conclusion — consult qualified counsel before any use outside this private-university assignment. Architecture-only reuse does not create a modified version, so the Section 7 attribution term does not bind our plan, but that assessment is ours, not legal advice.
- Note distinction: legacy ratio pricing (deprecated but present) vs expression pricing (default for new models).

## Tests performed

- None (documentation research task). Verified claims by fetching primary sources directly; repo structure inspected from official GitHub listing/clone.

## Problems / risks

- Exact internals of rate-limit Lua semantics, batch-update flush cadence, and subscription auto-renew scheduling were not read file-by-file — flagged medium confidence; read `middleware/rate-limit.go`, `common/limiter/`, `model/batch_update*` if these matter to our design.
- Docs and README track the latest main branch; deployed versions differ (README itself warns to check release notes). Freshness caveat applies to API route list.
- new-api is AGPL: copying code, or even close paraphrase, into our assignment would trigger AGPL obligations. Architecture/ideas only.
- Some doc pages (subscription admin, environment variables) not fetched; internals of subscription lifecycle partly inferred.

## Suggested next steps

- If our design needs rate limiting: fetch `middleware/rate-limit.go` + `common/limiter/lua/rate_limit.lua` directly.
- If subscription billing matters: read `model/subscription*.go` and admin subscription doc page.
- Check env-var reference (`docs.newapi.pro/en/docs/installation/config-maintenance/environment-variables`) for SQLite/Redis/job configuration before writing our config surface.
