// Payment-control settings + USD conversion (owner decisions): timeout
// default 30 bounded 1..1440, cap default 100000000 VND, FX default 26000,
// exact BigInt cents-to-VND ceiling with no float money math.
import { describe, test, expect } from "bun:test";
import {
  parsePaymentTimeoutMinutes,
  parsePaymentMaxAmountVnd,
  parsePaymentUsdVndRate,
  parseUsdCents,
  usdCentsToVndCeiling,
  USD_AMOUNT_PATTERN,
  DEFAULT_PAYMENT_TIMEOUT_MINUTES,
  DEFAULT_PAYMENT_MAX_AMOUNT_VND,
  DEFAULT_PAYMENT_USD_VND_RATE,
} from "../src/payment-settings";

describe("payment settings parsers", () => {
  test("missing values fall back to defaults", () => {
    expect(parsePaymentTimeoutMinutes(null)).toBe(DEFAULT_PAYMENT_TIMEOUT_MINUTES);
    expect(parsePaymentTimeoutMinutes(undefined)).toBe(DEFAULT_PAYMENT_TIMEOUT_MINUTES);
    expect(parsePaymentTimeoutMinutes("")).toBe(DEFAULT_PAYMENT_TIMEOUT_MINUTES);
    expect(parsePaymentMaxAmountVnd(null)).toBe(DEFAULT_PAYMENT_MAX_AMOUNT_VND);
    expect(parsePaymentUsdVndRate("")).toBe(DEFAULT_PAYMENT_USD_VND_RATE);
    expect(DEFAULT_PAYMENT_TIMEOUT_MINUTES).toBe(30);
    expect(DEFAULT_PAYMENT_MAX_AMOUNT_VND).toBe(100_000_000);
    expect(DEFAULT_PAYMENT_USD_VND_RATE).toBe(26_000);
  });

  test("timeout bounds are 1..1440; out-of-range or invalid falls back to default", () => {
    expect(parsePaymentTimeoutMinutes("1")).toBe(1);
    expect(parsePaymentTimeoutMinutes("1440")).toBe(1440);
    expect(parsePaymentTimeoutMinutes("60")).toBe(60);
    expect(parsePaymentTimeoutMinutes("0")).toBe(DEFAULT_PAYMENT_TIMEOUT_MINUTES);
    expect(parsePaymentTimeoutMinutes("1441")).toBe(DEFAULT_PAYMENT_TIMEOUT_MINUTES);
    expect(parsePaymentTimeoutMinutes("30.5")).toBe(DEFAULT_PAYMENT_TIMEOUT_MINUTES);
    expect(parsePaymentTimeoutMinutes("abc")).toBe(DEFAULT_PAYMENT_TIMEOUT_MINUTES);
  });

  test("cap and FX rate parse positive safe integers; invalid falls back", () => {
    expect(parsePaymentMaxAmountVnd("500000")).toBe(500000);
    expect(parsePaymentMaxAmountVnd("-1")).toBe(DEFAULT_PAYMENT_MAX_AMOUNT_VND);
    expect(parsePaymentMaxAmountVnd("0")).toBe(DEFAULT_PAYMENT_MAX_AMOUNT_VND);
    expect(parsePaymentUsdVndRate("27000")).toBe(27000);
    expect(parsePaymentUsdVndRate("NaN")).toBe(DEFAULT_PAYMENT_USD_VND_RATE);
  });
});

describe("USD amount parsing + ceiling conversion", () => {
  test("regex accepts digits with at most 2 decimals", () => {
    expect(USD_AMOUNT_PATTERN.test("5")).toBe(true);
    expect(USD_AMOUNT_PATTERN.test("12.3")).toBe(true);
    expect(USD_AMOUNT_PATTERN.test("12.34")).toBe(true);
    expect(USD_AMOUNT_PATTERN.test("0.01")).toBe(true);
    expect(USD_AMOUNT_PATTERN.test("12.345")).toBe(false);
    expect(USD_AMOUNT_PATTERN.test(".5")).toBe(false);
    expect(USD_AMOUNT_PATTERN.test("1,000")).toBe(false);
    expect(USD_AMOUNT_PATTERN.test("-3")).toBe(false);
    expect(USD_AMOUNT_PATTERN.test("")).toBe(false);
  });

  test("parseUsdCents is exact BigInt cents", () => {
    expect(parseUsdCents("10.99")).toBe(1099n);
    expect(parseUsdCents("10.9")).toBe(1090n);
    expect(parseUsdCents("10")).toBe(1000n);
    expect(parseUsdCents("0.01")).toBe(1n);
    expect(parseUsdCents("abc")).toBeNull();
    expect(parseUsdCents("1.234")).toBeNull();
    // absurdly long input is rejected, not multiplied
    expect(parseUsdCents("123456789012345")).toBeNull();
  });

  test("ceiling: 1 cent at 26000 => 260 VND (exact, no float)", () => {
    expect(usdCentsToVndCeiling(1n, 26000)).toBe(260);
  });

  test("ceiling rounds up: 3 cents at 26000 => 780 (exact) but 26001/100 case rounds up", () => {
    // 1 cent at 26001 -> 260.01 VND -> ceiling 261
    expect(usdCentsToVndCeiling(1n, 26001)).toBe(261);
    // 123456789 cents * 26000 / 100 = 32098765140 exactly
    expect(usdCentsToVndCeiling(123456789n, 26000)).toBe(32_098_765_140);
  });

  test("invalid conversions return null (zero input, bad rate, overflow)", () => {
    expect(usdCentsToVndCeiling(0n, 26000)).toBeNull();
    expect(usdCentsToVndCeiling(1n, 0)).toBeNull();
    expect(usdCentsToVndCeiling(1n, -5)).toBeNull();
    expect(usdCentsToVndCeiling(1n, Number.NaN)).toBeNull();
    // beyond MAX_SAFE_INTEGER VND (1e14 cents at 26000 => 2.6e16 VND)
    expect(usdCentsToVndCeiling(100_000_000_000_000n, 26000)).toBeNull();
  });
});
