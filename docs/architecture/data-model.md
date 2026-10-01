# Hoborouter data model

SQLite WAL via Drizzle; epoch milliseconds; IDs are UUIDs. All money is
integer VND. Migration is forward-only. `packages/db/src/migrate.ts` must preflight before
schema mutation; populated incompatible data requires explicit owner approval.
Never assume no production data; never drop foundation data.

## Identity, workspaces, keys

- Better Auth owns `users`, sessions, accounts, and verification.
- `workspaces(id, name, status, created_at)`; `workspace_members(workspace_id,
user_id, role)` with roles `owner|admin|member`. Personal workspaces now;
  schema supports teams later.
- `api_keys(id, workspace_id, key_hash, key_prefix, name, status, created_at,
last_used_at, revoked_at)`. Secret is `sk-hbr-` plus 32 random bytes in
  base64url. Store only a strong hash; show plaintext once. Display first 4
  secret characters, `...`, last 6. Status supports enabled/disabled/revoked.
- `api_key_model_permissions(api_key_id, model_id, ...)` restricts access.
  Optional budget and expiry are later additions.
- `key_rate_limits` may hold per-key overrides; default limiting is in-process.

## Catalog

- `models(id, public_id UNIQUE, slug, display_name, provider, description,
capabilities JSON, context_window, enabled, published, created_at,
updated_at)`. Public IDs look like `openai/gpt-...`; upstream IDs are not
  public.
- `provider_model_mappings(id, model_id, provider, upstream_model, enabled,
created_at, updated_at)`. A callable model needs an enabled, published model
  and enabled mapping.
- `model_prices(id, model_id, input_usd_micro_per_1m,
output_usd_micro_per_1m, cached_input_usd_micro_per_1m,
reasoning_usd_micro_per_1m, markup_ppm, effective_at, retired_at)`. Prices
  are integer USD micro-units per 1M tokens; versions are immutable after use.

### Current schema → target (TARGET entities)

| Current           | Target                               | Mapping                         |
| ----------------- | ------------------------------------ | ------------------------------- |
| `reservations`    | `billing_reservations`               | request/price snapshots and cap |
| `usage_events`    | `usage_logs`                         | idempotent response usage       |
| `model_bindings`  | `models` + `provider_model_mappings` | public model plus CPA alias     |
| `price_snapshots` | `model_prices`                       | immutable price versions        |
| settlement fields | `settlements`                        | one row per reservation         |

These target names are canonical. Migrate forward with explicit mappings and preserve legacy rows/tables until
verified. Incompatible populated data stops migration pending owner approval. `settlements` target columns are
`reservation_id UNIQUE`, `charged_vnd`, `usage_log_id` (nullable FK for every
full-hold settlement, including CPA errors, client aborts, partial streams,
timeouts, and missing usage), `reason`, and `created_at`. Write `usage_logs` for
observability whenever usage is available.
Do not retain `charged_input`, `charged_output`, or `total`; token amounts live
in `usage_logs` and `charged_vnd` is the formula result or full `cap_vnd`.

## Wallet, reservations, ledger

- `wallets(id, workspace_id UNIQUE, currency='VND', balance, reserved,
version, created_at)`. `available = balance - reserved`; checks enforce
  integer non-negative values and `balance >= reserved`.
- `billing_reservations(id, wallet_id, request_id UNIQUE, api_key_id, model_id,
model_price_id, usd_vnd_exchange_rate, markup_ppm, cap_vnd, status,
created_at, resolved_at)`. Status: `held|settled|settled_full_hold|released`;
  post-dispatch failures never remain held or UNKNOWN.
- `ledger_entries(id, wallet_id, direction, amount, kind, reservation_id,
payment_id, original_ledger_entry_id, balance_after, memo, created_at)`.
  Kinds: `topup|settle|adjustment|refund`; append-only, one settle per
  reservation, one topup per payment, one refund per original debit. Holds and
  hold releases are reserved balance changes, not ledger cash rows.
- `settlements(id, reservation_id UNIQUE, charged_vnd, usage_log_id nullable,
reason, created_at)`; `usage_log_id` is nullable for every full-hold
  settlement, including CPA errors, client aborts, partial streams, timeouts,
  and missing usage. Write `usage_logs` for observability whenever usage is
  available. Settlement and wallet mutation are one transaction. A charge must be `0 <= charged_vnd <= cap_vnd`; full-hold charge
  uses `charged_vnd = cap_vnd` and releases the full hold.
