// Remembered chat model/effort preferences (preferences.ts): per
// user+workspace storage, erase paths, and the catalog-validity filter that
// keeps non-published IDs from ever being applied. Pure module tests.
import { test, expect, beforeEach, afterAll } from "bun:test";

class FakeStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

const g = globalThis as { localStorage?: Storage };
const previous = Object.getOwnPropertyDescriptor(g, "localStorage");

beforeEach(() => {
  g.localStorage = new FakeStorage();
});

afterAll(() => {
  if (previous) Object.defineProperty(g, "localStorage", previous);
  else delete g.localStorage;
});

const {
  rememberChatModel,
  recallChatModel,
  rememberChatEffort,
  recallChatEffort,
  clearChatPreferences,
  validModelChoice,
} = await import("../apps/web/src/pages/chat/preferences");

const catalog = [{ publicId: "pub/model-a" }, { publicId: "pub/model-b" }];

test("model and effort remember/recall round-trips per user+workspace", () => {
  rememberChatModel("u1", "w1", "pub/model-a");
  rememberChatEffort("u1", "w1", "high");
  expect(recallChatModel("u1", "w1")).toBe("pub/model-a");
  expect(recallChatEffort("u1", "w1")).toBe("high");
  expect(recallChatModel("u2", "w1")).toBe(null);
  expect(recallChatModel("u1", "w2")).toBe(null);
});

test("remembering null/empty clears the stored value", () => {
  rememberChatModel("u1", "w1", "pub/model-a");
  rememberChatModel("u1", "w1", null);
  expect(recallChatModel("u1", "w1")).toBe(null);
  rememberChatEffort("u1", "w1", "high");
  rememberChatEffort("u1", "w1", "");
  expect(recallChatEffort("u1", "w1")).toBe(null);
});

test("clearChatPreferences erases both prefs for the identity", () => {
  rememberChatModel("u1", "w1", "pub/model-a");
  rememberChatEffort("u1", "w1", "high");
  rememberChatModel("u1", "w2", "pub/model-b");
  clearChatPreferences("u1", "w1");
  expect(recallChatModel("u1", "w1")).toBe(null);
  expect(recallChatEffort("u1", "w1")).toBe(null);
  expect(recallChatModel("u1", "w2")).toBe("pub/model-b");
});

test("validModelChoice keeps only published catalog IDs — no raw keys applied", () => {
  expect(validModelChoice("pub/model-a", catalog)).toBe("pub/model-a");
  expect(validModelChoice("upstream/private-key-id", catalog)).toBe(null);
  expect(validModelChoice(null, catalog)).toBe(null);
  // A remembered model that later left the catalog is dropped.
  expect(validModelChoice("pub/removed", catalog)).toBe(null);
});
