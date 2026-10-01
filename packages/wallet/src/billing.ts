// Task 3: canonical billing service over the canonical catalog tables.
// Pure DB, no HTTP, no provider calls. One BEGIN IMMEDIATE transaction per
// mutation via runInImmediate. Money is integer VND; prices are immutable
// model_prices rows; fx/markup are snapshotted on billing_reservations at
// reserve time and reused verbatim at settle time.
import type { Database } from "bun:sqlite";
import { WalletError, requirePositiveSafeInteger, runInImmediate } from "./wallet";
import { calculateCharge, maxStoredMoney, type PriceSnapshot, type UsageTokens } from "./money";

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
  const { chargedVnd } = calculateCharge(
    {
      inputTokens: BigInt(maxInput),
      cachedInputTokens: 0n,
      outputTokens: BigInt(maxOutput),
      reasoningTokens: 0n,
    },
    snapshot,
  );
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
  endpoint: "/v1/chat/completions" | "/v1/responses";
  mode: "stream" | "non-stream";
  fxRate: number;
  capVnd: number;
  now: number;
};

/**
 * One IMMEDIATE txn: insert requests(status 'pending', dispatch_state
 * 'reserved', model_binding_id NULL) + billing_reservations(status 'held',
 * fx from args, markup from the immutable price row) + wallet reserved += cap
 * with an available-balance CAS. Insufficient balance -> typed
 * WalletError("insufficient"), nothing written.
 */
export function reserveRequest(
  db: Database,
  args: ReserveRequestArgs,
): { requestId: string; reservationId: string } {
  const capVnd = requirePositiveSafeInteger("capVnd", args.capVnd);
  const fxRate = requirePositiveSafeInteger("fxRate", args.fxRate);
  if (typeof args.requestId !== "string" || args.requestId === "") {
    throw new WalletError("invalid", "requestId must be a non-empty string");
  }
  return runInImmediate(db, () => {
    const key = db
      .prepare("SELECT workspace_id, status FROM api_keys WHERE id = ?")
      .get(args.apiKeyId) as { workspace_id: string; status: string } | undefined;
    if (!key || key.workspace_id !== args.workspaceId || key.status === "revoked") {
      throw new WalletError(
        "ownership",
        `api key ${args.apiKeyId} not usable for workspace ${args.workspaceId}`,
      );
    }
    const wallet = db
      .prepare("SELECT id FROM wallets WHERE workspace_id = ?")
      .get(args.workspaceId) as { id: string } | undefined;
    if (!wallet)
      throw new WalletError("not_found", `wallet not found for workspace ${args.workspaceId}`);
    const model = db
      .prepare("SELECT id FROM models WHERE id = ? AND enabled = 1 AND published = 1")
      .get(args.modelId);
    if (!model) throw new WalletError("ownership", `model ${args.modelId} not enabled+published`);
    const mapping = db
      .prepare("SELECT model_id FROM provider_model_mappings WHERE id = ? AND enabled = 1")
      .get(args.mappingId) as { model_id: string } | undefined;
    if (!mapping || mapping.model_id !== args.modelId) {
      throw new WalletError(
        "ownership",
        `mapping ${args.mappingId} not enabled for model ${args.modelId}`,
      );
    }
    const price = db
      .prepare(
        "SELECT markup_ppm FROM model_prices WHERE id = ? AND model_id = ? AND effective_at <= ? AND retired_at IS NULL",
      )
      .get(args.modelPriceId, args.modelId, args.now) as { markup_ppm: number } | undefined;
    if (!price) {
      throw new WalletError(
        "ownership",
        `price ${args.modelPriceId} not current for model ${args.modelId}`,
      );
    }
    if (db.prepare("SELECT 1 FROM requests WHERE id = ?").get(args.requestId)) {
      throw new WalletError("conflict", `request id ${args.requestId} already exists`);
    }

    db.prepare(
      "INSERT INTO requests (id, workspace_id, api_key_id, model_binding_id, model_id, provider_model_mapping_id, endpoint, mode, status, dispatch_state, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'pending', 'reserved', ?)",
    ).run(
      args.requestId,
      args.workspaceId,
      args.apiKeyId,
      args.modelId,
      args.mappingId,
      args.endpoint,
      args.mode,
      args.now,
    );

    const reservationId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO billing_reservations (id, wallet_id, request_id, api_key_id, model_id, model_price_id, usd_vnd_exchange_rate, markup_ppm, cap_vnd, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'held', ?)",
    ).run(
      reservationId,
      wallet.id,
      args.requestId,
      args.apiKeyId,
      args.modelId,
      args.modelPriceId,
      fxRate,
      price.markup_ppm,
      capVnd,
      args.now,
    );

    const updated = db
      .prepare(
        "UPDATE wallets SET reserved = reserved + ?, version = version + 1 WHERE id = ? AND balance - reserved >= ?",
      )
      .run(capVnd, wallet.id, capVnd);
    if (updated.changes !== 1) {
      throw new WalletError("insufficient", "insufficient: available balance below cap");
    }
    return { requestId: args.requestId, reservationId };
  });
}

