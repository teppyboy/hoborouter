// Bundle/plan creation amount parsing: the only client-side validation shared
// by both create forms on the admin bundles page. Sign rules (price > 0,
// credit/bonus >= 0) live in each form + the server; the parser accepts any
// safe integer so the form can flag the specific rule that failed.
import { test, expect } from "bun:test";
import { JSDOM } from "jsdom";

// The page module pulls React/Radix, which capture `globalThis.document` at
// import time (Radix turns useLayoutEffect into a noop without a document).
// Install a minimal DOM before the first import so load order (e.g. when the
// USD editor test file shares this process) cannot poison dialog rendering,
// then restore the previous globals so nothing leaks across test files.
const GLOBAL_KEYS = [
  "window",
  "document",
  "Node",
  "Element",
  "HTMLElement",
  "getComputedStyle",
  "MutationObserver",
] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
for (const k of GLOBAL_KEYS) {
  originals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
}
const dom = new JSDOM("", { url: "http://localhost:5173" });
for (const [k, v] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  Node: dom.window.Node,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  MutationObserver: dom.window.MutationObserver,
})) {
  (globalThis as Record<string, unknown>)[k] = v;
}

const { parseIntVnd } = await import("../apps/web/src/pages/admin/bundles");

for (const k of GLOBAL_KEYS) {
  const d = originals[k];
  if (d) Object.defineProperty(globalThis, k, d);
  else delete (globalThis as Record<string, unknown>)[k];
}

test("accepts plain integers and padded input", () => {
  expect(parseIntVnd("500000")).toBe(500000);
  expect(parseIntVnd(" 500000 ")).toBe(500000);
});

test("rejects empty, whitespace-only, float, and non-numeric input", () => {
  expect(parseIntVnd("")).toBeNull();
  expect(parseIntVnd("   ")).toBeNull();
  expect(parseIntVnd("500.5")).toBeNull();
  expect(parseIntVnd("50a")).toBeNull();
  expect(parseIntVnd("1e6")).toBeNull();
});

test("rejects values beyond the safe-integer money bound", () => {
  expect(parseIntVnd("9007199254740992")).toBeNull();
  expect(parseIntVnd("9007199254740991")).toBe(9007199254740991);
});

test("parses negatives so the form (not the parser) flags sign violations", () => {
  expect(parseIntVnd("-5")).toBe(-5);
});
