// System page scope: instance system facts + usage logs only. CPA health and
// CPA models moved to the CPA page's tabs — their absence here is the contract.
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
  ({ createRoot } = await import("react-dom/client"));
  ({ default: AdminSystemPage } = await import("../apps/web/src/pages/admin/system"));

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

let AdminSystemPage: (typeof import("../apps/web/src/pages/admin/system"))["default"];
let createRoot: (typeof import("react-dom/client"))["createRoot"];
type Root = import("react-dom/client").Root;

const realFetch = globalThis.fetch;
let calls: { path: string }[] = [];
const mockFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  calls.push({ path: String(input) });
  return responder(input, init);
};
const responder = async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
  if (String(_input) === "/api/v1/admin/system")
    return jsonRes(200, {
      gateway_enabled: true,
      usd_vnd_rate: 26300,
      payos_configured: false,
      manual_payments: true,
      db: { wal: "wal" },
      counts: { users: 3, workspaces: 2, models: 11, requests: 99 },
    });
  if (String(_input) === "/api/v1/admin/usage-logs")
    return jsonRes(200, {
      data: [
        {
          id: "u1",
          workspace_name: "ws",
          provider: "gemini",
          public_model: "pub-model",
          input_tokens: 10,
          output_tokens: 20,
          status: "ok",
          charged_vnd: 1234,
          created_at: 1_700_000_000_000,
        },
      ],
    });
  return jsonRes(404, {});
};

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const roots: Root[] = [];
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(async () => {
  for (const root of roots.splice(0)) root.unmount();
  await flush();
  document.body.innerHTML = "";
  calls = [];
});

async function waitFor(cond: () => boolean, label: string, timeoutMs = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout: ${label}`);
    await flush();
  }
}

const bodyText = () => document.body.textContent ?? "";

test("system page renders system facts and usage logs only — no CPA sections", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  roots.push(root);
  root.render(
    <QueryClientProvider client={qc}>
      <AdminSystemPage />
    </QueryClientProvider>,
  );
  await waitFor(() => bodyText().includes("pub-model"), "system page rendered");
  // System card facts still render.
  expect(bodyText()).toContain("Gateway");
  expect(bodyText()).toContain("USD/VND rate");
  expect(bodyText()).toContain("Manual payments");
  // Usage logs table still renders with its row data.
  expect(bodyText()).toContain("ws");
  expect(bodyText()).toContain("pub-model");
  expect(calls.some((c) => c.path === "/api/v1/admin/usage-logs")).toBe(true);
  // CPA info moved to the CPA page: neither section may appear here, and no
  // CPA endpoints are fetched from this page.
  expect(bodyText()).not.toContain("CPA health");
  expect(bodyText()).not.toContain("CPA models");
  expect(calls.some((c) => c.path.startsWith("/api/v1/admin/cpa"))).toBe(false);
});
