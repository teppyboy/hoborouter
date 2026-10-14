// Composer text-draft persistence (draft.ts): scoping (no context leak),
// 64 KiB UTF-8 byte cap, clear paths and the logout prefix sweep. Pure module
// tests — the debounce/hydration timing lives in use-chat-drafts.
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

const g = globalThis as { sessionStorage?: Storage };
const previous = Object.getOwnPropertyDescriptor(g, "sessionStorage");

beforeEach(() => {
  g.sessionStorage = new FakeStorage();
});

afterAll(() => {
  if (previous) Object.defineProperty(g, "sessionStorage", previous);
  else delete g.sessionStorage;
});

const { readChatDraft, writeChatDraft, clearChatDraft, clearChatDrafts, chatDraftKey } =
  await import("../apps/web/src/pages/chat/draft");

const scope = { userId: "u1", workspaceId: "w1", chatId: null };
const scopeC1 = { userId: "u1", workspaceId: "w1", chatId: "c1" };
const scopeOtherUser = { userId: "u2", workspaceId: "w1", chatId: null };

test("draft round-trips under its scope; the unsaved view uses the `new` key", () => {
  expect(chatDraftKey(scope)).toBe("chat.draft.u1.w1.new");
  writeChatDraft(scope, "hello draft");
  expect(readChatDraft(scope)).toBe("hello draft");
});

test("drafts never leak across user, workspace or conversation scopes", () => {
  writeChatDraft(scope, "user one secret draft");
  expect(readChatDraft(scopeOtherUser)).toBe("");
  expect(readChatDraft(scopeC1)).toBe("");
  writeChatDraft(scopeC1, "conversation one draft");
  expect(readChatDraft(scope)).toBe("user one secret draft");
  expect(readChatDraft(scopeOtherUser)).toBe("");
});

test("drafts at the 64 KiB UTF-8 byte boundary persist; larger ones never do", () => {
  const atCap = "a".repeat(64 * 1024);
  expect(writeChatDraft(scope, atCap)).toBe(true);
  expect(readChatDraft(scope)).toBe(atCap);
  // 4-byte emoji keeps the UTF-8 measurement honest (not UTF-16 length).
  const overCap = "🎯".repeat(16 * 1024 + 1); // 65540 bytes
  expect(overCap.length < 64 * 1024).toBe(true); // UTF-16 length is under the cap
  expect(writeChatDraft(scope, overCap)).toBe(false);
  expect(readChatDraft(scope)).toBe(atCap); // previous draft untouched
});

test("clearChatDraft erases exactly its scope", () => {
  writeChatDraft(scope, "kept elsewhere");
  writeChatDraft(scopeC1, "conversation draft");
  clearChatDraft(scope);
  expect(readChatDraft(scope)).toBe("");
  expect(readChatDraft(scopeC1)).toBe("conversation draft");
});

test("clearChatDrafts sweeps the chat.draft prefix only, optionally per user", () => {
  writeChatDraft(scope, "u1 new");
  writeChatDraft(scopeC1, "u1 c1");
  writeChatDraft(scopeOtherUser, "u2 new");
  (g.sessionStorage as FakeStorage).setItem("unrelated.key", "keep me");
  clearChatDrafts({ userId: "u1" });
  expect(readChatDraft(scope)).toBe("");
  expect(readChatDraft(scopeC1)).toBe("");
  expect(readChatDraft(scopeOtherUser)).toBe("u2 new");
  expect((g.sessionStorage as FakeStorage).getItem("unrelated.key")).toBe("keep me");
  clearChatDrafts();
  expect(readChatDraft(scopeOtherUser)).toBe("");
  expect((g.sessionStorage as FakeStorage).getItem("unrelated.key")).toBe("keep me");
});

test("unavailable storage degrades to memory-only without throwing", () => {
  // Privacy-mode storage: every access throws. The module must treat that as
  // memory-only instead of surfacing the error.
  g.sessionStorage = {
    length: 0,
    key: () => null,
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {
      throw new Error("denied");
    },
    clear: () => {},
  };
  expect(writeChatDraft(scope, "lost")).toBe(false);
  expect(readChatDraft(scope)).toBe("");
  expect(() => clearChatDraft(scope)).not.toThrow();
  expect(() => clearChatDrafts()).not.toThrow();
});
