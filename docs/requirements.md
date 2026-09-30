# Hoborouter — Requirements (source of truth)

Condensed from the owner's master implementation prompt (2026-09-30). Every
subagent works from this file. Literal values (paths, env vars, formats,
endpoints) are exact. Private university assignment: never publish, never copy
New API (AGPL) source.

## Owner decisions (2026-09-30)

- Deployment: single-owner self-hosted machine. CPA published only on
  `127.0.0.1:8317` + 256-bit keys (commit `c6913d2`). No firewall gate.
- Gateway users: **strangers paying VND**.
- Billing source: token `usage` from CPA's response (non-stream body; final
  SSE usage chunk for streams).
- Failed/ambiguous request after dispatch: **charge the full hold**.
- Streaming: **included at launch**.
- Top-up: **payOS integration now** (behind the PaymentProvider interface;
  Mock stays; must be testable without merchant credentials).

## Roles

Root = orchestrator only. All research, code, tests, review, docs, debugging
go to subagents. Parallelize independent work; one writer per file scope.
Review loop: implementer → reviewer → tester → orchestrator accepts.
Subagent report: investigated/implemented · files changed · decisions · tests ·
risks · next steps.

## Architecture boundary

- Hoborouter = product/control plane + thin gateway: auth, virtual keys,
  workspaces, quota, credit, billing, pricing, access control, logs, payments,
  admin, dashboard.
- CLIProxyAPI (CPA) = data plane: provider auth/OAuth, provider APIs, routing,
  protocol conversion, multi-account, retry/failover.
- Never build provider adapters, protocol converters, or a second router.
- Integration layer `CliproxyClient` with methods **only** for verified CPA
  endpoints (candidates: getHealth, listModels, listApiKeys, syncApiKeys,
  listProviders, listAuthFiles, getUsage, consumeUsage, getConfiguration,
  updateConfiguration). CPA management secret never reaches the browser.

## Stack (frozen)

Bun · Vite+ `vp` (primary task runner: build/test/lint/check) · Elysia 2 ·
React 19 + TypeScript, **static build only** (no SSR/Next/Remix), served by
Elysia · TanStack Router/Query/Table (+Virtual where useful) · Zustand (light) ·
React Hook Form · Zod · shadcn/ui + Tailwind CSS 4 · Geist + Geist Mono ·
Lucide · SQLite WAL via `bun:sqlite` + Drizzle (Postgres-migratable) · Better
Auth · Elysia OpenAPI · Docker Compose (`hoborouter`, `cliproxyapi`; Caddy/nginx
optional).

Forbidden without demonstrated need: Kubernetes, Kafka, RabbitMQ, NATS,
microservices, Redis, PostgreSQL, ClickHouse, Elasticsearch, separate worker
service, distributed locks/tracing, Prometheus/Grafana, SSR.

## API keys

- Format `sk-hbr-<secret>`; CSPRNG, URL-safe, sufficient entropy (example
  secret is 43 chars base64url ≈ 256 bits).
- Plaintext shown once; store hash only; never log full secret.
- Display `sk-hbr-WlfQ...H0bY6I` (first 4 + `...` + last 6 of secret).
- Features: create, show once, revoke, enable/disable, list, last-used, model
  restrictions (`api_key_model_permissions`); creation form later: name,
  budget, models, expiration.

## Workspaces

Personal workspace per user now; schema ready for teams, members, roles,
shared billing, team keys, shared quotas. Entities: users, sessions,
workspaces, workspace_members, api_keys, api_key_model_permissions. Don't
overbuild team UI.

## Model catalog

- Public IDs `openai/gpt-...`, `anthropic/claude-...`, `google/gemini-...`.
- Upstream model ≠ public model; public model must be explicitly
  enabled/published. Entities: models, provider_model_mappings, model_prices.
- Fields: slug, display name, provider, upstream model, description,
  capabilities, context window, enabled, input price, output price, cached
  input price, reasoning price. No pricing hardcoded in source.

## Billing (≠ payments)

- Flow: authenticate key → validate model access → estimate cost → reserve →
  CPA (stream passthrough) → actual usage → compute charge → settle
  (release remainder / charge delta).
- Concurrency-safe reservations; idempotent settlement; request IDs prevent
  double charge; defined failed-request behavior (owner: charge full hold on
  ambiguous); traceable refunds.
- Append-only ledger (`+50000 TOPUP`, `-124 AI_USAGE req_x`,
  `+88 REFUND req_y`); `wallet.balance` only a snapshot. Integers only.
- Entities: wallets, ledger_entries, billing_reservations, usage_logs.

## Currency

