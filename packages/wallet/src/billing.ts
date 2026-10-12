// Task 3: canonical billing service over the canonical catalog tables.
// Pure DB, no HTTP, no provider calls. One Postgres transaction per mutation
// via runInImmediate (wallet row locked FOR UPDATE). Money is integer VND;
// prices are immutable model_prices rows; fx/markup are snapshotted on
// billing_reservations at reserve time and reused verbatim at settle time.
import { and, asc, eq, gte, isNull, lte, ne, sql } from "drizzle-orm";
import type { Db, Tx } from "@hoborouter/db";
import {
  auditLog,
  billingReservations,
  apiKeys,
  ledgerEntries,
  models as modelsTable,
  modelPrices,
  providerModelMappings,
  requests,
  settlements,
  usageLogs,
  wallets,
} from "@hoborouter/db";
import { WalletError, lockWallet, requirePositiveSafeInteger, runInImmediate } from "./wallet";
import { settleKeyBudgetHold } from "@hoborouter/keys";
import { calculateCharge, maxStoredMoney, type PriceSnapshot, type UsageTokens } from "./money";
import {
  applySubscriptionDailyGrant,
  applySubscriptionExpiry,
  getActiveUnexpiredSubscription,
  getSubscriptionWallet,
} from "./subscription";

type UnitPrice = {
  inputUsdMicroPer1m: number;
  outputUsdMicroPer1m: number;
  cachedInputUsdMicroPer1m: number;
  reasoningUsdMicroPer1m: number;
};

function requireNonnegativeSafeInteger(name: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw new WalletError(
      "invalid",
      `${name} must be a nonnegative safe integer, got ${String(v)}`,
    );
  }
  return v;
}

/**
 * Worst-case cap: all input tokens billed at the more expensive of the
 * input/cached rates, all output tokens at the more expensive of the
 * output/reasoning rates, then through calculateCharge semantics (fx, markup,
 * customer-facing ceiling). Rejects non-positive/unsafe inputs; the result
 * must be > 0 and <= maxStoredMoney.
 */
export function estimateCapVnd(
  bound: { maxInputTokens: number; maxOutputTokens: number },
  price: UnitPrice,
  fxRate: number,
  markupPpm: number,
): number {
  const maxInput = requirePositiveSafeInteger("maxInputTokens", bound.maxInputTokens);
  const maxOutput = requirePositiveSafeInteger("maxOutputTokens", bound.maxOutputTokens);
  requireNonnegativeSafeInteger("inputUsdMicroPer1m", price.inputUsdMicroPer1m);
  requireNonnegativeSafeInteger("outputUsdMicroPer1m", price.outputUsdMicroPer1m);
  requireNonnegativeSafeInteger("cachedInputUsdMicroPer1m", price.cachedInputUsdMicroPer1m);
  requireNonnegativeSafeInteger("reasoningUsdMicroPer1m", price.reasoningUsdMicroPer1m);
  const fx = requirePositiveSafeInteger("fxRate", fxRate);
  const markup = requireNonnegativeSafeInteger("markupPpm", markupPpm);
  const snapshot: PriceSnapshot = {
    inputUsdMicroPer1m: BigInt(Math.max(price.inputUsdMicroPer1m, price.cachedInputUsdMicroPer1m)),
    cachedInputUsdMicroPer1m: 0n, // unused: all input billed at the max rate above
    outputUsdMicroPer1m: BigInt(Math.max(price.outputUsdMicroPer1m, price.reasoningUsdMicroPer1m)),
    reasoningUsdMicroPer1m: 0n, // unused: all output billed at the max rate above
    usdVndRate: BigInt(fx),
    markupPpm: BigInt(markup),
  };
  let chargedVnd: bigint;
  try {
    ({ chargedVnd } = calculateCharge(
      {
        inputTokens: BigInt(maxInput),
        cachedInputTokens: 0n,
        outputTokens: BigInt(maxOutput),
        reasoningTokens: 0n,
      },
      snapshot,
    ));
  } catch (err) {
    // calculateCharge guards both money bounds with RangeError; callers of
    // estimateCapVnd handle the typed WalletError("overflow") — the gateway
    // maps it to 400 instead of an unhandled 500.
    if (err instanceof RangeError)
      throw new WalletError("overflow", "estimated cap exceeds maxStoredMoney");
    throw err;
  }
  if (chargedVnd <= 0n) throw new WalletError("invalid", "estimated cap must be positive");
  if (chargedVnd > maxStoredMoney)
    throw new WalletError("overflow", "estimated cap exceeds maxStoredMoney");
  return Number(chargedVnd);
}

