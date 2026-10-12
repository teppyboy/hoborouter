// Keys page UI: budget/expiry policy fields render per key — expiry date,
// in-window budget usage with period label, and an "Expired" effective status
// badge for keys past their expires_at. jsdom render test, mirroring
// keys-page-remove-ui.test.tsx's harness; the network layer is mocked via
// the shared faithful api mock.
import { test, expect, beforeAll, afterAll, mock } from "bun:test";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import { registerFaithfulApiMock } from "./helpers/faithful-api-mock";

const GLOBAL_KEYS = [
  "window",
  "document",
  "localStorage",
  "location",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "MouseEvent",
  "MutationObserver",
  "Element",
  "HTMLElement",
  "Node",
  "ShadowRoot",
  "SVGElement",
  "Text",
  "Comment",
  "CustomEvent",
  "Event",
  "KeyboardEvent",
  "PointerEvent",
  "NodeFilter",
  "TreeWalker",
  "DocumentFragment",
  "DOMParser",
  "HTMLInputElement",
  "HTMLButtonElement",
  "HTMLAnchorElement",
  "HTMLDivElement",
  "HTMLSpanElement",
  "HTMLLabelElement",
  "HTMLTextAreaElement",
  "HTMLSelectElement",
  "HTMLFormElement",
  "HTMLTableElement",
  "HTMLTableRowElement",
  "HTMLTableCellElement",
  "HTMLTableSectionElement",
  "HTMLHeadingElement",
  "HTMLParagraphElement",
  "HTMLUListElement",
  "HTMLLIElement",
  "HTMLHtmlElement",
  "HTMLHeadElement",
  "HTMLStyleElement",
  "HTMLDialogElement",
  "CSSStyleDeclaration",
  "DOMTokenList",
  "NodeList",
  "HTMLCollection",
] as const;

// Budget window starts aligned so the "in-window" branch renders used > 0.
const DAY = Date.UTC(2026, 0, 15);
const DAY_BUDGETED = {
  id: "key-budget",
  key_prefix: "sk-hbr-budg...eted1",
  name: "Budgeted key",
  status: "enabled",
  created_at: 1_700_000_000_000,
  last_used_at: null,
  revoked_at: null,
  expires_at: null,
  budget_vnd: 50_000,
  budget_period: "daily",
  budget_used_vnd: 12_345,
  budget_period_start: DAY,
};
const EXPIRED = {
  ...DAY_BUDGETED,
  id: "key-expired",
  key_prefix: "sk-hbr-expi...red01",
  name: "Expired key",
  // Fixed past timestamp: must render the Expired badge regardless of run time.
  expires_at: 1,
  budget_vnd: null,
  budget_period: null,
  budget_period_start: null,
};
const PLAIN = {
  ...DAY_BUDGETED,
  id: "key-plain",
  key_prefix: "sk-hbr-plai...n001",
  name: "Plain key",
  budget_vnd: null,
  budget_period: null,
  budget_period_start: null,
};

let createRoot: (c: HTMLElement) => { render: (n: unknown) => void; unmount: () => void };
const webDir = new URL("../apps/web/src/", import.meta.url).pathname;

const keysFixture = [DAY_BUDGETED, EXPIRED, PLAIN];

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const mockFetch = (input: RequestInfo | URL): Promise<Response> => {
  const path = String(input);
  if (path.endsWith("/keys")) return Promise.resolve(jsonRes(200, keysFixture));
  return Promise.resolve(jsonRes(200, {}));
};

mock.module("../apps/web/src/lib/workspace-queries", () => ({
  useCurrentWorkspaceId: () => "ws-test",
  useWorkspaces: () => ({ data: [], isSuccess: false }),
}));

// lib/api is registered once per process via the shared faithful mock (see
// tests/helpers/faithful-api-mock.ts) so ApiError identity stays correct.
registerFaithfulApiMock();

let KeysPage: (typeof import("../apps/web/src/pages/keys/index"))["default"];

const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};

