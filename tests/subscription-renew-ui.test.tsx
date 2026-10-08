// Subscription renew UI (jsdom, real React, mocked network): a canceled
// subscription's status card swaps the destructive Cancel button for Renew;
// clicking Renew PUTs the workspace subscription (clearing the cancel marker
// server-side) and never DELETEs or posts a payment. Expired subscriptions
// keep showing no action buttons — renewal there happens via plan payment.
import { test, expect, afterAll } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const GLOBAL_KEYS = [
  "window",
  "document",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "Event",
  "MouseEvent",
  "localStorage",
  "matchMedia",
] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;
const roots: { unmount: () => void }[] = [];
const containers: HTMLElement[] = [];
type EventCtor<T, I> = new (type: string, init?: I) => T;
interface JsdomRealm {
  Event: EventCtor<Event, EventInit>;
  MouseEvent: EventCtor<MouseEvent, MouseEventInit>;
  document: Document;
  Node: typeof Node;
  Element: typeof Element;
  HTMLElement: typeof HTMLElement;
  HTMLInputElement: typeof HTMLInputElement;
  localStorage: Storage;
  close: () => void;
}
const W = new JSDOM("", { url: "http://localhost:5173" }).window as unknown as JsdomRealm;

// Saved at module scope, before any stub is installed, so afterAll restores
// the genuine fetch even if another file's stub was still installed here.
// The mount() fetch stub was previously never restored, leaking it into every
// later file in the same worker (relative-path api() calls then hit Bun's
// native fetch and fail with ERR_INVALID_URL).
const realFetch = globalThis.fetch;

for (const k of GLOBAL_KEYS) originals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
for (const [k, v] of Object.entries({
  window: W,
  document: W.document,
  Node: W.Node,
  Element: W.Element,
  HTMLElement: W.HTMLElement,
  HTMLInputElement: W.HTMLInputElement,
  Event: W.Event,
  MouseEvent: W.MouseEvent,
  localStorage: W.localStorage,
})) {
  (globalThis as Record<string, unknown>)[k] = v;
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const matchMediaStub = () => ({
  matches: false,
  media: "",
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
});
(W as unknown as { matchMedia: unknown }).matchMedia = matchMediaStub;
(globalThis as { matchMedia?: unknown }).matchMedia = matchMediaStub;
jsdomWindow = W;

afterAll(async () => {
  // react-dom 19.3's deferred commit callback reads `window.event`
  // (react-dom-client commitRoot -> flushPassiveEffects). Roots left mounted
  // keep a commit queued when the tests end, so removing the jsdom globals
  // races that callback: it throws an unhandled "ReferenceError: window is
  // not defined" after teardown and bun exits 1 with 0 failing tests (the
  // v0.5.4-v0.5.7 CI failures). Unmount inside act while the globals are
  // still installed (same pattern as tests/user-settings-menu-ui.test.tsx),
  // drain the queued scheduler work, then restore.
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const c of containers.splice(0)) c.remove();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  // Restore the genuine fetch after the drain so queued commits still use
  // this file's stub; without this the mount() stub leaked into every later
  // file in the same worker (relative-path api() calls then hit Bun's native
  // fetch and fail with ERR_INVALID_URL).
  globalThis.fetch = realFetch;
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  jsdomWindow?.close();
  jsdomWindow = null;
});

// @ts-expect-error relative specifier has no declaration file under tests tsconfig
const { createRoot } = await import("../apps/web/node_modules/react-dom/client");
const { SubscriptionStatusCard } = await import("../apps/web/src/pages/billing/bundles");
import type { SubscriptionInfo } from "../apps/web/src/pages/billing/bundles";

const RATE = 26_000;

const CANCELED_SUB: SubscriptionInfo = {
  balance: 250_000,
  available: 230_000,
  period_end: Date.parse("2030-02-01T00:00:00Z"),
  plan_name: "Pro",
  rate_limit_per_minute: 15,
  expired: false,
  canceled: true,
};

function mountSubCard(subscription: SubscriptionInfo): {
  container: HTMLElement;
  fetchCalls: { url: string; method: string }[];
  clickButton: (label: string) => Promise<void>;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  roots.push(root);
  containers.push(container);
  const fetchCalls: { url: string; method: string }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({ url, method: init?.method ?? "GET" });
    return new Response(
      JSON.stringify({
        id: "sub-1",
        status: "active",
        canceled: false,
        period_end: subscription.period_end,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  act(() => {
    root.render(
      <QueryClientProvider client={qc}>
        <SubscriptionStatusCard subscription={subscription} workspaceId="ws_1" rate={RATE} />
      </QueryClientProvider>,
    );
  });
  const clickButton = async (label: string) => {
    const btn = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes(label),
    );
    if (!btn) throw new Error(`button "${label}" missing`);
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
  };
  return { container, fetchCalls, clickButton };
}

test("canceled subscription card shows Renew instead of Cancel", () => {
  const m = mountSubCard(CANCELED_SUB);
  expect(m.container.textContent).toContain("canceled — will not renew");
  expect(m.container.textContent).toContain("Renew");
  expect(m.container.textContent).not.toContain("Cancel subscription");
});

test("Renew PUTs the workspace subscription (no DELETE, no payment POST)", async () => {
  const m = mountSubCard(CANCELED_SUB);
  await m.clickButton("Renew");
  const renew = m.fetchCalls.find((c) => c.method === "PUT");
  expect(renew).toEqual({ url: "/api/v1/workspaces/ws_1/subscription", method: "PUT" });
  expect(m.fetchCalls.some((c) => c.method === "DELETE")).toBe(false);
  expect(m.fetchCalls.some((c) => c.method === "POST")).toBe(false);
});

test("expired canceled subscription shows no action buttons", () => {
  const m = mountSubCard({ ...CANCELED_SUB, expired: true });
  expect(m.container.textContent).not.toContain("Renew");
  expect(m.container.textContent).not.toContain("Cancel subscription");
});
