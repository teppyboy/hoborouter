// Admin sidebar group contract (jsdom, real Radix + TanStack router):
// - The admin sidebar shows an "Admin" group (tools) and a dedicated "Logs"
//   group holding the audit log and request log links.
// - The System entry is gone from the nav: /admin/system folded into
//   /admin/settings, so no link to it may exist anywhere in the shell.
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
      ? { is_instance_admin: true }
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
  globalThis.fetch = originalFetch;
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

async function mountShell(): Promise<{ root: { unmount: () => void }; container: HTMLElement }> {
  const qc = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  const rootRoute = createRootRoute({ component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/admin/settings",
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
  return { root: reactRoot, container };
}

async function unmount(mounted: { root: { unmount: () => void }; container: HTMLElement }) {
  await flush();
  await flush();
  act(() => mounted.root.unmount());
  mounted.container.remove();
  await flush();
}

test("admin sidebar has Admin tools group and a dedicated Logs group; no System link", async () => {
  useLocaleStore.getState().setLocale("en");
  useSidebarStore.setState({ collapsed: false });
  const mounted = await mountShell();
  try {
    const aside = document.querySelector("aside");
    if (!aside) throw new Error("aside not rendered");
    const text = aside.textContent ?? "";
    // Logs section exists with both log links.
    expect(text).toContain("Logs");
    expect(aside.querySelector('a[href="/admin/audit"]')).not.toBeNull();
    expect(aside.querySelector('a[href="/admin/request-log"]')).not.toBeNull();
    // Admin tools still present, System folded into Settings.
    expect(aside.querySelector('a[href="/admin/settings"]')).not.toBeNull();
    expect(aside.querySelector('a[href="/admin/users"]')).not.toBeNull();
    expect(aside.querySelector('a[href="/admin/system"]')).toBeNull();
  } finally {
    await unmount(mounted);
  }
});
