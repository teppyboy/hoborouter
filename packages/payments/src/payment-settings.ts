// Shared payment-control settings rules (owner decisions):
//   - payment_timeout_minutes: default 30, bounds 1..1440
//   - payment_max_amount_vnd: default 100000000 (cap applied at creation)
//   - payment_usd_vnd_rate: canonical payment FX rate, default 26000 VND/USD
// Reads of each setting go through these parsers so the admin settings API,
// payment creation, the expiry sweep, and the public config cannot drift.
// Invalid stored values fail closed to the default (same rule as
// isFirstTopupBonusEnabled's "missing = default" contract).

export const PAYMENT_TIMEOUT_MINUTES_KEY = "payment_timeout_minutes";
export const PAYMENT_MAX_AMOUNT_VND_KEY = "payment_max_amount_vnd";
export const PAYMENT_USD_VND_RATE_KEY = "payment_usd_vnd_rate";

export const DEFAULT_PAYMENT_TIMEOUT_MINUTES = 30;
export const MIN_PAYMENT_TIMEOUT_MINUTES = 1;
export const MAX_PAYMENT_TIMEOUT_MINUTES = 1440;
export const DEFAULT_PAYMENT_MAX_AMOUNT_VND = 100_000_000;
export const DEFAULT_PAYMENT_USD_VND_RATE = 26_000;

function parsePositiveInt(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Timeout in minutes; stored value must be an integer within 1..1440, else default. */
export function parsePaymentTimeoutMinutes(raw: string | null | undefined): number {
  const n = parsePositiveInt(raw);
  if (n === null || n < MIN_PAYMENT_TIMEOUT_MINUTES || n > MAX_PAYMENT_TIMEOUT_MINUTES) {
    return DEFAULT_PAYMENT_TIMEOUT_MINUTES;
  }
  return n;
}

/** Maximum single payment amount in VND; must be a positive safe integer, else default. */
export function parsePaymentMaxAmountVnd(raw: string | null | undefined): number {
  return parsePositiveInt(raw) ?? DEFAULT_PAYMENT_MAX_AMOUNT_VND;
}

/** Canonical payment FX rate in VND per USD; must be a positive safe integer, else default. */
export function parsePaymentUsdVndRate(raw: string | null | undefined): number {
  return parsePositiveInt(raw) ?? DEFAULT_PAYMENT_USD_VND_RATE;
}

// USD input validation (owner decision): optional string usd_amount on plain
// top-ups only — digits with at most 2 decimals, no sign, no separators.
export const USD_AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;

/** Parse a USD amount string into exact cents (BigInt). Null when invalid. */
export function parseUsdCents(text: string): bigint | null {
  const trimmed = text.trim();
  if (!USD_AMOUNT_PATTERN.test(trimmed)) return null;
  // Bound the integer part so a hostile long string cannot create an
  // unbounded BigInt multiplication (12 digits ~= 10 billion USD).
  const dot = trimmed.indexOf(".");
  const intPart = dot === -1 ? trimmed : trimmed.slice(0, dot);
  if (intPart.length > 12) return null;
  const fracPart = dot === -1 ? "0" : trimmed.slice(dot + 1).padEnd(2, "0");
  return BigInt(intPart) * 100n + BigInt(fracPart);
}

/**
 * Exact BigInt cents-to-VND ceiling: ceil(cents * rate / 100). No float math.
 * Returns null when the result is not a positive safe integer VND amount.
 */
export function usdCentsToVndCeiling(cents: bigint, rateVndPerUsd: number): number | null {
  if (cents <= 0n) return null;
  if (!Number.isSafeInteger(rateVndPerUsd) || rateVndPerUsd <= 0) return null;
  const total = cents * BigInt(rateVndPerUsd);
  const vnd = (total + 99n) / 100n; // ceiling for positive BigInt values
  if (vnd > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(vnd);
}
