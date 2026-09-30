import { describe, expect, test } from "bun:test";
import { calculateCharge, maxStoredMoney, type PriceSnapshot, type UsageTokens } from "../src";

const prices: PriceSnapshot = {
  inputUsdMicroPer1m: 1_000_000n,
  outputUsdMicroPer1m: 1_000_000n,
  cachedInputUsdMicroPer1m: 1_000_000n,
  reasoningUsdMicroPer1m: 1_000_000n,
  usdVndRate: 26_000n,
  markupPpm: 1_000_000n,
};
const usage: UsageTokens = {
  inputTokens: 1_000_000n,
  outputTokens: 0n,
  cachedInputTokens: 0n,
  reasoningTokens: 0n,
};

const charged = (u: UsageTokens, p = prices) => calculateCharge(u, p);

describe("calculateCharge", () => {
  test("calculates normalized categories and regression prices", () => {
    expect(charged(usage)).toEqual({ upstreamCostUsdMicro: 1_000_000n, chargedVnd: 26_000n });
    expect(
      charged({ ...usage, inputTokens: 500_000n }, { ...prices, markupPpm: 1_200_000n }),
    ).toEqual({
      upstreamCostUsdMicro: 500_000n,
      chargedVnd: 15_600n,
    });
    expect(charged({ ...usage, inputTokens: 1n })).toEqual({
      upstreamCostUsdMicro: 1n,
      chargedVnd: 1n,
    });
  });

  test("does not double-count cached and reasoning categories", () => {
    const p = {
      ...prices,
      inputUsdMicroPer1m: 2n,
      cachedInputUsdMicroPer1m: 10n,
      outputUsdMicroPer1m: 3n,
      reasoningUsdMicroPer1m: 20n,
    };
    expect(
      charged(
        { inputTokens: 10n, cachedInputTokens: 4n, outputTokens: 10n, reasoningTokens: 3n },
        p,
      ),
    ).toEqual({ upstreamCostUsdMicro: 1n, chargedVnd: 1n });
  });

  test("rounds each monetary division upward", () => {
    expect(charged({ ...usage, inputTokens: 1n }, { ...prices, inputUsdMicroPer1m: 1n })).toEqual({
      upstreamCostUsdMicro: 1n,
      chargedVnd: 1n,
    });
    expect(charged({ ...usage, inputTokens: 1_000_001n })).toEqual({
      upstreamCostUsdMicro: 1_000_001n,
      chargedVnd: 26_001n,
    });
  });

  test("accepts zero usage, rates, and markup", () => {
    expect(
      charged(
        { inputTokens: 0n, outputTokens: 0n, cachedInputTokens: 0n, reasoningTokens: 0n },
        {
          inputUsdMicroPer1m: 0n,
          outputUsdMicroPer1m: 0n,
          cachedInputUsdMicroPer1m: 0n,
          reasoningUsdMicroPer1m: 0n,
          usdVndRate: 0n,
          markupPpm: 0n,
        },
      ),
    ).toEqual({ upstreamCostUsdMicro: 0n, chargedVnd: 0n });
  });

  test("rejects every negative field and invalid subsets", () => {
    for (const key of Object.keys(usage) as (keyof UsageTokens)[])
      expect(() => charged({ ...usage, [key]: -1n })).toThrow();
    for (const key of Object.keys(prices) as (keyof PriceSnapshot)[])
      expect(() => charged(usage, { ...prices, [key]: -1n })).toThrow();
    expect(() => charged({ ...usage, inputTokens: 1n, cachedInputTokens: 2n })).toThrow();
    expect(() => charged({ ...usage, outputTokens: 0n, reasoningTokens: 1n })).toThrow();
  });

  test("enforces stored-money limits, supports huge intermediate values, preserves inputs", () => {
    const u = { ...usage, inputTokens: 10n ** 100n };
    const p = { ...prices, inputUsdMicroPer1m: 0n };
    expect(charged(u, p)).toEqual({ upstreamCostUsdMicro: 0n, chargedVnd: 0n });
    expect(
      calculateCharge(
        { ...usage, inputTokens: maxStoredMoney },
        {
          ...prices,
          inputUsdMicroPer1m: 1_000_000n,
          usdVndRate: 1n,
          markupPpm: 1n,
        },
      ),
    ).toEqual({ upstreamCostUsdMicro: maxStoredMoney, chargedVnd: 9_223_373n });
    expect(() =>
      charged(
        { ...usage, inputTokens: maxStoredMoney },
        {
          ...prices,
          inputUsdMicroPer1m: 1_000_000n,
          usdVndRate: 1_000_000_000_000n,
          markupPpm: 1_000_000n,
        },
      ),
    ).toThrow();
    expect(() => charged(usage, { ...prices, usdVndRate: maxStoredMoney + 1n })).toThrow();
    const original = { ...usage };
    charged(usage);
    expect(usage).toEqual(original);
  });

  test("is publicly exported", () => expect(typeof calculateCharge).toBe("function"));
});