export type ReserveRequestArgs = {
  requestId: string;
  workspaceId: string;
  apiKeyId: string;
  modelId: string;
  mappingId: string;
  modelPriceId: string;
  endpoint: "/v1/chat/completions" | "/v1/responses" | "/v1/messages";
  mode: "stream" | "non-stream";
  fxRate: number;
  capVnd: number;
  /**
   * O3 gateway funding: when present, the reservation funds from the
   * subscription wallet iff the workspace has an active unexpired subscription
   * AND its available balance covers the cap AND underLimit is true; otherwise
   * the topup wallet funds (no limit). Lazy expiry runs first in the same txn.
   * Absent (default): topup wallet, unchanged legacy behavior.
   */
  funding?: { underLimit: boolean };
  now: number;
};

/**
 * One txn: insert requests(status 'pending', dispatch_state 'reserved',
 * model_binding_id NULL) + billing_reservations(status 'held', fx from args,
 * markup from the immutable price row) + wallet reserved += cap with an
 * available-balance CAS. Insufficient balance -> typed WalletError("insufficient"),
 * nothing written.
 */
export async function reserveRequest(
  db: Db | Tx,
  args: ReserveRequestArgs,
): Promise<{ requestId: string; reservationId: string; walletKind: "subscription" | "topup" }> {
  const capVnd = requirePositiveSafeInteger("capVnd", args.capVnd);
  const fxRate = requirePositiveSafeInteger("fxRate", args.fxRate);
  if (typeof args.requestId !== "string" || args.requestId === "") {
    throw new WalletError("invalid", "requestId must be a non-empty string");
  }
  return runInImmediate(
    db,
    async (tx) => {
      const keys = await tx
        .select({ workspace_id: apiKeys.workspace_id, status: apiKeys.status })
        .from(apiKeys)
        .where(eq(apiKeys.id, args.apiKeyId));
      const key = keys[0];
      if (!key || key.workspace_id !== args.workspaceId || key.status === "revoked") {
        throw new WalletError(
          "ownership",
          `api key ${args.apiKeyId} not usable for workspace ${args.workspaceId}`,
        );
      }
      // Funding source (O3): one request is funded by exactly one wallet.
      // Subscription only when under the per-minute limit AND an active
      // unexpired subscription's available covers the cap; else topup.
      // Daily grant (migration 0019): the lazy once-per-UTC-day grant runs
      // inside THIS funding transaction whenever the subscription is active
      // and unexpired — regardless of which wallet ends up funding, the
      // entitlement is the subscription's, not the request's. No catch-up:
      // only the current UTC day is granted. Idempotent per day via the
      // UNIQUE(workspace, subscription, grant_day) gate; the grant's wallet
      // lock serializes concurrent funding transactions.
      let walletKind: "subscription" | "topup" = "topup";
      let wallet: { id: string } | undefined;
      if (args.funding) {
        await applySubscriptionExpiry(tx, args.workspaceId, args.now);
        const sub = await getActiveUnexpiredSubscription(tx, args.workspaceId, args.now);
        if (sub) {
          // Ensures the subscription wallet exists and locks it; a grant here
          // may be what makes the cap affordable, so it precedes selection.
          await applySubscriptionDailyGrant(tx, args.workspaceId, args.now);
          if (args.funding.underLimit) {
            const subWallet = await getSubscriptionWallet(tx, args.workspaceId);
            if (subWallet && subWallet.balance - subWallet.reserved >= capVnd) {
              wallet = subWallet;
              walletKind = "subscription";
            }
          }
        }
      }
      if (!wallet) {
        const ws = await tx
          .select({ id: wallets.id })
          .from(wallets)
          .where(and(eq(wallets.workspace_id, args.workspaceId), eq(wallets.kind, "topup")));
        wallet = ws[0];
      }
      if (!wallet)
        throw new WalletError("not_found", `wallet not found for workspace ${args.workspaceId}`);
      // Wallet row locked by runInImmediate: concurrent reserves serialize here.
      const modelRows = await tx
        .select({ id: modelsTable.id })
        .from(modelsTable)
        .where(
          and(
            eq(modelsTable.id, args.modelId),
            eq(modelsTable.enabled, true),
            eq(modelsTable.published, true),
          ),
        );
      if (modelRows.length === 0)
        throw new WalletError("ownership", `model ${args.modelId} not enabled+published`);
      const mappings = await tx
        .select({ model_id: providerModelMappings.model_id })
        .from(providerModelMappings)
        .where(
          and(
            eq(providerModelMappings.id, args.mappingId),
            eq(providerModelMappings.enabled, true),
          ),
        );
      const mapping = mappings[0];
      if (!mapping || mapping.model_id !== args.modelId) {
        throw new WalletError(
          "ownership",
          `mapping ${args.mappingId} not enabled for model ${args.modelId}`,
        );
      }
      const prices = await tx
        .select({ markup_ppm: modelPrices.markup_ppm })
        .from(modelPrices)
        .where(
          and(
            eq(modelPrices.id, args.modelPriceId),
            eq(modelPrices.model_id, args.modelId),
            lte(modelPrices.effective_at, args.now),
            isNull(modelPrices.retired_at),
          ),
        );
      const price = prices[0];
      if (!price) {
        throw new WalletError(
          "ownership",
          `price ${args.modelPriceId} not current for model ${args.modelId}`,
        );
      }
      const dup = await tx
        .select({ x: requests.id })
        .from(requests)
        .where(eq(requests.id, args.requestId));
      if (dup.length > 0) {
        throw new WalletError("conflict", `request id ${args.requestId} already exists`);
      }

      await tx.insert(requests).values({
        id: args.requestId,
        workspace_id: args.workspaceId,
        api_key_id: args.apiKeyId,
        model_binding_id: null,
        model_id: args.modelId,
        provider_model_mapping_id: args.mappingId,
        endpoint: args.endpoint,
        mode: args.mode,
        status: "pending",
        dispatch_state: "reserved",
        created_at: args.now,
      });

      const reservationId = crypto.randomUUID();
      await tx.insert(billingReservations).values({
        id: reservationId,
        wallet_id: wallet.id,
        request_id: args.requestId,
        api_key_id: args.apiKeyId,
        model_id: args.modelId,
        model_price_id: args.modelPriceId,
        usd_vnd_exchange_rate: fxRate,
        markup_ppm: price.markup_ppm,
        cap_vnd: capVnd,
        status: "held",
        created_at: args.now,
      });

      // CAS: available balance must cover the cap; 0 rows = insufficient.
      const updated = await tx
        .update(wallets)
        .set({
          reserved: sql`${wallets.reserved} + ${capVnd}`,
          version: sql`${wallets.version} + 1`,
        })
        .where(
          and(
            eq(wallets.id, wallet.id),
            gte(sql`${wallets.balance} - ${wallets.reserved}`, capVnd),
          ),
        )
        .returning({ id: wallets.id });
      if (updated.length !== 1) {
        throw new WalletError("insufficient", "insufficient: available balance below cap");
      }
      return { requestId: args.requestId, reservationId, walletKind };
    },
    // walletId unknown before the lookup; the CAS above is the concurrency gate.
  );
}

