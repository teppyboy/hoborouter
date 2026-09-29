# Research: CLIProxyAPI upstream (official repo, docs, source)

## What investigated

### Official repo identity (verified)

- Official repo: `router-for-me/CLIProxyAPI` (Go, MIT). Docs site: https://help.router-for.me/. Companion: `router-for-me/Cli-Proxy-API-Management-Center` (Web UI only, talks to `/v0/management`). Module path in source is `github.com/router-for-me/CLIProxyAPI/v8` — confirms current major is v8. Forks exist (`kaitranntt/CLIProxyAPIPlus`, `qqlightspeed/CLIProxyAPIPlus`, old `luispater/CLIProxyAPI`); treat those as non-authoritative. DeepWiki mirrors both `luispater` and `router-for-me`; prefer router-for-me. Sources: https://github.com/router-for-me/CLIProxyAPI, https://github.com/router-for-me/Cli-Proxy-API-Management-Center.

### Public OpenAI-compatible endpoints (from `internal/api/server_routes.go`, main branch — direct source evidence)

All under `/v1` with `AuthMiddleware(s.accessManager)` (client API keys from `access.api-keys`):

- `GET /v1/models` — unified handler: Anthropic clients (presence of `Anthropic-Version` header or `User-Agent: claude-cli*`) get Claude-format list; Grok Shell UA gets Grok format; otherwise OpenAI format. In Home mode the list comes from the Home catalog.
- `POST /v1/chat/completions`, `POST /v1/completions`
- `POST /v1/responses` (OpenAI Responses), `GET /v1/responses` (Responses WebSocket), `POST /v1/responses/compact`
- `POST /v1/messages`, `POST /v1/messages/count_tokens` (Claude Messages)
- Images: `POST /v1/images/generations`, `/v1/images/edits`; xAI videos: `/v1/videos...`; Gemini: `/v1beta/models/*action`, `/v1beta/interactions`
- Codex CLI direct aliases: `/backend-api/codex/responses`, `/backend-api/codex/responses/compact`, `/backend-api/codex/alpha/search`
- Codex extras: `POST /v1/alpha/search`, `POST /v1/live`, `GET /v1/live/:call_id`, full `/v1/realtime*` family (WebSocket/SIP)
- Health: `GET /healthz` and `HEAD /healthz` → `{"status":"ok"}`, **no auth**.
- Root `GET /` returns an endpoints index JSON.
  Source: https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/api/server_routes.go (fetched raw, verified above).

### Streaming

- SSE streaming on chat/completions, responses, messages; WebSocket for `/v1/responses` GET, `/v1/ws` (aistudio ws-auth), Codex/xAI upstream websocket transports. Config `requests.streaming.keepalive-seconds` (SSE keep-alives) and `bootstrap-retries` (retry before first byte sent — headers uncommitted). `requests.nonstream-keepalive-interval` emits blank lines for non-streaming responses. Source: `config.example.yaml` (repo), https://help.router-for.me/.
- Notable upstream quirk: Codex `oauth.providers.codex.response-steering` / bootstrap hold-back exists because Codex upstream smuggles `server_is_overloaded` rejections inside HTTP 200 streams; CPA buffers handshake frames so it can transparently failover (documented at length in config.example.yaml comments — direct evidence).

### Management API

- Two versions: legacy `/v0/management` (still supported) and current `/v8/management` (repo doc `docs/management-api-v8.md`). Auth: `Authorization: Bearer <management-key>` or `X-Management-Key`. OAuth callback validation exempt from key.
- v8 operational endpoints (confirmed from docs/management-api-v8.md):
  - Config: `GET/PUT/PATCH /config`, `/config.yaml`, `/config/<section>/<field>` (GET/PUT/PATCH/DELETE); a successful v8 write migrates legacy config; legacy field names rejected by v8 writes.
  - Requests: `POST /requests/api-call` (authenticated upstream call).
  - Routing: `POST /routing/cooldown/reset`, `GET /routing/model-definitions/<channel>`.
  - Observability: `GET/DELETE /observability/logs`, error logs, `GET /observability/logs/requests/<id>` (per-request log), `GET /observability/usage/api-keys`, **`GET /observability/usage/queue` (queued usage events)**.
  - Credentials/provider accounts: `GET/POST/DELETE /credentials`, `/credentials/models`, `/credentials/download`, `/credentials/status` (PATCH), `/credentials/fields` (PATCH), `/credentials/refresh` (POST), quota: `/credentials/quota/providers|fetch|reset`.
  - OAuth account linking: `GET /oauth/auth-url?provider=<p>` (providers: claude, codex, antigravity, kimi, kimi-ai, xai, devin, meta, plugin IDs), `GET /oauth/status?state=`, `DELETE /oauth/session?state=`, `GET/POST /oauth/callback`, `POST /oauth/import?provider=vertex`.
  - Plugins: `/plugins`, `/plugins/<id>`, `/plugins/store`, `/plugins/store/<id>/install`, `/plugins/<id>/quota`.
  - v0 legacy flat endpoints remain: `/debug`, `/request-retry`, `/codex-api-key`, `/api-keys` (client keys; v8 equivalent is `/config/access/api-keys`).
