// Success-rate label shared by Usage page (and mirroring Overview's rule):
// (visible_requests - visible_errors) / visible_requests, em dash when counts
// are absent or the denominator is zero.
import { describe, test, expect } from "bun:test";
import { successRateLabel } from "../apps/web/src/pages/logs/api";

describe("successRateLabel", () => {
  test("computes (visible - errors) / visible", () => {
    expect(successRateLabel(8, 2)).toBe("75.0%");
  });

  test("em dash when visible counts absent (older backend)", () => {
    expect(successRateLabel(undefined, undefined)).toBe("—");
  });

  test("em dash when denominator zero", () => {
    expect(successRateLabel(0, 0)).toBe("—");
  });
});