/**
 * CAS reserved->dispatching + dispatched_at. Must COMMIT before any network
 * I/O (caller contract). Any other prior state -> typed error.
 */
export async function markDispatching(db: Db | Tx, requestId: string, now: number): Promise<void> {
  await runInImmediate(db, async (tx) => {
    const updated = await tx
      .update(requests)
      .set({ dispatch_state: "dispatching", dispatched_at: now })
      .where(and(eq(requests.id, requestId), eq(requests.dispatch_state, "reserved")))
      .returning({ id: requests.id });
    if (updated.length !== 1) {
      const rows = await tx
        .select({ dispatch_state: requests.dispatch_state })
        .from(requests)
        .where(eq(requests.id, requestId));
      const row = rows[0];
      throw new WalletError(
        row ? "terminal" : "not_found",
        row
          ? `request ${requestId} in state ${row.dispatch_state}, expected 'reserved'`
          : `request ${requestId} not found`,
      );
    }
  });
}

/**
 * Pre-dispatch release (validation/auth/balance failures BEFORE markDispatching):
 * reservation 'released', wallet reserved -= cap, request terminal, no ledger.
 * Idempotent: a second call on an already-released request is a no-op.
 */
export async function releaseRequest(db: Db | Tx, requestId: string, now: number): Promise<void> {
  await runInImmediate(db, async (tx) => {
    const rows = await tx
      .select({
        dispatch_state: requests.dispatch_state,
        br_id: billingReservations.id,
        br_status: billingReservations.status,
        cap_vnd: billingReservations.cap_vnd,
        wallet_id: billingReservations.wallet_id,
        api_key_id: billingReservations.api_key_id,
      })
      .from(requests)
      .innerJoin(billingReservations, eq(billingReservations.request_id, requests.id))
      .where(eq(requests.id, requestId));
    const row = rows[0];
    if (!row) throw new WalletError("not_found", `request ${requestId} not found`);
    if (row.dispatch_state === "terminal" && row.br_status === "released") return; // idempotent
    if (row.dispatch_state !== "reserved") {
      throw new WalletError(
        "terminal",
        `request ${requestId} in state ${row.dispatch_state}; release only allowed pre-dispatch ('reserved')`,
      );
    }
    await lockWallet(tx, row.wallet_id);
    const casRes = await tx
      .update(billingReservations)
      .set({ status: "released", resolved_at: now })
      .where(and(eq(billingReservations.id, row.br_id), eq(billingReservations.status, "held")))
      .returning({ id: billingReservations.id });
    if (casRes.length !== 1) {
      throw new WalletError("conflict", `billing reservation ${row.br_id} not held`);
    }
    const casReq = await tx
      .update(requests)
      .set({ dispatch_state: "terminal", status: "unknown" })
      .where(and(eq(requests.id, requestId), eq(requests.dispatch_state, "reserved")))
      .returning({ id: requests.id });
    if (casReq.length !== 1) {
      throw new WalletError("conflict", `request ${requestId} dispatch state changed concurrently`);
    }
    const casWallet = await tx
      .update(wallets)
      .set({
        reserved: sql`${wallets.reserved} - ${row.cap_vnd}`,
        version: sql`${wallets.version} + 1`,
      })
      .where(and(eq(wallets.id, row.wallet_id), gte(wallets.reserved, row.cap_vnd)))
      .returning({ id: wallets.id });
    if (casWallet.length !== 1) {
      throw new WalletError(
        "conflict",
        `wallet ${row.wallet_id} reserved invariant violated on release`,
      );
    }
    // Pre-dispatch release: return the key-budget admission hold (charged 0);
    // no-op for keys without a budget. Policy counter only — no ledger row.
    if (row.api_key_id !== null) {
      await settleKeyBudgetHold(tx, {
        apiKeyId: row.api_key_id,
        holdVnd: row.cap_vnd,
        chargedVnd: 0,
      });
    }
    // No ledger row: releasing a hold is not a cash movement.
  });
}

