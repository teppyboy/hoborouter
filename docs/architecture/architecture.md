# Hoborouter architecture

Status: current design, aligned with `docs/requirements.md` (2026-09-30).

## Product boundary

Hoborouter is the product/control plane and thin gateway: users, workspaces,
API keys, model catalog, authorization, wallets, VND billing, payments, logs,
and dashboard. CLIProxyAPI (CPA) is the data plane: provider credentials,
OAuth, protocol conversion, routing, retry/failover, and provider calls. Do
not build provider adapters or a second router.

Stack: Bun runtime, Elysia 2, React 19 static SPA, Vite+ (`vp`) build/test/
lint/check, Drizzle + PostgreSQL (`drizzle-orm/bun-sql`, selected by
`DATABASE_URL`; non-postgres URLs are refused), Better Auth, Docker Compose. Frontend
uses TanStack Router/Query/Table, Zustand, React Hook Form, Zod, shadcn/ui,
Tailwind 4, Geist, Lucide. No SSR or separate worker service; background work
runs in-process and is idempotent.

## Runtime topology

```text
clients/browser -> hoborouter (Elysia + static SPA) -> cliproxyapi:8317
                                            PostgreSQL (compose service `db`)
```

Compose services are exactly `db` (Postgres), `hoborouter`, and `cpa`. CPA is reachable
by Hoborouter on the private Compose network. Publish CPA only as
`127.0.0.1:8317:8317` for the single owner's debugging; it is not a tenant
API. CPA management key stays server-side.

## Catalog and publication

`models` stores public IDs such as `openai/gpt-...`, display metadata,
provider, capabilities, context window, enabled state. A
`provider_model_mappings` row maps a public model to one provider and upstream
model; the upstream name is never a public contract. `model_prices` stores
immutable/versioned integer USD micro-units per 1M tokens for `input`, `output`,
`cached_input`, and `reasoning`.

A model is visible and callable only when the model and mapping are enabled and
published. Publish/enable changes affect new requests; reservations retain the
selected price version. No prices are hardcoded. Replace current
`model_bindings` and `price_snapshots` through a forward migration/import that maps
public model and CPA alias into the new entities. The migration runner
`packages/db/src/migrate.ts` must preflight non-test data before schema mutation;
if populated data is incompatible, stop and obtain explicit owner approval.
Never assume no production data; never drop foundation rows or tables.

## Request and money flow

For `/v1/chat/completions` and `/v1/responses`, both stream and non-stream:

1. Authenticate `Authorization: Bearer sk-hbr-...`; verify enabled key,
   workspace, and model permission.
2. Validate input and estimate a cap from input size plus `max_tokens` (or the
   model default when absent), bounded by model context and gateway maximum.
3. Snapshot model price, FX rate, markup; atomically reserve the VND cap before
   dispatch. Insufficient available balance returns 402.
4. Forward to CPA with its private access key. Stream responses unbuffered;
   tap bytes for TTFT and usage. Set `stream_options.include_usage=true` when
   absent on streaming requests.
5. Extract usage, calculate actual charge, SETTLE debit idempotently once per
   reservation, release remainder. Missing usage is ambiguous: SETTLE debit the
   full cap. Client abort after dispatch is ambiguous: SETTLE debit the full
   hold.

Pre-dispatch validation, authorization, insufficient balance, or transport
failure releases the hold and writes no ledger row. After dispatch, any failed
or ambiguous outcome (CPA non-2xx, client abort, partial stream, missing usage,
or timeout) is settled identically: one settlement row, a ledger debit equal to
`cap_vnd`, and a terminal reservation status such as `settled_full_hold` with a
reason code; atomically apply `wallets.reserved -= cap_vnd` and
`wallets.balance -= cap_vnd`. Durable request dispatch states are `reserved`,
`dispatching`, and `terminal`; `dispatched_at` is nullable. Financial reservation
status is distinct from dispatch state. One transaction marks the request
`dispatching` before network I/O, then marks it `terminal` with settlement or
release. Recovery releases `reserved`, full-holds `dispatching`, and no-ops
`terminal`; transport failure after `dispatching` is not pre-dispatch release.
Settlement is idempotent, exactly once per reservation. The gateway adds
`X-HBR-Request-Id`; no billing header promises a final state after streaming.

### Charge formula

Let `p_i` be the integer USD micro per 1M price snapshot, `t_i` the token
count, `r` the integer VND/USD FX snapshot, and `m` markup in parts per
million (`1_000_000` means no markup). Define:

```text
upstream_cost_usd_micro = ceil(((input_tokens-cached_input_tokens)*p_input
  + cached_input_tokens*p_cached + (output_tokens-reasoning_tokens)*p_output
  + reasoning_tokens*p_reasoning) / 1_000_000)
charged_vnd = ceil(upstream_cost_usd_micro * r * m / 1e12); USD prices are per 1e6 units, then converted to VND by 1e12.
```

All arithmetic is checked integer arithmetic. Ceiling rounds UP in the customer charge, preventing fractional-token/unit
truncation from undercharging; snapshots are stored on the usage/reservation
and never recomputed from current prices. `HBR_USD_VND_RATE=26000` supplies the
rate; an authenticated admin override supplies a later snapshot value.