- `refund_operations` references an original ledger entry whose `kind` is
  `settle` and represents `AI_USAGE`; this is enforced in service code and by a
DB CHECK/trigger in the target schema. Refunds append a wallet credit referencing
that original debit, capped at the original debit, one refund per debit, and
validated in one transaction.

Reservation transaction inserts request/reservation, then conditionally adds
`cap_vnd` to `wallets.reserved` only when `balance-reserved >= cap_vnd`.
Settlement or release uses compare-and-set status and wallet checks. Recovery releases `reserved`, full-holds `dispatching`, and no-ops `terminal`. Replays
return the stored result; conflicting keys fail. Late usage after terminal
status is stored for audit and never charged.

## Usage and requests

`requests(id, workspace_id, api_key_id, endpoint, mode, model_id,
provider_model_mapping_id, status, dispatch_state, dispatched_at, http_status,
cpa_trace_id, created_at, latency_ms, ttft_ms)` is the gateway request identity.
`dispatch_state` is `reserved|dispatching|terminal`; `dispatched_at` is nullable.
It is distinct from the financial reservation status. One transaction marks a
request `dispatching` before network I/O, then marks it `terminal` with
settlement or release. Recovery releases `reserved`, full-holds `dispatching`,
and no-ops `terminal`; transport failure after `dispatching` is not a
pre-dispatch release. Endpoint is only
`/v1/chat/completions` or `/v1/responses`; mode is `stream|non-stream`.

`usage_logs(id, idempotency_key UNIQUE, request_id UNIQUE, api_key_id,
workspace_id, provider, public_model, upstream_model, input_tokens,
output_tokens, cached_input_tokens, reasoning_tokens, status, failure,
latency_ms, ttft_ms, upstream_cost_usd_micro, usd_vnd_exchange_rate, markup_ppm,
charged_vnd, raw_payload, created_at)` stores the response usage snapshot.
A request ID/idempotency key prevents duplicate ingestion and settlement.

### Money calculation

For each token category `k`, let `t_k` be tokens and `p_k` the snapshot price
(USD micro per 1M). Let `r` be snapshot VND per USD and `m` markup in ppm,
where `1_000_000` means no markup:

```text
upstream_cost_usd_micro = ceil(((input_tokens-cached_input_tokens)*p_input
  + cached_input_tokens*p_cached + (output_tokens-reasoning_tokens)*p_output
  + reasoning_tokens*p_reasoning) / 1_000_000)
charged_vnd = ceil(upstream_cost_usd_micro * r * m / 1_000_000_000_000)
```

Checked integer arithmetic rejects overflow and negative values. Ceiling rounds UP in the customer charge: no fractional micro-unit/token
calculation silently undercharges. Store all operands and results; never recalculate history.
`HBR_USD_VND_RATE` defaults to `26000`; an authenticated admin override
changes the rate used by future snapshots.

## Payments

`payments(id, workspace_id, amount_vnd, provider, provider_order_code, status,
created_at, expires_at)`; `payment_events(id, payment_id, provider,
provider_reference UNIQUE per provider, raw_payload, signature_valid,
processed_at)`. `PaymentService` depends on
`PaymentProvider { createPayment, getPayment, verifyWebhook, cancelPayment? }`.
`MockPaymentProvider` exercises pending→paid→verified event→top-up ledger.
`POST /api/v1/dev/payments/:id/complete` is development/demo-only. payOS uses
signature fixtures and webhook replay/idempotency; tests require no merchant
credentials.

## Audit and invariants

`audit_log` records admin changes, key actions, model/pricing changes,
settlements, refunds, and payment decisions. Transactions enforce: no negative
wallets; no concurrent double-spend; one settlement per reservation; one credit
per payment; integer-only money; immutable price/FX/markup snapshots; every
refund references an original `settle`/`AI_USAGE` debit; no plaintext secrets.

## Open questions

- Exact live CPA usage payload paths and stable event identity.
- Whether usage can always identify upstream model after live capture.
