// Shell nav behavior contract (jsdom, real Radix + TanStack router):
// - Focused Chat: entering /chat collapses the desktop rail locally WITHOUT
//   writing the persisted hbr-sidebar preference; expanding on /chat stays
//   route-local; leaving /chat restores the persisted preference.
// - Active nav matches route segments at boundaries: /models/detail keeps
//   Models active via aria-current, and "/" never acts as a prefix root.
// - The theme toggle label is locale-aware (EN/VI), not a raw `Theme: x`.
// - The mobile global nav stays reachable on /chat.
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
let useThemeStore: (typeof import("../apps/web/src/lib/theme"))["useThemeStore"];
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
  ({ useThemeStore } = await import("../apps/web/src/lib/theme"));
  createRoot = (await import("react-dom/client")).createRoot as typeof createRoot;
});

afterAll(() => {
  useLocaleStore.getState().setLocale("en");
  useThemeStore.setState({ theme: "system" });
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
  router: { navigate: (opts: { href: string }) => Promise<unknown> };
}

async function mountShell(initialPath = "/"): Promise<Mounted> {
  const qc = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  const rootRoute = createRootRoute({ component: () => null });
  const route = (path: string) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      route("/"),
      route("/chat"),
      route("/models"),
      route("/models/detail"),
    ]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
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

async function navigate(mounted: Mounted, href: string) {
  await act(async () => {
    await mounted.router.navigate({ href });
    await flush();
    await flush();
  });
}

const persistedCollapsed = (): boolean | null => {
  const raw = localStorage.getItem("hbr-sidebar");
  if (!raw) return null;
  const parsed = JSON.parse(raw) as { state?: { collapsed?: boolean } };
  return parsed.state?.collapsed ?? null;
};

const asideEl = (): HTMLElement => {
  const aside = document.querySelector("aside");
  if (!aside) throw new Error("aside not rendered");
  return aside;
};

const clickByLabel = async (label: string) => {
  const btn = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!btn) throw new Error(`button "${label}" not found`);
  await act(async () => {
    btn.click();
    await flush();
    await flush();
  });
};

test("entering /chat collapses the rail locally and never writes the persisted preference", async () => {
  useLocaleStore.getState().setLocale("en");
  useSidebarStore.setState({ collapsed: false });
  localStorage.removeItem("hbr-sidebar");
  const mounted = await mountShell("/");
  try {
    expect(asideEl().className).toContain("w-52");
    await navigate(mounted, "/chat");
    expect(asideEl().className).toContain("w-14");
    // Route-local only: the persisted pref stays expanded:false (or unset).
    expect([false, null]).toContain(persistedCollapsed());
    // Expanding inside /chat is also route-local.
    await clickByLabel("Expand sidebar");
    expect(asideEl().className).toContain("w-52");
    expect([false, null]).toContain(persistedCollapsed());
    // Leaving /chat restores the (expanded) preference display.
    await navigate(mounted, "/");
    expect(asideEl().className).toContain("w-52");
  } finally {
    await unmount(mounted);
  }
});

test("a collapsed persisted preference survives a /chat visit", async () => {
  useLocaleStore.getState().setLocale("en");
  useSidebarStore.setState({ collapsed: true });
  const mounted = await mountShell("/chat");
  try {
    expect(asideEl().className).toContain("w-14");
    expect(persistedCollapsed()).toBe(true);
    await navigate(mounted, "/");
    expect(asideEl().className).toContain("w-14");
    expect(persistedCollapsed()).toBe(true);
  } finally {
    await unmount(mounted);
  }
});

test("active nav matches route segments, not arbitrary prefixes", async () => {
  useLocaleStore.getState().setLocale("en");
  useSidebarStore.setState({ collapsed: false });
  const mounted = await mountShell("/");
  try {
    await navigate(mounted, "/models/detail");
    const models = document.querySelector<HTMLAnchorElement>('a[href="/models"]');
    const overview = document.querySelector<HTMLAnchorElement>('a[href="/"]');
    expect(models?.getAttribute("aria-current")).toBe("page");
    expect(overview?.getAttribute("aria-current")).toBeNull();
    await navigate(mounted, "/models");
    expect(document.querySelector('a[href="/models"]')?.getAttribute("aria-current")).toBe("page");
  } finally {
    await unmount(mounted);
  }
});

test("the theme toggle label is localized (EN and VI)", async () => {
  useLocaleStore.getState().setLocale("en");
  useSidebarStore.setState({ collapsed: false });
  // The persisted default is "system"; pin "light" so the first label is known.
  useThemeStore.setState({ theme: "light" });
  const mounted = await mountShell("/");
  try {
    expect(document.querySelector('button[aria-label="Light theme"]')).not.toBeNull();
    // Toggling advances the localized label (light → dark).
    await clickByLabel("Light theme");
    expect(document.querySelector('button[aria-label="Dark theme"]')).not.toBeNull();
    await act(async () => {
      useLocaleStore.getState().setLocale("vi");
      await flush();
      await flush();
    });
    expect(document.querySelector('button[aria-label="Giao diện tối"]')).not.toBeNull();
    expect(document.querySelector('button[aria-label="Theme: dark"]')).toBeNull();
  } finally {
    await unmount(mounted);
  }
});

test("the mobile global nav is reachable on /chat", async () => {
  useLocaleStore.getState().setLocale("en");
  useSidebarStore.setState({ collapsed: false });
  const mounted = await mountShell("/chat");
  try {
    const trigger = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Open navigation"]',
    );
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger!.click();
      for (let i = 0; i < 50; i++) {
        await flush();
        if (document.querySelector('[role="dialog"]')) break;
      }
    });
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector('a[href="/chat"]')).not.toBeNull();
  } finally {
    await unmount(mounted);
  }
});
