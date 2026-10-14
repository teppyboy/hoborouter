// Logout draft-clearing contract: signOutAndReset clears every sessionStorage
// key under CHAT_DRAFT_STORAGE_PREFIX (sessionStorage survives the full
// document navigation used for sign-out), and leaves other keys alone.
import { test, expect, beforeAll } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { signOutAndReset, CHAT_DRAFT_STORAGE_PREFIX } from "../apps/web/src/lib/logout";

// Bun has no sessionStorage global; a Map-backed stub is enough for this
// behavior check (the code only uses set/get/remove/keys).
beforeAll(() => {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
});

test("signOutAndReset clears chat draft keys and preserves other session keys", async () => {
  sessionStorage.setItem(`${CHAT_DRAFT_STORAGE_PREFIX}u1-ws1-c1`, "draft text");
  sessionStorage.setItem("hbr-unrelated", "keep");
  const calls: string[] = [];
  const qc = new QueryClient();
  await signOutAndReset(
    qc,
    () => {
      calls.push("signOut");
      return Promise.resolve();
    },
    () => calls.push("navigate"),
  );
  expect(sessionStorage.getItem(`${CHAT_DRAFT_STORAGE_PREFIX}u1-ws1-c1`)).toBeNull();
  expect(sessionStorage.getItem("hbr-unrelated")).toBe("keep");
  // Ordering contract: cancel/sign-out run before navigation.
  expect(calls).toEqual(["signOut", "navigate"]);
});
