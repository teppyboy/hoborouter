// Billing checkout UI contract (jsdom, real React, mocked network only):
// - three tabs (Credit bundles / Subscription plans / Prepaid throughput) with
//   status cards and the throughput disclaimer inside their own tab;
// - payment methods are ABSENT until a product is selected: Select opens the
//   checkout Dialog with the product name + server price and the provider
//   choice (manual default), Confirm/Cancel — selection fires no requests;
// - Confirm POSTs the same purchase endpoints and payload shapes as before
//   (`{}` manual, `{"provider":"payos"}`), pending/disabled guards make a
//   duplicate click safe;
// - switching tabs clears the selection and provider choice; selecting another
//   product replaces the stale checkout (fresh manual default).
import { test, expect, beforeAll, afterAll, mock, afterEach } from "bun:test";
import { act, useSyncExternalStore } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, createRootRoute, createMemoryHistory } from "@tanstack/react-router";
import { routerContext } from "@tanstack/react-router/dist/esm/routerContext.js";
import { JSDOM } from "jsdom";
import { registerFaithfulApiMock } from "./helpers/faithful-api-mock";

// lib/api is registered once per process via the shared faithful mock (see
// tests/helpers/faithful-api-mock.ts): stable ApiError identity and an api()
// that reads globalThis.fetch live, so this file's fetch mock intercepts
// requests and later files sharing the worker keep correct error-code
// mapping. mock.module is process-global in Bun and outlives mock.restore(),
// so a per-file hand-rolled mock would leak a wrong ApiError into files like
// promo-ui, which do `instanceof ApiError` for friendly error mapping.
registerFaithfulApiMock();
// The mocked workspace hook is reactive: tests switch the "active" workspace
// with setWorkspace() and the page re-renders through useSyncExternalStore,
// mirroring how the real hook re-renders on a workspace change.
let activeWorkspace = "ws-test";
const workspaceSubs = new Set<() => void>();
mock.module("../apps/web/src/lib/workspace-queries", () => ({
  // Third argument (getServerSnapshot) is required: mock.module is
  // process-global and outlives this file, so SSR files sharing the worker
  // render through this hook; without a server snapshot React's server
  // renderer rejects with "Missing getServerSnapshot".
  useCurrentWorkspaceId: () =>
    useSyncExternalStore(
      (cb) => {
        workspaceSubs.add(cb);
        return () => workspaceSubs.delete(cb);
      },
      () => activeWorkspace,
      () => activeWorkspace,
    ),
  useWorkspaces: () => ({ data: [], isSuccess: false }),
}));
function setWorkspace(ws: string) {
  activeWorkspace = ws;
  for (const cb of workspaceSubs) cb();
}

const GLOBAL_KEYS = [
  "window",
  "document",
  "localStorage",
  "location",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "MutationObserver",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "PointerEvent",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLButtonElement",
  "HTMLAnchorElement",
  "HTMLFormElement",
  "HTMLLabelElement",
  "HTMLSelectElement",
  "DocumentFragment",
  "SVGElement",
] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
// act() reads this at call time; capture the previous value so afterAll can
// restore exactly what this file installed, after unmount + drain.
let previousActEnv: PropertyDescriptor | undefined;
let jsdomWindow: { close: () => void } | null = null;

let BillingBundlesPage: (typeof import("../apps/web/src/pages/billing/bundles"))["default"];
let mountRoot: (container: HTMLElement) => { render: (n: unknown) => void; unmount: () => void };

