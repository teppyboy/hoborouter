# Hoborouter Data Model (PROPOSED — pending human review)

Bun + Drizzle ORM + `bun:sqlite`, WAL mode. Frontend built by **Vite+ with Node** (Vite+ requires Node engines; Node is the build-time builder image); runtime is **Bun**. All money = **VND integers** (no floats, no subunits). All times = epoch ms integers. All IDs = UUID v4 unless noted.

## 1. Entity overview

```
users ─< workspace_members >─ workspaces
workspaces ─< api_keys
workspaces ─1 wallets ─< ledger_entries
workspaces ─< payments ─< payment_events
workspaces ─< model_bindings ─> price_snapshots (immutable, versioned)
requests ─< reservations >─ wallets
usage_events (CPA attestations)
settlements (reservation + usage → settled ledger entry)
unknown_resolutions (UNKNOWN manual-review resolution, idempotent)
refund_operations (post-settlement cash refund, idempotent)
audit_log
```

## 2. Tables

### users / auth

- **users** — Better Auth managed (id, email, password/OAuth fields per Better Auth schema). No custom money fields here; money lives on wallets. Better Auth's Drizzle/SQLite adapter schema and migration output must be verified against `bun:sqlite` in a Phase 1 test before relying on generated tables.

**Roles:** workspace roles are `owner|admin|member` (route matrix in api-boundaries.md §2). An **instance-wide admin** (deployment operator) is a separate role from any workspace admin and must not be inferred from workspace membership.

- **workspace_members** (workspace_id, user_id, role: owner|admin|member; PK(workspace_id,user_id)).

### workspaces & keys

- **workspaces** (id, name, status: active|suspended, created_at).
- **api_keys** (id, workspace_id, key_hash SHA-256, key_prefix `sk-hbr-…last4`, name, status: active|revoked, created_at, last_used_at, revoked_at). Plaintext `sk-hbr-` value shown **once** at creation; only hash stored. Unique(key_hash).
- **key_rate_limits** (api_key_id, window, max_requests) — optional per-key limits; default workspace-level.

### wallet & ledger

- **wallets** (id, workspace_id UNIQUE, currency `VND` fixed, balance bigint VND, reserved bigint VND, version bigint). `balance` is the **actual posted balance** (topups credited, settlement charges debited). `available` is **derived**, never stored: `available = balance − reserved`. Check constraints: `balance >= 0 AND reserved >= 0 AND balance >= reserved`.
- **Reservation (canonical, atomic):** one transaction inserts the request row + reservation row and runs
  `UPDATE wallets SET reserved = reserved + :cap, version = version + 1 WHERE id = :wallet_id AND balance - reserved >= :cap`;
  require affected row count `= 1` (0 → reject 402). Commit before dispatch.
