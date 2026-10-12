# Research: OpenRouter parity — reasoning, routing, usage, keys vs Hoborouter gateway

Date: 2026-02 (research run). Sources: official docs only (OpenRouter,
OpenAI platform docs, Anthropic/Claude platform docs), fetched directly.
No source edits, no dependencies, no provider calls.

## Summary

OpenRouter is a normalized multi-provider router whose _API compatibility_
surface is: a unified `reasoning` parameter + `reasoning_details` response
metadata, a `provider` routing object with model fallbacks, always-on `usage`
including `cost` and cache splits, a `GET /api/v1/key` limits endpoint, a
management-key `/api/v1/keys` CRUD API, and an analytics query API. Hoborouter
today is a thin billing passthrough (`/v1/chat/completions`, `/v1/responses`,
`/v1/messages`) that forwards all of these params verbatim to CPA and extracts
only usage totals for billing. The concrete compatibility gaps are narrow
(usage-split extraction misses Anthropic `output_tokens_details.thinking_tokens`;
Responses `response.incomplete` treated as a billing error; 1 MiB body cap on
Responses; no reasoning metadata in `/v1/models`); the remaining OpenRouter
surface (provider routing, per-key credit limits, analytics API, management
keys) is product parity that the requirements explicitly assign to CPA or to
later milestones, not gateway work.

## 1. OpenRouter — official API surface (with exact claims)

### 1.1 Reasoning parameters and response metadata

Source: <https://openrouter.ai/docs/guides/best-practices/reasoning-tokens.md> (fetched in full).

- Request param `reasoning`: `{ effort }` ("max", "xhigh", "high", "medium",
  "low", "minimal", "none") **or** `{ max_tokens }` (not both), plus
  `exclude: boolean` (default false) and `enabled: boolean`. Direct quote:
  "One of the following (not both): `effort`… `max_tokens`".
- Effort is normalized per provider: for Anthropic the page gives the exact
  formula `budget_tokens = max(min(max_tokens * effort_ratio, 128000), 1024)`
  with effort_ratio 0.95 (max/xhigh), 0.8 (high), 0.5 (medium), 0.2 (low),
  0.1 (minimal), and "max_tokens must be strictly higher than the reasoning
  budget". For Gemini 3, `reasoning.effort` maps to Google `thinkingLevel`
  (xhigh maps down to "high").
- Response metadata: reasoning text appears in `choices[].message.reasoning`
  (aliases `reasoning_content`) and structured blocks in
  `choices[].message.reasoning_details` (non-stream) /
  `choices[].delta.reasoning_details` (stream). Each detail object has `id`,
  `format` (e.g. `"anthropic-claude-v1"`, `"openai-responses-v1"`), `index`,
  and a type (`reasoning.summary`, plus encrypted/text types).
- Reasoning tokens are "considered output tokens and charged accordingly" and
  "count against `max_tokens`"; the documented overflow signal is
  `finish_reason: "length"` with empty `content`, detectable via
  `usage.completion_tokens - usage.completion_tokens_details.reasoning_tokens`.
- Per-model discovery: `GET /api/v1/models` entries may carry
  `reasoning: { supported_efforts, default_effort, default_enabled,
supports_max_tokens, mandatory }`.
- Legacy params still accepted: `include_reasoning: true/false`.
- Anthropic Messages normalization table (exact from the page):
  `output_config: { effort }` ⇔ `reasoning: { effort }`;
  `thinking: { type: "enabled", budget_tokens }` ⇔
  `reasoning: { max_tokens: budget_tokens }`;
  `thinking: { type: "adaptive" }` ⇔ `reasoning: { enabled: true }`;
  `thinking: { type: "disabled" }` ⇔ `reasoning: { enabled: false }`.