beforeAll(async () => {
  const win = new JSDOM("", { url: "http://localhost:5173" }).window as unknown as Record<
    string,
    unknown
  >;
  win.matchMedia = () => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  // Radix Tabs/Dialog internals need getComputedStyle + rAF; jsdom has neither.
  const raf = (cb: (t: number) => void) =>
    setTimeout(() => cb(Date.now()), 16) as unknown as number;
  for (const k of GLOBAL_KEYS) originals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  previousActEnv = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  const values: Record<string, unknown> = {
    window: win,
    document: win.document,
    localStorage: win.localStorage,
    location: win.location,
    getComputedStyle: (win.getComputedStyle as (e: Element) => CSSStyleDeclaration).bind(win),
    requestAnimationFrame: raf,
    cancelAnimationFrame: (id: number) =>
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
    MutationObserver: win.MutationObserver,
    Event: win.Event,
    CustomEvent: win.CustomEvent,
    MouseEvent: win.MouseEvent,
    KeyboardEvent: win.KeyboardEvent,
    FocusEvent: win.FocusEvent,
    PointerEvent: win.PointerEvent,
    Node: win.Node,
    NodeFilter: win.NodeFilter,
    Element: win.Element,
    HTMLElement: win.HTMLElement,
    HTMLInputElement: win.HTMLInputElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement,
    HTMLButtonElement: win.HTMLButtonElement,
    HTMLAnchorElement: win.HTMLAnchorElement,
    HTMLFormElement: win.HTMLFormElement,
    HTMLLabelElement: win.HTMLLabelElement,
    HTMLSelectElement: win.HTMLSelectElement,
    DocumentFragment: win.DocumentFragment,
    SVGElement: win.SVGElement,
  };
  for (const [k, v] of Object.entries(values)) {
    (globalThis as Record<string, unknown>)[k] = v;
  }
  jsdomWindow = win as unknown as { close: () => void };
  globalThis.fetch = mockFetch as typeof fetch;
  ({ default: BillingBundlesPage } = await import("../apps/web/src/pages/billing/bundles"));
  const webDir = new URL("../apps/web/src/pages/billing/", import.meta.url).pathname;
  ({ createRoot: mountRoot } = (await import(Bun.resolveSync("react-dom/client", webDir))) as {
    createRoot: (c: HTMLElement) => { render: (n: unknown) => void; unmount: () => void };
  });
});

afterAll(() => {
  mock.restore();
  globalThis.fetch = realFetch;
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  jsdomWindow?.close();
  jsdomWindow = null;
  if (previousActEnv) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnv);
  else delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  previousActEnv = undefined;
});

beforeAll(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

// --- harness ----------------------------------------------------------------

interface ApiCall {
  path: string;
  init?: RequestInit;
}

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let calls: ApiCall[] = [];
// Deferred gate: when set, POST /purchase responses wait until released, so
// pending-state guards (duplicate click) can be asserted deterministically.
let gatePost: ((call: ApiCall) => Promise<Response>) | null = null;

const realFetch = globalThis.fetch;
const mockFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const call: ApiCall = { path: String(input), init };
  calls.push(call);
  if ((init?.method ?? "GET") === "POST" && gatePost) return gatePost(call);
  return responder(call);
};

const responder = async (call: ApiCall): Promise<Response> => {
  const p = call.path;
  if (call.init?.method === "POST")
    return jsonRes(200, {
      id: "pay1",
      status: "pending",
      checkout_url: "/billing/payments?payment=pay1",
    });
  if (p.endsWith("/bundles"))
    return jsonRes(200, { data: [BUNDLE, BUNDLE2], usd_vnd_rate: 26_000 });
  if (p.endsWith("/subscription-plans"))
    return jsonRes(200, { data: [PLAN], usd_vnd_rate: 26_000 });
  if (p.endsWith("/throughput-products")) return jsonRes(200, { data: [PRODUCT] });
  if (p.endsWith("/payment-methods")) return jsonRes(200, { manual: true, payos: true });
  return jsonRes(200, {});
};

const BUNDLE = { id: "b1", name: "Starter", price_vnd: 50_000, credit_vnd: 50_000, bonus_vnd: 0 };
const BUNDLE2 = {
  id: "b2",
  name: "Value",
  price_vnd: 100_000,
  credit_vnd: 110_000,
  bonus_vnd: 10_000,
};
const PLAN = {
  id: "p1",
  name: "Pro",
  price_vnd: 200_000,
  credit_per_period_vnd: 250_000,
  period_days: 30,
  rate_limit_per_minute: 15,
};
const PRODUCT = {
  id: "tp1",
  name: "Turbo 30",
  price_vnd: 150_000,
  requests_per_minute: 30,
  duration_days: 7,
};

