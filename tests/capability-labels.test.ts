// Capability label contract: known canonical metadata keys (mirroring gateway
// truth in apps/api/src/auto-resolve.ts) get bilingual display labels; unknown
// stored values render verbatim — never renamed, dropped, or reinterpreted.
// The match is case-sensitive: admin-typed "Chat" is not silently promoted to
// the canonical "chat" key.
import { test, expect } from "bun:test";

const { KNOWN_CAPABILITIES, isKnownCapability, capabilityLabel, capabilityFilterOptions } =
  await import("../apps/web/src/lib/capabilities");

test("known capabilities are exactly the canonical metadata keys", () => {
  expect([...KNOWN_CAPABILITIES]).toEqual(["chat", "vision", "tools", "reasoning"]);
});

test("known capabilities get bilingual labels", () => {
  expect(capabilityLabel("chat", "en")).toBe("Chat");
  expect(capabilityLabel("chat", "vi")).toBe("Chat");
  expect(capabilityLabel("vision", "en")).toBe("Vision");
  expect(capabilityLabel("vision", "vi")).toBe("Nhận diện ảnh");
  expect(capabilityLabel("tools", "en")).toBe("Tools");
  expect(capabilityLabel("tools", "vi")).toBe("Công cụ");
  expect(capabilityLabel("reasoning", "en")).toBe("Reasoning");
  expect(capabilityLabel("reasoning", "vi")).toBe("Suy luận");
});

test("unknown capability values render verbatim (case-sensitive, no heuristics)", () => {
  expect(capabilityLabel("image", "en")).toBe("image");
  expect(capabilityLabel("image", "vi")).toBe("image");
  // Wrong case is NOT canonicalized — it stays verbatim.
  expect(capabilityLabel("Vision", "en")).toBe("Vision");
  expect(capabilityLabel("CHAT ", "en")).toBe("CHAT ");
  expect(isKnownCapability("Vision")).toBe(false);
  expect(isKnownCapability("chat")).toBe(true);
});

test("capabilityFilterOptions: distinct stored values, known first in canonical order, unknown after alphabetically", () => {
  expect(capabilityFilterOptions(["tools", "ocr", "chat", "chat", "audio"])).toEqual([
    "chat",
    "tools",
    "audio",
    "ocr",
  ]);
  expect(capabilityFilterOptions([])).toEqual([]);
  // No known caps at all: plain sorted distinct values, nothing invented.
  expect(capabilityFilterOptions(["b", "a", "a"])).toEqual(["a", "b"]);
});
