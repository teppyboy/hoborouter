// Desktop conversation-list collapse: toggle flips data-state +
// aria-expanded, the preference persists across remounts (identity-independent
// device UI pref in localStorage), and the list stays reachable when expanded.
// Phone Sheet untouched. Observable behavior only.
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
  "HTMLSelectElement",
  "HTMLLabelElement",
  "DocumentFragment",
  "DOMParser",
  "SVGElement",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;

const mockFetch = (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
  Promise.resolve(
    new Response(JSON.stringify({ data: [], nextCursor: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
// No mock.module here: bun's module mocks are process-global and would leak
// into other files sharing this worker (e.g. the SSR chat-page tests, which
// rely on the REAL lib/auth). This file only needs jsdom + a stubbed fetch.

let ChatPage: (typeof import("../apps/web/src/pages/chat"))["ChatPage"];
let createRoot: (typeof import("react-dom/client"))["createRoot"];
type Root = import("react-dom/client").Root;
const roots: Root[] = [];
const realFetch = globalThis.fetch;
const flush = () => new Promise((r) => setTimeout(r, 0));
const SIDEBAR_PREF = "chat.sidebar.collapsed";
let prevPref: string | null = null;

beforeAll(async () => {
  prevPref = globalThis.localStorage?.getItem(SIDEBAR_PREF) ?? null;
  const win = new JSDOM("", { url: "http://localhost:5173", pretendToBeVisual: true })
    .window as unknown as Record<string, unknown>;
  for (const k of GLOBAL_KEYS) originals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  for (const k of GLOBAL_KEYS) (globalThis as Record<string, unknown>)[k] = win[k];
  jsdomWindow = win as unknown as { close: () => void };
  globalThis.fetch = mockFetch as typeof fetch;
  ({ createRoot } = await import("react-dom/client"));
  ({ ChatPage } = await import("../apps/web/src/pages/chat"));
});

afterAll(() => {
  globalThis.fetch = realFetch;
  // Restore the device pref this test mutated so shared-worker state stays
  // hermetic for other files in the same process.
  try {
    if (prevPref === null) globalThis.localStorage?.removeItem(SIDEBAR_PREF);
    else globalThis.localStorage?.setItem(SIDEBAR_PREF, prevPref);
  } catch {
    // Unavailable storage: nothing to restore.
  }
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  jsdomWindow?.close();
  jsdomWindow = null;
});

afterEach(async () => {
  for (const root of roots.splice(0)) root.unmount();
  await flush();
  document.body.innerHTML = "";
  globalThis.localStorage?.clear();
});

type EventCtor = new (type: string, init?: { bubbles?: boolean; cancelable?: boolean }) => Event;
const click = (el: Element) =>
  el.dispatchEvent(
    new (window as unknown as { MouseEvent: EventCtor }).MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    }),
  );

const aside = () => document.getElementById("chat-history-aside");
const toggle = () =>
  document.querySelector<HTMLButtonElement>('button[aria-controls="chat-history-aside"]');

async function mountPage(): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  roots.push(root);
  root.render(
    <QueryClientProvider client={qc}>
      <ChatPage />
    </QueryClientProvider>,
  );
  await flush();
  await flush();
}

test("desktop sidebar collapses with data-state + aria-expanded and persists across remount", async () => {
  await mountPage();
  expect(aside()?.getAttribute("data-state")).toBe("expanded");
  expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
  // Expanded: the history list is reachable (empty-state text present).
  expect(document.body.textContent).toContain("No conversations yet.");

  // The toggle button lives outside the swapped children, so keyboard focus
  // survives the collapse (it must not be dropped on a re-mounted node).
  // jsdom does not focus buttons on synthetic clicks; a keyboard user has the
  // toggle focused before activating it, so focus it explicitly first.
  toggle()!.focus();
  click(toggle()!);
  await flush();
  expect(aside()?.getAttribute("data-state")).toBe("collapsed");
  expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
  expect(globalThis.localStorage?.getItem("chat.sidebar.collapsed")).toBe("1");
  // Collapsed rail keeps the New chat affordance reachable.
  expect(document.body.textContent).toContain("New chat");
  expect(document.activeElement).toBe(toggle());

  // Remount: the collapsed preference survives (device UI pref, stored "1").
  roots.splice(0).forEach((r) => r.unmount());
  await flush();
  document.body.innerHTML = "";
  await mountPage();
  expect(aside()?.getAttribute("data-state")).toBe("collapsed");
  expect(toggle()?.getAttribute("aria-expanded")).toBe("false");

  // Expanding clears the stored collapsed flag and restores the list.
  click(toggle()!);
  await flush();
  await flush();
  await flush();
  expect(aside()?.getAttribute("data-state")).toBe("expanded");
  expect(globalThis.localStorage?.getItem("chat.sidebar.collapsed")).toBe("0");
  expect(document.body.textContent).toContain("No conversations yet.");
});
