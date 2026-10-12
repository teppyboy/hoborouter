// Chat thinking-effort controls (OpenRouter parity plan Task 6 web lane):
// - tolerant public metadata: the effort selector exists only for models whose
//   stored capabilities explicitly carry "reasoning"; absent/unknown lists
//   never infer support
// - canonical request serialization: an explicit effort becomes exactly one
//   `reasoning: { effort }` carrier on the unchanged chat body shape;
//   "default" (and any non-effort value) omits the field entirely so
//   legacy/un-authored models see a byte-identical body
// - no private route/provider identifiers ever appear in the serialized body
import { describe, test, expect } from "bun:test";
import {
  buildChatRequestBody,
  EFFORT_LABELS,
  EFFORT_UNSET,
  isReasoningEffort,
  REASONING_EFFORTS,
  supportedEffortOptions,
} from "../apps/web/src/pages/chat/reasoning";

describe("supportedEffortOptions (catalog-authored metadata)", () => {
  test("only catalog-authored supported efforts are offered", () => {
    expect(
      supportedEffortOptions({ supported_efforts: ["low", "high"], default_effort: "low" }),
    ).toEqual(["low", "high"]);
  });

  test("missing, malformed, and empty metadata never infer options", () => {
    expect(supportedEffortOptions(undefined)).toEqual([]);
    expect(supportedEffortOptions(null)).toEqual([]);
    expect(supportedEffortOptions({ supported_efforts: [], default_effort: null })).toEqual([]);
  });

  test("unknown effort ids are dropped, never shown as selectable options", () => {
    expect(
      supportedEffortOptions({ supported_efforts: ["low", "ultra", "MAX"], default_effort: null }),
    ).toEqual(["low"]);
  });

  test("authored order is preserved (no re-sorting to the canonical ladder)", () => {
    expect(
      supportedEffortOptions({ supported_efforts: ["high", "low"], default_effort: null }),
    ).toEqual(["high", "low"]);
  });
});

describe("buildChatRequestBody (canonical serialization)", () => {
  const messages = [{ role: "user", content: "Hello" }];

  test("default effort omits the reasoning field entirely (legacy body shape)", () => {
    const body = buildChatRequestBody({ model: "m/a", messages, effort: EFFORT_UNSET });
    expect(body).toEqual({ model: "m/a", messages, stream: true });
    expect("reasoning" in body).toBe(false);
    // Byte-identical to the pre-change serialization.
    expect(JSON.stringify(body)).toBe(JSON.stringify({ model: "m/a", messages, stream: true }));
  });

  test("explicit effort serializes the canonical OpenRouter carrier once", () => {
    const body = buildChatRequestBody({ model: "m/a", messages, effort: "high" });
    expect(body).toEqual({ model: "m/a", messages, stream: true, reasoning: { effort: "high" } });
    expect(JSON.stringify(body)).toContain('"reasoning":{"effort":"high"}');
  });

  test("every canonical effort value serializes verbatim", () => {
    for (const effort of REASONING_EFFORTS) {
      const body = buildChatRequestBody({ model: "m", messages, effort });
      expect(body.reasoning).toEqual({ effort });
    }
  });

  test("non-effort values (stale selector state) never reach the body", () => {
    expect(buildChatRequestBody({ model: "m", messages, effort: "" }).reasoning).toBeUndefined();
    expect(buildChatRequestBody({ model: "m", messages, effort: "MAX" }).reasoning).toBeUndefined();
    expect(
      buildChatRequestBody({ model: "m", messages, effort: "unlimited" }).reasoning,
    ).toBeUndefined();
  });
});

describe("effort metadata", () => {
  test("canonical ladder matches the gateway's accepted values", () => {
    expect([...REASONING_EFFORTS]).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(isReasoningEffort("high")).toBe(true);
    expect(isReasoningEffort("extreme")).toBe(false);
  });

  test("every effort has a bilingual label (no bare enum leakage into UI)", () => {
    for (const e of REASONING_EFFORTS) {
      expect(EFFORT_LABELS[e].en.length).toBeGreaterThan(0);
      expect(EFFORT_LABELS[e].vi.length).toBeGreaterThan(0);
    }
  });
});
