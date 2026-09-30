export type PriceSnapshot = {
  inputUsdMicroPer1m: bigint;
  outputUsdMicroPer1m: bigint;
  cachedInputUsdMicroPer1m: bigint;
  reasoningUsdMicroPer1m: bigint;
  usdVndRate: bigint;
  markupPpm: bigint;
};

export type UsageTokens = {
  inputTokens: bigint;
  outputTokens: bigint;
  cachedInputTokens: bigint;
  reasoningTokens: bigint;
};

export const maxStoredMoney = 9223372036854775807n;
const tokensPerMillion = 1_000_000n;
const markupDenominator = 1_000_000_000_000n;

function requireNonnegative(values: Record<string, bigint>): void {
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "bigint" || value < 0n)
      throw new RangeError(`${name} must be nonnegative`);
  }
}

function ceilDivide(value: bigint, divisor: bigint): bigint {
  return value === 0n ? 0n : (value + divisor - 1n) / divisor;
}

export function calculateCharge(
  usage: UsageTokens,
  price: PriceSnapshot,
): { upstreamCostUsdMicro: bigint; chargedVnd: bigint } {
  // SAFETY: public typed inputs contain only the declared bigint fields.
  requireNonnegative(usage as unknown as Record<string, bigint>);
  // SAFETY: public typed inputs contain only the declared bigint fields.
  requireNonnegative(price as unknown as Record<string, bigint>);
  if (usage.cachedInputTokens > usage.inputTokens) {
    throw new RangeError("cachedInputTokens cannot exceed inputTokens");
  }
  if (usage.reasoningTokens > usage.outputTokens) {
    throw new RangeError("reasoningTokens cannot exceed outputTokens");
  }

  const rawUsdMicro =
    (usage.inputTokens - usage.cachedInputTokens) * price.inputUsdMicroPer1m +
    usage.cachedInputTokens * price.cachedInputUsdMicroPer1m +
    (usage.outputTokens - usage.reasoningTokens) * price.outputUsdMicroPer1m +
    usage.reasoningTokens * price.reasoningUsdMicroPer1m;
  const upstreamCostUsdMicro = ceilDivide(rawUsdMicro, tokensPerMillion);
  if (upstreamCostUsdMicro > maxStoredMoney) {
    throw new RangeError("upstreamCostUsdMicro exceeds maxStoredMoney");
  }

  const chargedVnd = ceilDivide(
    upstreamCostUsdMicro * price.usdVndRate * price.markupPpm,
    markupDenominator,
  );
  if (chargedVnd > maxStoredMoney) throw new RangeError("chargedVnd exceeds maxStoredMoney");
  return { upstreamCostUsdMicro, chargedVnd };
}
