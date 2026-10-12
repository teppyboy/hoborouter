# OpenRouter-Compatible Thinking and Platform Parity

## Status

Draft for owner review. Design approved conversationally; implementation waits for written-spec approval.

## Goal

Add a canonical, catalog-authored reasoning/thinking contract while preserving Hoborouter's boundary: Hoborouter owns auth, catalog, billing, policy, and product UX; CPA owns provider conversion, routing, credentials, and failover. Expand adjacent compatibility/product surfaces without copying OpenRouter/OpenAI/Anthropic implementation code or exposing upstream model IDs/secrets.

## Scope

### Stage 1: canonical reasoning normalization

Accept these equivalent request forms:

- OpenRouter: `reasoning: { effort }`, `reasoning: { max_tokens }`, `reasoning: { enabled }`.
- OpenAI: `reasoning_effort`.
- Anthropic: `thinking: { type: "enabled", budget_tokens }`, `adaptive`, or `disabled`; `output_config.effort` where applicable.

Catalog metadata describes supported efforts, default effort, and per-route CPA mapping. A request resolves its public model and selected route before billing reservation. The selected route determines the CPA-compatible upstream model and reasoning value. Unsupported/invalid combinations fail before reservation. Public responses keep the requested public model ID.

A route mapping supports examples such as `max`/`xhigh`/`low` mapping from a public Claude model to a CPA Z-AI GLM route with `high`/`high`/`none`. No provider adapter is added.

### Stage 2: usage and billing correctness

- Preserve Anthropic `output_tokens_details.thinking_tokens` through non-stream and cumulative stream usage extraction.
- Bill reasoning tokens using the existing catalog reasoning price, without double-counting output tokens.
- Treat Responses `incomplete` responses with valid usage as normal billed outcomes; retain full-hold charging for missing/ambiguous usage.
- Add regression coverage for idempotent settlement and reasoning splits.

### Stage 3: compatibility metadata and preflight

Extend `/v1/models` with safe capability metadata: supported parameters, reasoning efforts/default, tools, structured outputs, vision, and streaming. Metadata is derived from catalog fields and never includes private upstream IDs. Add capability preflight for explicitly requested tools/structured output/reasoning; CPA remains responsible for actual conversion.

Preserve passthrough of tools, structured output, multimodal content, and streaming. Add safe rate-limit headers and metadata where existing limiter state supports them; do not fabricate unavailable limits.

### Stage 4: product parity

- API-key expiry, per-key spend budgets, reset periods, and remaining-budget/usage endpoint.
- Model capability filtering/discovery in admin and public model views.
- Usage/activity analytics endpoints over existing request/usage data, with workspace authorization and no secrets/private upstream IDs.
- Workspace/team policy controls using existing workspace/member authorization; no overbuilt team UI.
- Provider preference/fallback controls only through verified CPA-compatible configuration seams; no second router.

## Data model

Add forward-only migration(s), journal entries, schema fields, and tests for route reasoning metadata and API-key policy/budget fields. Existing model, mapping, price, key, usage, reservation, and ledger history remain immutable where currently required. All money remains integer VND; USD micros and frozen FX snapshots remain exact. No migration edits or dialect-specific SQL.

Prefer JSON/text metadata only where bounded Zod validation and deterministic projection are sufficient; use normalized rows when querying/filtering or concurrency requires it. Metadata edits are instance-admin-only, audited, and do not rewrite usage history.

## Request flow

1. Authenticate key/session and resolve public model.
2. Validate body and requested capability/reasoning against catalog route metadata.
3. Normalize canonical reasoning to the selected CPA route's body/model mapping.
4. Estimate conservative hold including reasoning/output capacity.
5. Reserve and mark dispatching atomically.
6. Forward exactly once to CPA; preserve stream protocol.
7. Extract actual usage, including reasoning/cache splits; settle once.
8. Rewrite private model IDs and emit public capability/usage-safe metadata.

## Security and invariants

- No upstream model IDs, provider credentials, management keys, raw upstream errors, prompts, or secret key material in public responses/logs.
- Unsupported capability requests fail before reservation.
- Every settlement remains idempotent; ambiguous dispatched requests charge full hold.
- Key budget/expiry checks are atomic with request admission; no concurrent overspend.
- Analytics are workspace/key-authorized and bounded; pagination prevents unbounded scans.
- Provider fallback remains CPA-owned; Hoborouter never retries a dispatched request as a second provider call.

## Testing and rollout

Each stage ships with behavior tests before integration:

- reasoning normalization matrix and malformed/unsupported preflight;
- Chat, Responses, and Messages usage/reasoning billing, stream/non-stream;
- `/v1/models` capability projection and private-field absence;
- key budget/expiry/concurrent admission invariants;
- analytics authorization/pagination;
- UI capability filters and thinking controls;
- existing full suite, typechecks, `bun run check`, web build, and isolated E2E.

Implement in small commits and staged lanes: schema/catalog, gateway/usage, product APIs, web UI, independent security/billing review, then one integration owner. Existing dirty `deploy/docker-compose.yml` config mount is unrelated and must remain preserved.

## Explicit non-goals

No provider adapters, second router, OpenRouter source/code copy, AGPL/New API code, Redis/Kafka/workers, real provider calls in tests, management-key browser path, or fabricated benchmarks/cost metadata.

## Primary sources

See `docs/research/openrouter-parity.md` for official OpenRouter, OpenAI, and Anthropic source links and the current-repo gap analysis.
