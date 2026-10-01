import { describe, expect, test } from "bun:test";
import { resolveBillableUsage } from "../src/usage";

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
    });
  });

  test("null split with differing rates => fail closed", () => {
    const result = {
      complete: true as const,
      usage: { ...usage, cachedInputTokens: null },
    };
    expect(resolveBillableUsage(result, differingRates)).toEqual({
      billable: false,
      reason: "missing_split_differing_rate",
    });
  });

  test("reasoning null with differing rates => fail closed", () => {
    const result = {
      complete: true as const,
      usage: { ...usage, reasoningTokens: null },
    };
    expect(resolveBillableUsage(result, differingRates)).toEqual({
      billable: false,
      reason: "missing_split_differing_rate",
    });
  });
});
