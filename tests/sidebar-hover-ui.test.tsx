// Collapsed-sidebar hover-expand behavior (jsdom, real React, no network):
// - hovering the collapsed desktop rail expands it for display only (labels
//   visible, w-52) without touching the persisted collapsed store state;
// - moving the pointer out collapses it back to the icon rail (w-14);
// - the click toggle still persists: "Expand sidebar" flips the store so the
//   rail stays open after the pointer leaves, "Collapse sidebar" re-collapses;
// - the mobile hamburger trigger is untouched (aside stays hidden below md,
//   no overlay involvement).
import { test, expect, afterAll, afterEach, beforeEach } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, createRootRoute, createMemoryHistory } from "@tanstack/react-router";
import { routerContext } from "@tanstack/react-router/dist/esm/routerContext.js";

const GLOBAL_KEYS = [
  "window",
  "document",
  "Node",
  "Element",
  "HTMLElement",
  "Event",
  "MouseEvent",
  "localStorage",
] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;
const W = new JSDOM("", { url: "http://localhost:5173" }).window as unknown as {
  close: () => void;
  document: Document;
  localStorage: Storage;
  Event: typeof Event;
  MouseEvent: typeof MouseEvent;
  Node: typeof Node;
  Element: typeof Element;
  HTMLElement: typeof HTMLElement;
};