beforeAll(async () => {
  for (const key of GLOBAL_KEYS) {
    originals[key] = Object.getOwnPropertyDescriptor(globalThis, key);
  }
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
  (win.Element as typeof Element).prototype.hasPointerCapture = () => false;
  (win.Element as typeof Element).prototype.releasePointerCapture = () => {};
  (win.HTMLElement as typeof HTMLElement).prototype.scrollIntoView = () => {};
  const raf = (cb: (t: number) => void) =>
    setTimeout(() => cb(Date.now()), 16) as unknown as number;
  const values: Record<string, unknown> = {
    window: win,
    document: win.document,
    localStorage: win.localStorage,
    location: win.location,
    getComputedStyle: (win.getComputedStyle as (element: Element) => CSSStyleDeclaration).bind(win),
    requestAnimationFrame: raf,
    cancelAnimationFrame: (id: number) =>
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
    MouseEvent: win.MouseEvent,
    MutationObserver: win.MutationObserver,
    Element: win.Element,
    HTMLElement: win.HTMLElement,
    Node: win.Node,
    ShadowRoot: win.ShadowRoot,
    SVGElement: win.SVGElement,
    Text: win.Text,
    Comment: win.Comment,
    CustomEvent: win.CustomEvent,
    Event: win.Event,
    KeyboardEvent: win.KeyboardEvent,
    PointerEvent: win.PointerEvent ?? win.MouseEvent,
    NodeFilter: win.NodeFilter,
    TreeWalker: win.TreeWalker,
    DocumentFragment: win.DocumentFragment,
    DOMParser: win.DOMParser,
    HTMLInputElement: win.HTMLInputElement,
    HTMLButtonElement: win.HTMLButtonElement,
    HTMLAnchorElement: win.HTMLAnchorElement,
    HTMLDivElement: win.HTMLDivElement,
    HTMLSpanElement: win.HTMLSpanElement,
    HTMLLabelElement: win.HTMLLabelElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement,
    HTMLSelectElement: win.HTMLSelectElement,
    HTMLFormElement: win.HTMLFormElement,
    HTMLTableElement: win.HTMLTableElement,
    HTMLTableRowElement: win.HTMLTableRowElement,
    HTMLTableCellElement: win.HTMLTableCellElement,
    HTMLTableSectionElement: win.HTMLTableSectionElement,
    HTMLHeadingElement: win.HTMLHeadingElement,
    HTMLParagraphElement: win.HTMLParagraphElement,
    HTMLUListElement: win.HTMLUListElement,
    HTMLLIElement: win.HTMLLIElement,
    HTMLHtmlElement: win.HTMLHtmlElement,
    HTMLHeadElement: win.HTMLHeadElement,
    HTMLStyleElement: win.HTMLStyleElement,
    HTMLDialogElement: win.HTMLDialogElement,
    CSSStyleDeclaration: win.CSSStyleDeclaration,
    DOMTokenList: win.DOMTokenList,
    NodeList: win.NodeList,
    HTMLCollection: win.HTMLCollection,
  };
  for (const [k, v] of Object.entries(values)) {
    (globalThis as Record<string, unknown>)[k] = v;
  }
  globalThis.fetch = mockFetch as typeof fetch;
  // react-dom computes canUseDOM once at first module load; import only after
  // the jsdom realm is installed (see keys-page-remove-ui.test.tsx).
  ({ createRoot } = (await import(Bun.resolveSync("react-dom/client", webDir))) as {
    createRoot: (c: HTMLElement) => { render: (n: unknown) => void; unmount: () => void };
  });
  ({ default: KeysPage } = await import("../apps/web/src/pages/keys/index"));
});

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  mock.restore();
  for (const key of GLOBAL_KEYS) {
    const desc = originals[key];
    if (desc) Object.defineProperty(globalThis, key, desc);
  }
});

test("keys page renders budget usage, period label, expiry date, and Expired badge", async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        <QueryClientProvider client={qc}>
          <KeysPage />
        </QueryClientProvider>,
      ),
    );
    for (let i = 0; i < 10; i++)
      await act(async () => {
        await new Promise((r) => setTimeout(r, 25));
      });

    const text = container.textContent ?? "";
    // Budgeted key: in-window usage renders with the period label and total.
    expect(text).toContain("daily");
    expect(text).toContain("50.000");
    // Expired badge for the key whose expires_at is in the past.
    expect(text).toContain("Expired");
    // All three fixture rows render.
    expect(text).toContain("Budgeted key");
    expect(text).toContain("Expired key");
    expect(text).toContain("Plain key");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
