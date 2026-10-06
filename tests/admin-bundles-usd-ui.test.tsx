// Admin catalog editor per-field currency contract (jsdom, real React, mocked
// fetch only):
// - every amount field (bundle price/credit/bonus, plan price and per-period
//   credit) owns an independent USD/VND selector; USD is the default;
// - each field submits exactly one key: its USD decimal string verbatim or
//   its VND safe integer — so mixed bodies (price_usd + credit_vnd) are
//   legal and no fabricated USD metadata is ever sent;
// - invalid amount text is blocked client-side before any POST;
// - toggling one field's currency never changes another field's;
// - table shows authored USD prices and each credit field using its OWN USD
//   metadata (not the price currency); legacy rows keep plain VND display;
// - rename / active / rate-limit behavior is unchanged.
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
  "getComputedStyle",
  "MutationObserver",
  "CustomEvent",
  "localStorage",
] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;
type EventCtor<T, I> = new (type: string, init?: I) => T;
interface JsdomRealm {
  Event: EventCtor<Event, EventInit>;
  MouseEvent: EventCtor<MouseEvent, MouseEventInit>;
  document: Document;
  Node: typeof Node;
  Element: typeof Element;
  HTMLElement: typeof HTMLElement;
  HTMLInputElement: typeof HTMLInputElement;
  getComputedStyle: typeof getComputedStyle;
  MutationObserver: typeof MutationObserver;
  CustomEvent: EventCtor<CustomEvent, CustomEventInit>;
  localStorage: Storage;
  close: () => void;
}
const W = new JSDOM("", { url: "http://localhost:5173" }).window as unknown as JsdomRealm;

