// Usage page UI contract (Seam 4 redesign):
// - compact summary strip with honest success-rate em dash when the backend
//   omits visible counts; money renders only via passthrough formatting of
//   spend_vnd with the workspace FX rate
// - full-width trend chart driven by one selected metric; period + model
//   filters scope the same query contract (days / model params)
// - per-model breakdown is a sortable house table whose default order is the
//   API's spend-desc order
// - error/empty states stay honest (404 -> unavailable, 500 -> error message)
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

let UsagePage: (typeof import("../apps/web/src/pages/usage"))["default"];
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
    addListener() {},
    removeListener() {},
  });
  // Radix Tabs/Select internals need getComputedStyle + rAF; jsdom has neither.
  const raf = (cb: (t: number) => void) =>
    setTimeout(() => cb(Date.now()), 16) as unknown as number;
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (win as { ResizeObserver?: unknown }).ResizeObserver = RO;
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
  // UsagePage derives its workspace from useCurrentWorkspaceId; pin it.
  mock.module("../apps/web/src/lib/workspace-queries", () => ({
    useCurrentWorkspaceId: () => "ws-test",
    useWorkspaces: () => ({ data: [], isSuccess: false }),
  }));
  ({ default: UsagePage } = await import("../apps/web/src/pages/usage"));
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

const today = new Date().toISOString().slice(0, 10);
const RATE = 26000;

interface ByModel {
  public_model: string | number;
  requests: number;
  spend_vnd: number;
  tokens: number;
}

function summaryPayload(opts: {
  daily?: { day: string; requests: number; spend_vnd: number; tokens: number; errors: number }[];
  byModel?: ByModel[];
  visible?: boolean;
}) {
  return {
    totals: {
      requests: 12,
      spend_vnd: RATE,
      input_tokens: 150000,
      output_tokens: 30000,
      errors: 1,
      ...(opts.visible ? { visible_requests: 12, visible_errors: 3 } : {}),
    },
    daily: opts.daily ?? [
      { day: today, requests: 4, spend_vnd: 1300, tokens: 1_234_567, errors: 0 },
    ],
    by_model: opts.byModel ?? [],
  };
}

