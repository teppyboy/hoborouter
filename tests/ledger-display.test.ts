import { describe, expect, test } from "bun:test";
import { formatVnd, formatUsdFromVnd } from "../apps/web/src/lib/format";
import {
  formatLedgerSourceLabel,
  isUsageDebit,
  partitionLedger,
  signedLedgerAmount,
  type LedgerLike,
} from "../apps/web/src/pages/billing/ledger-display";

const RATE = 26000;

describe("ledger classification and sign", () => {
  test("amount is positive; sign comes from direction, applied once", () => {
    expect(signedLedgerAmount({ direction: "debit", kind: "settle", amount: 2500 })).toBe(-2500);
    expect(signedLedgerAmount({ direction: "credit", kind: "topup", amount: 100000 })).toBe(100000);
    expect(signedLedgerAmount({ direction: "credit", kind: "refund", amount: 500 })).toBe(500);
  });

  test("usage deductions are settle debits only", () => {
    expect(isUsageDebit({ direction: "debit", kind: "settle", amount: 1 })).toBe(true);
    expect(isUsageDebit({ direction: "credit", kind: "topup", amount: 1 })).toBe(false);
    expect(isUsageDebit({ direction: "credit", kind: "adjustment", amount: 1 })).toBe(false);
  });

  test("partition drops no rows: every entry lands in exactly one section", () => {
    const entries: LedgerLike[] = [
      { direction: "credit", kind: "topup", amount: 100000 },
      { direction: "debit", kind: "settle", amount: 2500 },
      { direction: "debit", kind: "settle", amount: 100 },
      { direction: "credit", kind: "refund", amount: 2500 },
      { direction: "credit", kind: "adjustment", amount: 750 },
      // Unknown kind (forward-compat) must still be visible, not dropped.
      { direction: "debit", kind: "mystery", amount: 42 },
    ];
    const s = partitionLedger(entries);
    expect(s.usage.length + s.topups.length + s.adjustments.length).toBe(entries.length);
    expect(s.usage.map((e) => e.amount)).toEqual([2500, 100]);
    expect(s.topups.map((e) => e.amount)).toEqual([100000]);
    expect(s.adjustments.map((e) => e.kind)).toEqual(["refund", "adjustment", "mystery"]);
  });

  test("source labels: subscription credit vs top-up credit, unknown falls back to top-up", () => {
    expect(formatLedgerSourceLabel("subscription")).toBe("Subscription credit");
    expect(formatLedgerSourceLabel("topup")).toBe("Top-up credit");
    // Older backends omit wallet_kind — display still works.
    expect(formatLedgerSourceLabel(undefined)).toBe("Top-up credit");
    expect(formatLedgerSourceLabel(null)).toBe("Top-up credit");
  });

  // Rendered formatter evidence: both display paths render the sign
  // themselves, so the credits.tsx Amount cell never re-adds '-' manually.

  test("USD path renders debit/credit/refund with sign (FX present)", () => {
    expect(formatUsdFromVnd(-2500, RATE)).toBe("-$0.10"); // debit loses money
    expect(formatUsdFromVnd(2500, RATE)).toBe("$0.10"); // refund restores it
    expect(formatUsdFromVnd(100000, RATE)).toBe("$3.85"); // topup credit
    expect(formatUsdFromVnd(-100, RATE)).toMatch(/^-/); // small debit still negative
    expect(formatUsdFromVnd(-100, RATE)).not.toBe("$0.00");
  });

  test("VND fallback path renders the sign for debits (rate undefined)", () => {
    // formatVnd is the primary fallback in credits.tsx when FX is undefined;
    // it must carry the minus for debits — no manual '-' prefix anywhere.
    expect(formatVnd(-2500)).toMatch(/^-/);
    expect(formatVnd(-2500)).toBe(formatVnd(2500).replace(/^/, "-"));
    expect(formatVnd(2500)).not.toMatch(/^-/);
    expect(formatVnd(-500)).toBe("-500 ₫");
    // And when FX is present, the cell renders the signed VND string as the
    // secondary span directly — also signed, no double negative.
    expect(formatVnd(-2500)).not.toContain("--");
  });
});
