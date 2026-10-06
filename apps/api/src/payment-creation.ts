// Shared payment-creation helpers (owner decisions): timeout deadline +
// max-amount cap + USD top-up conversion. Settings are read INSIDE the insert
// transaction so expires_at and the cap reflect one consistent read, and
// expires_at is a creation-time snapshot that never changes afterwards.
import { inArray } from "drizzle-orm";
import type { Db, Tx } from "@hoborouter/db";
import { instanceSettings } from "@hoborouter/db";
import {
  PAYMENT_TIMEOUT_MINUTES_KEY,
  PAYMENT_MAX_AMOUNT_VND_KEY,
  PAYMENT_USD_VND_RATE_KEY,
  parsePaymentTimeoutMinutes,
  parsePaymentMaxAmountVnd,
  parsePaymentUsdVndRate,
  parseUsdCents,
  usdCentsToVndCeiling,
} from "@hoborouter/payments";

export interface PaymentLimits {
  timeoutMinutes: number;
  maxAmountVnd: number;
  usdVndRate: number;
}

const LIMIT_KEYS = [
  PAYMENT_TIMEOUT_MINUTES_KEY,
  PAYMENT_MAX_AMOUNT_VND_KEY,
  PAYMENT_USD_VND_RATE_KEY,
];

/** Read the three payment-control settings; invalid/missing values fall back to defaults. */
export async function readPaymentLimits(db: Db | Tx): Promise<PaymentLimits> {
  const rows = await db
    .select({ key: instanceSettings.key, value: instanceSettings.value })
    .from(instanceSettings)
    .where(inArray(instanceSettings.key, LIMIT_KEYS));
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  return {
    timeoutMinutes: parsePaymentTimeoutMinutes(byKey.get(PAYMENT_TIMEOUT_MINUTES_KEY)),
    maxAmountVnd: parsePaymentMaxAmountVnd(byKey.get(PAYMENT_MAX_AMOUNT_VND_KEY)),
    usdVndRate: parsePaymentUsdVndRate(byKey.get(PAYMENT_USD_VND_RATE_KEY)),
  };
}

/** Deadline snapshot at creation: now + timeout, integer epoch ms. */
export function paymentDeadlineMs(nowMs: number, timeoutMinutes: number): number {
  return nowMs + timeoutMinutes * 60_000;
}

/** Cap check for every creation path (top-up, bundle, plan). */
export function withinPaymentCap(amountVnd: number, maxAmountVnd: number): boolean {
  return amountVnd <= maxAmountVnd;
}

export type UsdTopupResult =
  | {
      ok: true;
      amountVnd: number;
      inputCurrency: string;
      inputAmountText: string;
      fxRateVndPerUsd: number | null;
    }
  | { ok: false; reason: "invalid" | "over_cap"; message: string };

/**
 * Resolve the amount + creation snapshot for a plain top-up:
 *  - usdAmountText present: exact BigInt cents-to-VND ceiling at the current
 *    payment FX rate (no float money math); the input text + rate are
 *    snapshotted verbatim.
 *  - absent: amount stays the integer VND input.
 * Both branches enforce the max-amount cap.
 */
export function resolveTopupAmount(
  amountVnd: number | null,
  usdAmountText: string | null,
  limits: PaymentLimits,
): UsdTopupResult {
  if (usdAmountText !== null) {
    const cents = parseUsdCents(usdAmountText);
    const vnd = cents === null ? null : usdCentsToVndCeiling(cents, limits.usdVndRate);
    if (vnd === null) {
      return {
        ok: false,
        reason: "invalid",
        message: "usd_amount must be a decimal amount with at most 2 decimals",
      };
    }
    if (!withinPaymentCap(vnd, limits.maxAmountVnd)) {
      return {
        ok: false,
        reason: "over_cap",
        message: "payment amount exceeds the configured maximum",
      };
    }
    return {
      ok: true,
      amountVnd: vnd,
      inputCurrency: "USD",
      inputAmountText: usdAmountText.trim(),
      fxRateVndPerUsd: limits.usdVndRate,
    };
  }
  if (amountVnd === null || !Number.isSafeInteger(amountVnd) || amountVnd <= 0) {
    return {
      ok: false,
      reason: "invalid",
      message: "amount must be a positive integer VND amount",
    };
  }
  if (!withinPaymentCap(amountVnd, limits.maxAmountVnd)) {
    return {
      ok: false,
      reason: "over_cap",
      message: "payment amount exceeds the configured maximum",
    };
  }
  return {
    ok: true,
    amountVnd,
    inputCurrency: "VND",
    inputAmountText: String(amountVnd),
    fxRateVndPerUsd: null,
  };
}

// Percent-voucher math (owner decision): the discount is FLOORED — the exact
// product original * bp is computed in BigInt and floor-divided by 10000, so
// the discount never exceeds the proportional amount by even one dong and
// every value stays an integer end to end (no float money math). The cap is a
// plain integer min(); percent_bp is bounded 1..9999 at authoring, so the
// final due can never reach zero.
export function computePercentDiscountVnd(
  originalVnd: number,
  percentBp: number,
  maxDiscountVnd: number,
): { discountVnd: number; finalDueVnd: number } {
  let discountVnd = Number((BigInt(originalVnd) * BigInt(percentBp)) / 10_000n);
  if (discountVnd > maxDiscountVnd) discountVnd = maxDiscountVnd;
  return { discountVnd, finalDueVnd: originalVnd - discountVnd };
}

