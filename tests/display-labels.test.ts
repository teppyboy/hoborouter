import { describe, expect, it } from "bun:test";
import {
  formatLedgerKindLabel,
  formatProviderLabel,
  formatStatusLabel,
} from "../apps/web/src/lib/display";

describe("display labels", () => {
  it("maps known machine values", () => {
    expect(formatStatusLabel("mock")).toBe("Manual");
    expect(formatStatusLabel("topup")).toBe("Top-up");
    expect(formatStatusLabel("top_up")).toBe("Top-up");
    expect(formatStatusLabel("succeeded")).toBe("Succeeded");
    expect(formatStatusLabel("ok")).toBe("Succeeded");
    expect(formatStatusLabel("enabled")).toBe("Enabled");
    expect(formatStatusLabel("pending")).toBe("Pending");
    expect(formatStatusLabel("revoked")).toBe("Revoked");
    expect(formatStatusLabel("rate_limited")).toBe("Rate Limited");
    expect(formatStatusLabel("timeout")).toBe("Timeout");
    expect(formatProviderLabel("stripe")).toBe("Stripe");
    expect(formatLedgerKindLabel("topup")).toBe("Top-up");
  });

  it("falls back to readable text for unknown values", () => {
    expect(formatStatusLabel("payment_failed")).toBe("Payment Failed");
    expect(formatStatusLabel("crypto-transfer")).toBe("Crypto Transfer");
    expect(formatProviderLabel("")).toBe("—");
    expect(formatStatusLabel("")).toBe("—");
    expect(formatStatusLabel("Failed")).toBe("Failed");
  });
});
