// Admin catalog edit dialog contract (jsdom, real React, mocked fetch only):
// - one Edit action per catalog row opens a dialog prefilled from the
//   captured row's current server state;
// - metadata edits (name, plan rate limit) go through the existing PATCH
//   endpoint; any financial-terms change goes through POST .../revise with
//   the full create-shape body (exact authored USD text verbatim, integer
//   VND, no rate_limit_per_minute in a revise body);
// - an unchanged (no-op) or invalid dialog submits nothing;
// - a 409 RESOURCE_SUPERSEDED renders the bilingual superseded message
//   instead of a silent failure;
// - double submit while a revise is in flight issues exactly one POST.
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
    /** Click the Edit button inside the table row containing the given text. */
    async clickRowEdit(rowName: string) {
      const tr = [...document.querySelectorAll("tbody tr")].find((r) =>
        r.textContent?.includes(rowName),
      );
      if (!tr) throw new Error(`row not found: ${rowName}`);
      const btn = [...tr.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Edit");
      if (!btn) throw new Error(`edit button not found in row: ${rowName}`);
      await act(async () => {
        btn.dispatchEvent(new W.MouseEvent("click", { bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 0));
      });
    },
    /** Dispatch click(s) on one button without awaiting between dispatches. */
    async rawClicks(label: string, count: number) {
      const btn = [...document.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === label,
      );
      if (!btn) throw new Error(`button not found: ${label}`);
      await act(async () => {
        for (let i = 0; i < count; i++) {
          btn.dispatchEvent(new W.MouseEvent("click", { bubbles: true, cancelable: true }));
        }
        await new Promise((r) => setTimeout(r, 0));
      });
    },
    postsTo(url: string) {
      return fetchCalls.filter((c) => c.url === url && c.method === "POST");
    },
    patchesTo(url: string) {
      return fetchCalls.filter((c) => c.url.startsWith(url) && c.method === "PATCH");
    },
    async cleanup() {
      // Stop in-flight queries and drain React Query's batched notifications
      // while the jsdom realm is still installed, then unmount and clear the
      // client so no scheduled callback (React's scheduler reads
      // `window.event`) can fire after the globals are restored.
      await act(async () => {
        await qc.cancelQueries();
      });
      act(() => root.unmount());
      qc.clear();
      container.remove();
      globalThis.fetch = realFetch;
      await act(async () => {
        for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
      });
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
  // Drain React's MessageChannel-scheduled callbacks while the realm is
  // installed: a pending NormalPriority callback reads `window.event` and
  // would crash after the globals are restored (only surfaces when a later
  // test file yields the event loop first).
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  jsdomWindow?.close();
  jsdomWindow = null;
});

// --- prefill -------------------------------------------------------------

test("one Edit action opens the dialog prefilled from the captured row", async () => {
  const h = mount();
  try {
    await h.waitForData();
    await h.clickRowEdit("USD pack");
    // Bundle fields prefilled from the row's own authored values.
    expect((document.querySelector("#edit-name") as HTMLInputElement).value).toBe("USD pack");
    expect((document.querySelector("#edit-price-usd") as HTMLInputElement).value).toBe("9.99");
    expect((document.querySelector("#edit-credit-usd") as HTMLInputElement).value).toBe("12");
    expect((document.querySelector("#edit-bonus-usd") as HTMLInputElement).value).toBe("0");
    // Legacy VND row prefills VND text, not a fabricated USD value.
    await h.clickButton("Cancel");
    await h.waitForData();
    await h.clickRowEdit("Legacy pack");
    expect((document.querySelector("#edit-name") as HTMLInputElement).value).toBe("Legacy pack");
    expect((document.querySelector("#edit-price-vnd") as HTMLInputElement).value).toBe("500000");
    expect(document.querySelector("#edit-price-usd")).toBeNull();
  } finally {
    await h.cleanup();
  }
});

test("plan edit dialog prefills name, rate limit and period", async () => {
  const h = mount();
  try {
    await h.waitForData();
    await h.clickRowEdit("USD plan");
    expect((document.querySelector("#edit-name") as HTMLInputElement).value).toBe("USD plan");
    expect((document.querySelector("#edit-rate") as HTMLInputElement).value).toBe("15");
    expect((document.querySelector("#edit-period") as HTMLInputElement).value).toBe("30");
  } finally {
    await h.cleanup();
  }
});

// --- routing: revise POST vs metadata PATCH -------------------------------

test("money fields issue a revise POST with the full create body, not PATCH", async () => {
  const h = mount();
  try {
    await h.waitForData();
    await h.clickRowEdit("USD pack");
    await h.typeInto("edit-price-usd", "19.99");
    // Financial change shows the future-only terms confirmation.
    expect(document.body.textContent).toContain("future purchases only");
    await h.clickButton("Revise terms");
    await h.waitForData();
    const posts = h.postsTo("/api/v1/admin/bundles/b_usd/revise");
    expect(posts.length).toBe(1);
    expect(posts[0]!.body).toEqual({
      name: "USD pack",
      price_usd: "19.99",
      credit_usd: "12",
      bonus_usd: "0",
    });
    expect(h.patchesTo("/api/v1/admin/bundles").length).toBe(0);
  } finally {
    await h.cleanup();
  }
});

test("metadata-only name edit issues PATCH, never a revise POST", async () => {
  const h = mount();
  try {
    await h.waitForData();
    await h.clickRowEdit("USD pack");
    await h.typeInto("edit-name", "Renamed pack");
    await h.clickButton("Save");
    await h.waitForData();
    const patches = h.patchesTo("/api/v1/admin/bundles");
    expect(patches.some((p) => p.body?.name === "Renamed pack")).toBe(true);
    expect(h.postsTo("/api/v1/admin/bundles/b_usd/revise").length).toBe(0);
  } finally {
    await h.cleanup();
  }
});

test("plan rate limit is a live PATCH field and never enters a revise body", async () => {
  const h = mount();
  try {
    await h.waitForData();
    await h.clickRowEdit("USD plan");
    await h.typeInto("edit-rate", "30");
    await h.clickButton("Save");
    await h.waitForData();
    const patches = h.patchesTo("/api/v1/admin/subscription-plans");
    expect(patches.some((p) => p.body?.rate_limit_per_minute === 30)).toBe(true);
    expect(h.postsTo("/api/v1/admin/subscription-plans/p_usd/revise").length).toBe(0);

    // Financial change on a plan: full create shape, no rate_limit key.
    await h.clickRowEdit("USD plan");
    await h.typeInto("edit-price-usd", "14.50");
    await h.clickButton("Revise terms");
    await h.waitForData();
    const posts = h.postsTo("/api/v1/admin/subscription-plans/p_usd/revise");
    expect(posts.length).toBe(1);
    expect(posts[0]!.body).toEqual({
      name: "USD plan",
      price_usd: "14.50",
      credit_per_period_usd: "12",
      period_days: 30,
    });
    expect(JSON.stringify(posts[0]!.body)).not.toContain("rate_limit");
  } finally {
    await h.cleanup();
  }
});

test("rate change alongside a financial change PATCHes the successor row", async () => {
  const h = mount();
  try {
    await h.waitForData();
    h.setFetch(async (url) => {
      if (url.includes("/revise"))
        return jsonResponse(201, { data: { id: "p_successor", name: "USD plan" } });
      if (url.includes("/admin/subscription-plans")) return jsonResponse(200, SEED_PLANS);
      if (url.includes("/admin/bundles")) return jsonResponse(200, SEED_BUNDLES);
      return jsonResponse(200, {});
    });
    await h.waitForData();
    await h.clickRowEdit("USD plan");
    await h.typeInto("edit-price-usd", "14.50");
    await h.typeInto("edit-rate", "45");
    await h.clickButton("Revise terms");
    await h.waitForData();
    expect(h.postsTo("/api/v1/admin/subscription-plans/p_usd/revise").length).toBe(1);
    const patches = h.patchesTo("/api/v1/admin/subscription-plans");
    expect(patches.some((p) => p.url.endsWith("/p_successor"))).toBe(true);
    expect(
      patches.some((p) => p.url.endsWith("/p_successor") && p.body?.rate_limit_per_minute === 45),
    ).toBe(true);
  } finally {
    await h.cleanup();
  }
});

// --- no-op / invalid edits submit nothing ---------------------------------

test("no-op and invalid edits submit nothing", async () => {
  const h = mount();
  try {
    await h.waitForData();
    await h.clickRowEdit("USD pack");
    // Unchanged dialog: save disabled, no fake POST.
    const save = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Save" || b.textContent?.trim() === "Revise terms",
    );
    expect(save?.disabled).toBe(true);
    await h.rawClicks(save?.textContent?.trim() ?? "Save", 1);
    expect(h.fetchCalls.filter((c) => c.method === "POST" || c.method === "PATCH").length).toBe(0);

    // Invalid money text: still nothing submitted.
    await h.typeInto("edit-price-usd", "1.001");
    await h.clickButton("Revise terms");
    expect(h.fetchCalls.filter((c) => c.method === "POST" || c.method === "PATCH").length).toBe(0);
  } finally {
    await h.cleanup();
  }
});