export type SettleOutcome =
  | {
      kind: "usage";
      usage: UsageTokens;
      /** Real provider-reported cached tokens to STORE when usage.cachedInputTokens was zeroed for charging (prompt caching off). */
      storedCachedInputTokens?: bigint;
      upstreamModel: string;
      provider: string;
      publicModel: string;
      latencyMs?: number;
      ttftMs?: number;
      httpStatus?: number;
      rawPayload?: string;
      /** Recorded into raw_payload when rawPayload is absent (e.g. assumed splits). */
      metadata?: unknown;
    }
  | {
      kind: "full_hold";
      reason: "client_abort" | "upstream_error" | "unknown";
      metadata?: unknown;
      /** Customer-facing model id; '' when unknown. Upstream never recorded. */
      publicModel?: string;
    };

export type SettleResult = {
  status: "settled" | "settled_full_hold";
  chargedVnd: number;
  alreadySettled: boolean;
};

function requestStatusForReason(reason: string): "client_abort" | "upstream_error" | "unknown" {
  if (reason === "client_abort" || reason === "upstream_error") return reason;
  return "unknown";
}

/**
 * Settle from 'dispatching' only. Usage outcome charges via calculateCharge
 * with the reservation's immutable price row and the snapshotted fx/markup;
 * charge above cap is clamped to the cap (full-hold: audit + disable the
 * provider_model_mapping). full_hold debits the whole cap. One txn; the
 * settlements row is the idempotency gate — a repeat call returns the stored
 * result and never double-debits.
 */
