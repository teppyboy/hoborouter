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
