# Paid Gateway Implementation Plan

> Execute in order. Gateway disabled until gates pass. No production migration,
> provider calls, push, reset, staging, or secrets in this slice.

**Goal:** Ship a disabled-by-default, auditable paid Chat/Responses gateway with
bounded streaming usage, durable reservations, crash-safe reconciliation, and
payOS now.

**Boundary:** Elysia routes plus existing CPA client; locate before editing.
CPA owns provider calls/retries/routing/failover. SQLite WAL + Drizzle own
billing. Tasks permit implementation, tests, review, and reviewed local commits;
prohibit production migration execution, push, reset, staging, and secrets.

**Validation:** Scoped formatter on changed docs, `git diff --check`; report ≤8
lines.

## 1. Money seam first

- Add `packages/wallet/src/money.ts` and export through the existing
  `packages/wallet/src/index.ts` barrel. No schema execution.
- Exact interface:
  `PriceSnapshot {inputUsdMicroPer1m,outputUsdMicroPer1m,cachedInputUsdMicroPer1m,reasoningUsdMicroPer1m: bigint;usdVndRate: bigint;markupPpm: bigint}`;
  `UsageTokens {inputTokens,outputTokens,cachedInputTokens,reasoningTokens: bigint}`;
  `calculateCharge(usage,price): {upstreamCostUsdMicro:bigint;chargedVnd:bigint}`.
- Formula: `(input-cached)*p_input + cached*p_cached +
  (output-reasoning)*p_output + reasoning*p_reasoning`; divide USD by 1e6,
  then VND conversion by 1e12, with customer-facing ceiling.
- Set `maxStoredMoney=9223372036854775807n`; reject negatives, invalid subsets,
  and final stored values above it. Fixed price snapshots. Missing split handling
  belongs to usage module, not money.
- Tests in `packages/wallet/test/money.test.ts`: whole/half/micro USD conversion,
  no double count, negatives, invalid subsets, huge safe BigInt operands, stored
  overflow.

## 2. Schema, catalog, reservation

- Add forward-only tables/columns for keys, models, mappings, prices, wallets,
  reservations, requests, usage, settlements, ledger/refunds. Preflight before
  mutation; incompatible populated data stops for owner approval.
- Requests use `dispatch_state='reserved|dispatching|terminal'` and nullable
  `dispatched_at`; financial reservation status is distinct. One transaction
  marks dispatching before network, then terminal with settlement/release.
- Normalize cached input as an input subset and reasoning as an output subset;
  missing differing-rate details fail closed. Cap from bounded input/output.

## 3. Dispatch, capture, settlement

- Persist `reserved`, commit `dispatching` before one outbound attempt; CPA owns
  retries. Recovery: reserved releases, dispatching full-holds, terminal no-op.
  Transport failure after dispatching is not pre-dispatch release.
- Require complete valid usage and protocol completion before actual charge;
  otherwise settle one full-cap debit. Above-cap usage also full-holds and audits.
- Refunds append a wallet credit referencing the original debit, capped at it,
  one refund per debit. Test parser splits, malformed UTF-8, cancellation,
  completion gates, idempotency, crash matrix, concurrency, refund, late usage.

## 4. Routes and payOS

- Implement `/v1/models`, `/v1/chat/completions`, `/v1/responses`; validate key,
  workspace, published model, verified mapping, limits, disabled gate. Stream
  without buffering and inject Chat usage option when absent.
- Strip bypass/request-ID headers; issue local `X-HBR-Request-Id`; keep CPA and
  payment secrets server-side. Fail closed on unverified/differing-rate profiles.
- Implement existing PaymentProvider boundary for Mock and payOS: create/get,
  signature/replay/order/amount validation, dev completion fixture, one top-up.

## 5. Gates and reporting

- Startup/in-process reconciliation; gateway enable requires migration review,
  billing audit, independent review, scoped checks, and Bun QA. Dashboard later.
- Run scoped formatter and `git diff --check`; report commands/results, risks,
  and changed files ≤8 lines. No staging or commit in this pass.