// Query/mutation state updates resolve on timers; running the flush inside
// act() keeps those React updates attributed to the test, not the void.
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

async function waitFor(cond: () => boolean, label: string, timeoutMs = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs)
      throw new Error(`waitFor timeout: ${label} | body=${bodyText().slice(0, 600)}`);
    await flush();
  }
}

const bodyText = () => document.body.textContent ?? "";

let roots: { unmount: () => void }[] = [];
// Last router/client created by mountPage; used to assert (non-)navigation
// and which cache entries a late completion invalidates.
let lastRouter: { state: { location: { pathname: string } } } | null = null;
let lastQc: QueryClient | null = null;

function mountPage() {
  calls = [];
  gatePost = null;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree: createRootRoute({ component: () => null }),
    history: createMemoryHistory({ initialEntries: ["/billing/bundles"] }),
  });
  lastRouter = router;
  lastQc = qc;
  const root = mountRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      <routerContext.Provider value={router}>
        <QueryClientProvider client={qc}>
          <BillingBundlesPage />
        </QueryClientProvider>
      </routerContext.Provider>,
    );
  });
  return container;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  await flush();
  document.body.innerHTML = "";
  calls = [];
  gatePost = null;
  setWorkspace("ws-test");
});

async function click(el: Element) {
  await act(async () => {
    // Radix TabsTrigger activates on mousedown; plain Buttons on click.
    el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flush();
  });
}

/** Click the visible (non-dialog) Select button inside the card named `name`. */
async function selectCard(productName: string) {
  const heading = [...document.body.querySelectorAll("*")].find(
    (el) => el.children.length === 0 && el.textContent === productName,
  );
  expect(heading).toBeDefined();
  // Scope to the product's own card: the panel holds one Select per card and
  // the first panel-wide match would pick the wrong product.
  const card = heading!.closest("[data-slot='card']");
  expect(card).not.toBeNull();
  const select = [...card!.querySelectorAll("button")].find(
    (b) => b.textContent === "Select" && !b.closest("[role='dialog']"),
  );
  expect(select).toBeDefined();
  await click(select!);
  await waitFor(() => bodyText().includes("Payment method"), `checkout for ${productName}`);
}

function dialogEl() {
  return document.body.querySelector("[role='dialog']");
}

async function tabTrigger(label: string) {
  const trigger = [...document.body.querySelectorAll("[role='tab']")].find(
    (t) => t.textContent === label,
  );
  expect(trigger).toBeDefined();
  await click(trigger!);
  await flush();
}

test("late completion after a workspace switch stays out of the new workspace", async () => {
  mountPage();
  await waitFor(() => bodyText().includes("Starter"), "bundles tab content");
  await selectCard("Starter");
  let release: (() => void) | null = null;
  gatePost = async (call) => {
    await new Promise<void>((r) => {
      release = r;
    });
    return responder(call);
  };
  const confirm = [...dialogEl()!.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").startsWith("Confirm purchase"),
  )!;
  await click(confirm);
  await flush();
  // The POST was dispatched against the workspace that confirmed it.
  const posted = calls.filter((c) => c.init?.method === "POST");
  expect(posted).toHaveLength(1);
  expect(posted[0]!.path).toBe("/api/v1/workspaces/ws-test/bundles/b1/purchase");

  // Seed payment history for both workspaces: the late completion must
  // refresh only the workspace the payment was created in.
  const qc = lastQc!;
  qc.setQueryData(["payments", "ws-test"], { marker: "old" });
  qc.setQueryData(["payments", "ws-2"], { marker: "new" });

  // Switch workspaces while the POST is in flight: the checkout belongs to
  // the previous workspace's catalog, so the dialog must close on its own.
  act(() => setWorkspace("ws-2"));
  await waitFor(() => dialogEl() === null, "dialog closed on workspace switch");

  // Release the old POST. The payment itself is never canceled or deleted —
  // but the stale completion must not surface it under the new workspace:
  // no navigation, no new requests for it.
  release!();
  await flush();
  await flush();
  expect(lastRouter!.state.location.pathname).toBe("/billing/bundles");
  expect(calls.filter((c) => c.init?.method === "POST")).toHaveLength(1);
  // History refresh used the captured workspace, not the active one: the old
  // payment can never appear as ws-2 data.
  expect(qc.getQueryState(["payments", "ws-test"])?.isInvalidated).toBe(true);
  expect(qc.getQueryState(["payments", "ws-2"])?.isInvalidated).toBe(false);
});

