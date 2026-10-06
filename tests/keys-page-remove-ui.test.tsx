// Keys page UI: the row menu must offer Remove alongside Revoke, and Remove
// must confirm with the soft-delete copy, then POST the key's /remove endpoint.
// jsdom interaction test (radix dropdown + dialog), mirroring
// page-body-i18n.test.tsx's harness; the network layer (lib/api) is mocked.
import { test, expect, beforeAll, afterAll, mock } from "bun:test";
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
];

let calls: ApiCall[] = [];

mock.module("../apps/web/src/lib/api", () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    ApiError,
    api: async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      const method = init?.method ?? "GET";
      if (method === "GET" && path.endsWith("/keys")) return keysFixture;
      return {};
    },
  };
});
mock.module("../apps/web/src/lib/workspace-queries", () => ({
  useCurrentWorkspaceId: () => "ws-test",
  useWorkspaces: () => ({ data: [], isSuccess: false }),
}));

let KeysPage: (typeof import("../apps/web/src/pages/keys/index"))["default"];

beforeAll(async () => {
  const win = new JSDOM("", { url: "http://localhost:5173" }).window as unknown as {
    document: object;
    localStorage: Storage;
    location: unknown;
    matchMedia: unknown;
    getComputedStyle: (element: Element) => CSSStyleDeclaration;
    Element: typeof Element;
    HTMLElement: typeof HTMLElement;
    close: () => void;
  };
  win.matchMedia = () => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  // Radix popover internals need these; jsdom has neither.
  win.Element.prototype.hasPointerCapture = () => false;
  win.Element.prototype.releasePointerCapture = () => {};
  win.HTMLElement.prototype.scrollIntoView = () => {};
  const raf = (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 16) as unknown as number;
  const values: Record<string, unknown> = {
    window: win,
    document: win.document,
    localStorage: win.localStorage,
    location: win.location,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: raf,
    cancelAnimationFrame: (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
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
  ({ default: KeysPage } = await import("../apps/web/src/pages/keys/index"));
});

// Globals are deliberately left in place (window/document/etc. stay jsdom's):
// restoring them while radix's MutationObserver callbacks can still fire
// produced cross-realm dispatchEvent errors that leaked into later test
// files. The jsdom window stays alive for the remainder of the run.
afterAll(() => {
  mock.restore();
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const webDir = new URL("../apps/web/src/", import.meta.url).pathname;
const { createRoot } = (await import(Bun.resolveSync("react-dom/client", webDir))) as {
  createRoot: (c: HTMLElement) => { render: (n: unknown) => void; unmount: () => void };
};

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
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(mounted.text()).toContain("Test key");
    const trigger = mounted.container.querySelector<HTMLButtonElement>("[aria-label='Key actions']");
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
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    const trigger = mounted.container.querySelector<HTMLButtonElement>("[aria-label='Key actions']");
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

test("Revoke still targets DELETE (existing behavior unchanged)", async () => {
  calls = [];
  const mounted = mount(<KeysPage />);
  try {
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    const trigger = mounted.container.querySelector<HTMLButtonElement>("[aria-label='Key actions']");
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