- Customer currency VND, displayed `20.000 ₫`.
- Upstream prices usually USD. Usage records store `upstream_cost_usd_micro`,
  `usd_vnd_exchange_rate`, `markup`, `charged_vnd`; never recompute history.
- Env `HOBOROUTER_USD_VND_RATE=26000`; admin setting may override.

## Payments

- Interface `PaymentProvider { createPayment(); getPayment(); verifyWebhook();
cancelPayment?() }`. Billing must not care which provider paid.
- `MockPaymentProvider` exercises the real pipeline: pending → provider reports
  paid → verified event → PaymentService → ledger TOPUP → wallet.
- Dev endpoint `POST /api/dev/payments/:id/complete`, disabled outside
  demo/development.
- Next: `VietQRStaticProvider` (real QR, manual/mock settlement), payOS
  (owner: now), later VNPay/MoMo. Frontend never mutates wallet directly.

## Public AI API

- `/v1/models`, `/v1/chat/completions`, `/v1/responses`; more only if CPA
  verified.
- Streaming stays streaming (no buffering); preserve status codes, chunks,
  content types, request IDs where possible. Thin gateway.

## Usage / logs

Per request, as verified available: request ID, API key, workspace, provider,
public model, upstream model, input/output/cached/reasoning tokens, status,
failure, latency, TTFT, timestamp, upstream cost, customer charge. Ingestion
idempotent (unique upstream request ID or equivalent).

## Frontend

- Design language: Vercel dashboard / Vercel AI Gateway (not a pixel clone;
  not New API visuals). Monochrome, dense, subtle borders, minimal shadows,
  mono for code/IDs, responsive, dark + light, accessible. No glassmorphism,
  gradients, giant cards, heavy rounding, "AI purple".
- IA: Overview · AI Gateway (Models, API Keys, Logs, Usage) · Billing (Credits,
  Payments) · Settings · Admin (Users, Models, Providers, Pricing, Payments,
  System).
- Overview: Requests, Spend, Tokens, Error Rate → usage chart → recent
  requests; latency/TTFT/top models only if data exists. Never fabricate.
- Models: search, provider filter, capabilities, prices, detail page (ID +
  copy, provider, pricing, capabilities, context, cURL + OpenAI SDK examples).
  No fake benchmarks.
- API Keys table: Name, Key, Created, Last used, Status; secret shown once.
- Logs table: Time, Model, Status, Tokens, Cost, Latency; detail: request ID,
  status, model, provider, key prefix, tokens, cost, duration, TTFT. No
  secrets/unnecessary prompt content.

## Security

API key hashing; no plaintext logging; password/session security; CSRF where
relevant; secure cookies; CORS; security headers; request size limits; API
rate limiting; management API isolation; webhook verification + replay
protection; admin authz; audit logs; safe errors; DB transactions around
billing; idempotency. No fake abstractions.

## Background work

In-process only (usage draining, cleanup, reconciliation), idempotent. A
separate worker needs a documented, verified reason.

## Docs & state

README.md, docs/architecture/{architecture,data-model,api-boundaries}.md,
docs/development.md, docs/deployment.md, research docs in docs/research/
(cliproxyapi, new-api, vercel-ai-gateway-ui, viteplus, vietnam-payments).
`docs/STATUS.md`: current milestone, done, active tasks, blockers, open
decisions, next — short, not a log.

## Milestones

0 Research · 1 Architecture (+review) · 2 Workspace foundation (`vp`
build/test/lint/check must work) · 3 Auth + workspace + protected dashboard ·
4 CLIProxy integration (health, model discovery/sync, provider/system info,
no browser secret) · 5 API keys · 6 Public gateway (OpenAI-compatible,
streaming e2e, invalid/disabled keys fail, model restrictions, CPA not public)
· 7 Usage ingestion (idempotent) · 8 Wallet + billing (USD cost, VND charge,
rate snapshot; billing auditor review) · 9 Mock payment · 10 Dashboard (+UI
review vs Vercel notes) · 11 VietQR demo · 12 Hardening (rate limits, safe
errors, audit, payment idempotency, billing concurrency, key security, backup
guidance, Docker health checks, graceful shutdown, error boundaries,
empty/loading/error states).

## Testing

Unit: pricing, VND conversion, key parsing/hashing, reservation, settlement,
refund, ledger invariants, payment transitions. Integration: auth, key
lifecycle, payment→wallet, usage→charge, insufficient balance, concurrent
reservations, duplicate settlement, CPA adapter. Gateway: streaming, auth
rejection, provider error propagation, model restrictions. UI: key flows only.
Billing invariants formally defined and tested (no double credit, no double
charge, idempotent settlement, auditable ledger, reservations never vanish,
refund references original, integer money, no concurrent double-spend).

## Git

No destructive commands, no push, no publishing. Small reviewed local commits.
