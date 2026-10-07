// Account menu "Settings" action contract (jsdom, real Radix dropdown):
// - The top-right account menu exposes a Settings item linking to the
//   existing /settings route (no new route, no auth change).
// - The item is locale-aware: EN "Settings", VI "Cài đặt" (same label set
//   as the sidebar entry).
// - Activating the item navigates the router to /settings.
import { test, expect, beforeAll, afterAll, mock } from "bun:test";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRouter,
  createRootRoute,
  createRoute,
  createMemoryHistory,
} from "@tanstack/react-router";
// routerContext is not public API; providing it directly mounts Link/useNavigate
// without a full RouterProvider (same approach as tests/language-toggle.test.tsx).
import { routerContext } from "@tanstack/react-router/dist/esm/routerContext.js";
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
  "InputEvent",
  "DocumentFragment",
  "SVGElement",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;

// Radix freezes useLayoutEffect to a no-op at MODULE LOAD when
// globalThis.document doesn't exist yet. Sibling SSR test files load the whole
// app module chain before this file's jsdom globals are installed, which would
// permanently break Radix Portal mounting (menu content never renders). Always
// providing the real hook matches browser semantics for every consumer.
import * as ReactNS from "react";
mock.module("@radix-ui/react-use-layout-effect", () => ({
  useLayoutEffect: ReactNS.useLayoutEffect,
}));

// Signed-in identity comes from stubbing fetch for Better Auth's
// /api/auth/get-session, /api/v1/me and public-config — no mock.module, which
// bun applies process-wide and would break sibling test files that import the
// real modules.
const SESSION_USER = { id: "u1", name: "Test User", email: "t@example.com", emailVerified: true };
const stubFetch = (input: RequestInfo | URL): Promise<Response> => {
  const path = String(input);
  const body = path.includes("/api/auth/get-session")
    ? { user: SESSION_USER, session: { userId: SESSION_USER.id } }
    : path.includes("/api/v1/me")
      ? { is_instance_admin: false }
      : path.includes("/api/v1/public-config")
        ? { turnstileSiteKey: null, emailVerification: { enabled: false } }
        : path.includes("/api/v1/workspaces")
          ? [{ id: "ws1", name: "WS" }]
          : {};
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
};

let AppShell: (typeof import("../apps/web/src/components/app-shell"))["AppShell"];
let useLocaleStore: (typeof import("../apps/web/src/lib/i18n/locale"))["useLocaleStore"];
let createRoot: (c: HTMLElement) => { render: (n: unknown) => void; unmount: () => void };

beforeAll(async () => {
  const win = new JSDOM("", { url: "http://localhost:5173", pretendToBeVisual: true })
    .window as unknown as Record<string, unknown>;
  for (const k of GLOBAL_KEYS) {
    originals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    (globalThis as Record<string, unknown>)[k] = win[k];
  }
  jsdomWindow = win as unknown as { close: () => void };
  // Radix focus management scrolls the highlighted item into view.
  const elProto = win.Element as typeof Element;
  elProto.prototype.scrollIntoView = () => {};
  // No provider telemetry / media queries under jsdom.
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (win as { matchMedia: unknown }).matchMedia = () => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  // The contract only needs identity + admin flag + public config to settle;
  // everything else stays disabled via the QueryClient defaults.
  globalThis.fetch = stubFetch as unknown as typeof fetch;
  // Import AFTER jsdom globals exist: auth reads window.location.origin and
  // zustand persist binds storage at first module load.
  ({ AppShell } = await import("../apps/web/src/components/app-shell"));
  ({ useLocaleStore } = await import("../apps/web/src/lib/i18n/locale"));
  createRoot = (await import("react-dom/client")).createRoot as typeof createRoot;
});

afterAll(() => {
  useLocaleStore.getState().setLocale("en");
  if (originalFetch) globalThis.fetch = originalFetch;
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  jsdomWindow?.close();
  jsdomWindow = null;
});

const originalFetch = globalThis.fetch;

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const flush = () => new Promise((r) => setTimeout(r, 0));

