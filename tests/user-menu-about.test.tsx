// Account menu "About" action contract (jsdom, real Radix dropdown), mirroring
// tests/user-settings-menu-ui.test.tsx:
// - The top-right account menu exposes an About item linking to the existing
//   public /about route (no new route, no auth change).
// - The item is locale-aware: EN "About", VI "Giới thiệu" (same label set as
//   the public About page heading).
// - Activating the item navigates the router to /about.
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
// globalThis.document doesn't exist yet (see tests/user-settings-menu-ui.test.tsx).
import * as ReactNS from "react";
mock.module("@radix-ui/react-use-layout-effect", () => ({
  useLayoutEffect: ReactNS.useLayoutEffect,
}));

const SESSION_USER = {
  id: "u1",
  name: "Test User",
  // 66 chars: long enough that an unbounded dropdown would overflow 375px.
  email: "very.long.account.email.address.for.wrap.testing@example-mail-domain.test",
  emailVerified: true,
};
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
  const elProto = win.Element as typeof Element;
  elProto.prototype.scrollIntoView = () => {};
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
  globalThis.fetch = stubFetch as unknown as typeof fetch;
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

const container = () => document.body;

interface Mounted {
  root: { unmount: () => void };
  container: HTMLElement;
  router: { state: { location: { pathname: string } } };
}

async function mountShell(): Promise<Mounted> {
  const qc = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  const router = createRouter({
    routeTree: createRootRoute({ component: () => null }).addChildren([
      createRoute({ getParentRoute: () => createRootRoute(), path: "/", component: () => null }),
      createRoute({
        getParentRoute: () => createRootRoute(),
        path: "/about",
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
  await act(async () => {
    await flush();
    await flush();
  });
  return { root: reactRoot, container, router };
}

async function unmount(mounted: Mounted) {
  await flush();
  await flush();
  act(() => mounted.root.unmount());
  mounted.container.remove();
  await flush();
}

async function openAccountMenu() {
  const trigger = container()?.querySelector<HTMLButtonElement>(
    'button[aria-label="Account menu"]',
  );
  if (!trigger) throw new Error("account menu trigger not found");
  await act(async () => {
    trigger.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
    );
    // Radix PopperContent measures/positions the opened menu asynchronously;
    // settle it inside act (same polling as tests/user-settings-menu-ui.test.tsx).
    for (let i = 0; i < 50; i++) {
      await flush();
      if (document.querySelector('a[href="/about"]')) break;
    }
  });
}

test("account menu exposes an About item that links to /about", async () => {
  useLocaleStore.getState().setLocale("en");
  const mounted = await mountShell();
  try {
    await openAccountMenu();
    const item = document.querySelector<HTMLAnchorElement>('a[href="/about"][role="menuitem"]');
    expect(item).not.toBeNull();
    expect(item?.textContent).toContain("About");
  } finally {
    await unmount(mounted);
  }
});

test("the About item follows the active locale (EN → VI: Giới thiệu)", async () => {
  const mounted = await mountShell();
  try {
    await openAccountMenu();
    expect(
      [...document.querySelectorAll('a[href="/about"]')].some((link) =>
        link.textContent?.includes("About"),
      ),
    ).toBe(true);
    act(() => useLocaleStore.getState().setLocale("vi"));
    expect(
      [...document.querySelectorAll('a[href="/about"]')].some((link) =>
        link.textContent?.includes("Giới thiệu"),
      ),
    ).toBe(true);
  } finally {
    act(() => useLocaleStore.getState().setLocale("en"));
    await unmount(mounted);
  }
});

test("account menu keeps a long email fully rendered (no truncation)", async () => {
  useLocaleStore.getState().setLocale("en");
  const mounted = await mountShell();
  try {
    await openAccountMenu();
    // The full address stays in the accessible text; wrapping itself is a
    // browser-layout property (pending numeric verification).
    const content = document
      .querySelector('[role="menuitem"]')
      ?.closest("[data-radix-popper-content-wrapper]");
    const menuText = content?.textContent ?? document.body.textContent ?? "";
    expect(menuText).toContain(SESSION_USER.email);
    // About and Settings items stay reachable alongside the email label.
    expect(document.querySelector('a[href="/about"][role="menuitem"]')).not.toBeNull();
    expect(document.querySelector('a[href="/settings"][role="menuitem"]')).not.toBeNull();
  } finally {
    await unmount(mounted);
  }
});

test("activating the About item navigates to /about", async () => {
  useLocaleStore.getState().setLocale("en");
  const mounted = await mountShell();
  try {
    await openAccountMenu();
    const item = document.querySelector<HTMLAnchorElement>('a[href="/about"][role="menuitem"]');
    if (!item) throw new Error('About menu item (a[href="/about"]) not found');
    act(() => {
      item.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    });
    await flush();
    expect(mounted.router.state.location.pathname).toBe("/about");
  } finally {
    await unmount(mounted);
  }
});
