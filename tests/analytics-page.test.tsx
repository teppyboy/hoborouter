// Analytics page UI contract (OpenRouter parity plan Task 6 web lane):
// - GET /api/v1/analytics/activity exact contract rendering: group label,
//   requests, input/output tokens, charged VND, cache hit rate (null -> em dash)
// - honest states: loading skeletons, empty period, 404 -> unavailable note,
//   other errors -> error message with no fabricated rows
// - workspace gate: no workspace id, no query, a visible ask-to-choose state
import { test, expect, beforeAll, afterAll, afterEach, mock } from "bun:test";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";

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
  "SVGElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLButtonElement",
  "HTMLFormElement",
  "HTMLLabelElement",
  "HTMLSelectElement",
  "DocumentFragment",
] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let previousActEnv: PropertyDescriptor | undefined;
let jsdomWindow: { close: () => void } | null = null;

let AnalyticsPage: (typeof import("../apps/web/src/pages/analytics"))["default"];
let createRoot: (c: HTMLElement) => { render: (n: unknown) => void; unmount: () => void };

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
  });
  const raf = (cb: (t: number) => void) =>
    setTimeout(() => cb(Date.now()), 16) as unknown as number;
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (win as { ResizeObserver?: unknown }).ResizeObserver = RO;
  // Radix Select pointer handling needs pointer-capture stubs in jsdom.
  (win.Element as typeof Element).prototype.hasPointerCapture = () => false;
  (win.Element as typeof Element).prototype.setPointerCapture = () => {};
  (win.Element as typeof Element).prototype.releasePointerCapture = () => {};
  // Radix Select highlight scrolling needs a jsdom stub.
  (win.Element as typeof Element).prototype.scrollIntoView = () => {};
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
    SVGElement: win.SVGElement,
    HTMLInputElement: win.HTMLInputElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement,
    HTMLButtonElement: win.HTMLButtonElement,
    HTMLFormElement: win.HTMLFormElement,
    HTMLLabelElement: win.HTMLLabelElement,
    HTMLSelectElement: win.HTMLSelectElement,
    DocumentFragment: win.DocumentFragment,
    ResizeObserver: RO,
  };
  for (const [k, v] of Object.entries(values)) {
    (globalThis as Record<string, unknown>)[k] = v;
  }
  jsdomWindow = win as unknown as { close: () => void };
  // Page data queries must never hit the network for real: fetch is routed to
  // fixtures below.
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  // The page derives its workspace from useCurrentWorkspaceId; pin it.
  mock.module("../apps/web/src/lib/workspace-queries", () => ({
    useCurrentWorkspaceId: () => "ws-test",
    useWorkspaces: () => ({ data: [], isSuccess: false }),
  }));
  ({ default: AnalyticsPage } = await import("../apps/web/src/pages/analytics"));
  const webDir = new URL("../apps/web/src/", import.meta.url).pathname;
  ({ createRoot } = (await import(Bun.resolveSync("react-dom/client", webDir))) as unknown as {
    createRoot: (c: HTMLElement) => { render: (n: unknown) => void; unmount: () => void };
  });
});

afterAll(() => {
  mock.restore();
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  if (previousActEnv) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnv);
  jsdomWindow?.close();
  jsdomWindow = null;
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// --- fixtures -----------------------------------------------------------------

interface Group {
  group: string | null;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  charged_vnd: number;
  cache_hit_rate: number | null;
}

// Exact analytics API response shape (apps/api/src/routes/analytics.ts).
const activity = (data: Group[], next_cursor: string | null = null) => ({ data, next_cursor });

let responder: (path: string) => Response = () => new Response("{}", { status: 500 });
const mockFetch = (input: RequestInfo | URL): Promise<Response> =>
  Promise.resolve(responder(String(input)));

// --- harness ------------------------------------------------------------------

const flush = () => new Promise((r) => setTimeout(r, 0));
async function waitFor(cond: () => boolean, label: string, timeoutMs = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout: ${label}`);
    await flush();
  }
}
const bodyText = () => document.body.textContent ?? "";

const roots: { unmount: () => void }[] = [];
async function mountPage(settle?: () => boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      <QueryClientProvider client={qc}>
        <AnalyticsPage />
      </QueryClientProvider>,
    ),
  );
  await waitFor(
    settle ?? (() => !document.querySelector("[data-slot='skeleton']")),
    "analytics query settled",
    6000,
  );
  await flush();
  return qc;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  await flush();
  document.body.innerHTML = "";
});

// --- tests --------------------------------------------------------------------

test("renders the activity contract: group, tokens, VND, cache hit rate", async () => {
  const requested: string[] = [];
  responder = (path) => {
    requested.push(path);
    return new Response(
      JSON.stringify(
        activity([
          {
            group: "2026-10-12",
            requests: 12,
            input_tokens: 1_500_000,
            output_tokens: 30_000,
            charged_vnd: 26_000,
            cache_hit_rate: 0.256,
          },
          {
            group: null,
            requests: 1,
            input_tokens: 0,
            output_tokens: 0,
            charged_vnd: 0,
            cache_hit_rate: null,
          },
        ]),
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  await mountPage();
  expect(requested.join(" ")).toContain("/api/v1/analytics/activity?workspace_id=ws-test");
  expect(requested.join(" ")).toContain("group_by=day");
  const text = bodyText();
  expect(text).toContain("2026-10-12");
  expect(text).toContain("12"); // requests
  expect(text).toContain("26.000 ₫"); // formatVnd
  expect(text).toContain("25.6%"); // cache hit rate
  // null group + null rate render the honest em dash, never fabricated values.
  expect(text).toContain("—");
});

test("empty period renders the empty state, not a table", async () => {
  responder = () => new Response(JSON.stringify(activity([])), { status: 200 });
  await mountPage();
  expect(bodyText()).toContain("No usage in this period yet");
  expect(document.querySelector("table")).toBeNull();
});

test("404 renders the endpoint-unavailable note (integration not merged yet)", async () => {
  responder = () => new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), { status: 404 });
  await mountPage(() => bodyText().includes("Analytics endpoint not available yet."));
  expect(bodyText()).toContain("Analytics endpoint not available yet.");
});

test("500 renders the error state with no fabricated rows", async () => {
  responder = () => new Response("{}", { status: 500 });
  await mountPage(() => bodyText().includes("Request failed (500)"));
  expect(bodyText()).toContain("Request failed (500)");
  expect(document.querySelector("table")).toBeNull();
});

test("key_prefix grouping requests the matching dimension", async () => {
  const requested: string[] = [];
  responder = (path) => {
    requested.push(path);
    return new Response(
      JSON.stringify(
        activity([
          {
            group: "hbr_",
            requests: 3,
            input_tokens: 10,
            output_tokens: 5,
            charged_vnd: 100,
            cache_hit_rate: null,
          },
        ]),
      ),
      { status: 200 },
    );
  };
  await mountPage();
  // Default (day) already loaded; switch grouping via the combobox. Radix
  // Select opens on pointerdown, options render in a portal (body).
  const trigger = document.querySelector("[aria-label='Group by']");
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    trigger!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flush();
  });
  await waitFor(() => document.querySelectorAll("[role='option']").length >= 3, "options open");
  const keyOption = [...document.querySelectorAll("[role='option']")].find((o) =>
    (o.textContent ?? "").includes("API key prefix"),
  );
  await act(async () => {
    keyOption!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    keyOption!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    keyOption!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flush();
  });
  await waitFor(() => requested.some((p) => p.includes("group_by=key_prefix")), "key_prefix query");
});