for (const k of GLOBAL_KEYS) originals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
for (const [k, v] of Object.entries({
  window: W,
  document: W.document,
  Node: W.Node,
  Element: W.Element,
  HTMLElement: W.HTMLElement,
  HTMLInputElement: W.HTMLInputElement,
  getComputedStyle: W.getComputedStyle,
  MutationObserver: W.MutationObserver,
  CustomEvent: W.CustomEvent,
  localStorage: W.localStorage,
})) {
  (globalThis as Record<string, unknown>)[k] = v;
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
jsdomWindow = W;

// @ts-expect-error relative specifier has no declaration file under tests tsconfig
const { createRoot } = await import("../apps/web/node_modules/react-dom/client");
const AdminBundlesPage = (await import("../apps/web/src/pages/admin/bundles")).default;

// --- harness -------------------------------------------------------------

interface FetchCall {
  url: string;
  method?: string;
  body: Record<string, unknown> | null;
}

type FetchHandler = (url: string, init: RequestInit | undefined) => Promise<Response>;

const SEED_BUNDLES = {
  data: [
    {
      id: "b_usd",
      name: "USD pack",
      price_vnd: 259_750,
      credit_vnd: 312_012,
      bonus_vnd: 0,
      price_usd: "9.99",
      credit_usd: "12",
      bonus_usd: "0",
      active: true,
      created_at: 1,
    },
    {
      id: "b_vnd",
      name: "Legacy pack",
      price_vnd: 500_000,
      credit_vnd: 500_000,
      bonus_vnd: 0,
      active: true,
      created_at: 2,
    },
    {
      id: "b_mixed",
      name: "Mixed pack",
      price_vnd: 300_000,
      credit_vnd: 130_005,
      bonus_vnd: 0,
      price_usd: "12.5",
      credit_usd: null,
      bonus_usd: null,
      active: true,
      created_at: 4,
    },
    {
      id: "b_mixed2",
      name: "Mixed grant pack",
      price_vnd: 259_750,
      credit_vnd: 312_012,
      bonus_vnd: 26_000,
      price_usd: "9.99",
      credit_usd: "12",
      bonus_usd: null,
      active: true,
      created_at: 5,
    },
  ],
};

const SEED_PLANS = {
  data: [
    {
      id: "p_usd",
      name: "USD plan",
      price_vnd: 259_750,
      credit_per_period_vnd: 312_012,
      period_days: 30,
      rate_limit_per_minute: 15,
      price_usd: "9.99",
      credit_per_period_usd: "12",
      active: true,
      created_at: 3,
    },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);

  const fetchCalls: FetchCall[] = [];
  let handler: FetchHandler = async (url) => {
    if (url.includes("/admin/bundles")) return jsonResponse(200, SEED_BUNDLES);
    if (url.includes("/admin/subscription-plans")) return jsonResponse(200, SEED_PLANS);
    return jsonResponse(200, {});
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    fetchCalls.push({
      url: String(url),
      method: init?.method,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    });
    return handler(String(url), init);
  }) as typeof fetch;

  const render = () =>
    act(() => {
      root.render(
        <QueryClientProvider client={qc}>
          <AdminBundlesPage />
        </QueryClientProvider>,
      );
    });
  render();

  const settle = async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  };

  const h = {
    container,
    fetchCalls,
    setFetch: (fn: FetchHandler) => {
      handler = fn;
    },
    async waitForData() {
      for (let i = 0; i < 20; i++) {
        if (h.container.textContent?.includes("Legacy pack")) return;
        await settle();
      }
      throw new Error(`admin catalog data never rendered: ${h.container.textContent}`);
    },
    async typeInto(inputId: string, value: string) {
      // Dialog content mounts in a Radix portal on document.body, so query
      // the document, not the mounted container.
      const el = document.querySelector<HTMLInputElement>(`#${inputId}`);
      if (!el) throw new Error(`input not found: #${inputId}`);
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(W.HTMLInputElement.prototype, "value")!.set!;
        setter.call(el, value);
        el.dispatchEvent(new W.Event("input", { bubbles: true }));
      });
    },
    async clickButton(label: string) {
      const btn = [...document.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === label,
      );
      if (!btn) throw new Error(`button not found: ${label}`);
      await act(async () => {
        btn.dispatchEvent(new W.MouseEvent("click", { bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 0));
      });
    },
    /** Click USD/VND inside one field's own toggle group (unique aria-label). */
    async clickCurrency(groupLabel: string, currency: "USD" | "VND") {
      const group = h.container.querySelector(`div[role="group"][aria-label="${groupLabel}"]`);
      if (!group) throw new Error(`currency group not found: ${groupLabel}`);
      const btn = [...group.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === currency,
      );
      if (!btn) throw new Error(`currency button not found: ${groupLabel}/${currency}`);
      await act(async () => {
        btn.dispatchEvent(new W.MouseEvent("click", { bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 0));
      });
    },
    /** aria-pressed state of one currency button inside a toggle group. */
    currencyPressed(groupLabel: string, currency: "USD" | "VND"): boolean {
      const group = h.container.querySelector(`div[role="group"][aria-label="${groupLabel}"]`);
      if (!group) throw new Error(`currency group not found: ${groupLabel}`);
      const btn = [...group.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === currency,
      );
      if (!btn) throw new Error(`currency button not found: ${groupLabel}/${currency}`);
      return btn.getAttribute("aria-pressed") === "true";
    },
    /** The form submit button whose text contains the given prefix (excludes toggles). */
    submitButton(submitText: string) {
      const btn = [...document.querySelectorAll('button[type="submit"]')].find((b) =>
        b.textContent?.includes(submitText),
      );
      if (!btn) throw new Error(`submit button not found: ${submitText}`);
      return btn;
    },
    async submit(submitText: string) {
      const btn = h.submitButton(submitText);
      await act(async () => {
        btn.dispatchEvent(new W.MouseEvent("click", { bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 0));
      });
    },
    postsTo(url: string) {
      return fetchCalls.filter((c) => c.url === url && c.method === "POST");
    },
    patchesTo(url: string) {
      return fetchCalls.filter((c) => c.url.startsWith(url) && c.method === "PATCH");
    },
    cleanup() {
      act(() => root.unmount());
      container.remove();
      globalThis.fetch = realFetch;
    },
  };
  return h;
}

/**
 * Radix FocusScope's unmount cleanup schedules a setTimeout(0) that dispatches
 * a CustomEvent built from the global realm into the mounted document. Await
 * those ticks while the jsdom globals are still installed, or the pending
 * dispatch fires after restoration and fails the realm check.
 */
async function flushPendingRealmEvents() {
  for (let i = 0; i < 2; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  document.body.innerHTML = "";
}

afterAll(async () => {
  await flushPendingRealmEvents();
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  jsdomWindow?.close();
  jsdomWindow = null;
});

// --- USD default mode ------------------------------------------------------

test("USD is the default currency; USD bundle POST body is exact", async () => {
  const h = mount();
  try {
    await h.waitForData();
    // Accessible label association: label[for] resolves to the input.
    for (const id of ["bundle-price-usd", "bundle-credit-usd", "bundle-bonus-usd"]) {
      const label = h.container.querySelector<HTMLLabelElement>(`label[for="${id}"]`);
      expect(label).not.toBeNull();
      expect(h.container.querySelector(`#${id}`)).not.toBeNull();
    }
    expect(h.container.textContent).not.toContain("Price (VND)");

    await h.typeInto("bundle-name", "Starter");
    await h.typeInto("bundle-price-usd", "9.99");
    await h.typeInto("bundle-credit-usd", "12");
    // bonus left at its default "0"
    await h.submit("Create bundle");
    const posts = h.postsTo("/api/v1/admin/bundles");
    expect(posts.length).toBe(1);
    expect(posts[0]!.body).toEqual({
      name: "Starter",
      price_usd: "9.99",
      credit_usd: "12",
      bonus_usd: "0",
    });
  } finally {
    h.cleanup();
  }
});

test("invalid USD decimals blocked before any POST", async () => {
  const h = mount();
  try {
    await h.waitForData();
    await h.typeInto("bundle-name", "Starter");
    for (const bad of ["", "0", "1.001", "1e2", "-5", "abc", ".5"]) {
      await h.typeInto("bundle-price-usd", bad);
      await h.submit("Create bundle");
      expect(h.postsTo("/api/v1/admin/bundles").length).toBe(0);
    }
    // Valid amounts, invalid credit: still blocked.
    await h.typeInto("bundle-price-usd", "5");
    for (const bad of ["-1", "2.5.5"]) {
      await h.typeInto("bundle-credit-usd", bad);
      await h.submit("Create bundle");
      expect(h.postsTo("/api/v1/admin/bundles").length).toBe(0);
    }
  } finally {
    h.cleanup();
  }
});

// --- plans -----------------------------------------------------------------

test("USD plan POST body is exact and preserves period/rate controls", async () => {
  const h = mount();
  try {
    await h.waitForData();
    for (const id of ["plan-price-usd", "plan-credit-usd", "plan-period", "plan-rate"]) {
      const label = h.container.querySelector<HTMLLabelElement>(`label[for="${id}"]`);
      expect(label).not.toBeNull();
      expect(h.container.querySelector(`#${id}`)).not.toBeNull();
    }
    await h.typeInto("plan-name", "Monthly");
    await h.typeInto("plan-price-usd", "5");
    await h.typeInto("plan-credit-usd", "12");
    await h.typeInto("plan-period", "30");
    await h.typeInto("plan-rate", "15");
    await h.submit("Create plan");
    const posts = h.postsTo("/api/v1/admin/subscription-plans");
    expect(posts.length).toBe(1);
    expect(posts[0]!.body).toEqual({
      name: "Monthly",
      price_usd: "5",
      credit_per_period_usd: "12",
      period_days: 30,
      rate_limit_per_minute: 15,
    });
  } finally {
    h.cleanup();
  }
});

test("explicit legacy VND mode posts the unchanged integer body", async () => {
  const h = mount();
  try {
    await h.waitForData();
    await h.clickCurrency("Price currency", "VND");
    expect(h.container.textContent).toContain("Price (VND)");
    expect(h.container.querySelector("#bundle-price-usd")).toBeNull();
    await h.clickCurrency("Credit currency", "VND");
    await h.clickCurrency("Bonus currency", "VND");

    await h.typeInto("bundle-name", "Legacy");
    await h.typeInto("bundle-price-vnd", "500000");
    await h.typeInto("bundle-credit-vnd", "500000");
    await h.typeInto("bundle-bonus-vnd", "10000");
    await h.submit("Create bundle");
    const posts = h.postsTo("/api/v1/admin/bundles");
    expect(posts.length).toBe(1);
    expect(posts[0]!.body).toEqual({
      name: "Legacy",
      price_vnd: 500_000,
      credit_vnd: 500_000,
      bonus_vnd: 10_000,
    });
  } finally {
    h.cleanup();
  }
});

// --- independent per-field selectors and mixed bodies -----------------------

test("toggling one field's currency leaves the other fields in USD", async () => {
  const h = mount();
  try {
    await h.waitForData();
    expect(h.currencyPressed("Price currency", "USD")).toBe(true);
    await h.clickCurrency("Price currency", "VND");
    // Only the price field flipped; credit and bonus selectors untouched.
    expect(h.currencyPressed("Price currency", "VND")).toBe(true);
    expect(h.currencyPressed("Credit currency", "USD")).toBe(true);
    expect(h.currencyPressed("Bonus currency", "USD")).toBe(true);
    expect(h.container.querySelector("#bundle-price-usd")).toBeNull();
    expect(h.container.querySelector("#bundle-credit-usd")).not.toBeNull();
    expect(h.container.querySelector("#bundle-price-vnd")).not.toBeNull();

    // Toggling back restores the retained USD text, not a blank field.
    await h.typeInto("bundle-price-vnd", "500000");
    await h.clickCurrency("Price currency", "USD");
    await h.typeInto("bundle-price-usd", "9.99");
    await h.clickCurrency("Price currency", "VND");
    const el = h.container.querySelector<HTMLInputElement>("#bundle-price-vnd");
    expect(el?.value).toBe("500000");
  } finally {
    h.cleanup();
  }
});

test("mixed bundle body: USD price, VND credit, USD bonus, no fabricated USD metadata", async () => {
  const h = mount();
  try {
    await h.waitForData();
    await h.clickCurrency("Credit currency", "VND");
    await h.typeInto("bundle-name", "Mixed");
    await h.typeInto("bundle-price-usd", "9.99");
    await h.typeInto("bundle-credit-vnd", "300000");
    // bonus stays USD at its default "0"
    await h.submit("Create bundle");
    const posts = h.postsTo("/api/v1/admin/bundles");
    expect(posts.length).toBe(1);
    expect(posts[0]!.body).toEqual({
      name: "Mixed",
      price_usd: "9.99",
      credit_vnd: 300_000,
      bonus_usd: "0",
    });
    // The USD text is sent verbatim; no float-derived value anywhere.
    expect(JSON.stringify(posts[0]!.body)).toContain('"price_usd":"9.99"');
  } finally {
    h.cleanup();
  }
});

test("mixed plan body: VND price with USD per-period credit", async () => {
  const h = mount();
  try {
    await h.waitForData();
    await h.clickCurrency("Plan price currency", "VND");
    await h.typeInto("plan-name", "Mixed plan");
    await h.typeInto("plan-price-vnd", "200000");
    await h.typeInto("plan-credit-usd", "12");
    await h.typeInto("plan-period", "30");
    await h.submit("Create plan");
    const posts = h.postsTo("/api/v1/admin/subscription-plans");
    expect(posts.length).toBe(1);
    expect(posts[0]!.body).toEqual({
      name: "Mixed plan",
      price_vnd: 200_000,
      credit_per_period_usd: "12",
      period_days: 30,
      rate_limit_per_minute: 15,
    });
  } finally {
  }
});

test("invalid VND text is blocked before any POST, per field", async () => {
  const h = mount();
  try {
    await h.waitForData();
    await h.clickCurrency("Price currency", "VND");
    await h.typeInto("bundle-name", "Starter");
    await h.typeInto("bundle-price-vnd", "500.5");
    await h.submit("Create bundle");
    expect(h.postsTo("/api/v1/admin/bundles").length).toBe(0);
    // Negative price violates the sign rule client-side too.
    await h.typeInto("bundle-price-vnd", "-5");
    await h.submit("Create bundle");
    expect(h.postsTo("/api/v1/admin/bundles").length).toBe(0);
    await h.typeInto("bundle-price-vnd", "500000");
    await h.clickCurrency("Credit currency", "VND");
    await h.typeInto("bundle-credit-vnd", "-1");
    await h.submit("Create bundle");
    expect(h.postsTo("/api/v1/admin/bundles").length).toBe(0);
  } finally {
    h.cleanup();
  }
});

test("table shows authored USD price and creation-frozen VND grant", async () => {
  const h = mount();
  try {
    await h.waitForData();
    const text = h.container.textContent ?? "";
    // Authored USD price displayed exactly, VND grant labeled as frozen.
    expect(text).toContain("$9.99");
    expect(text).toContain("312.012 ₫");
    expect(text.toLowerCase()).toContain("fixed at creation");
    // Legacy VND row keeps its plain VND display, no USD text.
    expect(text).toContain("500.000 ₫");
    const legacyCell = h.container.querySelector('[data-testid="row-b_vnd-price"]');
    if (legacyCell) expect(legacyCell.textContent).not.toContain("$");
  } finally {
    h.cleanup();
  }
});

test("mixed rows render each credit field with its own USD metadata", async () => {
  const h = mount();
  try {
    await h.waitForData();
    const text = h.container.textContent ?? "";
    // VND-credit row with a USD price: credit shown in VND, no fabricated
    // USD grant text, price still shows the exact authored USD text.
    expect(text).toContain("$12.50");
    expect(text).toContain("130.005 ₫");
    // VND bonus under a USD-credit row: bonus follows its own metadata.
    expect(text).toContain("+ 26.000 ₫ bonus");
    expect(text).toContain("$9.99");
  } finally {
    h.cleanup();
  }
});

// --- preserved behaviors ---------------------------------------------------

test("rename and active toggles PATCH unchanged bodies", async () => {
  const h = mount();
  try {
    await h.waitForData();
    await h.clickButton("Rename");
    await h.typeInto("rename-name", "Renamed pack");
    await h.clickButton("Save");
    await h.waitForData();
    const patches = h.patchesTo("/api/v1/admin/bundles");
    expect(patches.some((p) => p.body?.name === "Renamed pack")).toBe(true);

    await h.clickButton("Deactivate");
    await h.waitForData();
    const patches2 = h.patchesTo("/api/v1/admin/bundles");
    expect(patches2.some((p) => p.body?.active === false)).toBe(true);
  } finally {
    h.cleanup();
  }
});
