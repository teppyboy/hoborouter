// CreateWorkspace i18n contract: the first-workspace screen renders its
// chrome from the inline workspaceCopy LocaleEntry set and follows the
// persisted hbr-locale store. Mounted (not SSR) because zustand's server
// snapshot is always the initial "en" state — locale flips are client-side.
// afterAll resets the locale to the English default so later files in this
// process are unaffected (see tests/i18n.test.tsx).
import { test, expect, beforeAll, afterAll } from "bun:test";
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
  "NodeFilter",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "DocumentFragment",
] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;

beforeAll(async () => {
  const win = new JSDOM("", { url: "http://localhost:5173" }).window as unknown as Record<
    string,
    unknown
  >;
  for (const k of GLOBAL_KEYS) originals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  const values: Record<string, unknown> = {
    window: win,
    document: win.document,
    localStorage: win.localStorage,
    location: win.location,
    getComputedStyle: (win.getComputedStyle as (e: Element) => CSSStyleDeclaration).bind(win),
    MutationObserver: win.MutationObserver,
    Event: win.Event,
    CustomEvent: win.CustomEvent,
    MouseEvent: win.MouseEvent,
    NodeFilter: win.NodeFilter,
    Node: win.Node,
    Element: win.Element,
    HTMLElement: win.HTMLElement,
    HTMLInputElement: win.HTMLInputElement,
    HTMLButtonElement: win.HTMLButtonElement,
    DocumentFragment: win.DocumentFragment,
  };
  for (const [k, v] of Object.entries(values)) {
    (globalThis as Record<string, unknown>)[k] = v;
  }
  jsdomWindow = win as unknown as { close: () => void };
  ({ createRoot } = await import("react-dom/client"));
  ({ CreateWorkspace } = await import("../apps/web/src/components/create-workspace"));
  ({ useLocaleStore } = await import("../apps/web/src/lib/i18n/locale"));
});

afterAll(async () => {
  // Locale is process-global zustand state; restore the English default.
  useLocaleStore.getState().setLocale("en");
  await flush();
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  jsdomWindow?.close();
  jsdomWindow = null;
});

let createRoot: (typeof import("react-dom/client"))["createRoot"];
let CreateWorkspace: (typeof import("../apps/web/src/components/create-workspace"))["CreateWorkspace"];
let useLocaleStore: (typeof import("../apps/web/src/lib/i18n/locale"))["useLocaleStore"];

function mount(): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient();
  const root = createRoot(container);
  root.render(
    <QueryClientProvider client={qc}>
      <CreateWorkspace />
    </QueryClientProvider>,
  );
  return () => {
    root.unmount();
    container.remove();
    // Drain pending React scheduler work while the jsdom globals still exist.
    return flush();
  };
}

const bodyText = () => document.body.textContent ?? "";

const flush = () => new Promise((r) => setTimeout(r, 0));

test("create-workspace renders English chrome by default", async () => {
  useLocaleStore.getState().setLocale("en");
  const unmount = mount();
  try {
    await flush();
    expect(bodyText()).toContain("Create your first workspace");
    expect(bodyText()).toContain("Create");
  } finally {
    unmount();
  }
});

test("create-workspace flips EN → VI with the locale store", async () => {
  useLocaleStore.getState().setLocale("vi");
  const unmount = mount();
  try {
    await flush();
    expect(bodyText()).toContain("Tạo workspace đầu tiên của bạn");
    expect(bodyText()).toContain("Tạo");
    expect(bodyText()).not.toContain("Create your first workspace");
  } finally {
    unmount();
    useLocaleStore.getState().setLocale("en");
  }
});