export async function settleRequest(
  db: Db | Tx,
  requestId: string,
  outcome: SettleOutcome,
  now: number,
): Promise<SettleResult> {
  return runInImmediate(db, async (tx) => {
    const rows = await tx
      .select({
        br_id: billingReservations.id,
        br_status: billingReservations.status,
        wallet_id: billingReservations.wallet_id,
        cap_vnd: billingReservations.cap_vnd,
        usd_vnd_exchange_rate: billingReservations.usd_vnd_exchange_rate,
        markup_ppm: billingReservations.markup_ppm,
        model_price_id: billingReservations.model_price_id,
        api_key_id: billingReservations.api_key_id,
        model_id: billingReservations.model_id,
        workspace_id: requests.workspace_id,
        dispatch_state: requests.dispatch_state,
        provider_model_mapping_id: requests.provider_model_mapping_id,
      })
      .from(billingReservations)
      .innerJoin(requests, eq(requests.id, billingReservations.request_id))
      .where(eq(billingReservations.request_id, requestId));
    const row = rows[0];
    if (!row)
      throw new WalletError("not_found", `billing reservation for request ${requestId} not found`);

    // Serialize money movement on this wallet BEFORE the idempotency check:
    // a concurrent settle of the same request commits its settlement row
    // while we wait on the lock, so the re-check below sees it (no double
    // charge, no unique-violation crash).
    await lockWallet(tx, row.wallet_id);

    // Idempotency: a stored settlement is the single source of truth.
    const existingRows = await tx
      .select({ id: settlements.id, charged_vnd: settlements.charged_vnd })
      .from(settlements)
      .where(eq(settlements.billing_reservation_id, row.br_id));
    const existing = existingRows[0];
    if (existing) {
      return {
        status: row.br_status as SettleResult["status"],
        chargedVnd: existing.charged_vnd ?? 0,
        alreadySettled: true,
      };
    }
    if (row.dispatch_state !== "dispatching") {
      throw new WalletError(
        "terminal",
        `request ${requestId} in state ${row.dispatch_state}; settle requires 'dispatching'`,
      );
    }

    const priceRows = await tx
      .select({
        inputUsdMicroPer1m: modelPrices.input_usd_micro_per_1m,
        outputUsdMicroPer1m: modelPrices.output_usd_micro_per_1m,
        cachedInputUsdMicroPer1m: modelPrices.cached_input_usd_micro_per_1m,
        reasoningUsdMicroPer1m: modelPrices.reasoning_usd_micro_per_1m,
      })
      .from(modelPrices)
      .where(eq(modelPrices.id, row.model_price_id));
    const price = priceRows[0];
    if (!price) throw new WalletError("not_found", `price row ${row.model_price_id} missing`);
    // SAFETY: price row columns are schema-bounded integers; fixed shape.
    const snapshot: PriceSnapshot = {
      inputUsdMicroPer1m: BigInt(price.inputUsdMicroPer1m),
      outputUsdMicroPer1m: BigInt(price.outputUsdMicroPer1m),
      cachedInputUsdMicroPer1m: BigInt(price.cachedInputUsdMicroPer1m),
      reasoningUsdMicroPer1m: BigInt(price.reasoningUsdMicroPer1m),
      usdVndRate: BigInt(row.usd_vnd_exchange_rate),
      markupPpm: BigInt(row.markup_ppm),
    };

    let charge: number;
    let upstreamCostUsdMicro: number | null = null;
    let resStatus: SettleResult["status"];
    let requestStatus: "ok" | "client_abort" | "upstream_error" | "unknown";
    let reason: string | null = null;
    if (outcome.kind === "usage") {
      const { chargedVnd, upstreamCostUsdMicro: usdMicro } = calculateCharge(
        outcome.usage,
        snapshot,
      );
      // P1: record the real unclamped USD micro cost; NULL if it exceeds the
      // canonical money bound (charge itself is still clamped to the cap below).
      if (usdMicro <= maxStoredMoney) upstreamCostUsdMicro = Number(usdMicro);
      const capped = chargedVnd > BigInt(row.cap_vnd);
      charge = capped ? row.cap_vnd : Number(chargedVnd);
      resStatus = capped ? "settled_full_hold" : "settled";
      requestStatus = "ok";
    } else {
      charge = row.cap_vnd;
      resStatus = "settled_full_hold";
      requestStatus = requestStatusForReason(outcome.reason);
      reason = outcome.reason;
    }

    const usageLogId = crypto.randomUUID();
    if (outcome.kind === "usage") {
      await tx.insert(usageLogs).values({
        id: usageLogId,
        idempotency_key: requestId,
        request_id: requestId,
        api_key_id: row.api_key_id,
        workspace_id: row.workspace_id,
        provider: outcome.provider,
        public_model: outcome.publicModel,
        upstream_model: outcome.upstreamModel,
        input_tokens: Number(outcome.usage.inputTokens),
        output_tokens: Number(outcome.usage.outputTokens),
        cached_input_tokens: Number(
          outcome.storedCachedInputTokens ?? outcome.usage.cachedInputTokens,
        ),
        reasoning_tokens: Number(outcome.usage.reasoningTokens),
        status: "ok",
        failure: null,
        latency_ms: outcome.latencyMs ?? null,
        ttft_ms: outcome.ttftMs ?? null,
        upstream_cost_usd_micro: upstreamCostUsdMicro, // P1: real USD micro cost, NOT the VND charge
        usd_vnd_exchange_rate: row.usd_vnd_exchange_rate,
        markup_ppm: row.markup_ppm,
        charged_vnd: charge,
        raw_payload:
          outcome.rawPayload ??
          (outcome.metadata === undefined ? null : JSON.stringify(outcome.metadata)),
        created_at: now,
      });
    } else {
      await tx.insert(usageLogs).values({
        id: usageLogId,
        idempotency_key: requestId,
        request_id: requestId,
        api_key_id: row.api_key_id,
        workspace_id: row.workspace_id,
        provider: "",
        public_model: outcome.publicModel ?? "",
        upstream_model: "",
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        reasoning_tokens: 0,
        status: "full_hold",
        failure: reason,
        latency_ms: null,
        ttft_ms: null,
        upstream_cost_usd_micro: null,
        usd_vnd_exchange_rate: null,
        markup_ppm: null,
        charged_vnd: null,
        raw_payload: outcome.metadata === undefined ? null : JSON.stringify(outcome.metadata),
        created_at: now,
      });
    }

    const settlementId = crypto.randomUUID();
    const usage = outcome.kind === "usage" ? outcome.usage : null;
    const chargedInput = usage ? Number(usage.inputTokens) : 0;
    const chargedOutput = usage ? Number(usage.outputTokens) : 0;
    await tx.insert(settlements).values({
      id: settlementId,
      reservation_id: null,
      billing_reservation_id: row.br_id,
      charged_input: chargedInput,
      charged_output: chargedOutput,
      charged_total: chargedInput + chargedOutput,
      settled_at: now,
      charged_vnd: charge,
      usage_log_id: usageLogId,
      reason,
      created_at: now,
    });

    if (resStatus === "settled_full_hold" && outcome.kind === "usage") {
      // Above-cap usage: audit then fail closed on the mapping that allowed it.
      await tx.insert(auditLog).values({
        id: crypto.randomUUID(),
        workspace_id: row.workspace_id,
        action: "billing.cap_exceeded",
        target: row.br_id,
        detail: { requestId, capVnd: row.cap_vnd },
        created_at: now,
      });
      if (row.provider_model_mapping_id) {
        await tx
          .update(providerModelMappings)
          .set({ enabled: false, updated_at: now })
          .where(eq(providerModelMappings.id, row.provider_model_mapping_id));
        await tx.insert(auditLog).values({
          id: crypto.randomUUID(),
          workspace_id: row.workspace_id,
          action: "billing.mapping_disabled",
          target: row.provider_model_mapping_id,
          detail: { requestId, reason: "cap_exceeded" },
          created_at: now,
        });
      }
    }

    await tx
      .update(billingReservations)
      .set({ status: resStatus, resolved_at: now })
      .where(and(eq(billingReservations.id, row.br_id), eq(billingReservations.status, "held")));

    if (charge > 0) {
      const walletRows = await tx
        .select({
          balance: wallets.balance,
          reserved: wallets.reserved,
          version: wallets.version,
        })
        .from(wallets)
        .where(eq(wallets.id, row.wallet_id));
      const wallet = walletRows[0];
      if (!wallet) {
        throw new WalletError("not_found", `wallet ${row.wallet_id} vanished during settle`);
      }
      const balanceAfter = wallet.balance - charge;
      // CAS on full (balance, reserved, version); wallet row already locked.
      const casWallet = await tx
        .update(wallets)
        .set({
          balance: balanceAfter,
          reserved: wallet.reserved - row.cap_vnd,
          version: sql`${wallets.version} + 1`,
        })
        .where(
          and(
            eq(wallets.id, row.wallet_id),
            eq(wallets.balance, wallet.balance),
            eq(wallets.reserved, wallet.reserved),
            eq(wallets.version, wallet.version),
          ),
        )
        .returning({ id: wallets.id });
      if (casWallet.length !== 1) {
        throw new WalletError(
          "conflict",
          `wallet ${row.wallet_id} concurrent modification during settle`,
        );
      }
      await tx.insert(ledgerEntries).values({
        id: crypto.randomUUID(),
        wallet_id: row.wallet_id,
        direction: "debit",
        billing_reservation_id: row.br_id,
        amount: charge,
        kind: "settle",
        balance_after: balanceAfter,
        memo: null,
        created_at: now,
      });
    } else {
      // Zero charge: amount > 0 CHECK forbids a ledger row; still clear the hold.
      const casZero = await tx
        .update(wallets)
        .set({
          reserved: sql`${wallets.reserved} - ${row.cap_vnd}`,
          version: sql`${wallets.version} + 1`,
        })
        .where(and(eq(wallets.id, row.wallet_id), gte(wallets.reserved, row.cap_vnd)))
        .returning({ id: wallets.id });
      if (casZero.length !== 1) {
        throw new WalletError(
          "conflict",
          `wallet ${row.wallet_id} concurrent modification during zero-charge settle`,
        );
      }
    }

    // Settle the key-budget admission hold with the ACTUAL charge (full_hold:
    // charged == cap, net zero). Policy counter only — wallet ledger above is
    // untouched; no-op for keys without a budget. api_key_id is schema-nullable
    // but always set by reserveRequest; a null is a legacy row with no policy.
    if (row.api_key_id !== null) {
      await settleKeyBudgetHold(tx, {
        apiKeyId: row.api_key_id,
        holdVnd: row.cap_vnd,
        chargedVnd: charge,
      });
    }

    if (outcome.kind === "usage") {
      await tx
        .update(requests)
        .set({
          dispatch_state: "terminal",
          status: "ok",
          http_status: outcome.httpStatus ?? null,
          ttft_ms: outcome.ttftMs ?? null,
          duration_ms: outcome.latencyMs ?? null,
        })
        .where(eq(requests.id, requestId));
    } else {
      await tx
        .update(requests)
        .set({ dispatch_state: "terminal", status: requestStatus })
        .where(eq(requests.id, requestId));
    }

    return { status: resStatus, chargedVnd: charge, alreadySettled: false };
  });
}

