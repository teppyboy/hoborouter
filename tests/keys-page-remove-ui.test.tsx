// Keys page UI: the row menu must offer Remove alongside Revoke, and Remove
// must confirm with the soft-delete copy, then POST the key's /remove endpoint.
// jsdom interaction test (radix dropdown + dialog), mirroring
// page-body-i18n.test.tsx's harness; the network layer (lib/api) is mocked.
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
  "HTMLBodyElement",
  "HTMLHeadElement",
  "HTMLStyleElement",
  "HTMLDialogElement",
  "CSSStyleDeclaration",
  "DOMTokenList",
  "NodeList",
  "HTMLCollection",
] as const;

interface ApiCall {
  path: string;
  init?: RequestInit;
}

const keysFixture = [
  {
    id: "key-ui-1",
    key_prefix: "sk-hbr-abcd...wxyz",
    name: "Test key",
    status: "enabled",
    created_at: 1_700_000_000_000,
    last_used_at: null,
    revoked_at: null,
  },
  {
    id: "key-ui-2",
    key_prefix: "sk-hbr-revo...ked1",
    name: "Revoked key",
    status: "revoked",
    created_at: 1_699_000_000_000,
    last_used_at: 1_699_500_000_000,
    revoked_at: 1_699_600_000_000,
  },
];

let calls: ApiCall[] = [];

// lib/api is registered once per process via the shared faithful mock (see
// tests/helpers/faithful-api-mock.ts): stable ApiError identity and an api()
// that reads globalThis.fetch live, so this file's fetch mock intercepts
// requests and later files sharing the worker keep correct error-code
// mapping. mock.module is process-global in Bun and outlives mock.restore(),
// so a per-file hand-rolled mock would leak a wrong ApiError into files like
// promo-ui, which do `instanceof ApiError` for friendly error mapping.
registerFaithfulApiMock();

const realFetch = globalThis.fetch;
const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const mockFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  calls.push({ path: String(input), init });
  const method = init?.method ?? "GET";
  if (method === "GET" && String(input).endsWith("/keys"))
    return Promise.resolve(jsonRes(200, keysFixture));
  return Promise.resolve(jsonRes(200, {}));
};
mock.module("../apps/web/src/lib/workspace-queries", () => ({
  useCurrentWorkspaceId: () => "ws-test",
  useWorkspaces: () => ({ data: [], isSuccess: false }),
}));

let KeysPage: (typeof import("../apps/web/src/pages/keys/index"))["default"];

beforeAll(async () => {
  // Capture originals BEFORE any replacement: bun runs beforeAll hooks in
  // declaration order, so capturing them in a later hook would snapshot the
  // jsdom realm itself and make afterAll's restore a no-op (leaking this
  // file's realm into every later file in the combined run).
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
  // Radix popover internals need these; jsdom has neither.
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
    HTMLBodyElement: win.HTMLBodyElement,
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
  // react-dom computes canUseDOM / isInputEventSupported once at first module
  // load. Importing it at top level (before any DOM globals exist) permanently
  // disables delegated onChange for controlled inputs in this process and
  // breaks every later jsdom file that types into a text input. It must be
  // loaded only after the jsdom realm is installed.
  ({ createRoot } = (await import(Bun.resolveSync("react-dom/client", webDir))) as {
    createRoot: (c: HTMLElement) => { render: (n: unknown) => void; unmount: () => void };
  });
  ({ default: KeysPage } = await import("../apps/web/src/pages/keys/index"));
});

const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};

