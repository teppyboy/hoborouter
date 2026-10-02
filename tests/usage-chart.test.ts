import { describe, expect, test } from "bun:test";
import { metricSeries, zeroFillDaily } from "../apps/web/src/pages/usage/charthelper";

describe("zeroFillDaily", () => {
  test("fills missing UTC days with zeros and keeps sparse buckets", () => {
    const today = new Date().toISOString().slice(0, 10);
    const filled = zeroFillDaily(
      [{ day: today, requests: 2, tokens: 10, spend_vnd: 20, errors: 1 }],
      7,
    );
    expect(filled).toHaveLength(7);
    const last = filled[6];
    const first = filled[0];
    if (!last || !first) throw new Error("expected 7 filled days");
    expect(last.day).toBe(today);
    expect(last.requests).toBe(2);
    expect(first.requests).toBe(0);
    expect(first.spend_vnd).toBe(0);
  });

  test("axis endpoints derive from zero-filled series, not sparse daily", () => {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const s = metricSeries(
      [{ day: yesterday, requests: 1, tokens: 5, spend_vnd: 100, errors: 0 }],
      3,
      "requests",
    );
    expect(s).toHaveLength(3);
    expect(s[0]!.value).toBe(0);
    expect(s.at(-1)!.label).toBe(today);
  });

  test("metricSeries maps cost to spend_vnd", () => {
    const today = new Date().toISOString().slice(0, 10);
    const s = metricSeries(
      [{ day: today, requests: 1, tokens: 5, spend_vnd: 100, errors: 0 }],
      3,
      "cost",
    );
    expect(s.map((p) => p.value)).toEqual([0, 0, 100]);
  });
});