- Multi-turn preservation: pass back `message.reasoning` (string) or
  `message.reasoning_details` (array) unmodified; required for Claude tool-use
  reasoning continuity. `reasoning.context` (`auto`/`all_turns`/`current_turn`)
  and `reasoning.mode` (`standard`/`pro`) are model-scoped extensions
  (GPT-5.6+). Mid-conversation effort changes arrive as a content-less
  `system` message with `configuration_update` (Chat Completions form is an
  OpenRouter extension; OpenAI's own Chat Completions has no equivalent).

### 1.2 Streaming

Source: <https://openrouter.ai/docs/api-reference/streaming.md> (fetched in full).

- `stream: true`; SSE frames `data: {...}` terminated by `data: [DONE]`.
- OpenRouter sends keep-alive **comments** `: OPENROUTER PROCESSING`; parsers
  must skip `:`-prefixed lines before `JSON.parse`.
- Exact claim on the final usage chunk: "On the Chat Completions endpoint,
  every stream ends with an extra chunk that carries the `usage` object… sent
  just before the `[DONE]` message. OpenAI's spec emits this chunk with an
  empty `choices` array, but many clients crash… so OpenRouter intentionally
  deviates: the usage chunk contains one choice with a content-free `delta`
  that repeats the `finish_reason` (and `native_finish_reason`)". So the
  terminal `finish_reason` appears twice; the usage chunk is "an accounting
  frame rather than a second terminal event".
- Per-endpoint usage placement: "the Responses API (`/api/v1/responses`)
  reports usage in the `response.completed` event, and the Messages API
  (`/api/v1/messages`) reports it in the `message_delta` event before
  `message_stop`".
- `X-Generation-Id` response header returned on all endpoints.
- Errors mid-stream arrive as SSE events with an `error` field; a rate limit
  after headers were sent arrives as SSE with `finish_reason: "error"` instead
  of HTTP 429. Stream cancellation: "For supported providers, this immediately
  stops model processing and billing."

### 1.3 Usage accounting

Source: <https://openrouter.ai/docs/cookbook/administration/usage-accounting.md> (fetched in full).

- "No additional parameters are required": every response includes `usage`
  with prompt/completion tokens, `cost` (credits),
  `cost_details.upstream_inference_cost`, reasoning token counts, and cached
  token counts. `usage: { include: true }` and
  `stream_options: { include_usage: true }` are "deprecated and have no
  effect".
- `prompt_tokens_details.cached_tokens` = tokens _read_ from cache;
  `prompt_tokens_details.cache_write_tokens` = tokens written (only for
  models with explicit cache-write pricing).
- Async alternative: fetch usage by generation id via the `/generation`
  endpoint; `upstream_inference_cost` is BYOK-only there.

### 1.4 Provider routing and fallbacks

Sources: <https://openrouter.ai/docs/guides/routing/provider-selection.md> (fetched, 67 KB),
<https://openrouter.ai/docs/guides/routing/model-fallbacks.md> (fetched in full).

- Request-body `provider` object fields (exact table): `order: string[]`,
  `allow_fallbacks: boolean` (default true), `require_parameters: boolean`
  (default false), `data_collection: "allow"|"deny"`, `zdr: boolean`,
  `enforce_distillable_text`, `only: string[]`, `ignore: string[]`,
  `quantizations: string[]`, `sort` ("price"|"throughput"|"latency" or object
  with `by`+`partition`), `preferred_min_throughput`, `preferred_max_latency`,
  `max_price`.
- Default strategy: "load balance requests across providers, prioritizing
  price": skip providers with outages in last 30 s, weight selection by
  inverse square of price, remaining providers as fallbacks. `sort` or `order`
  disables load balancing.
- Model variants as routing shortcuts: `:nitro` (throughput sort + priority
  tier eligibility), `:floor` (price sort + flex tier eligibility). These are
  "not a separate entry in the models API".
- Model fallbacks: `models: [...]` array in Chat Completions; "If the first
  model returns an error, OpenRouter will automatically try the next model",
  triggered by context-length errors, moderation flags, rate-limiting,
  downtime. "Requests are priced using the model that was ultimately used,
  which will be returned in the `model` attribute". On the Anthropic Messages
  endpoint, a `fallbacks` parameter (Anthropic SDK shape, max 3 entries, each
  entry only `model`, not combinable with `models`, else 400) maps onto the
  same routing; "OpenRouter handles this fallback routing itself".
- Anthropic beta pass-through: `x-anthropic-beta` header values
  `interleaved-thinking-2025-05-14`, `structured-outputs-2025-11-13` are
  forwarded to Anthropic.

### 1.5 Structured outputs

Source: <https://openrouter.ai/docs/features/structured-outputs> (fetched, 11 KB).

- `response_format: { type: "json_schema", json_schema: { name, strict,
schema, additionalProperties: false } }`; "Set `strict: true` so that
  providers with a native strict mode enforce your schema exactly… exact
  compliance is not guaranteed on every endpoint".
- Support is per endpoint, not per model; route only to supporting endpoints
  by checking `supported_parameters` and setting `provider.require_parameters:
true`. Streaming with structured outputs is supported (partial JSON).
- Optional "Response Healing" plugin for non-streaming json_schema requests.

### 1.6 Limits

Source: <https://openrouter.ai/docs/api-reference/limits> (fetched, 26 KB).

- Three limit kinds: Credit limits (402), Budget limits (403), Rate limits
  (429). Check via `GET /api/v1/key` → `limit_remaining`, `budgets`,
  `effective_budget`; errors carry `error.metadata.limit_source` (e.g.
  `openrouter_in_flight_budget`, `openrouter_key_limit`, `openrouter_credits`)
  and a `remedy_hint`.
- In-flight spending budget: "A request whose estimated cost does not fit
  alongside your running and recently completed requests is rejected with 402
  before it reaches a provider"; transient case returns `Retry-After`.
- 429 can be platform or upstream: `error.metadata.provider_code` carries the
  provider code; fallback routing retries other providers automatically.
  Rate-limit errors carry `X-RateLimit-Remaining`, `X-RateLimit-Limit`,
  `X-RateLimit-Reset` headers. Mid-stream rate limits become SSE
  `finish_reason: "error"`.
- `GET /api/v1/key` response includes `usage`, `usage_daily`,
  `usage_weekly`, `usage_monthly`, `byok_usage*`, `is_free_tier`,
  `free_model_daily_requests: { used, limit, remaining }`; a deprecated
  `rate_limit` object is "safe to ignore".

### 1.7 Key management

Source: <https://openrouter.ai/docs/guides/overview/auth/management-api-keys.md> (fetched, 21 KB).

- All key management endpoints under `/api/v1/keys`, authenticated with a
  separate Management API key (not a credit key). CRUD: list (paginate via
  `offset`), create `{ name, limit, limit_reset, expires, ... }`, get by key
  hash, update (`name`, `disabled`, `limit`, ...), delete.
- Key object fields (exact from response example): `created_at`, `updated_at`,
  `hash`, `label` (`sk-or-v1-abc...123`), `name`, `disabled`, `limit`,
  `limit_remaining`, `limit_reset`, `include_byok_in_limit`, `usage`,
  `usage_daily`, … Stated use cases: per-customer instance keys, rotation,
  "disable keys that exceed limits (with optional daily/weekly/monthly limit
  resets)". Management keys can themselves be expiring (401 on expiry).

