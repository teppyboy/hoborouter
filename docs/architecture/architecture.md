# Hoborouter Architecture (PROPOSED — pending human review)

Status: draft v1. Nothing here is approved. Three approaches are presented; the recommendation is Approach 3 (risk-limited phased release). Decisions marked **[OPEN — HUMAN]** require explicit sign-off before implementation.

## 1. Product contract (fixed)

Self-hosted AI gateway for Vietnam AI commerce, private deployment:

- **Stack:** Bun + Elysia 2 (API), React 19 static SPA built by Vite+ **under Node** (Vite+ requires Node engines; Node is the build-time builder image), Bun is the runtime, Drizzle ORM over `bun:sqlite` in WAL mode, Better Auth, Docker Compose running a private CLIProxyAPI (CPA) instance.
- **Gateway owns:** tenancy (workspaces), virtual `sk-hbr-` keys (hashed, shown once), published model catalog (mapped → CPA aliases), VND-integer wallet + append-only single-wallet event ledger, mock payment pipeline, thin OpenAI-compatible proxy routes, usage aggregation.
- **CPA owns:** provider protocols (OpenAI/Claude/Gemini/Responses translation), credential/OAuth management, multi-account routing, retry/cooldown/failover, usage-event publication (lossy).
- **License:** no AGPL source from new-api is copied or paraphrased; concept-level reuse only.

## 2. The central billing conflict (from adversarial review — accepted as fact)

CPA's usage publication is **asynchronous, fire-and-forget, in-memory, and lossy**:

