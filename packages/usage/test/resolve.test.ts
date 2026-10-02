import { describe, expect, test } from "bun:test";
import { resolveBillableUsage } from "../src/usage";
import { calculateCharge } from "../../wallet/src/money";

const usage = {
  inputTokens: 100n,
  outputTokens: 50n,
  cachedInputTokens: 20n,
  reasoningTokens: 10n,
};

const complete = { complete: true as const, usage };
const incomplete = { complete: false as const, reason: "missing_usage" };

const equalRates = {
  input: 100n,
  output: 200n,
  cachedInput: 100n, // same as input
  reasoning: 200n, // same as output
};

const differingRates = {
  input: 100n,
  output: 200n,
  cachedInput: 50n,
  reasoning: 150n,
};

describe("resolveBillableUsage", () => {
  test("complete with splits returns usage", () => {
    expect(resolveBillableUsage(complete, differingRates)).toEqual({ billable: true, usage });
  });

  test("incomplete result => not billable with result reason", () => {
    expect(resolveBillableUsage(incomplete, differingRates)).toEqual({
      billable: false,
      reason: "missing_usage",
    });
  });

  test("null split with equal rates => treated as 0", () => {
    const result = {
      complete: true as const,
      usage: { ...usage, cachedInputTokens: null, reasoningTokens: null },
    };
    expect(resolveBillableUsage(result, equalRates)).toEqual({
      billable: true,
      usage: { ...usage, cachedInputTokens: 0n, reasoningTokens: 0n },
      // Equal rates make 0 exact, but the split was still missing — recorded.
      assumed: ["cached_input", "reasoning"],
    });
  });

  // CHANGED (was: null split with differing rates => fail closed
  // 'missing_split_differing_rate'). Missing splits no longer fail a complete
  // response; we assume the higher-charge value instead. cachedInput (50) <
  // input (100) => cached assumed 0 (all input at the pricier input rate).
  test("null cached split with lower cached rate => assumed 0", () => {
    const result = {
      complete: true as const,
      usage: { ...usage, cachedInputTokens: null },
    };
    expect(resolveBillableUsage(result, differingRates)).toEqual({
      billable: true,
      usage: { ...usage, cachedInputTokens: 0n },
      assumed: ["cached_input"],
    });
  });

  // CHANGED (was: reasoning null with differing rates => fail closed). Here
  // reasoning rate (150) < output (200) => reasoning assumed 0 (all output at
  // the pricier output rate).
  test("null reasoning split with lower reasoning rate => assumed 0", () => {
    const result = {
      complete: true as const,
      usage: { ...usage, reasoningTokens: null },
    };
    expect(resolveBillableUsage(result, differingRates)).toEqual({
      billable: true,
      usage: { ...usage, reasoningTokens: 0n },
      assumed: ["reasoning"],
    });
  });

  test("null split with HIGHER split rate => assumed full base tokens", () => {
    const higherSplitRates = {
      input: 100n,
      output: 200n,
      cachedInput: 500n, // > input
      reasoning: 900n, // > output
    };
    const result = {
      complete: true as const,
      usage: { ...usage, cachedInputTokens: null, reasoningTokens: null },
    };
    expect(resolveBillableUsage(result, higherSplitRates)).toEqual({
      billable: true,
      usage: { ...usage, cachedInputTokens: 100n, reasoningTokens: 50n },
      assumed: ["cached_input", "reasoning"],
    });
  });

  test("resolved tokens charge identically to calculateCharge on chosen tokens", () => {
    const higherSplitRates = {
      input: 100n,
      output: 200n,
      cachedInput: 500n,
      reasoning: 900n,
    };
    const result = {
      complete: true as const,
      usage: { ...usage, cachedInputTokens: null, reasoningTokens: null },
    };
    const resolved = resolveBillableUsage(result, higherSplitRates);
    if (!resolved.billable) throw new Error("expected billable");
    const snapshot = {
      inputUsdMicroPer1m: 100n,
      outputUsdMicroPer1m: 200n,
      cachedInputUsdMicroPer1m: 500n,
      reasoningUsdMicroPer1m: 900n,
      usdVndRate: 26000n,
      markupPpm: 1000000n,
    };
    expect(calculateCharge(resolved.usage, snapshot).chargedVnd).toEqual(
      calculateCharge(
        { inputTokens: 100n, outputTokens: 50n, cachedInputTokens: 100n, reasoningTokens: 50n },
        snapshot,
      ).chargedVnd,
    );
  });
});