// --- tests ------------------------------------------------------------------

test("three tabs render; payment methods absent before any selection", async () => {
  mountPage();
  await waitFor(() => bodyText().includes("Starter"), "bundles tab content");
  expect([...document.body.querySelectorAll("[role='tab']")].map((t) => t.textContent)).toEqual([
    "Credit bundles",
    "Subscription plans",
    "Prepaid throughput",
  ]);
  expect(bodyText()).not.toContain("Payment method");
  // No checkout open: the /payment-methods query must not even start.
  expect(calls.filter((c) => c.path.endsWith("/payment-methods"))).toHaveLength(0);

  await tabTrigger("Subscription plans");
  await waitFor(() => bodyText().includes("Pro"), "plans tab content");
  expect(bodyText()).not.toContain("Payment method");

  await tabTrigger("Prepaid throughput");
  await waitFor(() => bodyText().includes("Turbo 30"), "throughput tab content");
  // Throughput disclaimer + allowance copy stay inside the throughput tab.
  expect(bodyText()).toContain("gateway admission limit");
  expect(bodyText()).not.toContain("Payment method");

  // Tab browsing still fires no payment-methods request and no purchases.
  expect(calls.filter((c) => c.path.endsWith("/payment-methods"))).toHaveLength(0);
  expect(calls.filter((c) => c.init?.method === "POST")).toHaveLength(0);
});

test("select opens the checkout dialog with product price and manual default; confirm posts `{}`", async () => {
  mountPage();
  await waitFor(() => bodyText().includes("Starter"), "bundles tab content");
  await selectCard("Starter");
  // Selection is what starts the payment-methods fetch (exactly once).
  expect(calls.filter((c) => c.path.endsWith("/payment-methods"))).toHaveLength(1);

  const dialog = dialogEl();
  expect(dialog).not.toBeNull();
  expect(dialog!.textContent).toContain("Starter");
  expect(dialog!.textContent).toContain("50.000");
  expect(dialog!.textContent).toContain("Payment method");
  const manual = dialog!.querySelector<HTMLInputElement>("input[value='manual']");
  expect(manual?.checked).toBe(true);
  const payos = dialog!.querySelector<HTMLInputElement>("input[value='payos']");
  expect(payos).not.toBeNull();

  const confirm = [...dialog!.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").startsWith("Confirm purchase"),
  );
  expect(confirm).toBeDefined();
  await click(confirm!);
  await waitFor(
    () => calls.some((c) => c.init?.method === "POST" && c.path.includes("/bundles/b1/purchase")),
    "bundle purchase POST",
  );
  const posted = calls.find((c) => c.init?.method === "POST")!;
  expect(posted.path).toBe("/api/v1/workspaces/ws-test/bundles/b1/purchase");
  expect(posted.init?.body).toBe("{}");
  // Same-workspace completion navigates to the payment's status page.
  await waitFor(() => lastRouter!.state.location.pathname === "/billing/payments", "navigate");
});