// Globals are restored after mock.restore(); radix's MutationObserver callbacks
// can still fire briefly after unmount, so drain one macrotask first.
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  mock.restore();
  // mock.module registrations are process-global and outlives mock.restore();
  // re-registering the real namespaces here is a no-op in bun 1.4 (first
  // registration wins), so the registered mocks above are kept faithful to
  // the real modules instead.
  for (const key of GLOBAL_KEYS) {
    const descriptor = originals[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  globalThis.fetch = realFetch;
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const webDir = new URL("../apps/web/src/", import.meta.url).pathname;
let createRoot: (c: HTMLElement) => { render: (n: unknown) => void; unmount: () => void };

function mount(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>));
  return {
    root,
    container,
    text: () => container.textContent ?? "",
    bodyText: () => document.body.textContent ?? "",
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

function menuItems(): string[] {
  return [...document.body.querySelectorAll("[role='menuitem']")].map((el) => el.textContent ?? "");
}

test("row menu offers Disable-or-Enable, Rename, Revoke and Remove", async () => {
  calls = [];
  const mounted = mount(<KeysPage />);
  try {
    for (let i = 0; i < 10; i++)
      await act(async () => {
        await new Promise((r) => setTimeout(r, 25));
      });
    expect(mounted.text()).toContain("Test key");
    const trigger = mounted.container.querySelector<HTMLButtonElement>(
      "[aria-label='Key actions']",
    );
    expect(trigger).not.toBeNull();
    await click(trigger!);
    const items = menuItems();
    expect(items).toContain("Rename");
    expect(items).toContain("Revoke");
    expect(items).toContain("Remove");
  } finally {
    mounted.unmount();
  }
});

test("Remove asks with soft-delete copy, then POSTs the key's /remove endpoint", async () => {
  calls = [];
  const mounted = mount(<KeysPage />);
  try {
    for (let i = 0; i < 10; i++)
      await act(async () => {
        await new Promise((r) => setTimeout(r, 25));
      });
    const trigger = mounted.container.querySelector<HTMLButtonElement>(
      "[aria-label='Key actions']",
    );
    await click(trigger!);
    const remove = [...document.body.querySelectorAll("[role='menuitem']")].find(
      (el) => el.textContent === "Remove",
    );
    expect(remove).toBeDefined();
    await click(remove!);
    // confirm dialog names the key and says it disappears from the list
    expect(mounted.bodyText()).toContain("Remove key");
    expect(mounted.bodyText()).toContain("Test key");
    expect(mounted.bodyText()).toContain("disappear from the list");
    const confirm = [...document.body.querySelectorAll("button")].find(
      (el) => el.textContent === "Remove" && el.closest("[role='dialog']"),
    );
    expect(confirm).toBeDefined();
    await click(confirm!);
    const posted = calls.filter((c) => c.init?.method === "POST");
    expect(posted).toHaveLength(1);
    expect(posted[0]!.path).toBe("/api/v1/workspaces/ws-test/keys/key-ui-1/remove");
  } finally {
    mounted.unmount();
  }
});

test("revoked row exposes only Remove; confirm POSTs its /remove endpoint", async () => {
  calls = [];
  const mounted = mount(<KeysPage />);
  try {
    for (let i = 0; i < 10; i++)
      await act(async () => {
        await new Promise((r) => setTimeout(r, 25));
      });
    expect(mounted.text()).toContain("Revoked key");
    // Two rows -> two action triggers; the second belongs to the revoked key.
    const triggers = mounted.container.querySelectorAll<HTMLButtonElement>(
      "[aria-label='Key actions']",
    );
    expect(triggers).toHaveLength(2);
    await click(triggers[1]!);
    // Revoked is terminal: no status toggle, rename, restrictions or revoke.
    const items = menuItems();
    expect(items).toEqual(["Remove"]);
    const remove = [...document.body.querySelectorAll("[role='menuitem']")].find(
      (el) => el.textContent === "Remove",
    );
    await click(remove!);
    // Same soft-delete confirm dialog as an active key's Remove.
    expect(mounted.bodyText()).toContain("Remove key");
    expect(mounted.bodyText()).toContain("Revoked key");
    expect(mounted.bodyText()).toContain("disappear from the list");
    const confirm = [...document.body.querySelectorAll("button")].find(
      (el) => el.textContent === "Remove" && el.closest("[role='dialog']"),
    );
    expect(confirm).toBeDefined();
    await click(confirm!);
    const posted = calls.filter((c) => c.init?.method === "POST");
    expect(posted).toHaveLength(1);
    expect(posted[0]!.path).toBe("/api/v1/workspaces/ws-test/keys/key-ui-2/remove");
  } finally {
    mounted.unmount();
  }
});

test("Revoke still targets DELETE (existing behavior unchanged)", async () => {
  calls = [];
  const mounted = mount(<KeysPage />);
  try {
    for (let i = 0; i < 10; i++)
      await act(async () => {
        await new Promise((r) => setTimeout(r, 25));
      });
    const trigger = mounted.container.querySelector<HTMLButtonElement>(
      "[aria-label='Key actions']",
    );
    await click(trigger!);
    const revoke = [...document.body.querySelectorAll("[role='menuitem']")].find(
      (el) => el.textContent === "Revoke",
    );
    await click(revoke!);
    expect(mounted.bodyText()).toContain("Revoke key");
    const confirm = [...document.body.querySelectorAll("button")].find(
      (el) => el.textContent === "Revoke" && el.closest("[role='dialog']"),
    );
    await click(confirm!);
    const deleted = calls.filter((c) => c.init?.method === "DELETE");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.path).toBe("/api/v1/workspaces/ws-test/keys/key-ui-1");
  } finally {
    mounted.unmount();
  }
});