### 1.8 Analytics

Source: <https://openrouter.ai/docs/guides/features/activity> (fetched in full).

- Dashboard "Activity" = rollup of per-generation logs: spend, requests,
  tokens, blended cost per million tokens, cache hit rate; slice by model,
  provider, API key, app, user; tabs Overview/Trends/Explore/Guardrails;
  CSV/PDF export.
- Programmatic API: `GET /api/v1/analytics/meta` (metrics/dimensions/
  granularities), `POST /api/v1/analytics/query` (Explore equivalent),
  `GET /api/v1/activity` (daily usage grouped by endpoint). Management key.

### 1.9 Model discovery

Source: <https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties.md> (fetched, 51 KB).

- `GET /api/v1/models` returns rich model metadata; the reasoning block
  documented in §1.1 (`supported_efforts`, `default_effort`, `default_enabled`,
  `supports_max_tokens`, `mandatory`) is the concrete example fetched; models
  pages expose `supported_parameters` (e.g. `structured_outputs`) and provider
  endpoint lists.

## 2. OpenAI official surface

Source: <https://platform.openai.com/docs/guides/reasoning> (fetched in full, 71 KB),
<https://platform.openai.com/docs/guides/structured-outputs> (fetched, 136 KB).

- Responses API: `POST /v1/responses`; reasoning guide recommends Responses
  over Chat Completions for reasoning models ("you'll get improved model
  intelligence and performance by using Responses").
- `reasoning.effort`: values "model-dependent and can include `none`,
  `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`"; `gpt-5.5` defaults
  to `medium`; some models reject `none` (HTTP 400). Chat Completions
  equivalent param is `reasoning_effort`.
- `reasoning.mode: "standard"|"pro"` on GPT-5.6/GPT-6; "Pro mode aggregates
  the model work performed to produce the final answer and bills those tokens
  at the selected model's standard token rates".
- Reasoning tokens: "While reasoning tokens are not visible via the API, they
  still occupy space in the model's context window and are billed as output
  tokens." Exact usage shape (from the page):
  `usage: { input_tokens, input_tokens_details: { cached_tokens },
output_tokens, output_tokens_details: { reasoning_tokens }, total_tokens }`.
- Cost control via `max_output_tokens`; on exhaustion the response has
  `status: "incomplete"` and `incomplete_details.reason: "max_output_tokens"`
  — a _normal billed outcome_, possibly with zero visible output.
- Reasoning summaries: opt-in `reasoning: { summary: "auto" }` (organization
  verification may be required); output item
  `{ type: "reasoning", id: "rs_…", summary: [{ type: "summary_text", text }] }`.
- Stateless/ZDR mode: reasoning items in `response.output` include
  `encrypted_content` by default; replay full history (with
  `toResponseInputItems`) to continue reasoning; `reasoning.context`
  `current_turn` (default pre-GPT-5.6) vs `all_turns` (GPT-5.6+ default);
  `previous_response_id` for stateful reuse. Reasoning reuse is per model
  family.
- Assistant `phase` field (`"commentary"` / `"final_answer"`) on GPT-5.5/5.4
  message items; missing `phase` in replayed history "can cause preambles to
  be treated as final answers".
- Structured outputs: Responses API uses `text.format` =
  `{ type: "json_schema", name, strict: true, schema }` (verified in fetched
  page: `ResponseFormatTextJsonSchemaConfig.builder().name("event")
.strict(true).schema(...)`); Chat Completions uses `response_format`.
- Tools: function calling configured via the request `tools` array
  (`type: "function"`); the reasoning guide's examples pass
  `"tools": [... function config ...]` alongside reasoning on Responses.
  (Direct evidence: example snippets; full function-calling guide not fetched.)
- Streaming/usage on Responses: usage is reported in the `response.completed`
  stream event (direct claim from OpenRouter's streaming doc §1.2; OpenAI's
  own streaming reference page was not fetched — flagged in Missing evidence).

## 3. Anthropic official surface

Sources: <https://platform.claude.com/docs/en/build-with-claude/thinking> (fetched, 85 KB),
<https://docs.claude.com/en/docs/build-with-claude/extended-thinking> (fetched, 22 KB),
<https://platform.claude.com/docs/en/build-with-claude/streaming> (fetched, 51 KB).

- Thinking modes: `thinking: { type: "adaptive" }` (model decides when/how
  deep), `{ type: "enabled", budget_tokens: N }` (manual extended thinking),
  `{ type: "disabled" }`, `{ type: "between_tools" }` (Sonnet 5.5 only).
  Per-model behavior table is exact in the thinking page; highlights:
  Claude 5.x models have thinking on by default and return 400 for
  `enabled`/`budget_tokens`; Claude 4.5 supports only manual extended
  thinking; extended thinking is deprecated on 4.6 and rejected on 4.7+.
- `budget_tokens` rules (extended-thinking page): minimum 1,024 tokens; "less
  than `max_tokens`" (exception: interleaved thinking); the budget "is a
  target rather than a strict cap"; `max_tokens` remains the hard ceiling.
- Cost: "the tokens Claude spends reasoning are billed as output tokens, even
  when the thinking text isn't returned to you, and they count toward
  `max_tokens`". Tracking field: "monitor the
  `usage.output_tokens_details.thinking_tokens` field in the response… When
  streaming, this breakdown appears only on the final `message_delta` event."
- Display: `display: "summarized"` (thinking blocks carry a _summary_, never
  raw chain of thought; billed tokens > visible summary tokens) vs
  `"omitted"` (empty `thinking` field, `signature` still present; faster
  TTFT) vs `"updates"` (beta, `thinking-display-updates-2026-08-18` header).
  Each thinking block carries a `signature` — an encrypted copy of the full
  reasoning — which must be passed back unchanged in multi-turn/tool use.
- Streaming: thinking blocks stream as `thinking_delta` inside
  `content_block_delta`, followed by a single `signature_delta` before
  `content_block_stop`. Event flow: `message_start` → content blocks →
  `message_delta`(s) → `message_stop`; any number of `ping` events may
  interleave; errors can arrive as stream events (e.g. `overloaded_error`).
  Exact claim: "The token counts shown in the `usage` field of the
  `message_delta` event are _cumulative_." Example shapes show
  `message_start.message.usage = { input_tokens, output_tokens }` and, with
  caching/tools, `{ input_tokens, cache_creation_input_tokens,
cache_read_input_tokens, output_tokens, server_tool_use: {...} }`.
- Tools: native `tools`/`tool_choice` on Messages; tool args stream as
  `input_json_delta`; server tools (e.g. `web_search_20250305`) appear in
  usage as `server_tool_use.web_search_requests`.
- Adaptive thinking + effort: `output_config.effort` controls response-wide
  effort (`low`/`medium`/`high`/`xhigh`/`max` on 5.x models); OpenRouter's
  normalization of these fields is documented in §1.1.

## 4. Current repo state and gaps

Files inspected (all current working tree): `apps/api/src/routes/v1-gateway.ts`,
`apps/api/src/routes/v1-models.ts`, `apps/api/src/auto-resolve.ts`,
`packages/catalog/src/catalog.ts`, `packages/usage/src/usage.ts`,
`packages/keys/src/keys.ts`, `docs/requirements.md`. No separate `chat.ts`
route file exists — chat-protocol handling lives in `v1-gateway.ts`
(`gatewayHandler`, chat branch) and `packages/usage/src/usage.ts`
(`injectChatUsageOption`, `chatUsageOf`); line numbers below are approximate
(±3), verified against the read offsets where noted.

### 4.1 What the gateway already does that matches the official surfaces

- **Usage extraction per protocol** (`packages/usage/src/usage.ts`,
  `chatUsageOf` ~L130, `responsesUsageOf` ~L142): reads
  `prompt_tokens/completion_tokens` + `prompt_tokens_details.cached_tokens` +
  `completion_tokens_details.reasoning_tokens` (Chat) and
  `input_tokens/output_tokens` + `input_tokens_details.cached_tokens` +
  `output_tokens_details.reasoning_tokens` (Responses) — exactly the field
  paths OpenAI/OpenRouter document (§1.3, §2).
- **Streaming usage placement matches all three providers**:
  Chat — `injectChatUsageOption` (usage.ts ~L38) sets
  `stream_options.include_usage` unless present, and the tap requires a clean
  `finish_reason` + `[DONE]`; Responses — usage only accepted from
  `response.completed` (tap `handleEventData`); Messages — `message_start`
  input split + cumulative `message_delta` output, completed on
  `message_stop` (tap `mergeMessagesUsage`, `finish()`). This matches
  OpenRouter's documented per-endpoint placement (§1.2) and Anthropic's
  cumulative-`message_delta` usage (§3).
- **SSE comment tolerance**: the tap and `sseModelRewriteStream`
  (v1-gateway.ts, `rewriteLine`) only rewrite `data: ` lines; `:` comment
  lines pass through — OpenRouter's `: OPENROUTER PROCESSING` keep-alives and
  Anthropic `ping` events are handled correctly.
- **Usage chunk with non-empty choices**: OpenRouter's deviating final usage
  chunk (§1.2) is compatible — the tap reads `choices[].finish_reason` when
  present and does not reject a usage chunk carrying one choice.
- **Reasoning deltas as first token**: `isFirstTokenEvent`
  (v1-gateway.ts ~L236) counts `delta.reasoning_content` / `delta.reasoning`
  and Anthropic `thinking` deltas as first-token — consistent with
  OpenRouter's `reasoning`/`reasoning_details` streaming fields (§1.1) and
  Anthropic `thinking_delta` (§3).
- **Anthropic cache accounting**: `messagesUsageOf` (usage.ts ~L156, verified
  by read) bills `input_tokens + cache_creation_input_tokens` at full input
  and `cache_read_input_tokens` at the cached rate — matches the Anthropic
  usage fields shown in §3 examples.
- **Reserved-cap billing resembles OpenRouter's in-flight budget**: bounded
  cap reservation + 402 `insufficient_balance` (v1-gateway.ts, reserve block
  ~L630) is the same economic mechanism as OpenRouter's in-flight spending
  budget returning 402 with `Retry-After` (§1.6), though the error envelope
  differs.

### 4.2 Concrete gaps (API compatibility)

1. **Anthropic thinking-token split ignored** — `messagesUsageOf`
   (usage.ts ~L156) parses only `input_tokens`, `cache_creation_input_tokens`,
   `cache_read_input_tokens`, `output_tokens`; the accumulator
   (`mergeMessagesUsage`) drops any other fields. Anthropic documents
   `usage.output_tokens_details.thinking_tokens` (§3) — the split needed to
   bill the catalog's `reasoning_usd_micro_per_1m` rate on
   `/v1/messages` is available upstream but discarded, so
   `reasoningTokens` is always `0n` for messages. `resolveBillableUsage`
   (usage.ts, ~L330) then assumes 0 when the reasoning rate ≤ output rate.
   Impact: reasoning-price billing on the Anthropic protocol under-charges
   thinking tokens whenever a distinct reasoning price is configured.
2. **`response.incomplete` treated as a hard failure** — the tap fails on
   `response.incomplete` (`fail("error_event")` in `handleEventData`) and
   non-stream requires `status === "completed"`. OpenAI documents
   `status: "incomplete"` with `max_output_tokens` reason as a normal _billed_
   outcome carrying usage (§2). Impact: a partially-successful Responses
   request is settled `full_hold` (`upstream_error` path in v1-gateway.ts)
   instead of charging the real token usage — consistent with the owner's
   "charge the full hold" rule only by accident of classification, and the
   client-visible status pass-through is unaffected, but logs misclassify it.
3. **1 MiB body cap on `/v1/responses`** — `CHAT_MAX_BODY_BYTES` (16 MiB)
   applies only to chat-purpose keys on `/v1/chat/completions` (v1-gateway.ts
   ~L21, body-limit selection ~L560); Responses bodies with large
   `text.format` JSON schemas or replayed encrypted reasoning history can hit
   the 1 MiB `MAX_BODY_BYTES` gate. OpenRouter/OpenAI place no documented
   request-size cap at this magnitude.
4. **`/v1/models` lacks reasoning/capability metadata** —
   `v1-models.ts` returns only `{id, object, created, owned_by}`; no
   `reasoning` block (`supported_efforts`, `default_effort`, …) or
   `supported_parameters`. OpenRouter's models API exposes both (§1.1, §1.9);
   clients doing OpenRouter-style UIs or `require_parameters`-style
   preflight have nothing to read. Catalog rows do carry `capabilities`
   (string[]) and `context_window` (catalog.ts `ModelRow`) but they are not
   surfaced on `/v1/models`.
5. **No reasoning-parameter surface of our own** — the gateway forwards
   `reasoning`/`reasoning_effort`/`thinking`/`output_config` verbatim
   (`outbound = { ...body, model }`, v1-gateway.ts ~L700, verified by read)
   and never produces `reasoning_details`, never normalizes effort↔budget,
   and has no `reasoning` awareness in cap estimation (reasoning tokens are
   covered only because `holdOutput` defaults to the context window). That is
   correct for a thin gateway whose upstream is CPA, but it means Hoborouter
   cannot offer OpenRouter's normalization guarantee (e.g. same
   `reasoning.max_tokens` working across providers) — that contract is
   silently delegated to CPA and unverified here.
