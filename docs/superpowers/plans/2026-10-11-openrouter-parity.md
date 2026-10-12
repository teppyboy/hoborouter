# OpenRouter-Compatible Thinking and Platform Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add catalog-authored thinking-level normalization and the highest-value OpenRouter-compatible API/product controls without duplicating CPA's provider router.

**Architecture:** Store bounded reasoning-route metadata with catalog models/mappings. Normalize OpenAI/OpenRouter/Anthropic request forms at the gateway boundary before reservation, then forward CPA-compatible model/effort fields while preserving public IDs. Add capability metadata, usage correctness, key policy, analytics, and admin/web controls over existing catalog, keys, usage, workspace, and billing seams.

**Tech Stack:** Bun, Elysia, PostgreSQL/Drizzle migrations, Zod/Elysia schemas, React 19, TanStack Query, existing shadcn/Tailwind UI, existing CPA passthrough.

**Spec:** `docs/superpowers/specs/2026-10-11-openrouter-parity-design.md`

## Global Constraints

- CPA remains the provider data plane; no provider adapters, second router, or copied OpenRouter/AGPL code.
- All money remains integer VND; USD micros and FX snapshots remain exact; ledger/reservation/settlement invariants are unchanged.
- Upstream model IDs, credentials, raw errors, prompts, and secret key material never reach public responses or logs.
- Unsupported reasoning/capability requests fail before reservation; dispatched ambiguity charges the full hold; settlement remains idempotent.
- Migrations are forward-only and registered; existing dirty `deploy/docker-compose.yml` config mount is preserved.
- Every behavior change gets behavior tests; stage commits are small and explicit.

## Review Focus

- Conflicting reasoning forms (`reasoning`, `reasoning_effort`, Anthropic `thinking`) must reject ambiguity before billing; test the exact conflict.
- Effort mappings must never leak private CPA model/provider IDs; test public response/model rewrite and error paths.
- Reasoning token splits must not double-count output or allow concurrent billing drift; test stream/non-stream and duplicate settlement.
- Capability and analytics queries must enforce key/workspace authorization and bounded pagination; test unauthorized/private-field cases.
- Key budget/expiry admission must serialize concurrent requests; test no double-spend and no post-expiry dispatch.

### Task 1: Catalog reasoning metadata and migration

**Files:**
- Create: `packages/db/drizzle/0021_model_reasoning_metadata.sql`
- Modify: `packages/db/drizzle/meta/_journal.json`
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/catalog/src/catalog.ts`
- Modify: `apps/api/src/routes/admin-catalog.ts`
- Test: `apps/api/test/catalog-reasoning.test.ts`

**Interfaces:**
- Produce `ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`.
- Produce `ReasoningRouteMapping { public_effort, provider, upstream_model, upstream_effort }` with bounded strings and strict effort enum.
- Produce `getReasoningMetadata(db, modelId)` and `validateReasoningRequest(...)` for gateway consumers.

- [ ] Add forward-only JSON/row metadata with a bounded validation contract, migration journal entry, admin create/update/read fields, audit details, and tests for example `max/xhigh/low` mappings.
- [ ] Commit `feat: add catalog reasoning route metadata`.

### Task 2: Gateway thinking normalization and usage billing

**Files:**
- Modify: `apps/api/src/routes/v1-gateway.ts`
- Modify: `packages/usage/src/usage.ts`
- Test: `apps/api/test/reasoning-gateway.test.ts`
- Test: `tests/usage-reasoning-splits.test.ts`

**Interfaces:**
- Consume Task 1 metadata.
- Produce `normalizeReasoningRequest(protocol, body, metadata)` returning `{ body, routeOverride? }` or a safe client error.
- Extend usage extraction with Anthropic `output_tokens_details.thinking_tokens` and cumulative stream merging.

- [ ] Write matrix tests for OpenRouter/OpenAI/Anthropic forms, conflict rejection, `max/xhigh/low` CPA mapping, unsupported effort pre-reservation, public model rewrite, and tool/structured/multimodal pass-through.
- [ ] Implement normalization before hold/reservation and route selection without exposing provider IDs.
- [ ] Add Responses `incomplete` usage-success handling and reasoning-token billing tests; preserve full-hold missing/ambiguous behavior.
- [ ] Commit `feat: normalize reasoning levels through CPA`.

### Task 3: Public model capabilities and rate-limit metadata

**Files:**
- Modify: `apps/api/src/routes/v1-models.ts`
- Modify: `packages/catalog/src/catalog.ts`
- Modify: `apps/api/src/routes/v1-gateway.ts`
- Test: `apps/api/test/v1-models-capabilities.test.ts`
- Test: `apps/api/test/gateway-rate-limit-headers.test.ts`

**Interfaces:**
- Produce safe `/v1/models` fields: `supported_parameters`, `reasoning`, `capabilities`, `context_window` where public.
- Produce rate-limit headers only from existing limiter state; no fabricated values.

- [ ] Project catalog capabilities and reasoning metadata while excluding mappings/private IDs.
- [ ] Add safe `X-RateLimit-*`/retry headers where a concrete workspace/key limit exists; test 402/429 metadata and absence when unknown.
- [ ] Commit `feat: expose public model capabilities`.

### Task 4: API-key expiry, budgets, and usage endpoint

**Files:**
- Create: `packages/db/drizzle/0022_api_key_budgets.sql`
- Modify: `packages/db/drizzle/meta/_journal.json`
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/keys/src/keys.ts`
- Modify: `apps/api/src/routes/keys.ts`
- Modify: `apps/api/src/routes/v1-gateway.ts`
- Test: `apps/api/test/api-key-budgets.test.ts`
- Test: `tests/keys-page-budget-ui.test.tsx`