- Models endpoint for management: model definitions via `/routing/model-definitions/<channel>`.
- Source: https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/docs/management-api-v8.md (read in full); https://help.router-for.me/management/api (fetched, 71KB stored).

### Keys / auth / security (confirmed)

- Client auth: `access.api-keys` in config (config.example.yaml). Not provider keys.
- Management key: `management.secret-key`; empty → management routes 404 entirely (config comment + help docs). `management.allow-remote: false` = localhost-only. Plaintext key hashed on startup. Home mode disables local management endpoints.
- Brute-force protection: 5 consecutive management auth failures per client IP → temporary ban (~30 minutes) (help.router-for.me/management/api).
- `server.trusted-proxies` empty by default → forwarded client IP headers not trusted. TLS optional. `commercial-mode` disables request logging middleware.
- `management.disable-control-panel` / panel auto-update from GitHub repo.

### Request IDs / accounting / usage

- Usage `Record` struct (sdk/cliproxy/usage/manager.go) captures per-request: provider, executor type, model, alias, API key, auth ID/index, `AccessTokenSHA256` (token version without exposing token), auth type, source, reasoning effort, tokens. Token breakdown v2 (`EnsureTokenBreakdown`, sdk/cliproxy/usage/accounting.go) classifies reasoning into output vs separate.
- Queue shape (help docs): records with timestamp, latency_ms, source (account email), auth_index, tokens {input, output, reasoning, cached, total}, failed, provider, model, alias, endpoint, auth_type, api_key, `request_id: "req_..."`.
- Built-in aggregated usage statistics removed since v6.10.0; README points to external projects (CPA Usage Keeper, CPA-Manager-Plus). Remaining: `/observability/usage/queue` (v8), `GET /usage-queue?count=N` (v0), `/usage-statistics-enabled` toggle, and a Redis RESP interface on the same TCP port for streaming usage records to collectors (only when management enabled). Sources: README.md; help.router-for.me/management/api.
- **Queue POP semantics (independently confirmed, both v0 and v8):** both endpoints route to the same handler `GetUsageQueue` (`internal/api/handlers/management/usage.go` → `redisqueue.PopOldest(count)`), wired as `mgmt.GET("/usage-queue", ...)` in `internal/api/server_management.go` (v0) and `v8.GET("/observability/usage/queue", ...)` in `internal/api/server_management_v8.go`. Docs state: "Pop up to `count` usage records from the queue" / "Records returned by this endpoint are removed from the queue." RESP path (`LPOP`/`RPOP`) also removes. Sources: https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/api/handlers/management/usage.go, https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/api/server_management.go, https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/api/server_management_v8.go, https://help.router-for.me/management/api, https://help.router-for.me/management/redis-usage-queue.
- **Crash-loss gap (cannot be made atomic from outside):** once a collector pops, the record is gone upstream; a crash before the collector durably persists (e.g. SQLite) loses those events. No pop-then-ack or read-with-visibility-timeout exists in the upstream API, so exactly-once usage ingestion/billing is **not achievable** against this queue alone. Design for **at-least-once-per-pop-attempt with at-most-once delivery** (persist before acknowledging/popping next batch, accept loss on crash between pop and persist) or introduce a durable intermediary; do not promise exactly-once billing.
- Per-request log retrieval: `GET /v8/management/observability/logs/requests/<id>`.

### Retry / routing (confirmed from config.example.yaml)

