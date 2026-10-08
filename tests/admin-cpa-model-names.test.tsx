// Admin CPA model list shows ORIGINAL upstream model IDs, not aliases or
// display names. Contract evidence:
// - CPA's /v1/models (proxied by GET /api/v1/admin/cpa/models) returns
//   client-visible alias IDs when oauth model aliases are configured.
// - The redacted management proxy GET /api/v1/admin/cpa/management/config
//   returns CPA's config JSON including oauth."model-alias" entries with the
//   original upstream `name` plus `alias` / `display-name` (yaml-style keys,
//   same shape admin-cpa-mutations.ts sends to PATCH /v0/management/oauth-model-alias).
// The page resolves alias/display-name IDs back to original names for display
// only — no upstream mutation. If the config read fails or has no aliases,
// IDs render exactly as CPA reported them.
import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
    CustomEvent: win.CustomEvent,
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
  ({ aliasToOriginalMap, ModelMappingsCard } = await import("../apps/web/src/pages/admin/cpa"));
  ({ createRoot } = await import("react-dom/client"));
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

let aliasToOriginalMap: (typeof import("../apps/web/src/pages/admin/cpa"))["aliasToOriginalMap"];
let ModelMappingsCard: (typeof import("../apps/web/src/pages/admin/cpa"))["ModelMappingsCard"];
let createRoot: (typeof import("react-dom/client"))["createRoot"];
type Root = import("react-dom/client").Root;

// --- harness ----------------------------------------------------------------

const realFetch = globalThis.fetch;
interface FetchCall {
  path: string;
  init?: RequestInit;
}
let calls: FetchCall[] = [];
let responder: (call: FetchCall) => Promise<Response> = async () =>
  new Response("{}", { status: 500 });
const mockFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const call: FetchCall = { path: String(input), init };
  calls.push(call);
  return responder(call);
};

const roots: Root[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    root.unmount();
  }
  await flush();
  document.body.innerHTML = "";
  calls = [];
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

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const modelsPayload = {
  data: [
    { id: "MiMo v2.5", owned_by: "xiaomi", mapped: true, mapped_public_ids: ["mimo"] },
    { id: "gemma-3", owned_by: null, mapped: false, mapped_public_ids: [] },
    { id: "Gemini 2.5 Pro", owned_by: "google", mapped: false, mapped_public_ids: [] },
  ],
};

const aliasConfig = {
  "request-retry": 3,
  oauth: {
    "auth-dir": "[REDACTED]",
    "model-alias": {
      xiaomi: [{ name: "xiaomi/mimo-v2.5", alias: "MiMo v2.5" }],
      aistudio: [
        {
          name: "gemini-2.5-pro",
          alias: "g2.5p",
          "display-name": "Gemini 2.5 Pro",
          fork: true,
        },
      ],
    },
  },
};

/** Mount ModelMappingsCard alone with the given config/models responders. */
async function mountCard(opts: { config: unknown | Response; models?: unknown }) {
  responder = async (call) => {
    if (call.path === "/api/v1/admin/cpa/management/config") {
      if (opts.config instanceof Response) return opts.config;
      return jsonRes(200, opts.config);
    }
    if (call.path === "/api/v1/admin/cpa/models") return jsonRes(200, opts.models ?? modelsPayload);
    return jsonRes(200, {});
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  roots.push(root);
  root.render(
    <QueryClientProvider client={qc}>
      <ModelMappingsCard />
    </QueryClientProvider>,
  );
  await waitFor(
    () => bodyText().includes("CPA upstream models") && !bodyText().includes("Loading…"),
    "models rendered",
  );
  return qc;
}

// --- pure helper ------------------------------------------------------------

test("aliasToOriginalMap maps alias and display-name back to the original id", () => {
  const map = aliasToOriginalMap(aliasConfig);
  expect(map.get("MiMo v2.5")).toBe("xiaomi/mimo-v2.5");
  expect(map.get("g2.5p")).toBe("gemini-2.5-pro");
  expect(map.get("Gemini 2.5 Pro")).toBe("gemini-2.5-pro");
  // Original names are not keys (no self-mapping).
  expect(map.has("xiaomi/mimo-v2.5")).toBe(false);
  expect(map.has("gemini-2.5-pro")).toBe(false);
  expect(map.size).toBe(3);
});

test("aliasToOriginalMap is defensive: no aliases, bad shapes → empty map", () => {
  expect(aliasToOriginalMap(null).size).toBe(0);
  expect(aliasToOriginalMap("nope").size).toBe(0);
  expect(aliasToOriginalMap({}).size).toBe(0);
  expect(aliasToOriginalMap({ oauth: {} }).size).toBe(0);
  expect(aliasToOriginalMap({ oauth: { "model-alias": { c: "not-an-array" } } }).size).toBe(0);
  // Malformed entries skipped; self-alias (name === alias) not mapped.
  expect(
    aliasToOriginalMap({
      oauth: {
        "model-alias": {
          c: [
            { name: "a" },
            { alias: "x" },
            { name: 1, alias: "y" },
            { name: "same", alias: "same" },
          ],
        },
      },
    }).size,
  ).toBe(0);
});

// --- rendered model list ----------------------------------------------------

test("model list shows original upstream IDs instead of aliases/display names", async () => {
  await mountCard({ config: aliasConfig });
  const text = bodyText();
  // Original IDs rendered.
  expect(text).toContain("xiaomi/mimo-v2.5");
  expect(text).toContain("gemini-2.5-pro");
  // Alias / display-name identities removed from the list.
  expect(text).not.toContain("MiMo v2.5");
  expect(text).not.toContain("Gemini 2.5 Pro");
  // Unaliased model passes through unchanged.
  expect(text).toContain("gemma-3");
  // Fork dedupe: gemini-2.5-pro appears once even though two client ids resolve to it.
  expect(text.split("gemini-2.5-pro").length - 1).toBe(1);
  // Mapping badges unaffected.
  expect(text).toContain("unmapped");
});

test("config read failure falls back to raw CPA-reported IDs", async () => {
  await mountCard({
    config: jsonRes(502, {
      error: { code: "CPA_UNCONFIGURED", message: "CPA_MANAGEMENT_KEY is not set" },
    }),
  });
  const text = bodyText();
  expect(text).toContain("MiMo v2.5");
  expect(text).toContain("gemma-3");
  expect(text).not.toContain("xiaomi/mimo-v2.5");
});

test("config without aliases leaves all IDs as reported", async () => {
  await mountCard({ config: { "request-retry": 3 } });
  const text = bodyText();
  expect(text).toContain("MiMo v2.5");
  expect(text).toContain("gemma-3");
});

test("empty model list renders the empty state", async () => {
  await mountCard({ config: aliasConfig, models: { data: [] } });
  expect(bodyText()).toContain("No CPA models");
});

test("model list is a labelled keyboard-scrollable region with header semantics", async () => {
  await mountCard({ config: aliasConfig });
  // ScrollPanel exposes the list as a semantic, focusable scroll region with a
  // bilingual label; the table header stays inside it.
  const region = document.querySelector('[role="region"][aria-label="CPA upstream models"]');
  expect(region).not.toBeNull();
  expect(region?.getAttribute("tabindex")).toBe("0");
  expect(region?.querySelector("table")).not.toBeNull();
  expect(region?.querySelector("thead")).not.toBeNull();
  expect(region?.textContent).toContain("gemma-3");
});