Wallets hold integer VND. A reservation increases `reserved`; settlement
charges `balance` by the actual amount and releases the full hold. Ledger rows
are append-only. Settlement, release, and wallet mutation are one transaction;
settlement is idempotent and one per reservation. Refunds append a wallet credit
referencing the original debit, capped at that debit, one refund per debit.

## Usage capture and uncertainty

`usage_logs` records request ID, API key, workspace, provider, public model,
upstream model, input/output/cached/reasoning tokens, status, failure,
latency_ms, ttft_ms, upstream_cost_usd_micro, usd_vnd_exchange_rate, markup,
and charged_vnd. It has a unique idempotency key. The extractor is one small
module, isolated from proxying and settlement.

CPA v8.0.4 live capture with `z-ai/glm-5.3-flash` verified Chat JSON/SSE
`$.usage.prompt_tokens`/`completion_tokens`; Responses JSON
`$.usage.input_tokens`/`output_tokens` plus cached/reasoning detail fields; and
Responses SSE `response.completed` `$.response.usage`. Inject
`stream_options.include_usage` for Chat streams. Chat cached/reasoning fields
were absent, not proof of zero cost; unsupported pricing fails closed until
verified for the selected model/provider. The response model matched the
requested alias only, not proof of translation. No inbound request-ID echo was
observed; persist local request ID plus CPA trace. The usage queue was empty,
with no schema/correlation verified, so it never replaces in-band response
usage or drives settlement. Missing, invalid, partial, or ambiguous usage
remains full-hold.

## Payments and security

`PaymentService` depends on `PaymentProvider`; the interface is
`createPayment`, `getPayment`, `verifyWebhook`, and optional `cancelPayment`.
New top-ups are provider `manual`: any workspace member creates a pending
payment, and only an instance admin credits the wallet
(`POST /api/v1/admin/payments/:id/complete`) after out-of-band confirmation —
there is no dev self-completion endpoint. payOS is optional when its three
credentials are set. Payment state transitions and webhook replay/idempotency
credit the wallet only once. payOS uses signature fixtures, so tests
need no merchant credentials. Legacy `mock` payment rows remain readable and
admin-completable; the legacy signed mock webhook route is gated by
`HBR_MOCK_PAYMENTS` and enabled only when its webhook key is set.

API secrets are 32 random bytes encoded base64url; plaintext is shown once and
only its hash is stored. Display first 4 and last 6 secret characters around
`...`. `api_key_model_permissions` restricts models; keys support enable/
disable and `last_used`. Budget/expiry remain optional later.

At the Elysia boundary enforce in-process rate limits, CORS, security headers,
request-size limits, safe errors, request IDs, and CSRF protection/posture for
cookie-authenticated routes. Never expose CPA management credentials.

## Frontend IA

Static React SPA: Overview; AI Gateway (Models, API Keys, Logs, Usage); Billing
(Credits, Payments); Settings; Admin (Users, Models, Providers, Pricing,
Payments). Vercel-dashboard-inspired dense monochrome UI, light/dark,
responsive and accessible; no fabricated metrics, secrets, prompts, or
benchmarks.

## Milestones 3–12

Each item states current foundation versus remaining work and an acceptance
check.

| Milestone              | Exists                                                                                            | Remaining and acceptance test                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3 Auth/workspace       | Basic workspace/key schema; Better Auth integration is partial                                    | Sessions, protected SPA, roles. Test cross-workspace denial and login.                                                                                              |
| 4 CPA integration      | Compose/CPA client research exists                                                                | `CliproxyClient`: `healthz`, `/v1/models` with access key, `/v8/management/...` config/credentials/api-keys/usage queue. Test management key never reaches browser. |
| 5 API keys             | Hashing and lifecycle partial                                                                     | 32-byte format, display, permissions, status, last-used. Test show-once and revoked/disabled rejection.                                                             |
| 6 Public gateway       | No gateway routes                                                                                 | Both endpoints, stream/non-stream, auth/model checks, reserve/forward/settle. Test streaming passthrough and CPA private reachability.                              |
| 7 Usage                | Partial legacy usage tables                                                                       | `usage_logs`, extractor, idempotency, captured paths; provider-event identity remains open. Test duplicate usage does not duplicate settlement.                     |
| 8 Wallet/billing       | Wallet/reservation primitives exist                                                               | Catalog migration, formula, FX/markup snapshots, settlement/refund invariants. Test concurrent reservation, integer formula, no double charge.                      |
| 9 Mock payment + payOS | Provider interface, manual admin-completed top-ups; payOS implemented behind optional credentials | Acceptance: pending→paid, replay, one ledger top-up, invalid signature; no merchant secret in tests.                                                                |
| 10 Dashboard           | Vite starter only                                                                                 | Required IA and data-backed states. Test key, log, billing happy paths plus loading/error/empty states.                                                             |
| 11 VietQR static demo  | Not implemented                                                                                   | Implement static VietQR demo. Test QR generation and manual/mock settlement.                                                                                        |
| 12 Hardening           | Basic request IDs/errors partial                                                                  | Rate limits, headers/CORS/CSRF, audit, graceful shutdown, health checks, backups, concurrency and payment hardening. Test security controls and Docker health.      |

## Open questions

- Stable provider-event identity and queue schema/correlation remain
  unverified; queue cannot drive settlement.
- Whether CPA v8.0.4 emits upstream model names beyond the requested alias.