/**
 * CAS reserved->dispatching + dispatched_at. Must COMMIT before any network
 * I/O (caller contract). Any other prior state -> typed error.
 */
export function markDispatching(db: Database, requestId: string, now: number): void {
  runInImmediate(db, () => {
    const updated = db
      .prepare(
        "UPDATE requests SET dispatch_state = 'dispatching', dispatched_at = ? WHERE id = ? AND dispatch_state = 'reserved'",
      )
      .run(now, requestId);
    if (updated.changes !== 1) {
      const row = db.prepare("SELECT dispatch_state FROM requests WHERE id = ?").get(requestId) as
        | { dispatch_state: string }
        | undefined;
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
export function releaseRequest(db: Database, requestId: string, now: number): void {
  runInImmediate(db, () => {
    const row = db
      .prepare(
        `SELECT rq.dispatch_state, br.id AS br_id, br.status AS br_status, br.cap_vnd, br.wallet_id
         FROM requests rq JOIN billing_reservations br ON br.request_id = rq.id WHERE rq.id = ?`,
      )
      .get(requestId) as
      | {
          dispatch_state: string;
          br_id: string;
          br_status: string;
          cap_vnd: number;
          wallet_id: string;
        }
      | undefined;
    if (!row) throw new WalletError("not_found", `request ${requestId} not found`);
    if (row.dispatch_state === "terminal" && row.br_status === "released") return; // idempotent
    if (row.dispatch_state !== "reserved") {
      throw new WalletError(
        "terminal",
        `request ${requestId} in state ${row.dispatch_state}; release only allowed pre-dispatch ('reserved')`,
      );
    }
    const casRes = db
      .prepare(
        "UPDATE billing_reservations SET status = 'released', resolved_at = ? WHERE id = ? AND status = 'held'",
      )
      .run(now, row.br_id);
    if (casRes.changes !== 1) {
      throw new WalletError("conflict", `billing reservation ${row.br_id} not held`);
    }
    const casReq = db
      .prepare(
        "UPDATE requests SET dispatch_state = 'terminal', status = 'unknown' WHERE id = ? AND dispatch_state = 'reserved'",
      )
      .run(requestId);
    if (casReq.changes !== 1) {
      throw new WalletError("conflict", `request ${requestId} dispatch state changed concurrently`);
    }
    const casWallet = db
      .prepare(
        "UPDATE wallets SET reserved = reserved - ?, version = version + 1 WHERE id = ? AND reserved >= ?",
      )
      .run(row.cap_vnd, row.wallet_id, row.cap_vnd);
    if (casWallet.changes !== 1) {
      throw new WalletError(
        "conflict",
        `wallet ${row.wallet_id} reserved invariant violated on release`,
      );
    }
    // No ledger row: releasing a hold is not a cash movement.
  });
}

export type SettleOutcome =
  | {
      kind: "usage";
      usage: UsageTokens;
      upstreamModel: string;
      provider: string;
      publicModel: string;
      latencyMs?: number;
      ttftMs?: number;
      httpStatus?: number;
      rawPayload?: string;
    }
  | {
      kind: "full_hold";
      reason: "client_abort" | "upstream_error" | "unknown";
      metadata?: unknown;
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
 * provider_model_mapping). full_hold debits the whole cap. One IMMEDIATE txn;
 * a repeat call returns the stored result and never double-debits.
 */
export function settleRequest(
  db: Database,
  requestId: string,
  outcome: SettleOutcome,
  now: number,
): SettleResult {
  return runInImmediate(db, () => {
    const row = db
      .prepare(
        `SELECT br.id AS br_id, br.status AS br_status, br.wallet_id, br.cap_vnd,
                br.usd_vnd_exchange_rate, br.markup_ppm, br.model_price_id, br.api_key_id,
                br.model_id, rq.workspace_id, rq.dispatch_state,
                rq.provider_model_mapping_id
         FROM billing_reservations br JOIN requests rq ON rq.id = br.request_id
         WHERE br.request_id = ?`,
      )
      .get(requestId) as
      | {
          br_id: string;
          br_status: string;
          wallet_id: string;
          cap_vnd: number;
          usd_vnd_exchange_rate: number;
          markup_ppm: number;
          model_price_id: string;
          api_key_id: string | null;
          model_id: string;
          workspace_id: string;
          dispatch_state: string;
          provider_model_mapping_id: string | null;
        }
      | undefined;
    if (!row)
      throw new WalletError("not_found", `billing reservation for request ${requestId} not found`);

    // Idempotency: a stored settlement is the single source of truth.
    const existing = db
      .prepare("SELECT id, charged_vnd FROM settlements WHERE billing_reservation_id = ?")
      .get(row.br_id) as { id: string; charged_vnd: number | null } | undefined;
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

    const price = db
      .prepare(
        "SELECT input_usd_micro_per_1m AS inputUsdMicroPer1m, output_usd_micro_per_1m AS outputUsdMicroPer1m, cached_input_usd_micro_per_1m AS cachedInputUsdMicroPer1m, reasoning_usd_micro_per_1m AS reasoningUsdMicroPer1m FROM model_prices WHERE id = ?",
      )
      .get(row.model_price_id) as UnitPrice | undefined;
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
      db.prepare(
        `INSERT INTO usage_logs (id, idempotency_key, request_id, api_key_id, workspace_id, provider, public_model, upstream_model,
          input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, status, failure, latency_ms, ttft_ms,
          upstream_cost_usd_micro, usd_vnd_exchange_rate, markup_ppm, charged_vnd, raw_payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        usageLogId,
        requestId,
        requestId,
        row.api_key_id,
        row.workspace_id,
        outcome.provider,
        outcome.publicModel,
        outcome.upstreamModel,
        outcome.usage.inputTokens,
        outcome.usage.outputTokens,
        outcome.usage.cachedInputTokens,
        outcome.usage.reasoningTokens,
        outcome.latencyMs ?? null,
        outcome.ttftMs ?? null,
        upstreamCostUsdMicro, // P1: real USD micro cost, NOT the VND charge
        row.usd_vnd_exchange_rate,
        row.markup_ppm,
        charge,
        outcome.rawPayload ?? null,
        now,
      );
    } else {
      db.prepare(
        `INSERT INTO usage_logs (id, idempotency_key, request_id, api_key_id, workspace_id, provider, public_model, upstream_model,
          input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, status, failure, latency_ms, ttft_ms,
          upstream_cost_usd_micro, usd_vnd_exchange_rate, markup_ppm, charged_vnd, raw_payload, created_at)
         VALUES (?, ?, ?, ?, ?, '', '', '', 0, 0, 0, 0, 'full_hold', ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      ).run(
        usageLogId,
        requestId,
        requestId,
        row.api_key_id,
        row.workspace_id,
        reason,
        outcome.metadata === undefined ? null : JSON.stringify(outcome.metadata),
        now,
      );
    }

    const settlementId = crypto.randomUUID();
    const usage = outcome.kind === "usage" ? outcome.usage : null;
    const chargedInput = usage ? Number(usage.inputTokens) : 0;
    const chargedOutput = usage ? Number(usage.outputTokens) : 0;
    db.prepare(
      "INSERT INTO settlements (id, reservation_id, billing_reservation_id, charged_input, charged_output, charged_total, settled_at, charged_vnd, usage_log_id, reason, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      settlementId,
      row.br_id,
      chargedInput,
      chargedOutput,
      chargedInput + chargedOutput,
      now,
      charge,
      usageLogId,
      reason,
      now,
    );

    if (resStatus === "settled_full_hold" && outcome.kind === "usage") {
      // Above-cap usage: audit then fail closed on the mapping that allowed it.
      db.prepare(
        "INSERT INTO audit_log (id, workspace_id, action, target, detail, created_at) VALUES (?, ?, 'billing.cap_exceeded', ?, ?, ?)",
      ).run(
        crypto.randomUUID(),
        row.workspace_id,
        row.br_id,
        JSON.stringify({ requestId, capVnd: row.cap_vnd }),
        now,
      );
      if (row.provider_model_mapping_id) {
        db.prepare(
          "UPDATE provider_model_mappings SET enabled = 0, updated_at = ? WHERE id = ?",
        ).run(now, row.provider_model_mapping_id);
        db.prepare(
          "INSERT INTO audit_log (id, workspace_id, action, target, detail, created_at) VALUES (?, ?, 'billing.mapping_disabled', ?, ?, ?)",
        ).run(
          crypto.randomUUID(),
          row.workspace_id,
          row.provider_model_mapping_id,
          JSON.stringify({ requestId, reason: "cap_exceeded" }),
          now,
        );
      }
    }

    db.prepare(
      "UPDATE billing_reservations SET status = ?, resolved_at = ? WHERE id = ? AND status = 'held'",
    ).run(resStatus, now, row.br_id);

    let balanceAfter = 0;
    if (charge > 0) {
      const wallet = db
        .prepare("SELECT balance, reserved, version FROM wallets WHERE id = ?")
        .get(row.wallet_id) as { balance: number; reserved: number; version: number };
      balanceAfter = wallet.balance - charge;
      const casWallet = db
        .prepare(
          "UPDATE wallets SET balance = ?, reserved = ?, version = version + 1 WHERE id = ? AND balance = ? AND reserved = ? AND version = ?",
        )
        .run(
          balanceAfter,
          wallet.reserved - row.cap_vnd,
          row.wallet_id,
          wallet.balance,
          wallet.reserved,
          wallet.version,
        );
      if (casWallet.changes !== 1) {
        throw new WalletError(
          "conflict",
          `wallet ${row.wallet_id} concurrent modification during settle`,
        );
      }
      db.prepare(
        "INSERT INTO ledger_entries (id, wallet_id, direction, billing_reservation_id, amount, kind, balance_after, memo, created_at) VALUES (?, ?, 'debit', ?, ?, 'settle', ?, NULL, ?)",
      ).run(crypto.randomUUID(), row.wallet_id, row.br_id, charge, balanceAfter, now);
    } else {
      // Zero charge: amount > 0 CHECK forbids a ledger row; still clear the hold.
      const casZero = db
        .prepare(
          "UPDATE wallets SET reserved = reserved - ?, version = version + 1 WHERE id = ? AND reserved >= ?",
        )
        .run(row.cap_vnd, row.wallet_id, row.cap_vnd);
      if (casZero.changes !== 1) {
        throw new WalletError(
          "conflict",
          `wallet ${row.wallet_id} concurrent modification during zero-charge settle`,
        );
      }
    }

    if (outcome.kind === "usage") {
      db.prepare(
        "UPDATE requests SET dispatch_state = 'terminal', status = 'ok', http_status = ?, ttft_ms = ?, duration_ms = ? WHERE id = ?",
      ).run(
        outcome.httpStatus ?? null,
        outcome.ttftMs ?? null,
        outcome.latencyMs ?? null,
        requestId,
      );
    } else {
      db.prepare("UPDATE requests SET dispatch_state = 'terminal', status = ? WHERE id = ?").run(
        requestStatus,
        requestId,
      );
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
export function recoverPending(db: Database, now: number): RecoverCounts {
  return runInImmediate(db, () => {
    const rows = db
      .prepare("SELECT id, dispatch_state FROM requests WHERE dispatch_state != 'terminal'")
      .all() as { id: string; dispatch_state: string }[];
    let released = 0;
    let fullHeld = 0;
    for (const row of rows) {
      try {
        if (row.dispatch_state === "reserved") {
          releaseRequest(db, row.id, now);
          released++;
        } else {
          settleRequest(db, row.id, { kind: "full_hold", reason: "unknown" }, now);
          db.prepare(
            "INSERT INTO audit_log (id, action, target, detail, created_at) VALUES (?, 'billing.recovered_ambiguous', ?, ?, ?)",
          ).run(
            crypto.randomUUID(),
            row.id,
            JSON.stringify({ reason: "recovered_ambiguous" }),
            now,
          );
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
export function refundCharge(
  db: Database,
  args: {
    originalLedgerEntryId: string;
    amount: number;
    actorUserId: string;
    reason: string;
    now: number;
  },
): RefundResult {
  const amount = requirePositiveSafeInteger("amount", args.amount);
  return runInImmediate(db, () => {
    const existing = db
      .prepare(
        "SELECT id, amount FROM ledger_entries WHERE original_ledger_entry_id = ? AND kind = 'refund'",
      )
      .get(args.originalLedgerEntryId) as { id: string; amount: number } | undefined;
    if (existing) {
      if (existing.amount !== amount) {
        throw new WalletError(
          "conflict",
          `refund for ${args.originalLedgerEntryId} already exists with amount ${existing.amount}, requested ${amount}`,
        );
      }
      return { ledgerEntryId: existing.id, alreadyRefunded: true };
    }
    const original = db
      .prepare("SELECT wallet_id, amount, direction, kind FROM ledger_entries WHERE id = ?")
      .get(args.originalLedgerEntryId) as
      | { wallet_id: string; amount: number; direction: string; kind: string }
      | undefined;
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
    const wallet = db
      .prepare("SELECT balance, version FROM wallets WHERE id = ?")
      .get(original.wallet_id) as { balance: number; version: number };
    const balanceAfter = wallet.balance + amount;
    const casWallet = db
      .prepare(
        "UPDATE wallets SET balance = ?, version = version + 1 WHERE id = ? AND balance = ? AND version = ?",
      )
      .run(balanceAfter, original.wallet_id, wallet.balance, wallet.version);
    if (casWallet.changes !== 1) {
      throw new WalletError(
        "conflict",
        `wallet ${original.wallet_id} concurrent modification during refund`,
      );
    }
    const ledgerEntryId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO ledger_entries (id, wallet_id, direction, amount, kind, original_ledger_entry_id, balance_after, memo, created_at) VALUES (?, ?, 'credit', ?, 'refund', ?, ?, ?, ?)",
    ).run(
      ledgerEntryId,
      original.wallet_id,
      amount,
      args.originalLedgerEntryId,
      balanceAfter,
      args.reason,
      args.now,
    );
    db.prepare(
      "INSERT INTO audit_log (id, actor_user_id, action, target, detail, created_at) VALUES (?, ?, 'billing.refund', ?, ?, ?)",
    ).run(
      crypto.randomUUID(),
      args.actorUserId,
      args.originalLedgerEntryId,
      JSON.stringify({ amount, reason: args.reason }),
      args.now,
    );
    return { ledgerEntryId, alreadyRefunded: false };
  });
}