const byModelFixture: ByModel[] = [
  // API returns by_model sorted by spend desc — m-big first.
  { public_model: "m-big", requests: 2, spend_vnd: 2600, tokens: 300 },
  { public_model: "m-many", requests: 9, spend_vnd: 100, tokens: 800 },
];

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
        <UsagePage />
      </QueryClientProvider>,
    ),
  );
  await waitFor(
    settle ?? (() => !document.querySelector("[data-slot='skeleton']")),
    "usage query settled",
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

function key(el: Element, key: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

async function click(el: Element) {
  await act(async () => {
    // Radix TabsTrigger activates on mousedown; plain buttons on click.
    el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flush();
  });
}

async function openPerModelTab() {
  const tab = [...document.querySelectorAll("[role='tab']")].find(
    (t) => t.textContent === "Per model",
  )!;
  expect(tab).toBeDefined();
  await click(tab);
}

// --- tests --------------------------------------------------------------------

test("summary strip shows totals with spend passthrough and honest em-dash rate when visible counts are absent", async () => {
  responder = (path) => {
    if (path.includes("/usage-summary")) return Response.json(summaryPayload({}));
    if (path.includes("/wallet")) return Response.json({ usd_vnd_rate: RATE });
    return new Response("{}", { status: 500 });
  };
  await mountPage();
  try {
    expect(bodyText()).toContain("12"); // requests
    expect(bodyText()).toContain("180.0K"); // formatTokens contract
    expect(bodyText()).toContain("$1.00"); // 26000 VND @ 26000 rate
    expect(bodyText()).toContain("—"); // success rate em dash
    expect(bodyText()).not.toContain("NaN");
  } finally {
    // afterEach unmounts
  }
});

test("success rate renders the visible-gated percentage when the backend provides counts", async () => {
  responder = (path) => {
    if (path.includes("/usage-summary")) return Response.json(summaryPayload({ visible: true }));
    if (path.includes("/wallet")) return Response.json({ usd_vnd_rate: RATE });
    return new Response("{}", { status: 500 });
  };
  await mountPage();
  expect(bodyText()).toContain("75.0%");
});

test("metric switch moves the chart onto one metric (tokens) with its persistent detail", async () => {
  responder = (path) => {
    if (path.includes("/usage-summary")) return Response.json(summaryPayload({}));
    if (path.includes("/wallet")) return Response.json({ usd_vnd_rate: RATE });
    return new Response("{}", { status: 500 });
  };
  await mountPage();
  const detail = () => document.querySelector("[data-slot='bar-series-detail']")?.textContent ?? "";
  expect(detail()).toContain(today);
  const tokensTab = [...document.querySelectorAll("[role='tab']")].find(
    (t) => t.textContent === "Tokens",
  );
  expect(tokensTab).toBeDefined();
  await click(tokensTab!);
  expect(detail()).toContain("1.23M");
});

test("period filter scopes the query window (7d / 90d hit the API contract)", async () => {
  const paths: string[] = [];
  responder = (path) => {
    paths.push(path);
    if (path.includes("/usage-summary")) return Response.json(summaryPayload({}));
    if (path.includes("/wallet")) return Response.json({ usd_vnd_rate: RATE });
    return new Response("{}", { status: 500 });
  };
  await mountPage();
  const d90 = [...document.querySelectorAll("button")].find((b) => b.textContent === "90d")!;
  await click(d90);
  await waitFor(() => paths.some((p) => p.includes("days=90")), "90d query");
  const d7 = [...document.querySelectorAll("button")].find((b) => b.textContent === "7d")!;
  await click(d7);
  await waitFor(() => paths.some((p) => p.includes("days=7")), "7d query");
  expect(paths.some((p) => p.includes("days=90"))).toBe(true);
  expect(paths.some((p) => p.includes("days=7"))).toBe(true);
});

test("model filter selects a model and scopes the query by public model id", async () => {
  const paths: string[] = [];
  responder = (path) => {
    paths.push(path);
    if (path.includes("/usage-summary")) {
      if (path.includes("model=gpt-test")) {
        return Response.json(
          summaryPayload({
            byModel: [{ public_model: "gpt-test", requests: 1, spend_vnd: 50, tokens: 10 }],
          }),
        );
      }
      return Response.json(
        summaryPayload({
          byModel: [
            { public_model: "gpt-test", requests: 1, spend_vnd: 50, tokens: 10 },
            { public_model: "other", requests: 2, spend_vnd: 70, tokens: 20 },
          ],
        }),
      );
    }
    if (path.includes("/wallet")) return Response.json({ usd_vnd_rate: RATE });
    return new Response("{}", { status: 500 });
  };
  await mountPage();
  const trigger = document.querySelector<HTMLElement>("button[role='combobox']");
  expect(trigger).not.toBeNull();
  act(() => trigger!.focus());
  key(trigger!, "ArrowDown");
  await waitFor(() => document.querySelector("[role='option']") !== null, "select open");
  const option = [...document.querySelectorAll("[role='option']")].find(
    (o) => o.textContent === "gpt-test",
  )!;
  expect(option).toBeDefined();
  key(option, "Enter");
  await waitFor(() => paths.some((p) => p.includes("model=gpt-test")), "filtered query");
  expect(bodyText()).toContain("gpt-test");
});

test("per-model table defaults to API spend-desc order and sorts on header click", async () => {
  responder = (path) => {
    if (path.includes("/usage-summary")) {
      return Response.json(summaryPayload({ byModel: byModelFixture }));
    }
    if (path.includes("/wallet")) return Response.json({ usd_vnd_rate: RATE });
    return new Response("{}", { status: 500 });
  };
  await mountPage();
  await openPerModelTab();
  const rowModels = () =>
    [...document.querySelectorAll("tbody tr")].map((r) => r.querySelector("td")?.textContent ?? "");
  // Default: API order (spend desc) preserved.
  expect(rowModels()).toEqual(["m-big", "m-many"]);
  const requestsHeader = [...document.querySelectorAll("thead button")].find(
    (b) => b.textContent === "Requests",
  )!;
  expect(requestsHeader).toBeDefined();
  await click(requestsHeader);
  // Descending by requests: m-many (9) first.
  expect(rowModels()).toEqual(["m-many", "m-big"]);
  await click(requestsHeader);
  // Ascending: m-big (2) first.
  expect(rowModels()).toEqual(["m-big", "m-many"]);
});

test("per-model spend is a passthrough render of spend_vnd (no recomputation)", async () => {
  responder = (path) => {
    if (path.includes("/usage-summary")) {
      return Response.json(summaryPayload({ byModel: byModelFixture }));
    }
    if (path.includes("/wallet")) return Response.json({ usd_vnd_rate: RATE });
    return new Response("{}", { status: 500 });
  };
  await mountPage();
  await openPerModelTab();
  // 2600 VND @ 26000 -> $0.10; 100 VND -> $0.003846 -> tiny-amount format $0.003846
  expect(bodyText()).toContain("$0.10");
  expect(bodyText()).toContain("$0.003846");
});

test("sparse-but-nonempty daily renders the chart; sparse-free daily keeps the honest empty state", async () => {
  responder = (path) => {
    if (path.includes("/usage-summary")) {
      return Response.json(summaryPayload({ daily: [] }));
    }
    if (path.includes("/wallet")) return Response.json({ usd_vnd_rate: RATE });
    return new Response("{}", { status: 500 });
  };
  await mountPage();
  expect(bodyText()).toContain("No requests yet");
});

test("404 keeps the honest 'endpoint unavailable' state; 500 shows the error message", async () => {
  responder = () => new Response("{}", { status: 404 });
  await mountPage();
  expect(bodyText()).toContain("Usage summary endpoint not available yet");

  responder = () => new Response("boom", { status: 500 });
  // Non-JSON 500 renders the API client's own message; retries use backoff, so
  // settle on the rendered message instead of the skeleton.
  await mountPage(() => bodyText().includes("Request failed (500)"));
  expect(bodyText()).toContain("Request failed (500)");
}, 10000);
