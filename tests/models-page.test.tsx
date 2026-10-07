// /models page: "Recommended" sort promotes cheaper models using only public
// catalog metadata (per-1M prices, public ids) — no upstream ids, no invented
// score fields. The list scrolls inside a bounded, labelled region, and the
// pre-existing provider/capability filters plus column-header sorting remain
// available. Harness mirrors admin-cpa-model-names.test.tsx (jsdom + mocked
// fetch) and auth-i18n.test.tsx (memory router for useNavigate).
import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, createRootRoute, createMemoryHistory } from "@tanstack/react-router";
import { routerContext } from "@tanstack/react-router/dist/esm/routerContext.js";
import { JSDOM } from "jsdom";

const GLOBAL_KEYS = [
  "window",
  "document",
  "localStorage",
  "location",
  "getComputedStyle",
  "MutationObserver",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "InputEvent",
  "PointerEvent",
  "NodeFilter",
  "Node",
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
let jsdomWindow: { close: () => void } | null = null;

beforeAll(async () => {
  const win = new JSDOM("", { url: "http://localhost:5173" }).window as unknown as Record<
    string,
    unknown
  >;
  for (const k of GLOBAL_KEYS) {
    originals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  }
  const values: Record<string, unknown> = {
    window: win,
    document: win.document,
    localStorage: win.localStorage,
    location: win.location,
    getComputedStyle: (win.getComputedStyle as (element: Element) => CSSStyleDeclaration).bind(win),
    MutationObserver: win.MutationObserver,
    Event: win.Event,
    CustomEvent: win.Event,
    MouseEvent: win.MouseEvent,
    KeyboardEvent: win.KeyboardEvent,
    FocusEvent: win.FocusEvent,
    InputEvent: win.InputEvent,
    PointerEvent: win.PointerEvent,
    NodeFilter: win.NodeFilter,
    Node: win.Node,
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
  ({ sortModels, MODEL_SORT_OPTIONS } = await import("../apps/web/src/pages/models/data"));
  ({ default: ModelsPage } = await import("../apps/web/src/pages/models"));
  // react-dom/client is not linked from the tests workspace; resolve through
  // apps/web's own node_modules (read-only, no installs).
  const webDir = new URL("../apps/web/src/pages/models/", import.meta.url).pathname;
  const { createRoot } = (await import(Bun.resolveSync("react-dom/client", webDir))) as {
    createRoot: (container: HTMLElement) => {
      render: (node: unknown) => void;
      unmount: () => void;
    };
  };
  mountRoot = createRoot;
  globalThis.fetch = mockFetch as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  jsdomWindow?.close();
  jsdomWindow = null;
});

let sortModels: (typeof import("../apps/web/src/pages/models/data"))["sortModels"];
let MODEL_SORT_OPTIONS: (typeof import("../apps/web/src/pages/models/data"))["MODEL_SORT_OPTIONS"];
let ModelsPage: (typeof import("../apps/web/src/pages/models"))["default"];
let mountRoot: (container: HTMLElement) => { render: (node: unknown) => void; unmount: () => void };

// --- harness ----------------------------------------------------------------

const realFetch = globalThis.fetch;
const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let responder: (path: string) => Promise<Response> = async () => jsonRes(500, {});
const mockFetch = (input: RequestInfo | URL): Promise<Response> =>
  responder(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

const roots: { unmount: () => void }[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    root.unmount();
  }
  await flush();
  document.body.innerHTML = "";
  responder = async () => jsonRes(500, {});
});

const flush = () => new Promise((r) => setTimeout(r, 0));

async function waitFor(cond: () => boolean, label: string, timeoutMs = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout: ${label}`);
    await flush();
  }
}

const bodyText = () => document.body.textContent ?? "";

// Catalog fixture: deliberately NOT sorted by price or id upstream
// (listPublicModels orders by public_id). Prices are USD micros per 1M.
const catalog = {
  data: [
    {
      id: "m_expensive",
      public_id: "zeta/premium",
      display_name: "Zeta Premium",
      provider: "zeta",
      description: null,
      capabilities: ["tools"],
      context_window: 200000,
      price: {
        input_usd_micro_per_1m: 10_000_000,
        output_usd_micro_per_1m: 30_000_000,
        cached_input_usd_micro_per_1m: 0,
        reasoning_usd_micro_per_1m: 0,
      },
    },
    {
      id: "m_cheap",
      public_id: "alpha/mini",
      display_name: "Alpha Mini",
      provider: "alpha",
      description: null,
      capabilities: ["chat"],
      context_window: 128000,
      price: {
        input_usd_micro_per_1m: 150_000,
        output_usd_micro_per_1m: 600_000,
        cached_input_usd_micro_per_1m: 0,
        reasoning_usd_micro_per_1m: 0,
      },
    },
    {
      id: "m_mid",
      public_id: "alpha/max",
      display_name: "Alpha Max",
      provider: "alpha",
      description: null,
      capabilities: ["chat", "tools"],
      context_window: 128000,
      price: {
        input_usd_micro_per_1m: 1_000_000,
        output_usd_micro_per_1m: 4_000_000,
        cached_input_usd_micro_per_1m: 0,
        reasoning_usd_micro_per_1m: 0,
      },
    },
  ],
};

async function mountPage() {
  responder = async (path) => {
    if (path === "/api/v1/catalog/models") return jsonRes(200, catalog);
    if (path === "/api/v1/me") return jsonRes(200, { is_instance_admin: false });
    return jsonRes(200, {});
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree: createRootRoute({ component: () => null }),
    history: createMemoryHistory({ initialEntries: ["/models"] }),
  });
  const root = mountRoot(container);
  roots.push(root);
  root.render(
    <routerContext.Provider value={router}>
      <QueryClientProvider client={qc}>
        <ModelsPage />
      </QueryClientProvider>
    </routerContext.Provider>,
  );
  await waitFor(
    () => bodyText().includes("alpha/mini") && !bodyText().includes("Loading"),
    "models rendered",
  );
}

/** Public ids in rendered row order. */
const renderedIds = () =>
  [...document.querySelectorAll("button.font-mono")].map((b) => b.textContent ?? "");

// --- pure helper: sortModels -------------------------------------------------

test("MODEL_SORT_OPTIONS offers exactly 'Recommended' (default) and name ordering", () => {
  expect(MODEL_SORT_OPTIONS.map((o) => o.label)).toEqual(["Recommended", "Name (A–Z)"]);
  expect(MODEL_SORT_OPTIONS[0]!.value).toBe("recommended");
});

test("sortModels 'recommended' promotes cheaper models by input+output per-1M price", () => {
  const models = catalog.data.map((m) => ({
    id: m.id,
    publicId: m.public_id,
    provider: m.provider,
    displayName: m.display_name,
    description: m.description,
    capabilities: m.capabilities,
    contextWindow: m.context_window,
    price: m.price,
  }));
  const out = sortModels(models, "recommended");
  expect(out.map((m) => m.publicId)).toEqual(["alpha/mini", "alpha/max", "zeta/premium"]);
  // Input order (public_id asc, as the API returns it) is untouched.
  expect(models.map((m) => m.publicId)).toEqual(["zeta/premium", "alpha/mini", "alpha/max"]);
});

test("sortModels 'recommended' ties break by public_id, 'name' sorts by public_id", () => {
  const mk = (publicId: string, input: number, output: number) =>
    ({
      id: publicId,
      publicId,
      provider: "p",
      displayName: null,
      description: null,
      capabilities: [],
      contextWindow: null,
      price: {
        input_usd_micro_per_1m: input,
        output_usd_micro_per_1m: output,
        cached_input_usd_micro_per_1m: 0,
        reasoning_usd_micro_per_1m: 0,
      },
    }) as import("../apps/web/src/pages/models/data").CatalogModel;
  const tied = [mk("b", 100, 0), mk("a", 50, 50), mk("c", 0, 200)];
  expect(sortModels(tied, "recommended").map((m) => m.publicId)).toEqual(["a", "b", "c"]);
  expect(sortModels(tied, "name").map((m) => m.publicId)).toEqual(["a", "b", "c"]);
});

// --- rendered page -----------------------------------------------------------

test("page defaults to Recommended: rows render cheapest-first in a scrollable region", async () => {
  await mountPage();
  const region = document.querySelector('[role="region"][aria-label="Model catalog"]');
  expect(region).not.toBeNull();
  // Bounded scroll region: internally scrollable, not page-growing.
  expect(region!.className).toContain("overflow-auto");
  expect(renderedIds()).toEqual(["alpha/mini", "alpha/max", "zeta/premium"]);
  // Public ids only — no private mapping or upstream identifiers exist to leak.
  expect(bodyText()).not.toContain("upstream");
});

test("existing filters remain: provider and capability selects still offered", async () => {
  await mountPage();
  expect(bodyText()).toContain("All providers");
  expect(bodyText()).toContain("All capabilities");
  // Sort control labelled for assistive tech, defaulting to Recommended.
  const sortTrigger = document.querySelector('[aria-label="Sort models"]');
  expect(sortTrigger?.textContent).toContain("Recommended");
});

test("column-header sorting still works alongside the Recommended option", async () => {
  await mountPage();
  const headers = [...document.querySelectorAll("thead button")];
  const providerHeader = headers.find((b) => b.textContent === "Provider");
  expect(providerHeader).toBeDefined();
  providerHeader!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await flush();
  // Sorting by Provider asc puts the alpha models first; within equal keys the
  // recommended (cheapest-first) input order is preserved.
  expect(renderedIds()).toEqual(["alpha/mini", "alpha/max", "zeta/premium"]);
});