**Interfaces:**
- Produce atomic `checkAndReserveKeyBudget(...)`, `GET /api/v1/keys/:id/usage`, and admin/user key fields for `expires_at`, `budget_vnd`, `budget_period`.

- [ ] Add migration/schema fields and strict create/update validation for expiry, VND budget, and daily/weekly/monthly reset.
- [ ] Enforce expiry/budget atomically before wallet reservation; settle actual charged VND against the key policy without changing wallet ledger semantics.
- [ ] Add authorized usage endpoint and UI fields/status/reset display; test expiry, concurrent admission, reset boundary, and no secret exposure.
- [ ] Commit `feat: add API key budgets and expiry`.

### Task 5: Usage analytics and model discovery product APIs

**Files:**
- Create: `apps/api/src/routes/analytics.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/routes/v1-models.ts`
- Test: `apps/api/test/analytics-routes.test.ts`
- Test: `apps/api/test/v1-models-capabilities.test.ts`

**Interfaces:**
- Produce workspace-authorized `GET /api/v1/analytics/activity` and bounded `POST /api/v1/analytics/query` over existing usage/log data.
- Consume public capability projection from Task 3.

- [ ] Implement validated dimensions/metrics/date ranges/cursor pagination; reject private upstream/provider fields and cross-workspace access.
- [ ] Add activity rollups for requests/tokens/charged VND/cache hit rate grouped by public model/key prefix where authorized.
- [ ] Commit `feat: add bounded usage analytics API`.

### Task 6: Admin/catalog, key, analytics, and Chat thinking UI

**Files:**
- Modify: `apps/web/src/pages/chat/index.tsx`
- Modify: `apps/web/src/pages/models/detail.tsx`
- Modify: `apps/web/src/pages/admin/models.tsx`
- Modify: `apps/web/src/pages/keys/index.tsx`
- Create: `apps/web/src/pages/analytics/index.tsx`
- Modify: `apps/web/src/router.tsx`
- Test: `tests/chat-thinking-ui.test.tsx`
- Test: `tests/models-capabilities-ui.test.tsx`
- Test: `tests/keys-page-budget-ui.test.tsx`
- Test: `tests/analytics-page.test.tsx`

**Interfaces:**
- Consume Tasks 1, 3, 4, and 5 API contracts.
- Render public effort labels only; never render CPA route/provider IDs.

- [ ] Add Chat effort selector and request serialization for the canonical form; preserve model/tool/attachment behavior.
- [ ] Add capability badges/filters and effort support to model detail/admin forms.
- [ ] Add key budget/expiry controls and analytics page with loading/empty/error states.
- [ ] Commit `feat: add parity controls to web UI`.

### Task 7: Integration, review, and release

**Files:**
- Modify only files required by review findings and docs/status.
- Test: affected and full suites.

- [ ] Integrate task commits in dependency order; preserve `deploy/docker-compose.yml` dirty config mount.
- [ ] Run focused stage tests, API/web/tests typechecks, `bun run check`, web build, full unit suite, and isolated E2E.
- [ ] Run independent security/billing review; fix only evidenced findings with new tests.
- [ ] Push main, create a new immutable annotated tag, wait exact-tag CI/image digest, publish release notes and verify remote/tag/release/image.
