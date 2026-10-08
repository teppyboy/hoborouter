// Request log page (/admin/request-log): renders recent requests fetched from
// GET /api/v1/admin/usage-logs inside an internally-scrolling panel, with the
// actor labeled "Key creator" and bilingual EN/VI copy.
import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { act } from "react";
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

let AdminRequestLogPage: (typeof import("../apps/web/src/pages/admin/request-log"))["default"];
let createRoot: (typeof import("react-dom/client"))["createRoot"];
let useLocaleStore: (typeof import("../apps/web/src/lib/i18n/locale"))["useLocaleStore"];

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
  ({ default: AdminRequestLogPage } = await import("../apps/web/src/pages/admin/request-log"));
  ({ useLocaleStore } = await import("../apps/web/src/lib/i18n/locale"));
  globalThis.fetch = mockFetch as typeof fetch;
});

afterAll(() => {
  useLocaleStore.getState().setLocale("en");
  globalThis.fetch = realFetch;
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  jsdomWindow?.close();
  jsdomWindow = null;
});

const realFetch = globalThis.fetch;
let calls: { path: string }[] = [];
const mockFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  calls.push({ path: String(input) });
  return responder(input, init);
};
const responder = async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
  if (String(_input) === "/api/v1/admin/usage-logs")
    return jsonRes(200, {
      data: [
        {
          id: "u1",
          workspace_name: "ws",
          key_prefix: "sk-hbr-abcd",
          provider: "gemini",
          public_model: "pub-model",
          input_tokens: 10,
          output_tokens: 20,
          status: "ok",
          charged_vnd: 1234,
          created_at: 1_700_000_000_000,
          actor: { id: "user-1", name: "Creator", email: "creator@example.com" },
          actor_source: "key_creator",
        },
      ],
    });
  return jsonRes(404, {});
};

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const roots: import("react-dom/client").Root[] = [];
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(async () => {
  // Unmount inside act so pending state updates flush before globals reset.
  for (const root of roots.splice(0)) await act(async () => root.unmount());
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

function renderPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      <QueryClientProvider client={qc}>
        <AdminRequestLogPage />
      </QueryClientProvider>,
    );
  });
  return root;
}

test("request log page renders rows from /api/v1/admin/usage-logs inside a scrolling panel with the key-creator actor", async () => {
  renderPage();
  await waitFor(() => bodyText().includes("pub-model"), "request log rendered");
  // Row data renders, actor identified as key creator.
  expect(bodyText()).toContain("ws");
  expect(bodyText()).toContain("creator@example.com");
  expect(bodyText()).toContain("Key creator");
  // Internally-scrolling panel: a labelled scroll region hosts the table.
  const region = document.body.querySelector('[role="region"][aria-label="Recent requests"]');
  expect(region).not.toBeNull();
  expect(calls.some((c) => c.path === "/api/v1/admin/usage-logs")).toBe(true);
});

test("request log page is bilingual EN → VI", async () => {
  useLocaleStore.getState().setLocale("en");
  renderPage();
  await waitFor(() => bodyText().includes("Request log"), "en title rendered");
  await waitFor(() => bodyText().includes("Key creator"), "en table rendered");
  await act(async () => {
    useLocaleStore.getState().setLocale("vi");
  });
  await waitFor(() => bodyText().includes("Nhật ký yêu cầu"), "vi title rendered");
  await waitFor(() => bodyText().includes("Người tạo khóa"), "vi table rendered");
  expect(bodyText()).not.toContain("Key creator");
});