test("pending confirm ignores duplicate clicks (single POST)", async () => {
  mountPage();
  await waitFor(() => bodyText().includes("Starter"), "bundles tab content");
  await selectCard("Starter");
  let release: (() => void) | null = null;
  gatePost = async (call) => {
    await new Promise<void>((r) => {
      release = r;
    });
    return responder(call);
  };
  const confirm = [...dialogEl()!.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").startsWith("Confirm purchase"),
  )!;
  await click(confirm);
  await flush(); // mutation state settles in a microtask after the click
  expect((confirm as HTMLButtonElement).disabled).toBe(true);
  await click(confirm);
  await click(confirm);
  await flush();
  expect(calls.filter((c) => c.init?.method === "POST")).toHaveLength(1);
  release!();
  await flush();
});

test("switching tab clears selection: no stale checkout or payload", async () => {
  mountPage();
  await waitFor(() => bodyText().includes("Starter"), "bundles tab content");
  await selectCard("Starter");
  expect(dialogEl()).not.toBeNull();

  await tabTrigger("Subscription plans");
  // Dialog closed and selection cleared by the tab switch.
  expect(dialogEl()).toBeNull();

  await tabTrigger("Credit bundles");
  await selectCard("Value");
  const confirm = [...dialogEl()!.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").startsWith("Confirm purchase"),
  )!;
  await click(confirm);
  await waitFor(() => calls.some((c) => c.init?.method === "POST"), "purchase POST");
  const posted = calls.filter((c) => c.init?.method === "POST");
  expect(posted).toHaveLength(1);
  // The cleared Starter selection must never leak into the payload.
  expect(posted[0]!.path).toBe("/api/v1/workspaces/ws-test/bundles/b2/purchase");
});

test("selecting another product resets the provider choice to manual", async () => {
  mountPage();
  await waitFor(() => bodyText().includes("Starter"), "bundles tab content");
  await selectCard("Starter");
  const payosRadio = dialogEl()!.querySelector<HTMLInputElement>("input[value='payos']")!;
  await click(payosRadio);
  expect(payosRadio.checked).toBe(true);

  // Cancel closes the dialog.
  const cancel = [...dialogEl()!.querySelectorAll("button")].find(
    (b) => b.textContent === "Cancel",
  );
  expect(cancel).toBeDefined();
  await click(cancel!);
  await waitFor(() => dialogEl() === null, "dialog closed on cancel");

  // Selecting another product opens a fresh checkout: manual default again.
  await selectCard("Value");
  const freshManual = dialogEl()!.querySelector<HTMLInputElement>("input[value='manual']")!;
  const freshPayos = dialogEl()!.querySelector<HTMLInputElement>("input[value='payos']")!;
  expect(freshManual.checked).toBe(true);
  expect(freshPayos.checked).toBe(false);
});

test("payos confirm keeps the exact payload shape", async () => {
  mountPage();
  await waitFor(() => bodyText().includes("Starter"), "bundles tab content");
  await selectCard("Starter");
  await click(dialogEl()!.querySelector<HTMLInputElement>("input[value='payos']")!);
  const confirm = [...dialogEl()!.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").startsWith("Confirm purchase"),
  )!;
  await click(confirm);
  await waitFor(() => calls.some((c) => c.init?.method === "POST"), "purchase POST");
  const posted = calls.find((c) => c.init?.method === "POST")!;
  expect(posted.path).toBe("/api/v1/workspaces/ws-test/bundles/b1/purchase");
  expect(posted.init?.body).toBe('{"provider":"payos"}');
});

test("throughput purchase posts the throughput endpoint; plan posts subscription-plans", async () => {
  mountPage();
  await waitFor(() => bodyText().includes("Starter"), "bundles tab content");

  await tabTrigger("Prepaid throughput");
  await waitFor(() => bodyText().includes("Turbo 30"), "throughput tab content");
  await selectCard("Turbo 30");
  const tpConfirm = [...dialogEl()!.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").startsWith("Confirm purchase"),
  )!;
  await click(tpConfirm);
  // calls also holds the page's GET queries; only POSTs are purchase requests.
  const posts = () => calls.filter((c) => c.init?.method === "POST");
  await waitFor(() => posts().length >= 1, "throughput purchase POST");
  expect(posts()[0]!.path).toBe("/api/v1/workspaces/ws-test/throughput-products/tp1/purchase");
  expect(posts()[0]!.init?.body).toBe("{}");

  await tabTrigger("Subscription plans");
  await waitFor(() => bodyText().includes("Pro"), "plans tab content");
  await selectCard("Pro");
  // Not subscribed: subscription confirm label; the renewal wording is the
  // active-subscription status card's own flow, untouched here.
  const planConfirm = [...dialogEl()!.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").startsWith("Confirm subscription"),
  );
  expect(planConfirm).toBeDefined();
  await click(planConfirm!);
  await waitFor(() => posts().length === 2, "plan purchase POST");
  expect(posts()[1]!.path).toBe("/api/v1/workspaces/ws-test/subscription-plans/p1/purchase");
  expect(posts()[1]!.init?.body).toBe("{}");
});

