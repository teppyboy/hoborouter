# Hoborouter API boundaries

Elysia 2 serves the static React SPA and JSON APIs. `/v1/*` uses Bearer
`sk-hbr-` keys. `/api/v1/*` uses Better Auth secure-cookie sessions. CPA is never
public through the gateway management surface.

## API versioning

- Control plane: versioned under `/api/v1/...`.
- OpenAI-compatible gateway: `/v1/...` (unversioned path prefix, OpenAI convention).
- Authentication: `/api/auth/*` (Better Auth, library-owned — not versioned).
- OpenAPI spec: `/openapi.json`; interactive docs at `/docs`.

## Public AI API

- `GET /v1/models`: enabled and published public catalog IDs only.
- `POST /v1/chat/completions`
- `POST /v1/responses`

Both POST routes accept stream and non-stream. Validate schema, key status,
workspace, model publication and `api_key_model_permissions`; estimate cap
from input size plus `max_tokens` or model default, bounded by context and a
gateway maximum; snapshot price/FX/markup; reserve; dispatch; then settle.
`Authorization` and client trace/request IDs are never forwarded as management
credentials. Responses pass through CPA status/content type; streams are
unbuffered with a usage tap. If streaming lacks `stream_options.include_usage`,
the gateway adds it.

Pre-dispatch validation, authorization, insufficient balance, or transport
failure releases the hold and writes no ledger row. After dispatch, any failed
or ambiguous outcome (CPA non-2xx, client abort, partial stream, missing usage,
or timeout) is settled identically: one settlement row, a ledger debit equal to
`cap_vnd`, and a terminal reservation status such as `settled_full_hold` with a
reason code; atomically apply `wallets.reserved -= cap_vnd` and
`wallets.balance -= cap_vnd`. Durable states are `reserved`, `dispatching`, and
`terminal`; commit `dispatching` before the one outbound attempt. Recovery
releases `reserved`, full-holds uncertain `dispatching`, and no-ops `terminal`.
Never leave it held or UNKNOWN indefinitely. Settlement is idempotent, exactly
once per reservation. The gateway adds
`X-HBR-Request-Id`; no billing header promises a final state after streaming.

### Usage extraction

Keep extraction in one small module. CPA v8.0.4 live capture with
`z-ai/glm-5.3-flash` verified Chat JSON/SSE `$.usage.prompt_tokens` and
`completion_tokens`; Responses JSON `$.usage.input_tokens`/`output_tokens`
plus cached/reasoning detail fields; Responses SSE `response.completed` at
`$.response.usage`. Inject `stream_options.include_usage` for Chat streams.
Cached input is a subset of input, reasoning is a subset of output; normalize
before charging and reject invalid or missing differing-rate details rather than
counting them as zero. Cached/reasoning fields were absent in Chat, not proof of
zero cost; unsupported pricing fails closed until fields are verified for the
selected model/provider.
Model echo matched the requested alias only; do not infer translation. No
inbound request-ID echo was observed: persist local request ID plus CPA trace.
Usage queue was empty; no schema/correlation is verified, so it is not a
settlement source. Missing, partial, invalid, or ambiguous usage follows the
full-hold policy. Persist usage and billing snapshots before settlement.

## Console and payment API

Session-protected routes include:

- `POST /api/auth/*` (Better Auth), workspace/member routes.
- `GET/POST /api/v1/keys`, `PATCH /api/v1/keys/:id` enable/disable, revoke; plaintext
  shown once. Model permissions are managed with the key.
- `GET /api/v1/wallet`, `GET /api/v1/ledger`, `GET /api/v1/requests`,
  `GET /api/v1/requests/:id`, `GET /api/v1/usage/summary`.
- `POST /api/v1/payments`, `GET /api/v1/payments/:id`; PaymentService owns provider
  selection and wallet credit.
- Instance-admin catalog routes `/api/v1/admin/models`, pricing, providers,
  users, payments, audit, and unknown/review operations.

Payment boundary:

```text
PaymentService -> PaymentProvider
                  ├─ MockPaymentProvider
                  └─ payOS
```

Provider interface: `createPayment`, `getPayment`, `verifyWebhook`, optional
`cancelPayment`. `POST /api/v1/dev/payments/:id/complete` is dev/demo-only and
replaces the old mock webhook completion route. Real webhooks verify provider
signatures, validate order/amount, insert a replay-keyed event, then invoke
PaymentService; duplicate webhooks produce one top-up. payOS tests use
signature fixtures, not merchant credentials.

## Internal CPA boundary

`CliproxyClient` exposes only verified v8.0.4 contracts:

- `GET /healthz` (liveness, unauthenticated)
- `GET /v1/models` with CPA access key
- `GET/PUT/PATCH /v8/management/config` and verified section paths
- `GET/POST/DELETE /v8/management/credentials` and verified credential paths
- `GET/PUT/PATCH /v8/management/config/access/api-keys`
- `GET /v8/management/observability/usage/queue`

Management requests use `Authorization: Bearer <management-key>` or
`X-Management-Key`; key is server-side only. Generic provider listing is not
assumed: only verified quota-provider paths may be added. Proxy traffic uses
CPA's internal access key over the Compose network. CPA is published only at
`127.0.0.1:8317` for owner debugging.

## App-boundary controls

Apply in-process rate limiting; CORS allowlist; security headers; request-size
limits; structured safe errors with request IDs; secure cookies and CSRF
protection for cookie-authenticated state-changing routes. API-key routes use
Bearer auth, not cookies. Enforce admin/workspace authorization and audit
mutations. Never log full keys, management secrets, prompts, or payment
secrets.

## Compose contract

Services: `hoborouter` and `cliproxyapi`, shared private network. Hoborouter
calls `http://cliproxyapi:8317`; only the CPA host debugging binding is
`127.0.0.1:8317`. No public CPA management endpoint.

## Open questions

- Stable provider-event identity and queue schema/correlation remain
  unverified; queue cannot drive settlement.
- CPA response upstream-model translation remains unverified; requested model
  echo is not evidence of translation.