for (const k of GLOBAL_KEYS) originals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
for (const [k, v] of Object.entries({
  window: W,
  document: W.document,
  Node: W.Node,
  Element: W.Element,
  HTMLElement: W.HTMLElement,
  Event: W.Event,
  MouseEvent: W.MouseEvent,
  localStorage: W.localStorage,
})) {
  (globalThis as Record<string, unknown>)[k] = v;
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Radix TooltipProvider/Sheet read matchMedia at render time; jsdom lacks it.
const matchMediaStub = () => ({
  matches: false,
  media: "",
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
});
(W as unknown as { matchMedia: unknown }).matchMedia = matchMediaStub;
(globalThis as { matchMedia?: unknown }).matchMedia = matchMediaStub;
jsdomWindow = W;

// Every hook in the shell (session, workspaces, admin flag, public config)
// resolves against fetch; a flat 401 keeps them all in a clean error state.
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () =>
  new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;

// @ts-expect-error relative specifier has no declaration file under tests tsconfig
const { createRoot } = await import("../apps/web/node_modules/react-dom/client");
const { AppShell } = await import("../apps/web/src/components/app-shell");
const { useSidebarStore } = await import("../apps/web/src/lib/sidebar");
import type { SidebarState } from "../apps/web/src/lib/sidebar";

// Setup isolation (root cause): the sidebar store's persist storage binds at
// first module load, which may happen while a sibling file's jsdom is torn
// down or before any localStorage exists — leaving `storage` undefined and
// crashing the first persist write (middleware setItem). Bind a never-
// undefined adapter following the LIVE global localStorage at call time; it
// no-ops when none is installed and stays bound for the process.
useSidebarStore.persist.setOptions({
  storage: {
    getItem: (name: string): { state: SidebarState; version: number } | null => {
      const raw = (globalThis as { localStorage?: Storage }).localStorage?.getItem(name);
      return raw ? (JSON.parse(raw) as { state: SidebarState; version: number }) : null;
    },
    setItem: (name: string, value: { state: SidebarState; version?: number }) => {
      (globalThis as { localStorage?: Storage }).localStorage?.setItem(name, JSON.stringify(value));
    },
    removeItem: (name: string) => {
      (globalThis as { localStorage?: Storage }).localStorage?.removeItem(name);
    },
  },
});

afterAll(async () => {
  await flushReact();
  act(() => {
    root.unmount();
  });
  globalThis.fetch = originalFetch;
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  jsdomWindow?.close();
  jsdomWindow = null;
});

function makeRouter() {
  const rootRoute = createRootRoute({ component: () => null });
  return createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;

async function flushReact() {
  // Drain async store updates (better-auth session fetch, react-query) so
  // they land inside act and cannot fire after the jsdom window is gone.
  await act(async () => {});
}

beforeEach(async () => {
  await flushReact();
  document.body.innerHTML = "";
  container = document.createElement("div");
  document.body.appendChild(container);
  useSidebarStore.setState({ collapsed: true });
});

async function renderShell() {
  const router = makeRouter();
  const qc = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  act(() => {
    root = createRoot(container);
    root.render(
      <routerContext.Provider value={router}>
        <QueryClientProvider client={qc}>
          <AppShell>
            <p>page body</p>
          </AppShell>
        </QueryClientProvider>
      </routerContext.Provider>,
    );
  });
  // Settle post-mount async updates (admin probe, session) inside act.
  await flushReact();
}

afterEach(async () => {
  await flushReact();
  if (root) {
    act(() => {
      root.unmount();
    });
  }
  document.body.innerHTML = "";
});

function aside(): HTMLElement {
  const el = document.querySelector("aside");
  if (!el) throw new Error("aside not rendered");
  return el;
}

function hoverAside(kind: "enter" | "leave") {
  act(() => {
    aside().dispatchEvent(
      new MouseEvent(kind === "enter" ? "mouseover" : "mouseout", { bubbles: true }),
    );
  });
}

test("collapsed rail expands on hover without persisting, collapses on leave", async () => {
  await renderShell();
  expect(aside().className).toContain("w-14");
  hoverAside("enter");
  expect(aside().className).toContain("w-52");
  expect(aside().className).not.toContain("w-14");
  // Display-only: the persisted store state stays collapsed.
  expect(useSidebarStore.getState().collapsed).toBe(true);
  expect(W.localStorage.getItem("hbr-sidebar") ?? "").toContain('"collapsed":true');
  hoverAside("leave");
  expect(aside().className).toContain("w-14");
  expect(useSidebarStore.getState().collapsed).toBe(true);
});

test("click toggle still persists through hover cycles", async () => {
  await renderShell();
  // While hover-expanded the header already shows an "Expand sidebar" button
  // (the control is always rendered); leave the rail anyway, then click it.
  hoverAside("enter");
  hoverAside("leave");
  const expand = document.querySelector<HTMLButtonElement>('[aria-label="Expand sidebar"]');
  expect(expand).not.toBeNull();
  act(() => {
    expand!.click();
  });
  expect(useSidebarStore.getState().collapsed).toBe(false);
  // Pointer leaving no longer collapses a click-opened rail.
  hoverAside("enter");
  hoverAside("leave");
  expect(aside().className).toContain("w-52");
  const collapse = document.querySelector<HTMLButtonElement>('[aria-label="Collapse sidebar"]');
  expect(collapse).not.toBeNull();
  act(() => {
    collapse!.click();
  });
  expect(useSidebarStore.getState().collapsed).toBe(true);
  expect(aside().className).toContain("w-14");
});

test("collapsed rail shows an accessible expand button; clicking it expands persistently", async () => {
  await renderShell();
  const expand = document.querySelector<HTMLButtonElement>('[aria-label="Expand sidebar"]');
  expect(expand).not.toBeNull();
  expect(expand!.tagName).toBe("BUTTON");
  act(() => {
    expand!.click();
  });
  expect(useSidebarStore.getState().collapsed).toBe(false);
  expect(aside().className).toContain("w-52");
  // Persistent: hover cycles no longer collapse it.
  hoverAside("enter");
  hoverAside("leave");
  expect(aside().className).toContain("w-52");
  expect(useSidebarStore.getState().collapsed).toBe(false);
});

test("hover-expanded rail exposes a persistent expand control", async () => {
  await renderShell();
  hoverAside("enter");
  expect(aside().className).toContain("w-52");
  expect(useSidebarStore.getState().collapsed).toBe(true);
  // While hover-expanded the header offers the persistent expand.
  const expand = document.querySelector<HTMLButtonElement>('[aria-label="Expand sidebar"]');
  expect(expand).not.toBeNull();
  act(() => {
    expand!.click();
  });
  expect(useSidebarStore.getState().collapsed).toBe(false);
  hoverAside("leave");
  expect(aside().className).toContain("w-52");
});

test("collapsed rail keeps exactly one expand toggle, in the header (no bottom button)", async () => {
  await renderShell();
  const expands = document.querySelectorAll<HTMLButtonElement>('[aria-label="Expand sidebar"]');
  // The bottom rail button was removed; the persistent header toggle is the
  // only expand control, so keyboard users still have a reachable one.
  expect(expands.length).toBe(1);
  const toggle = expands[0]!;
  expect(toggle.closest("aside")?.firstElementChild?.contains(toggle)).toBe(true);
  act(() => {
    toggle.click();
  });
  expect(useSidebarStore.getState().collapsed).toBe(false);
  expect(aside().className).toContain("w-52");
  // Persistent: hover cycles no longer collapse it.
  hoverAside("enter");
  hoverAside("leave");
  expect(aside().className).toContain("w-52");
  expect(useSidebarStore.getState().collapsed).toBe(false);
});

test("collapsed rail header hides the brand: no logo, no name, one toggle", async () => {
  await renderShell();
  const header = aside().firstElementChild as HTMLElement;
  expect(header.querySelector("svg.lucide-shuffle")).toBeNull();
  expect(header.textContent).not.toContain("Hoborouter");
  // Exactly one control remains: the accessible expand toggle.
  expect(header.querySelectorAll("button").length).toBe(1);
  expect(header.querySelector('[aria-label="Expand sidebar"]')).not.toBeNull();
});

test("expanded rail header shows brand, logo, and toggle", async () => {
  act(() => {
    useSidebarStore.setState({ collapsed: false });
  });
  await renderShell();
  const header = aside().firstElementChild as HTMLElement;
  expect(header.querySelector("svg.lucide-shuffle")).not.toBeNull();
  expect(header.textContent).toContain("Hoborouter");
  expect(header.querySelector('[aria-label="Collapse sidebar"]')).not.toBeNull();
});

test("hover-expanded rail shows the brand; mouse leave hides it again", async () => {
  await renderShell();
  const header = aside().firstElementChild as HTMLElement;
  hoverAside("enter");
  expect(header.querySelector("svg.lucide-shuffle")).not.toBeNull();
  expect(header.textContent).toContain("Hoborouter");
  // Display-only expansion: hover writes nothing to persistence.
  expect(useSidebarStore.getState().collapsed).toBe(true);
  expect(W.localStorage.getItem("hbr-sidebar") ?? "").toContain('"collapsed":true');
  hoverAside("leave");
  expect(header.querySelector("svg.lucide-shuffle")).toBeNull();
  expect(header.textContent).not.toContain("Hoborouter");
});

test("mobile nav trigger untouched: aside hidden below md, hamburger present", async () => {
  await renderShell();
  expect(aside().className).toContain("hidden");
  expect(document.querySelector('[aria-label="Open navigation"]')).not.toBeNull();
});