- **Settlement (canonical):** decreases `balance` by the actual charge, decreases `reserved` by the **full cap** (available rises by `cap − charge`), with checked integer arithmetic rejecting `charge < 0` or `charge > cap_amount`, and a wallet precondition `reserved >= cap_amount`. In the **same transaction** it performs the terminal CAS `UPDATE reservations SET status = 'settled', resolved_at = :now WHERE id = :reservation_id AND status IN ('held','unknown')` with affected rows `= 1` required (0 → reservation already terminal: persist the usage event only, no wallet/ledger mutation). CAS, wallet update, settlement row, and ledger debit commit together or not at all.
- **ledger_entries** (id, wallet_id, direction: debit|credit, amount bigint >0, kind: topup|settle|adjustment|refund, reservation_id NULL FK, **original_ledger_entry_id NULL FK → ledger_entries(id)** — NOT NULL for kind `refund`, optional for `adjustment`, never set for `topup`/`settle`; original row's kind and direction are validated in the same transaction as the compensating insert, payment_id NULL FK, balance_after bigint, memo, created_at). **Append-only SINGLE-wallet transaction/event ledger — not double-entry** (no account/journal pairs; holds are wallet `reserved`, NOT cash ledger entries — no `reserve_hold`/`reserve_release` cash rows exist). **One settle debit row per reservation: UNIQUE(reservation_id) on kind `settle`.** Releasing an unused or UNKNOWN hold writes **no** cash ledger row — hold release returns `reserved` to available, it is **not** a refund. A `refund` row exists only when an already-posted charge is later compensated: credit row with `original_ledger_entry_id` pointing at the original settle debit. Topup credit: partial unique index on `(payment_id) WHERE kind = 'topup'` — one credit per payment. One refund per original debit: partial unique index on `(original_ledger_entry_id) WHERE kind = 'refund'` — replaying a compensation is rejected 409.
- **reservations** (id, wallet_id, gateway_request_id UNIQUE **FK → requests(id)**, api_key_id, **price_snapshot_id NOT NULL FK → price_snapshots(id)**, status: held|settled|released|unknown, cap_amount bigint, estimated_input_tokens int, created_at, resolved_at, expires_at). Holds funds; never a charge.

### payments

- **payments** (id, workspace_id, amount bigint VND, status: pending|succeeded|failed|expired, provider: mock|vietqr_manual|payos, provider_order_code, created_at, expires_at). Unique(provider, provider_order_code).
- **payment_events** (id, payment_id, **provider TEXT NOT NULL**, provider_reference, raw_payload TEXT, signature_valid bool, processed_at, UNIQUE(provider, provider_reference)). Webhook handlers insert-then-process idempotently; at-least-once safe.

### model catalog & pricing snapshots

- **model_bindings** (id, workspace_id NULL=global, public_model TEXT, cpa_alias TEXT, status: published|disabled, price_input_per_1m bigint VND, price_output_per_1m bigint VND, effective_at). Published mapping is what clients see; CPA aliases are never exposed.
- **price_snapshots** (id, binding_id, price_input, price_output, created_at) — immutable; referenced by reservations so settlement uses request-time prices, never live prices.

### requests & usage

- **requests** (id = gateway_request_id, workspace_id, api_key_id, model_binding_id, endpoint `/v1/chat/completions`|`/v1/responses`, mode: stream|non-stream, cpa_trace_id TEXT NULL, status: pending|ok|client_abort|upstream_error|unknown, http_status, ttft_ms, duration_ms, created_at). Index(cpa_trace_id). **`pending` is the pre-dispatch state:** a request row is created with `status = 'pending'` in the reservation transaction, **before** any dispatch to CPA. On actual dispatch (pre-dispatch commit succeeded) it transitions to exactly one of `ok|client_abort|upstream_error|unknown`. A foundation/failed reservation that never dispatches remains `pending` or is cleaned/released without a paid dispatch — no such row is ever treated as billed or settled.
- **usage_events** (id, source_request_id TEXT — CPA queue payload `request_id` = **trace ID**, cpa_execution_uuid TEXT NULL — `Record.RequestID` when exposed, gateway_request_id NULL, tokens_input, tokens_output, tokens_reasoning, tokens_cached, tokens_total, failed bool, latency_ms, raw_payload TEXT, ingested_at). **Event persistence is distinct from settlement: every polled event is persisted raw first, including ambiguous ones (for audit and later manual review).** Per-event settlement assignment is enforced by the join table below. **The queue payload carries NO execution UUID**; `cpa_execution_uuid` may be NULL, and in SQLite `UNIQUE` columns permit multiple NULLs — so no nullable column here can enforce provider-event uniqueness. **Automatic ingestion idempotency is claimed only if the Phase 0 probe proves a stable, non-nullable provider event identity on the pinned release**, in which case `usage_events.provider_event_key TEXT NOT NULL UNIQUE` is added and inserts are insert-or-ignore idempotent. Without that proven identity, duplicate deliveries produce duplicate ambiguous rows: they are retained, marked ambiguous, and **never auto-settled, never summed, never debited** — no automatic per-execution dedupe is claimed until that proof (or a human-signed-off alternative durable identity).
- **settlement_usage_events** (settlement_id FK, usage_event_id FK UNIQUE, PK(settlement_id, usage_event_id)). Assignment of events to a settlement and the settlement write happen in **one transaction**; `UNIQUE(usage_event_id)` makes one event unassignable to two settlements.
- **settlements** (id, reservation_id UNIQUE, charged_input, charged_output, charged_total bigint VND, settled_at). Created only when usage is verified and correlated. In-transaction checks: `charged_total >= 0` and `charged_total <= reservation.cap_amount`, computed with checked integer arithmetic (overflow-rejecting); violations abort the transaction. Remainder (`cap − charged_total`) returns to available by releasing reserved — **not** a refund ledger credit.

### unknown_resolutions

- **unknown_resolutions** (id, **resolution_key TEXT NOT NULL UNIQUE** — client-supplied UUID, request_id NOT NULL FK → requests(id), reservation_id NOT NULL FK → reservations(id), payload_hash TEXT NOT NULL — hash of the resolve request payload, outcome: **hold_release|manual_settle** (only these two — cash refunds live in `refund_operations`, below), result TEXT NOT NULL — serialized resolution result returned to the caller, actor_user_id NULL FK → users(id), created_at). **One final resolution per request:** `UNIQUE(request_id)` — exactly one `unknown_resolutions` row per request, including `hold_release`. A second distinct-key resolution of any outcome after the terminal transition is rejected **409**; repeats of the same key are handled by replay (below), never re-executed — no repeated hold release, no double settlement.
- **refund_operations** — separate post-settlement cash refund record, deliberately NOT an `unknown_resolutions` outcome (a request may be refunded after its `manual_settle` resolution, which `UNIQUE(request_id)` would otherwise block): (id, **operation_key TEXT NOT NULL UNIQUE** — client-supplied UUID for idempotent replay, original_ledger_entry_id NOT NULL UNIQUE FK → ledger_entries(id) (kind `settle`, direction `debit`) — the unique constraint bounds it to one refund per original debit, request_id NOT NULL FK → requests(id), reservation_id NOT NULL FK → reservations(id), payload_hash TEXT NOT NULL, amount bigint > 0, result TEXT NOT NULL — serialized refund result, actor_user_id NULL FK → users(id), created_at). **Refund is allowed only after the reservation is `settled`** and only for the settle debit that belongs to that reservation **and** that wallet. One transaction under `BEGIN IMMEDIATE`: select by `operation_key` (found + same `payload_hash` → replay stored result; different hash → **409**), validate ownership (original settle debit's `reservation_id` **and** `wallet_id` match the target reservation/wallet), then, all in the same transaction: validate the refund `amount` with checked integer arithmetic — `0 < amount <= original_debit.amount` (violations abort) — atomically (a) credit the wallet: `UPDATE wallets SET balance = balance + :amount, version = version + 1 WHERE id = :wallet_id` (affected rows `= 1`; version overflow-checked like other wallet mutations; `reserved` is **unchanged** — the hold was already released at settlement), (b) insert the refund ledger row (kind `refund`, `original_ledger_entry_id` set, `balance_after` = the post-credit balance consistent with the wallet update), and (c) insert the refund_operations row — wallet, ledger, and record commit together or not at all. `UNIQUE(original_ledger_entry_id) WHERE kind = 'refund'` guarantees at most one refund per original debit, so the cap `amount <= original_debit.amount` cannot be exceeded across replays. Conflicting retry (different key, same debit, or mismatched payload/ownership) → **409**.

**Terminal state machine (atomic compare-and-set):** `hold_release` and `manual_settle` each perform exactly one terminal transition of `reservations.status` (`held|unknown` → `released` / `settled` respectively) inside the same resolution transaction: `UPDATE reservations SET status = :terminal, resolved_at = :now WHERE id = :reservation_id AND status IN ('held','unknown')`; affected rows `= 1` required (0 → **409**, reservation already terminal). Every distinct-key resolution attempt against an already-terminal reservation returns **409** — same-key replay of the saved `result` is the only post-terminal success path.

**Late usage after release is persist-only:** a verified usage event arriving after `released` is persisted raw for audit and **never settled, never debited, never triggers a settlement attempt** (the wallet mutation would violate `balance ≥ reserved`). Same for usage arriving after `settled` — the reservation already has its one settlement.

**Cash refund (refund_operations) is not a reservation terminal transition:** it applies only to an **already `settled`** reservation and is keyed by the original settle debit (`ledger_entries.original_ledger_entry_id`, kind `settle`, direction `debit`). It does not require `held|unknown` status and does not participate in the CAS above — the terminal fencing must not block a legitimate refund of an already-posted charge.

**Ownership validation (in the same transaction):** `reservation.gateway_request_id` must equal the resolution's `request_id` (i.e. `reservation.gateway_request_id = unknown_resolutions.request_id`; `reservations` has no `request_id` column), and the workspace/wallet must match the actor's scope. For a refund, the original settle debit's `reservation_id` **and** `wallet_id` must match the target reservation/wallet — no refund or release may cross requests, reservations, or wallets.

**Concurrent same-key replay:** the resolution transaction runs under `BEGIN IMMEDIATE` (with `busy_timeout` set), serializing concurrent first-use of one `resolution_key`. If a unique/snapshot conflict is still hit, the transaction rolls back, reselects by `resolution_key`, compares `payload_hash`, and returns the stored `result` — replay is guaranteed, never a duplicate mutation.

**Replay/insert is atomic:** one transaction (a) selects the existing row by `resolution_key` — if found and `payload_hash` matches, return the stored `result` (replay); if found with a different `payload_hash` → **409**; (b) else runs the terminal CAS / ownership checks, inserts the row, and performs the wallet/ledger mutation (hold release: `reserved` → available, no ledger row; manual settle: settlement debit ≤ cap) — insert, CAS, and mutation commit together or not at all. **Hold release ≠ cash refund:** `hold_release` touches only wallet `reserved` and writes no ledger row; a cash refund of an already-posted charge goes through `refund_operations` (separate endpoint, separate table), never through `unknown_resolutions`.

### audit

- **audit_log** (id, actor_user_id NULL, workspace_id, action TEXT, target TEXT, detail JSON, created_at). Covers key creation/revocation, model binding changes, manual UNKNOWN resolution, price changes, ledger adjustments.

## 3. Invariants (enforced, testable)

1. `wallets.balance ≥ 0`, `reserved ≥ 0`, `balance ≥ reserved` — check constraints; reservation via the single canonical conditional update (affected-rows check, one transaction with request/reservation insert).
2. One reservation per `gateway_request_id`; one settlement per reservation; one usage-event assignment per `settlement_usage_events.usage_event_id`; one topup per `(provider, provider_reference)`.
3. Ledger is append-only; corrections are new rows (`adjustment`/`refund` referencing the original debit via `original_ledger_entry_id`), never updates. **Single-wallet event ledger, not double-entry.** One refund per original debit (`UNIQUE(original_ledger_entry_id) WHERE kind = 'refund'`).
4. Settlement debits **≤** reservation cap, checked integer arithmetic, enforced in-transaction; remainder returns via reserved release, not a cash refund row.
5. UNKNOWN requests keep funds held until human policy acts; never auto-settled. Releasing an UNKNOWN hold is not a cash refund (no ledger row).
6. `sk-hbr-` plaintext never stored; hash-only + prefix for display.
7. Integer arithmetic only; immutable `price_snapshots` referenced by `reservations.price_snapshot_id` on every reservation.
8. Unknown/ambiguous `usage_events` are persisted for audit but never settle: settlement requires a verified, non-ambiguously correlated event; no aggregation/summing of ambiguous events.
9. **Terminal-resolution fencing:** every `unknown_resolutions` outcome (`hold_release`, `manual_settle`) performs exactly one terminal `reservations.status` transition (`held|unknown` → `released|settled`) via atomic compare-and-set in the same `BEGIN IMMEDIATE` transaction; the **normal CPA settlement transaction also terminalizes** with the same CAS (`held|unknown` → `settled`, affected rows `= 1`, committed with the wallet and ledger mutations; late usage on a terminal reservation is persist-only). Cash refunds via `refund_operations` require `status = 'settled'` and validate refund ownership. `UNIQUE(request_id)` on resolutions means one final resolution per request; distinct-key attempts after terminal → 409; same-key replay returns the stored result. Late usage after release/settled is persist-only, never settled.
10. **Ownership:** resolution `request_id` ↔ `reservation_id` must correspond (`reservation.gateway_request_id = unknown_resolutions.request_id`, with workspace/wallet scope validated); a refund's original debit `reservation_id` and `wallet_id` must match the target — no cross-request/cross-wallet leakage.
11. **Wallet mutations:** reservation and release/settle updates use conditional `UPDATE ... WHERE` with affected-rows `= 1` checks preserving `balance ≥ reserved`; violations abort the transaction.

## 5. Acceptance scenarios (design requirements, not code)

1. **Terminal fencing:** reservation at cap 100 with `reserved=100`; `hold_release(key=A)` commits → `manual_settle(key=B)` returns 409 and wallet `reserved` stays 0; no second release attempt succeeds.
2. **Same-key concurrent first-use:** two processes resolve the same new `resolution_key` simultaneously → exactly one mutation; both receive the identical stored result (or one receives it after rollback/reselect).
3. **Distinct-key post-terminal:** any resolution with a new key on an already `settled`/`released` reservation → 409; the same key replays the saved result.
4. **Late usage after release:** verified usage event arrives after `released` → event persisted, no ledger row, no settlement, `balance`/`reserved` unchanged.
5. **Refund after settlement:** a `refund_operations` entry against a `settled` reservation with a valid original settle debit → succeeds once; second refund for the same debit → 409; refund against a `held`/`released` reservation or a debit from another wallet/reservation → rejected.
6. **Cross-request leakage:** resolution carrying a `reservation_id` belonging to a different request → rejected; refund whose original debit belongs to another wallet → rejected.
7. **Wallet invariant:** under concurrent release + settle attempts, `balance ≥ reserved ≥ 0` holds after every commit; every conditional update that returns 0 affected rows aborts its transaction.

## 4. SQLite notes

- WAL mode; `busy_timeout` set; single gateway writer for MVP. Ledger + wallet mutations in one transaction per operation. Reservations need an immediate durable commit before dispatch — WAL commit is the durability point.
- Migrations via Drizzle; snapshot files committed.
