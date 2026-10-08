// Shared Help nav group contract (jsdom, real Radix + TanStack router):
// - The authenticated sidebar (desktop aside) and the mobile sheet both show
//   one "Help" group with Tutorials (/docs/quickstart) and About (/about).
// - Labels are locale-aware: EN "Help/Tutorials/About", VI "Trợ giúp/
//   Hướng dẫn/Giới thiệu".
// - Activating Tutorials navigates to /docs/quickstart (the existing public
//   quickstart route — no duplicated route or page).
// - In the collapsed rail the links keep an accessible name (tooltip/aria).
import { test, expect, beforeAll, afterAll, mock } from "bun:test";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRouter,
  createRootRoute,
  createRoute,
  createMemoryHistory,
} from "@tanstack/react-router";
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

import * as ReactNS from "react";
mock.module("@radix-ui/react-use-layout-effect", () => ({
  useLayoutEffect: ReactNS.useLayoutEffect,
}));

const stubFetch = (input: RequestInfo | URL): Promise<Response> => {
  const path = String(input);
  const body = path.includes("/api/auth/get-session")
    ? {
        user: { id: "u1", name: "T", email: "t@example.test", emailVerified: true },
        session: { userId: "u1" },
      }
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
let useSidebarStore: (typeof import("../apps/web/src/lib/sidebar"))["useSidebarStore"];
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
  ({ useSidebarStore } = await import("../apps/web/src/lib/sidebar"));
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
  router: { state: { location: { pathname: string } } };
}

async function mountShell(): Promise<Mounted> {
  const qc = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  const rootRoute = createRootRoute({ component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/docs/quickstart",
        component: () => null,
      }),
      createRoute({ getParentRoute: () => rootRoute, path: "/about", component: () => null }),
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

async function openMobileNav() {
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Open navigation"]');
  if (!trigger) throw new Error("mobile nav trigger not found");
  await act(async () => {
    trigger.click();
    for (let i = 0; i < 50; i++) {
      await flush();
      if (document.querySelector('[role="dialog"]')) break;
    }
  });
}

test("desktop sidebar shows a Help group with Tutorials and About links", async () => {
  useLocaleStore.getState().setLocale("en");
  useSidebarStore.setState({ collapsed: false });
  const mounted = await mountShell();
  try {
    const aside = document.querySelector("aside");
    if (!aside) throw new Error("aside not rendered");
    expect(aside.textContent).toContain("Help");
    const tutorials = aside.querySelector<HTMLAnchorElement>('a[href="/docs/quickstart"]');
    const about = aside.querySelector<HTMLAnchorElement>('a[href="/about"]');
    expect(tutorials).not.toBeNull();
    expect(tutorials?.textContent).toContain("Tutorials");
    expect(about).not.toBeNull();
    expect(about?.textContent).toContain("About");
  } finally {
    await unmount(mounted);
  }
});

test("the Help group follows the active locale (EN → VI)", async () => {
  useLocaleStore.getState().setLocale("en");
  const mounted = await mountShell();
  try {
    act(() => useLocaleStore.getState().setLocale("vi"));
    const aside = document.querySelector("aside");
    if (!aside) throw new Error("aside not rendered");
    expect(aside.textContent).toContain("Trợ giúp");
    expect(aside.querySelector('a[href="/docs/quickstart"]')?.textContent).toContain("Hướng dẫn");
    expect(aside.querySelector('a[href="/about"]')?.textContent).toContain("Giới thiệu");
  } finally {
    act(() => useLocaleStore.getState().setLocale("en"));
    await unmount(mounted);
  }
});

test("activating the Tutorials link navigates to /docs/quickstart", async () => {
  useLocaleStore.getState().setLocale("en");
  useSidebarStore.setState({ collapsed: false });
  const mounted = await mountShell();
  try {
    const link = mounted.container.querySelector<HTMLAnchorElement>('a[href="/docs/quickstart"]');
    if (!link) throw new Error('Tutorials link (a[href="/docs/quickstart"]) not found');
    act(() => {
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    });
    await flush();
    expect(mounted.router.state.location.pathname).toBe("/docs/quickstart");
  } finally {
    await unmount(mounted);
  }
});

test("the mobile sheet carries the same Help links", async () => {
  useLocaleStore.getState().setLocale("en");
  useSidebarStore.setState({ collapsed: false });
  const mounted = await mountShell();
  try {
    await openMobileNav();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector('a[href="/docs/quickstart"]')).not.toBeNull();
    expect(dialog?.querySelector('a[href="/about"]')).not.toBeNull();
  } finally {
    await unmount(mounted);
  }
});

test("collapsed rail keeps an accessible name for the Help links", async () => {
  useLocaleStore.getState().setLocale("en");
  useSidebarStore.setState({ collapsed: true });
  const mounted = await mountShell();
  try {
    const aside = document.querySelector("aside");
    if (!aside) throw new Error("aside not rendered");
    const tutorials = aside.querySelector('a[href="/docs/quickstart"]');
    expect(tutorials?.getAttribute("aria-label")).toBe("Tutorials");
    const about = aside.querySelector('a[href="/about"]');
    expect(about?.getAttribute("aria-label")).toBe("About");
  } finally {
    useSidebarStore.setState({ collapsed: false });
    await unmount(mounted);
  }
});