- `routing.strategy`: round-robin (default), weighted-round-robin, fill-first; per-credential `weight` (max 1e6), `priority` (higher wins), `prefix` (require `prefix/model` calls).
- Session affinity: `routing.session-affinity` (+ TTL 1h, subagent inheritance) — binds session → credential, explicit Claude Code/Codex/OpenCode/pi session headers preferred, then prompt_cache_key, Responses conversation IDs, legacy body IDs, first-message hash fallback. Established binding outranks priority; auto-failover always on when bound auth unavailable.
- Retry: `routing.retry.request-retry` (default 3 additional credential rounds; rounds admit credentials whose effective request-retry ≥ r), `max-retry-credentials`, `max-retry-interval` (cooldown wait cap, default 30s). Additional rounds trigger on HTTP 403, 408, 429, 500, 502, 503, 504.
- Cooldown: `disable-cooling`, `.cds` persistence files, transient-error cooldown for 408/500/502/503/504/520-526 (legacy 60s default).
- `request-scoped-errors` rules: classify by status + body match/regex → action stop | stop-and-cooldown | continue | continue-and-cooldown.
- Failover-within-stream: streaming `bootstrap-retries` and Codex overload hold-back (see Streaming above).

### Config surface relevant to Hoborouter

- Provider API-key groups: gemini, interactions, vertex, codex, claude, xai, meta, openai-compatibility (per-group base-url, headers with `$HEADER` client-copy values, proxy-url, models with alias/excluded-models/thinking/max-context-length, per-key weight/priority/prefix/request-retry/disable-cooling/proxy-url).
- `requests.passthrough-headers` (default false), payload override/default/filter rules (gjson/sjson paths), Claude cloak/fingerprint-profile options, model alias pools (same alias → round-robin pool with same-request failover).
- Default port 8317; mDNS discovery; `cliproxyapi --tui` client mode.

## CLIProxy vs Hoborouter responsibility map (researcher inference — no Hoborouter spec available in this run)

- CLIProxy is: protocol translation (OpenAI↔Claude↔Gemini↔Responses↔Interactions), credential/OAuth account management and refresh, multi-account routing/weighting/session-affinity, retry/cooldown/failover, cloaking/fingerprinting, management plane.
- Likely Hoborouter layer (unverified): tenant-facing gateway in front of one or more CPA instances — client key issuance, per-tenant quotas/accounting aggregation (pull `/usage-queue` or RESP, persist externally since upstream dropped built-in stats), request-id correlation, health/instance supervision, config provisioning via `/v8/management/config` writes.
- Integration blockers / exact behaviors to probe:
  1. ~~pop-vs-peek~~ **RESOLVED: pops (both v0 and v8, same handler).** Open risk: crash between pop and durable persistence loses usage events; no upstream ack mechanism exists, so exactly-once ingestion/billing is impossible without a durable intermediary. Collector must persist immediately on receipt and treat loss windows as accepted.
  2. RESP interface multiplexed on same TCP port 8317 — must speak RESP handshake to distinguish from HTTP; behavior under TLS unclear (docs say shared listener; protocol detection unverified).
  3. `request_id` format/stability: `"req_..."` in usage records; whether a downstream request-id header can be supplied or is echoed on responses is unverified — probe response headers on `/v1/chat/completions`.
  4. Management ban (5 failures → ~30 min) affects automated key rotation tooling — Hoborouter must cache the management key, never retry-loop.
  5. v8 config writes migrate legacy config and reject legacy field names — if Hoborouter generates config, must target v8 field spelling only.
  6. `/healthz` unauthenticated and liveness-only — no readiness/credential-health signal; probe whether `/routing/model-definitions` or quota endpoints serve as readiness.
  7. No aggregated usage endpoints remain (removed v6.10.0) — Hoborouter owns aggregation entirely.
  8. Version drift: v8 fields/config change fast; pin a CPA release and re-diff `config.example.yaml` on upgrade.

## Files changed

- `docs/research/cliproxyapi.md` (this file; only file owned/created).

## Decisions

- Treat `router-for-me/CLIProxyAPI` as authoritative; ignore forks and DeepWiki mirrors except as corroboration.
- Prefer repo source (`internal/api/server_routes.go`, `config.example.yaml`, `docs/management-api-v8.md`) over third-party summaries for all endpoint/config claims.
- Flag pop-vs-peek usage-queue semantics as the top open integration question rather than guessing.

## Tests performed

- None (research-only task; no code). Verified claims by fetching raw source files and official docs; no local build/run.

## Problems, risks, missing evidence

