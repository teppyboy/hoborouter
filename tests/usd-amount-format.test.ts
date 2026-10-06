// formatUsdAmountText: exact string formatting of validated nonnegative USD
// decimal text — no Number conversion, no floating-point rounding, two
// fraction digits, canonical leading zeros.
import { describe, expect, test } from "bun:test";
import { formatUsdAmountText } from "../apps/web/src/lib/format";

describe("formatUsdAmountText", () => {
  test.each([
    ["5", "$5.00"],
    ["9.9", "$9.90"],
    ["9.99", "$9.99"],
    ["0009.99", "$9.99"],
    ["0", "$0.00"],
    ["0000", "$0.00"],
    ["0.5", "$0.50"],
    ["0.05", "$0.05"],
    // 12-digit integer part stays exact (beyond Number.MAX_SAFE digits safety).
    ["123456789012", "$123456789012.00"],
    ["999999999999.99", "$999999999999.99"],
  ])("%s -> %s", (input, expected) => {
    expect(formatUsdAmountText(input)).toBe(expected);
  });

  test.each(["", "abc", "-5", "1.2.3", "1.234", "1.", ".5", " 5"])(
    "rejects invalid text %s",
    (input) => {
      expect(() => formatUsdAmountText(input)).toThrow();
    },
  );
});
