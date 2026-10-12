// Regression for the v0.11.1 ui-job crash: Better Auth's client session atom
// removes its window listeners in a nanostores unmount cleanup that is delayed
// by ~1000ms after the last subscriber disappears. A UI test file that deletes
// globalThis.window in afterAll therefore leaves that cleanup to run with no
// `window`, throwing an unhandled "ReferenceError: window is not defined"
// between test files (better-auth session-refresh.mjs cleanup →
// broadcast-channel/focus-manager/online-manager removeEventListener).
//
// This file drives the real client through the same lifecycle: mount the
// session atom with a jsdom window installed, tear the window down like a UI
// file's afterAll, then unsubscribe and outlive the unmount delay. With the
// isolation stubs installed the whole cycle is silent; without them it throws
// the exact ReferenceError observed in CI.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { JSDOM } from "jsdom";
import { isolateBetterAuthClientWindowManagers } from "./helpers/better-auth-client-isolation";

isolateBetterAuthClientWindowManagers();

const GLOBAL_KEYS = ["window", "document", "localStorage", "location"] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;
const originalFetch = globalThis.fetch;

interface SessionAtomView {
  get: () => unknown;
  subscribe: (listener: () => void) => () => void;
}

let sessionAtom: SessionAtomView;

beforeAll(async () => {
  const win = new JSDOM("", { url: "http://localhost:5173" }).window as unknown as {
    document: object;
    localStorage: Storage;
    location: unknown;
    close: () => void;
  };
  for (const k of GLOBAL_KEYS) {
    originals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  }
  const values: Record<string, unknown> = {
    window: win,
    document: win.document,
    localStorage: win.localStorage,
    location: win.location,
  };
  for (const [k, v] of Object.entries(values)) {
    (globalThis as Record<string, unknown>)[k] = v;
  }
  jsdomWindow = win;
  // Session fetch must never resolve: the atom stays pending, so nothing but
  // the listener lifecycle is under test here.
  globalThis.fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  const { authClient } = await import("../apps/web/src/lib/auth");
  sessionAtom = (
    authClient as unknown as {
      $store: { atoms: { session: SessionAtomView } };
    }
  ).$store.atoms.session;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  jsdomWindow?.close();
  jsdomWindow = null;
});

const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test("session atom mount → window teardown → unmount cycle stays silent", async () => {
  const unsubscribe = sessionAtom.subscribe(() => {});
  await flush(20);
  // Shape check only: the atom is a session map, not an error/computation.
  const mounted = sessionAtom.get() as { data?: unknown; isPending?: boolean };
  expect(mounted).toBeTypeOf("object");
  expect(mounted.isPending).toBe(true);

  // Simulate the UI file's afterAll: window globals gone before the delayed
  // unmount cleanup runs.
  for (const k of GLOBAL_KEYS) {
    delete (globalThis as Record<string, unknown>)[k];
  }
  jsdomWindow?.close();
  jsdomWindow = null;

  unsubscribe();
  // Outlive nanostores' STORE_UNMOUNT_DELAY (1000ms): the cleanup runs here.
  // Without the isolation stubs this wait surfaces the unhandled
  // ReferenceError; with them the cycle completes.
  await flush(1300);
  expect(sessionAtom.get()).toBeTypeOf("object");
});