// --- backend error reasons -------------------------------------------------

test("409 RESOURCE_SUPERSEDED shows the superseded message, not a silent failure", async () => {
  const h = mount();
  try {
    await h.waitForData();
    h.setFetch(async (url) => {
      if (url.includes("/revise"))
        return jsonResponse(409, {
          error: { code: "RESOURCE_SUPERSEDED", message: "already superseded" },
        });
      if (url.includes("/admin/bundles")) return jsonResponse(200, SEED_BUNDLES);
      if (url.includes("/admin/subscription-plans")) return jsonResponse(200, SEED_PLANS);
      return jsonResponse(200, {});
    });
    await h.waitForData();
    await h.clickRowEdit("USD pack");
    await h.typeInto("edit-price-usd", "19.99");
    await h.clickButton("Revise terms");
    await h.waitForData();
    expect(document.body.textContent).toContain("already superseded by another revision");
    expect(h.postsTo("/api/v1/admin/bundles/b_usd/revise").length).toBe(1);
  } finally {
    await h.cleanup();
  }
});

// --- pending guard ---------------------------------------------------------

test("double submit while a revise is in flight issues exactly one POST", async () => {
  const h = mount();
  try {
    await h.waitForData();
    let resolveRevise: (() => void) | null = null;
    h.setFetch(async (url) => {
      if (url.includes("/revise")) {
        await new Promise<void>((r) => {
          resolveRevise = r;
        });
        return jsonResponse(201, { data: { id: "b_successor" } });
      }
      if (url.includes("/admin/bundles")) return jsonResponse(200, SEED_BUNDLES);
      if (url.includes("/admin/subscription-plans")) return jsonResponse(200, SEED_PLANS);
      return jsonResponse(200, {});
    });
    await h.clickRowEdit("USD pack");
    await h.typeInto("edit-price-usd", "19.99");
    await h.rawClicks("Revise terms", 2);
    expect(h.postsTo("/api/v1/admin/bundles/b_usd/revise").length).toBe(1);
    resolveRevise!();
    await h.waitForData();
  } finally {
    await h.cleanup();
  }
});