- Usage queue is a plain Go slice; destructive pop, no ACK, retention default **60s** (max 3600s). Crash before pop or between pop and gateway persist **loses the usage event** (`internal/redisqueue/queue.go`).
- `SUBSCRIBE usage` **suppresses queueing entirely** and drops slow subscribers (256-buffer) with buffered messages lost.
- Publication is a background goroutine; `Publish` returns immediately; `Manager.Stop()` drains but crash loses everything.
- Client disconnect mid-stream may leave usage unpublished or partial (issue #3076).
- Queue payload `request_id` is the **HTTP trace ID (8-hex), not the per-execution UUID** (`Record.RequestID`). Retries may create new executions under the same or a new trace ID. No stable per-execution dedupe key is confirmed.
- `X-CPA-TRACE-ID` exists and is spoof-protected (`internal/logging/cpa_trace.go`), but emission across **all routes, versions, error paths, and aborted streams is unverified** — must be probed against a pinned release.

**Consequence:** exactly-once billing against CPA usage events is **impossible** from outside. The gateway must own idempotency, durability, and honest estimate-vs-settled labeling. CPA usage events are treated as **best-effort attestations**.

### Explicitly rejected claims (memo Option A and variants)

1. ❌ "Input tokens are exactly known from the raw client request" — tokenization is model/provider-specific; tools, system prompts, and caching expand upstream. Input cost is an **estimate** until a CPA event reports it.
2. ❌ "Gateway retry with the same gateway ID prevents duplicate provider spend" — every retry reaching CPA is fresh upstream spend. Gateway ID dedupes ledger rows only.
3. ❌ "Charging the estimate at response start is settlement" — it is a reservation; settlement comes only from verified usage.
4. ❌ "ack-by-advance" queue semantics — no such API exists; pop is destructive with no acknowledgment.
5. ❌ "SDK plugin mode guarantees durability" — still an in-process async callback; crash between spend and plugin commit loses the record.
6. ❌ "Automatic retry after ambiguous dispatch" — forbidden. Ambiguous outcome = UNKNOWN status + held reservation + review; never auto-retry (duplicate upstream spend).
7. ❌ "Missing usage is billable" — a request whose usage never arrived is **never silently settled**; it goes to UNKNOWN/hold.

## 3. Money-safety model (non-negotiable invariants)

Regardless of approach chosen:

1. **Reserve before dispatch.** A durable SQLite reservation row (VND integer, hard per-request cap) is committed **before** the upstream call. Funds held, not charged.
2. **Atomic concurrent availability.** Canonical reservation is one transaction: insert request row + reservation row, then `UPDATE wallets SET reserved = reserved + :cap, version = version + 1 WHERE id = :wallet_id AND balance - reserved >= :cap`; require affected row count `= 1` (0 → reject 402). `balance` is the actual posted balance; `available = balance − reserved` is derived. Check constraint `balance >= 0 AND reserved >= 0 AND balance >= reserved`. Unique constraint on `(wallet_id, gateway_request_id)` prevents double reservation.
3. **Settled ≠ reserved.** Two distinct ledger concepts. Holds live in the wallet `reserved` field, **not** as cash ledger entries; the ledger is an append-only **single-wallet event ledger, not double-entry**.
4. **Idempotent settlement, gated on verified usage.** Settlement runs only when a CPA usage event is received, correlates to the reservation, and passes token sanity checks. Per-event assignment uniqueness is enforced by `settlement_usage_events` with `UNIQUE(usage_event_id)`, assigned + settled in one transaction; one settlement per reservation (`settlements.reservation_id UNIQUE` on settle). **The queue payload contains no execution UUID**; events with NULL execution UUID are ambiguous and are **never auto-settled**, and no automatic per-execution dedupe is claimed until the Phase 0 probe on the pinned release (or a human-signed-off durable identity) proves otherwise. Settlement decreases `balance` by the actual charge and `reserved` by the full cap (precondition `reserved >= cap`; available rises by `cap − charge`), using checked integer arithmetic rejecting `charge < 0` or `charge > cap`. **The normal settlement transaction also terminalizes the reservation:** `UPDATE reservations SET status = 'settled' ... WHERE status IN ('held','unknown')` with affected rows `= 1` required, committed atomically with the wallet and ledger mutations; usage arriving on an already-terminal reservation is persisted only, never settled. Releasing an unused hold writes **no** refund/cash ledger row; only a later refund of an already-posted charge creates a refund row referencing the original debit (via the separate `refund_operations` table — one `BEGIN IMMEDIATE` transaction validates ownership, caps the amount at the original debit (`0 < amount <= original_debit.amount`, checked integer arithmetic), credits `wallets.balance` with a `version` increment, inserts the refund ledger row and `refund_operations` row, all committing together or none; `UNIQUE(original_ledger_entry_id) WHERE kind = 'refund'` bounds it to one refund per debit; same-key replay returns the stored result, conflicting different key → 409).
5. **UNKNOWN state exists.** If usage never arrives (crash, retention expiry, disconnect, zero-usage bug): reservation is held, request marked `unknown`, surfaced for manual review. **[OPEN — HUMAN]** what happens to held funds after a timeout (hold release vs. manual review). Note: releasing an unposted UNKNOWN hold returns reserved funds to available — it is **not** a cash refund (no ledger row); a cash refund exists only when an already-posted charge is later compensated (see §3.4 and data-model ledger rules). Every UNKNOWN resolution (`hold_release`, `manual_settle`) performs exactly **one** terminal `reservations.status` transition (`held|unknown` → `settled|released`) via atomic compare-and-set in the resolution transaction; the normal CPA settlement performs the same CAS in its own transaction; one resolution per request; distinct-key attempts after terminal → 409, same-key replay returns the stored result; late usage after release is persist-only, never settled. A cash refund of an already-posted charge is a separate operation (separate `refund_operations` record, separate admin route), keyed by the original settle debit and not blocked by terminal fencing.
6. **Integer money everywhere.** VND integers, no floats. Price/FX per model captured as an immutable **snapshot on the reservation** (model price table version + rates at request time); settlement reconciles against the snapshot, never live prices.
7. **No paid AI traffic without verified mapping.** If a stable, uniquely-enforced execution/event identity cannot be proven on the pinned CPA release, paid routes stay **disabled** until verified, or a **separate, explicitly approved bounded-loss process** is signed off (bounded, monitored; does not enable auto-settlement or summing of ambiguous events).

## 4. Design approaches

### Approach 1 — Estimate-forward gateway (memo Option A) — **REJECTED as-is**

Reserve an estimate pre-request, treat response-start estimate as committed charge, reconcile from a ≤60s queue poller.

- Pros: lowest latency to first byte; simple collector.
- Cons: **fails the money contract.** Estimate-as-charge permits over/undercharge on every long stream; poller crash window (60s retention, destructive pop) loses charges with no repair; no atomic concurrency control as stated; dedupe key is the wrong identity (trace ID ≠ execution UUID). Only salvageable as a _reservation_ mechanism, which Approach 3 adopts.
- Verdict: rejected as a money-safety guarantee; kept as one ingredient.

### Approach 2 — Durable intermediary / in-process CPA (memo Option C extended)

Run CPA as an SDK in-process, or wrap the RESP/HTTP collector in a durable intermediary (write-ahead local log before ack), or fork CPA to add a synchronous durable usage sink.

- Pros: tightest possible loss window; full `Record` (execution UUID + trace ID + token breakdown) in-process.
- Cons: forks/vendor-couples a Go component we don't own (release pinning, upstream drift); **still not exactly-once** — process crash between upstream spend and plugin commit loses the record; violates "Docker Compose private CLIProxyAPI, thin gateway" contract; highest engineering cost.
- Verdict: rejected for MVP; recorded as a future upgrade path if billing precision requirements grow and a fork is acceptable.

### Approach 3 — Risk-limited phased gateway (RECOMMENDED)

Gateway-side durable reservation + best-effort CPA usage ingestion + honest state machine. Phased so no phase ships a money promise CPA cannot keep.

- Core: reservation-before-dispatch (§3), single strict poller (HTTP pop → **persist to SQLite before polling again**), two-ID correlation (see §5), UNKNOWN/hold for ambiguity, upstream quota caps as spend backstop.
- Release gating: each phase has measurable acceptance gates (§7). Streaming is **designed** but not launched as guaranteed-billed until correlation and abort policy are human-approved and probed.
- Pros: no false promises; no fork; matches stack contract; every loss mode is a named, bounded, reviewable state instead of a silent mischarge.
- Cons: some usage is unbilled or held-for-review by design (bounded, capped, auditable); slightly higher request latency for the reservation transaction (one SQLite WAL commit, ~ms).

**Recommendation: Approach 3.**

## 5. Correlation: two-ID mapping

Two distinct CPA identities, stored separately, never conflated:

| ID                   | Source                                                    | Meaning                        | Use                                                                                                        |
| -------------------- | --------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `gateway_request_id` | Hoborouter UUID v4                                        | One gateway request/ledger row | Dedupes ledger + reservation; primary key of the request record                                            |
| `cpa_trace_id`       | `X-CPA-TRACE-ID` response header [H: coverage unverified] | CPA's inbound HTTP request ID  | Correlates gateway row ↔ CPA queue events for that HTTP exchange                                           |
| `cpa_execution_uuid` | `Record.RequestID` in usage records                       | One provider execution         | Highest-fidelity usage key; **the queue payload does not carry it** — payload `request_id` is the trace ID |

Rules:

- Persist `gateway_request_id → cpa_trace_id` **durably before** the response completes.
- On settlement, usage events are correlated **only** by a stable execution/event identity proven in the Phase 0 probe on the pinned release **and** enforced unique by a non-nullable provider-event key. **Trace-only correlation is never sufficient for automatic settlement**: an event that can only be matched by trace ID (or that carries NULL execution UUID) is recorded and routed to UNKNOWN — it is persisted for audit, never debited, and never summed/aggregated to estimate a charge (sums can double-count duplicate deliveries or retries). Multiple executions mapping to one gateway request, or one trace ID mapping to multiple gateway rows, is ambiguity → UNKNOWN, never guessed or auto-resolved.
- **`X-Request-Id` as a fallback identity is UNVERIFIED** — research confirms only the `X-CPA-TRACE-ID` candidate; treat equivalence as unproven until the pinned-release probe passes.
- **Ambiguous events (NULL execution UUID, trace-only match, ambiguous trace mapping) are persisted raw for audit but never auto-settled.** No automatic per-execution dedupe is claimed until the probe proves a stable execution identity **with a non-nullable, UNIQUE provider-event key** (nullable IDs cannot enforce uniqueness in SQLite — multiple NULLs are permitted) or a human signs off an alternative.
- If no deterministic usage mapping exists on the pinned release: **disable paid AI traffic** until verified, or obtain explicit approval for a **separate, explicit bounded-loss process** (human-signed-off cap + monitoring). Note: merely "accepting the loss" does **not** make unsafe dedupe safe — without stable identity, events are still never auto-settled or summed; the bounded-loss process governs only how unbilled/underbilled VND is tolerated and monitored, and remains a distinct human decision from the identity problem.

## 6. Runtime topology

```
[Browser] ──static──▶ [Nginx/Compose] ──▶ SPA dist (Vite+ build)
[Client SDKs] ──/v1/*──▶ [Hoborouter API (Bun+Elysia)]
                              │  auth (Better Auth session or sk-hbr- key)
                              │  reserve (SQLite WAL txn)
                              ▼
                       [CLIProxyAPI :8317]  (Docker Compose, private network)
                              ▲  usage: HTTP pop (strict poller) or RESP
[Hoborouter worker] ──────────┘  (part of the Hoborouter API container, on the
                                   shared private Compose network; management
                                   key cached)
```

- Single-writer gateway process for MVP (SQLite WAL, one node). Horizontal scale is out of scope until the ledger moves off SQLite.
- CPA release **pinned**; config snapshot committed to repo as compatibility contract.
- **Management reachability:** CPA and the Hoborouter API run in **separate Compose containers**, so `management.allow-remote: false` (localhost-only) would make the management API unreachable. Configuration: `management.allow-remote: true` **only** on the private Compose network, **non-empty `management.secret-key`** required, **no CPA port published to the host or Internet** (no `ports:` mapping; Compose-internal network only), an explicit firewall/network policy on that network, and a Phase 0 auth test (management call succeeds from the gateway container; management endpoint is **unreachable from outside** the Compose network). Do not rely on "localhost" semantics — it is false across containers. Never retry-loop management auth — 5 failures ≈ 30 min ban.
- Payment pipeline: mock provider emitting **payOS-shaped webhook events** (`code/desc/success/data{orderCode, amount,...}`) → durable `payment_events` table (`UNIQUE(provider, provider_reference)`; `provider` column required) → idempotent wallet credit. Payments never write ledger rows directly from webhook handlers. The **mock provider/completion path is development/demo only** — behind an explicit auth check and feature flag, disabled in production builds. Stage 2 = static VietQR + manual confirm; stage 3 = payOS/VNPay/MoMo behind the same provider interface, each with webhook signature verification and PaymentService-level idempotency. (Research: `docs/research/vietnam-payments.md`.)
- **AuthZ model:** per-workspace roles (`owner|admin|member`) govern workspace-scoped routes via a route matrix (api-boundaries.md §2). An **instance-wide admin** (deployment operator: model catalog globally, CPA config, instance settings) is a distinct role from any workspace admin. Better Auth's generated schema/migrations against Drizzle + `bun:sqlite` must be verified by a Phase 1 test.

## 7. Phased plan with acceptance gates

| Phase | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Acceptance gate (measurable)                                                                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0     | Pin CPA release; probe `X-CPA-TRACE-ID` on success/error/stream/disconnect; probe usage-queue schema & headers; **probe paid-path retry config: verify `routing.retry.request-retry = 0` and `bootstrap-retries = 0` actually take effect (count provider attempts per request); if no way to disable failover/retries exists, the pinned release is REJECTED for paid traffic**; management-reachability auth test (gateway container reaches management; endpoint unreachable externally) | Probe report in repo; header present on ≥ all tested routes or paid routes stay disabled; provider-attempt count = 1 per request on paid paths                                                                     |
| 1     | Auth, workspaces, keys, model catalog, wallet, ledger, mock payments (dev/demo only, behind auth + feature flag); **no AI traffic**; Better Auth × Drizzle × `bun:sqlite` schema/migration verification test                                                                                                                                                                                                                                                                                | Concurrency test: 2 parallel reservations of >balance/2 → exactly one succeeds; zero negative balances after fuzz; Better Auth migration test passes                                                               |
| 2     | **Non-streaming only** (`stream:false`; `stream:true` requests rejected with 400 until Phase 3) `/v1/chat/completions` + `/v1/responses`, reservation→settle state machine, strict poller; **launch gates: all §8 human decisions signed off, UNKNOWN review UI + operations live, bounded-loss monitoring live**                                                                                                                                                                           | Chaos test: kill gateway mid-request → every request ends in settled or unknown (never silently settled); unbilled VND ≤ approved bound; streaming requests rejected; UNKNOWN review workflow exercised end-to-end |
| 3     | Streaming routes (SSE), abort policy per [OPEN — HUMAN] decision                                                                                                                                                                                                                                                                                                                                                                                                                            | Abort test matrix passes per approved policy                                                                                                                                                                       |
| 4     | Dashboard (usage, logs, models, keys — Vercel-style IA, monochrome), VND top-up stage 1/2                                                                                                                                                                                                                                                                                                                                                                                                   | UI acceptance: key shown-once verified; ledger↔usage reconciliation report                                                                                                                                         |
| 5     | Real payment provider (payOS)                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Webhook replay test: duplicate webhooks → single credit                                                                                                                                                            |

## 8. Open human decisions

1. **Hard cap on unbilled/underbilled VND per period** (bounded-loss tolerance) — required before enabling paid traffic.
2. **Streaming launch + client-abort billing policy** (charge-max vs hold vs hold-release; never auto-retry after dispatch). Streaming may be built but not launched as guaranteed-billed without this; Phase 2 rejects `stream:true`.
3. **UNKNOWN/hold resolution policy**: auto-release of held funds (hold release, not a cash refund) after N hours vs manual review queue; and whether failed upstream attempts are billable (default: not billable). **Phase 2 paid-traffic gate: UNKNOWN review UI + operations must be live before launch.**
4. **Priority ordering** when CPA guarantees conflict: no-overcharge vs no-undercharge vs availability vs no-funds-lock — cannot have all four.
5. **Header coverage risk acceptance** if `X-CPA-TRACE-ID` proves missing on some routes (disable those routes vs. bounded-loss exemption).
6. **Bounded-loss monitoring thresholds** (dashboards/alerts on unbilled, underbilled, UNKNOWN counts) must be live **before** paid launch.
7. **Retry-disable sign-off**: confirmation that the pinned CPA release verifiably disables retries/bootstrap failover on paid paths, or rejection of that release for paid traffic.

## 9. Sources

- CPA queue/usage/trace internals: `docs/research/cliproxyapi.md` (+ addendum), memo `41791c82/research.md`, adversarial review `b8b5b5eb_reviewer_output.md`.
- Billing reference (concept only, AGPL): `docs/research/new-api.md`.
- Payments: `docs/research/vietnam-payments.md`. UI reference: `docs/research/vercel-ai-gateway-ui.md`. Toolchain: `docs/research/viteplus.md`.
- CPA upstream: https://github.com/router-for-me/CLIProxyAPI (queue.go, redisqueue/plugin.go, cpa_trace.go, sdk/cliproxy/usage/manager.go, server_routes.go), https://help.router-for.me/.