6. **Error envelopes differ from OpenRouter's limits taxonomy** — gateway
   returns `{error:{message,type,code}}` with codes
   `insufficient_balance` (402) / `subscription_rate_limited` /
   `throughput_allowance_limited` (429, with `retry-after`). OpenRouter 402s
   carry `error.metadata.limit_source` + `remedy_hint` + `Retry-After`; 429s
   carry `X-RateLimit-*` headers (§1.6). No `X-RateLimit-Remaining/Limit/
Reset` headers are emitted anywhere in the gateway.

### 4.3 Concrete gaps (product parity — NOT gateway API work per requirements)

Per `docs/requirements.md` ("Never build provider adapters… CPA = data plane:
routing, protocol conversion, retry/failover"), the following OpenRouter
features are deliberately out of Hoborouter's scope or belong to CPA/other
milestones. Listed so the parity picture is complete, not as action items:

- **Provider routing object / model fallbacks** (`provider.order`,
  `allow_fallbacks`, `sort`, `models[]`, `fallbacks`): no equivalent anywhere
  in the gateway; `auto-resolve.ts` implements a one-time cheapest-first pick
  with a 15-minute health window (`HEALTH_WINDOW_MS`, `HEALTH_MIN_SAMPLES=3`,
  `HEALTH_FAILURE_RATE=0.5`) — a different, simpler product. CPA owns
  failover upstream.
- **Per-key credit limits** (`limit`, `limit_remaining`, `limit_reset`,
  daily/weekly/monthly resets): `packages/keys/src/keys.ts` has only
  `purpose`, `status`, model permissions, workspace; `api_keys` carries
  no spend cap. Requirements defer "budget" on the key creation form.
- **Programmatic key management API + management keys**: Hoborouter has admin
  dashboard routes only; no client-facing `/v1/keys` CRUD, no separate
  management-key credential class.
- **Usage `cost` in responses / analytics API** (`cost`,
  `cost_details.upstream_inference_cost`, `/api/v1/activity`,
  `POST /api/v1/analytics/query`): Hoborouter computes VND charges
  server-side (integer VND invariant) and does not expose USD cost to clients
  or via any analytics endpoint; dashboard reads DB directly.
- **Model variants** (`:nitro`, `:floor`, `:thinking`, `:free`): not parsed;
  a slug like `openai/gpt-x:nitro` would simply fail `resolveModel` 404.

## Contradictions

- OpenRouter's Chat Completions usage chunk intentionally deviates from the
  OpenAI spec (non-empty `choices` on the usage chunk — §1.2). Hoborouter's
  tap and scrubber tolerate both shapes; no repo conflict.
- OpenAI says reasoning models' reasoning tokens are "not visible via the
  API" (reasoning guide) while OpenRouter returns `message.reasoning` text for
  the same families — provider-implementation difference, both official.
  Record, not resolved.
- Anthropic `usage.output_tokens_details.thinking_tokens` exists per Anthropic
  docs, yet the repo comment in `messagesUsageOf` states "Anthropic reports no
  reasoning split". The comment is stale relative to the current official
  docs (finding 4.2.1). Recorded as a contradiction; repo comment should be
  corrected when the split is consumed.

## Missing evidence

- OpenAI's own streaming-event reference (exact `response.completed` /
  `response.incomplete` event payloads) was not fetched; the `response.completed`
  usage placement is cited from OpenRouter's streaming doc (cross-vendor but
  directly on-point). OpenAI `function-calling` guide not fetched (tools
  coverage is from example snippets only).