interface Mounted {
  root: { unmount: () => void };
  container: HTMLElement;
  // Structural: the memory-history router's full generic type is irrelevant
  // to the contract, and ReturnType<typeof createRouter> widens to AnyRoute.
  router: { state: { location: { pathname: string } } };
}

async function mountShell(): Promise<Mounted> {
  const qc = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  const router = createRouter({
    routeTree: createRootRoute({ component: () => null }).addChildren([
      createRoute({ getParentRoute: () => createRootRoute(), path: "/", component: () => null }),
      createRoute({
        getParentRoute: () => createRootRoute(),
        path: "/settings",
        component: () => null,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const reactRoot = createRoot(container);
  act(() =>
    reactRoot.render(
      <routerContext.Provider value={router}>
        <QueryClientProvider client={qc}>
          <AppShell>
            <p>page body</p>
          </AppShell>
        </QueryClientProvider>
      </routerContext.Provider>,
    ),
  );
  // Settle the async session fetch and gravatar lookup UserAvatar fires on
  // mount so their setStates land inside act (no act warnings between tests).
  await act(async () => {
    await flush();
    await flush();
  });
  return { root: reactRoot, container, router };
}

async function unmount(mounted: Mounted) {
  // Let in-flight menu/portal effects settle before tearing the root down;
  // pending scheduler callbacks would otherwise fire after the jsdom globals
  // are restored and crash the run (same hazard as tests/language-toggle.test.tsx).
  await flush();
  await flush();
  act(() => mounted.root.unmount());
  mounted.container.remove();
  await flush();
}

async function openAccountMenu(container: HTMLElement) {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Account menu"]');
  if (!trigger) throw new Error("account menu trigger not found");
  await act(async () => {
    trigger.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
    );
    // Radix PopperContent measures/positions the opened menu asynchronously;
    // settle it inside act so the position update doesn't warn after the
    // assertion. Poll briefly: the portal content can land one tick later.
    for (let i = 0; i < 50; i++) {
      await flush();
      if (document.querySelector('a[href="/settings"]')) break;
    }
  });
}

async function clickSettingsItem() {
  await act(async () => {
    for (let i = 0; i < 50; i++) {
      await flush();
      if (document.querySelector('a[href="/settings"][role="menuitem"]')) break;
    }
  });
  const item = document.querySelector<HTMLAnchorElement>('a[href="/settings"][role="menuitem"]');
  if (!item) throw new Error('Settings menu item (a[href="/settings"]) not found');
  act(() => {
    item.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
  await flush();
}

test("account menu exposes a Settings item that links to /settings", async () => {
  useLocaleStore.getState().setLocale("en");
  const mounted = await mountShell();
  try {
    await openAccountMenu(mounted.container);
    const item = document.querySelector<HTMLAnchorElement>('a[href="/settings"][role="menuitem"]');
    expect(item).not.toBeNull();
    expect(item?.textContent).toContain("Settings");
  } finally {
    await unmount(mounted);
  }
});

test("the Settings item follows the active locale (EN → VI: Cài đặt)", async () => {
  const mounted = await mountShell();
  try {
    await openAccountMenu(mounted.container);
    expect(
      [...document.querySelectorAll('a[href="/settings"]')].some((link) =>
        link.textContent?.includes("Settings"),
      ),
    ).toBe(true);
    act(() => useLocaleStore.getState().setLocale("vi"));
    expect(
      [...document.querySelectorAll('a[href="/settings"]')].some((link) =>
        link.textContent?.includes("Cài đặt"),
      ),
    ).toBe(true);
  } finally {
    act(() => useLocaleStore.getState().setLocale("en"));
    await unmount(mounted);
  }
});

test("activating the Settings item navigates to /settings", async () => {
  useLocaleStore.getState().setLocale("en");
  const mounted = await mountShell();
  try {
    await openAccountMenu(mounted.container);
    await clickSettingsItem();
    expect(mounted.router.state.location.pathname).toBe("/settings");
  } finally {
    await unmount(mounted);
  }
});