// --- page-level display-currency control -----------------------------------
// One segmented USD/VND radiogroup beside the TabsList drives every section;
// the checkout dialog stays VND-authoritative regardless of the selection.

test("one display-currency control beside the tabs drives every section", async () => {
  mountPage();
  await waitFor(() => bodyText().includes("Starter"), "bundles tab content");
  const group = () => document.body.querySelector("[role='radiogroup']");
  // Exactly one control for the whole page: the per-section Show VND/USD
  // buttons are gone.
  expect(document.body.querySelectorAll("[role='radiogroup']")).toHaveLength(1);
  expect(document.body.querySelectorAll("[role='radio']")).toHaveLength(2);
  expect(group()!.getAttribute("aria-label")).toBe("Display currency");
  // USD default: bundle price leads with USD, VND integer secondary.
  const bundlePrice = () =>
    document.body.querySelector('[data-testid="price-b1"]')?.textContent ?? "";
  expect(bundlePrice()).toBe("$1.92"); // 50000 / 26000
  const selected = () => group()!.querySelector("[role='radio'][aria-checked='true']");
  expect(selected()!.textContent).toBe("USD");

  await click(
    [...group()!.querySelectorAll("[role='radio']")].find((r) => r.textContent === "VND")!,
  );
  // Every bundle price updates to VND; the primary line is the ledger truth.
  expect(bundlePrice()).toBe("50.000 ₫");
  expect(selected()!.textContent).toBe("VND");

  // The same hoisted state carries into the plans tab.
  await tabTrigger("Subscription plans");
  await waitFor(() => bodyText().includes("Pro"), "plans tab content");
  expect(document.body.querySelector('[data-testid="price-p1"]')?.textContent).toBe("200.000 ₫");
  expect(document.body.querySelectorAll("[role='radiogroup']")).toHaveLength(1);

  // Prepaid throughput is a VND-only product: the control hides there and no
  // USD option is suggested for it.
  await tabTrigger("Prepaid throughput");
  await waitFor(() => bodyText().includes("Turbo 30"), "throughput tab content");
  expect(document.body.querySelectorAll("[role='radiogroup']")).toHaveLength(0);

  // Back on bundles the selection is retained (same page state, not persisted).
  await tabTrigger("Credit bundles");
  expect(document.body.querySelectorAll("[role='radiogroup']")).toHaveLength(1);
  expect(bundlePrice()).toBe("50.000 ₫");
  expect(selected()!.textContent).toBe("VND");
});

test("checkout price stays VND-authoritative with the page in USD display", async () => {
  mountPage();
  await waitFor(() => bodyText().includes("Starter"), "bundles tab content");
  await selectCard("Starter");
  const dialog = dialogEl()!;
  // The dialog price is the ledger-truth VND amount (USD only as the small
  // secondary line), and the payload shape is untouched by the display.
  expect(dialog.querySelector('[data-testid="checkout-price"]')?.textContent).toBe("50.000 ₫");
  const confirm = [...dialog.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").startsWith("Confirm purchase"),
  )!;
  await click(confirm);
  await waitFor(() => calls.some((c) => c.init?.method === "POST"), "purchase POST");
  const posted = calls.find((c) => c.init?.method === "POST")!;
  expect(posted.init?.body).toBe("{}");
});