export type RecoverCounts = { released: number; fullHeld: number };

/**
 * Crash recovery: reserved -> release (pre-dispatch, nothing happened),
 * dispatching -> full_hold 'recovered_ambiguous' (we cannot know what the
 * upstream did), terminal -> untouched. Idempotent; returns counts.
 */
export async function recoverPending(db: Db | Tx, now: number): Promise<RecoverCounts> {
  return runInImmediate(db, async (tx) => {
    const rows = await tx
      .select({ id: requests.id, dispatch_state: requests.dispatch_state })
      .from(requests)
      .where(ne(requests.dispatch_state, "terminal"))
      .orderBy(asc(requests.created_at));
    let released = 0;
    let fullHeld = 0;
    for (const row of rows) {
      try {
        if (row.dispatch_state === "reserved") {
          await releaseRequest(tx, row.id, now);
          released++;
        } else {
          await settleRequest(tx, row.id, { kind: "full_hold", reason: "unknown" }, now);
          await tx.insert(auditLog).values({
            id: crypto.randomUUID(),
            action: "billing.recovered_ambiguous",
            target: row.id,
            detail: { reason: "recovered_ambiguous" },
            created_at: now,
          });
          fullHeld++;
        }
      } catch (err) {
        if (err instanceof WalletError && (err.code === "terminal" || err.code === "conflict"))
          continue;
        throw err;
      }
    }
    return { released, fullHeld };
  });
}