- OpenRouter `GET /api/v1/models` full response schema beyond the reasoning
  block (pricing fields, `supported_parameters` exact shape) not extracted.
- Whether CPA passes through `output_tokens_details.thinking_tokens` on the
  messages route (finding 4.2.1 depends on it) — requires the CPA research
  doc or a live check (out of scope: no provider calls).
- Exact line numbers in `v1-gateway.ts` beyond the read-verified anchors
  (~L560 limit selection, ~L600 limiter, ~L700 outbound) are approximate.

## Sources

Kept:

- OpenRouter Reasoning Tokens — https://openrouter.ai/docs/guides/best-practices/reasoning-tokens.md (full fetch; §1.1)
- OpenRouter Streaming — https://openrouter.ai/docs/api-reference/streaming.md (full fetch; §1.2)
- OpenRouter Usage Accounting — https://openrouter.ai/docs/cookbook/administration/usage-accounting.md (full fetch; §1.3)
- OpenRouter Provider Routing — https://openrouter.ai/docs/guides/routing/provider-selection.md (full fetch; §1.4)
- OpenRouter Model Fallbacks — https://openrouter.ai/docs/guides/routing/model-fallbacks.md (full fetch; §1.4)
- OpenRouter Structured Outputs — https://openrouter.ai/docs/features/structured-outputs (full fetch; §1.5)
- OpenRouter Limits — https://openrouter.ai/docs/api-reference/limits (full fetch; §1.6)
- OpenRouter Management API Keys — https://openrouter.ai/docs/guides/overview/auth/management-api-keys.md (full fetch; §1.7)
- OpenRouter Activity/Analytics — https://openrouter.ai/docs/guides/features/activity.md (full fetch; §1.8)
- OpenRouter Models API — https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties.md (fetch; §1.9)
- OpenAI Reasoning guide — https://platform.openai.com/docs/guides/reasoning (full fetch; §2)
- OpenAI Structured Outputs — https://platform.openai.com/docs/guides/structured-outputs (fetch; §2)
- Anthropic Thinking — https://platform.claude.com/docs/en/build-with-claude/thinking (fetch, 85 KB; §3)
- Anthropic Extended Thinking — https://docs.claude.com/en/docs/build-with-claude/extended-thinking (full fetch; §3)
- Anthropic Streaming — https://platform.claude.com/docs/en/build-with-claude/streaming (fetch; §3)

Rejected/deprioritized:

- https://openrouter.ai/docs/features/reasoning-tokens — 404 (page moved to
  /docs/guides/best-practices/reasoning-tokens).
- https://docs.claude.com/en/docs/build-with-claude/usage — 404; usage covered
  by streaming + thinking pages.
- https://openrouter.ai/docs/api-reference/usage/accounting.md — 404; real
  page is /docs/cookbook/administration/usage-accounting.md.
- OpenRouter llms.txt index — navigation only, not evidence.

## Next steps

1. Read `docs/research/cliproxyapi.md` (and CPA server routes) to confirm
   whether `output_tokens_details.thinking_tokens` and `response.incomplete`
   usage survive CPA — decides gap 4.2.1/4.2.2 fixes.
2. If gap 4.2.1 is real at CPA, extend `messagesUsageOf` +
   `mergeMessagesUsage` to carry `output_tokens_details.thinking_tokens`
   (one field each), with a billing regression test.