/** Creation snapshot columns shared by every payment insert. */
export interface PaymentSnapshot {
  input_currency: string;
  input_amount_text: string;
  fx_rate_vnd_per_usd: number | null;
}

export function snapshotForBundlePrice(priceVnd: number): PaymentSnapshot {
  return {
    input_currency: "VND",
    input_amount_text: String(priceVnd),
    fx_rate_vnd_per_usd: null,
  };
}

// --- percent-voucher checkout apply (TOP-UP purchases only) ---
// Applies an admin-authored percent promo to a plain top-up payment INSIDE the
// caller's insert transaction. Lock order matches /promotions/redeem exactly
// (workspace row → promo row) so a checkout apply can never cycle against a
// concurrent fixed-credit redemption. Fixed-credit promos are redeem-only and
// rejected here (not_percent); the redemption row itself is written only AFTER
// the caller inserts the payment (payment_id FK), via recordPercentRedemption.
import { and, eq } from "drizzle-orm";
import { promoCodes, promoRedemptions, workspaces } from "@hoborouter/db";
import { hashPromoCode } from "./routes/admin-promotions";
import { normalizePromoCode } from "./routes/promotions";

export type PromoApplyResult =
  | {
      ok: true;
      promoId: string;
      /** Percentage in basis points, snapshotted for audit detail. */
      percentBp: number;
      discountVnd: number;
      finalDueVnd: number;
    }
  | {
      ok: false;
      reason:
        | "invalid_code"
        | "not_found"
        | "workspace_suspended"
        | "promo_inactive"
        | "promo_expired"
        | "promo_exhausted"
        | "already_redeemed"
        | "not_percent";
    };

export async function applyPromoToTopup(
  tx: Tx,
  workspaceId: string,
  promoCodeText: string,
  originalVnd: number,
  now: number,
): Promise<PromoApplyResult> {
  const code = normalizePromoCode(promoCodeText);
  if (!code) return { ok: false, reason: "invalid_code" };

  // Same masking + active-workspace gate as redemption: membership is not
  // authorization for money movement, and a concurrent suspension must not
  // slip between the membership check and the discount.
  const wsRows = await tx
    .select({ status: workspaces.status })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .for("update");
  if (!wsRows[0]) return { ok: false, reason: "not_found" };
  if (wsRows[0].status !== "active") return { ok: false, reason: "workspace_suspended" };

  const promoRows = await tx
    .select()
    .from(promoCodes)
    .where(eq(promoCodes.code_hash, hashPromoCode(code)))
    .for("update");
  const promo = promoRows[0];
  if (!promo) return { ok: false, reason: "not_found" };
  if (!promo.active) return { ok: false, reason: "promo_inactive" };
  if (promo.expires_at !== null && promo.expires_at <= now)
    return { ok: false, reason: "promo_expired" };
  if (promo.uses >= promo.max_uses) return { ok: false, reason: "promo_exhausted" };
  if (promo.kind !== "percent" || promo.percent_bp === null || promo.max_discount_vnd === null)
    return { ok: false, reason: "not_percent" };

  // Same once-per-(code, workspace) gate as fixed redemption: applying the
  // voucher CONSUMES it, even if the payment later expires unpaid.
  const prior = await tx
    .select({ id: promoRedemptions.id })
    .from(promoRedemptions)
    .where(
      and(
        eq(promoRedemptions.promo_code_id, promo.id),
        eq(promoRedemptions.workspace_id, workspaceId),
      ),
    )
    .limit(1);
  if (prior.length > 0) return { ok: false, reason: "already_redeemed" };

  const { discountVnd, finalDueVnd } = computePercentDiscountVnd(
    originalVnd,
    promo.percent_bp,
    promo.max_discount_vnd,
  );
  return {
    ok: true,
    promoId: promo.id,
    percentBp: promo.percent_bp,
    discountVnd,
    finalDueVnd,
  };
}

/** Redemption row + uses increment for a percent-applied payment; caller runs both inside the same payment-insert transaction. */
export async function recordPercentRedemption(
  tx: Tx,
  args: { promoId: string; workspaceId: string; paymentId: string; uses: number; now: number },
): Promise<void> {
  await tx.insert(promoRedemptions).values({
    id: crypto.randomUUID(),
    promo_code_id: args.promoId,
    workspace_id: args.workspaceId,
    ledger_entry_id: null,
    payment_id: args.paymentId,
    created_at: args.now,
  });
  // CHECK uses<=max_uses backs this up; the promo row lock held since
  // applyPromoToTopup makes the increment safe against last-slot races.
  await tx
    .update(promoCodes)
    .set({ uses: args.uses + 1 })
    .where(eq(promoCodes.id, args.promoId));
}