export type RefundResult = { ledgerEntryId: string; alreadyRefunded: boolean };

/**
 * Append a wallet credit (ledger kind 'refund') referencing the original
 * settle debit, 1..original amount, one refund per original (unique index on
 * ledger_entries.original_ledger_entry_id WHERE kind='refund'). A repeat call
 * with the same amount returns the existing refund; a different amount is a
 * typed conflict. Note: refund_operations requires a legacy reservations row
 * and is intentionally NOT used for canonical billing.
 */
export async function refundCharge(
  db: Db | Tx,
  args: {
    originalLedgerEntryId: string;
    amount: number;
    actorUserId: string;
    reason: string;
    now: number;
  },
): Promise<RefundResult> {
  const amount = requirePositiveSafeInteger("amount", args.amount);
  return runInImmediate(db, async (tx) => {
    const existingRows = await tx
      .select({ id: ledgerEntries.id, amount: ledgerEntries.amount })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.original_ledger_entry_id, args.originalLedgerEntryId),
          eq(ledgerEntries.kind, "refund"),
        ),
      );
    const existing = existingRows[0];
    if (existing) {
      if (existing.amount !== amount) {
        throw new WalletError(
          "conflict",
          `refund for ${args.originalLedgerEntryId} already exists with amount ${existing.amount}, requested ${amount}`,
        );
      }
      return { ledgerEntryId: existing.id, alreadyRefunded: true };
    }
    const originalRows = await tx
      .select({
        id: ledgerEntries.id,
        wallet_id: ledgerEntries.wallet_id,
        amount: ledgerEntries.amount,
        direction: ledgerEntries.direction,
        kind: ledgerEntries.kind,
      })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.id, args.originalLedgerEntryId));
    const original = originalRows[0];
    if (!original)
      throw new WalletError(
        "not_found",
        `original ledger entry ${args.originalLedgerEntryId} not found`,
      );
    if (original.kind !== "settle" || original.direction !== "debit") {
      throw new WalletError(
        "invalid",
        `ledger entry ${args.originalLedgerEntryId} is not a settle debit`,
      );
    }
    if (amount > original.amount) {
      throw new WalletError(
        "conflict",
        `refund amount ${amount} exceeds original debit ${original.amount}`,
      );
    }
    await lockWallet(tx, original.wallet_id);
    const walletRows = await tx
      .select({ balance: wallets.balance, version: wallets.version })
      .from(wallets)
      .where(eq(wallets.id, original.wallet_id));
    const wallet = walletRows[0];
    if (!wallet) {
      throw new WalletError("not_found", `wallet ${original.wallet_id} not found`);
    }
    const balanceAfter = wallet.balance + amount;
    const casWallet = await tx
      .update(wallets)
      .set({ balance: balanceAfter, version: sql`${wallets.version} + 1` })
      .where(
        and(
          eq(wallets.id, original.wallet_id),
          eq(wallets.balance, wallet.balance),
          eq(wallets.version, wallet.version),
        ),
      )
      .returning({ id: wallets.id });
    if (casWallet.length !== 1) {
      throw new WalletError(
        "conflict",
        `wallet ${original.wallet_id} concurrent modification during refund`,
      );
    }
    const ledgerEntryId = crypto.randomUUID();
    await tx.insert(ledgerEntries).values({
      id: ledgerEntryId,
      wallet_id: original.wallet_id,
      direction: "credit",
      amount,
      kind: "refund",
      original_ledger_entry_id: args.originalLedgerEntryId,
      balance_after: balanceAfter,
      memo: args.reason,
      created_at: args.now,
    });
    await tx.insert(auditLog).values({
      id: crypto.randomUUID(),
      actor_user_id: args.actorUserId,
      action: "billing.refund",
      target: args.originalLedgerEntryId,
      detail: { amount, reason: args.reason },
      created_at: args.now,
    });
    return { ledgerEntryId, alreadyRefunded: false };
  });
}
export { createReservation, releaseHold } from "./reservation";