- Miniasp mirror (cliproxyapi.gh.miniasp.com) may lag upstream; used only for RESP/usage-queue corroboration, not primary.
- Request-ID propagation into downstream response headers: not confirmed from source read.
- `/v8/management/observability/usage/queue` and `/requests/api-call` request/response schemas: not read in detail (present in help.router-for.me/management/api fetch but not extracted here).
- Exact streaming SSE event shapes per protocol: not extracted (large surface; probe against a running instance instead).
- Could not read every line of server_routes.go (file truncated at 29966/38202 chars; remainder is Home-model handlers, no additional route registrations observed before truncation).

## Addendum: usage-queue lossiness, correlation IDs, and rejected billing assumptions

Sourced from the follow-up research memo (`41791c82…/research.md`); [H] = hypothesis, unverified.

- **Queue is in-memory, no ACK, no durability.** Plain Go slice (`internal/redisqueue/queue.go`), `PopOldest` advances `head` irrecoverably; retention default **60s**, max **3600s** (`SetRetentionSeconds`). Crash before pop or between pop and collector persist loses events. https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/redisqueue/queue.go — verified from source.
- **SUBSCRIBE suppresses enqueueing.** If any subscriber exists, records are NOT added to the queue; slow subscriber (256-buffer full) is deleted and closed — buffered messages lost. Collectors must pick queue-pop or pub/sub; both are lossy. https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/redisqueue/queue.go — verified from source.
- **X-CPA-TRACE-ID candidate correlation header.** Injected by CPA trace middleware into downstream responses, reserved from upstream spoofing, CORS-exposed with `X-Request-Id`/`OpenAI-Request-Id` (`internal/logging/cpa_trace.go`). [H] Emission on all routes/versions and client-supplied IDs unverified — probe pinned release. https://github.com/router-for-me/CLIProxyAPI/blob/bd34ceca/internal/logging/cpa_trace.go
- **Request ID schema (two distinct IDs).** Usage `Record.RequestID` = UUID v4 per execution; `Record.TraceID` = parent inbound HTTP request ID (8-hex). Queue payload `request_id` = `internallogging.GetRequestID(ctx)` (the trace ID, _not_ the execution UUID). https://github.com/router-for-me/CLIProxyAPI/blob/bd34ceca/sdk/cliproxy/usage/manager.go, https://github.com/router-for-me/CLIProxyAPI/blob/bd34ceca/internal/redisqueue/plugin.go — verified from source.
- **Publication is async fire-and-forget.** `Publish` returns immediately; plugins run serially on a background goroutine; `Manager.Stop()` drains but crash loses everything. [H] Client disconnect mid-stream may leave usage unpublished/partial (usage arrives at/after stream end; see issue #3076) — no test found. https://github.com/router-for-me/CLIProxyAPI/blob/bd34ceca/sdk/cliproxy/usage/manager.go, https://github.com/router-for-me/CLIProxyAPI/issues/3076

### Explicitly rejected (from the research memo's Option A proposal)

1. **"Input token count is exactly known from the raw client request" — REJECTED.** Raw request text does not determine token count: tokenization is provider/model-specific, differs per tokenizer, and tool/system expansions apply upstream. Input token cost is an estimate until a CPA usage event reports it.
2. **"Retrying an in-flight upstream call with the same gateway ID prevents duplicate provider spend" — REJECTED.** Each gateway retry that reaches CPA is a fresh upstream call CPA bills for. A stable gateway request ID dedupes the _gateway ledger row_ only; upstream spend is duplicated by construction. Use upstream quota caps as backstop.
3. **"Charging estimate at response start is actual settlement" — REJECTED.** A response-start charge computed from request size is an _estimate_; actual settlement comes only from CPA usage events (which may never arrive — see queue lossiness above). Billing must present estimates as estimates and reconcile asynchronously.

**Net correction to the main body:** do not promise exactly-once in any form — not from the queue, not from gateway-side idempotency, not from SDK-plugin mode. Every path has a crash/spend window. Treat CPA usage events as best-effort attestations; the gateway owns idempotency, durability, and honest estimate-vs-settled labeling.

## Suggested next steps

1. Probe a running CPA instance: auth on `/v1/chat/completions`, confirm response headers (request id), then poll both `/v0/management/usage-queue?count=1` and `/v8/management/observability/usage/queue` twice to determine pop vs peek.
2. Read https://help.router-for.me/management/api sections on `/requests/api-call` and usage queue record schema in full before writing the Hoborouter collector.
3. Pin CPA release version and snapshot `config.example.yaml` + `docs/management-api-v8.md` into the Hoborouter repo as the compatibility contract.
