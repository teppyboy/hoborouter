// Focused LanguageToggle contract test: clicking the header toggle must
// translate visible page text (login form), persist the locale to the
// hbr-locale localStorage entry, and survive a simulated reload (rehydrate
// into a fresh store). This is the end-user-visible guarantee behind the
// toggle; store internals have narrower coverage in tests/i18n.test.tsx.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRouter,
  createRootRoute,
  createRoute,
  createMemoryHistory,
} from "@tanstack/react-router";
// routerContext is not part of the package's public surface; providing it
// directly lets SSR-free page renders use Link/useNavigate without a full
// RouterProvider mount (which renders nothing under renderToStaticMarkup).
import { routerContext } from "@tanstack/react-router/dist/esm/routerContext.js";
import { JSDOM } from "jsdom";
import type { LocaleState } from "../apps/web/src/lib/i18n/locale";

/** PersistStorage following the LIVE global localStorage at call time; no-ops
 *  when no test environment has installed one. Never undefined, so lazily
 *  binding stores cannot crash on persist writes after sibling teardown. */
function liveLocalStorageAdapter<S>() {
  const ls = () => (globalThis as { localStorage?: Storage }).localStorage;
  return {
    getItem: (name: string): { state: S; version: number } | null => {
      const raw = ls()?.getItem(name);
      return raw ? (JSON.parse(raw) as { state: S; version: number }) : null;
    },
    setItem: (name: string, value: { state: S; version?: number }) => {
      ls()?.setItem(name, JSON.stringify(value));
    },
    removeItem: (name: string) => {
      ls()?.removeItem(name);
    },
  };
}

const GLOBAL_KEYS = ["window", "document", "localStorage", "location"] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let originalFetch: typeof fetch | undefined;
let jsdomWindow: { close: () => void } | null = null;

let LoginPage: (typeof import("../apps/web/src/pages/auth/login"))["default"];
let LanguageToggle: (typeof import("../apps/web/src/components/language-toggle"))["LanguageToggle"];
let useLocaleStore: (typeof import("../apps/web/src/lib/i18n/locale"))["useLocaleStore"];
let AppShell: (typeof import("../apps/web/src/components/app-shell"))["AppShell"];
let PublicLayout: (typeof import("../apps/web/src/components/public-layout"))["PublicLayout"];
let useSidebarStore: (typeof import("../apps/web/src/lib/sidebar"))["useSidebarStore"];

beforeAll(async () => {
  const win = new JSDOM("", { url: "http://localhost:5173" }).window as unknown as {
    document: object;
    localStorage: Storage;
    location: unknown;
    matchMedia: unknown;
    close: () => void;
  };
  // Sonner/theme hooks need matchMedia under jsdom.
  win.matchMedia = () => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  for (const k of GLOBAL_KEYS) {
    originals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  }
  const values: Record<string, unknown> = {
    window: win,
    document: win.document,
    localStorage: win.localStorage,
    location: win.location,
  };
  for (const [k, v] of Object.entries(values)) {
    (globalThis as Record<string, unknown>)[k] = v;
  }
  jsdomWindow = win;
  // AppShell's useIsAdmin fetches /api/v1/me on mount; a real (or resolving)
  // response triggers a setState outside act and leaves a scheduler callback
  // that fires after the jsdom globals are restored and crashes the run. The
  // admin flag is irrelevant here, so never resolve.
  originalFetch = globalThis.fetch;
  globalThis.fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  // Import AFTER the jsdom globals exist: lib/auth reads window.location
  // origin and zustand persist binds localStorage at first module load.
  ({ default: LoginPage } = await import("../apps/web/src/pages/auth/login"));
  ({ LanguageToggle } = await import("../apps/web/src/components/language-toggle"));
  ({ useLocaleStore } = await import("../apps/web/src/lib/i18n/locale"));
  // Sibling test files (e.g. shell-responsive) may have imported the store
  // first in this process without a localStorage, leaving persist bound to a
  // missing storage. Root-cause fix: bind a never-undefined adapter following
  // the LIVE global localStorage at call time (no-ops when none installed);
  // it stays bound for the process. Restoring `storage: undefined` in
  // afterAll instead crashed lazily-binding sibling stores (sidebar persist).
  useLocaleStore.persist.setOptions({ storage: liveLocalStorageAdapter<LocaleState>() });
  ({ AppShell } = await import("../apps/web/src/components/app-shell"));
  ({ PublicLayout } = await import("../apps/web/src/components/public-layout"));
  ({ useSidebarStore } = await import("../apps/web/src/lib/sidebar"));
});

afterAll(() => {
  useLocaleStore.getState().setLocale("en");
  useSidebarStore.setState({ collapsed: false });
  if (originalFetch) globalThis.fetch = originalFetch;
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  jsdomWindow?.close();
  jsdomWindow = null;
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// react-dom/client is only resolvable through the web app's own node_modules.
const authPageDir = new URL("../apps/web/src/pages/auth/", import.meta.url).pathname;
const { createRoot } = (await import(Bun.resolveSync("react-dom/client", authPageDir))) as {
  createRoot: (c: HTMLElement) => {
    render: (n: unknown) => void;
    unmount: () => void;
  };
};

// Mount the login page with the header toggle beside it, the way the auth
// layout renders both. Queries are disabled/seeded so no network runs.
function mountLogin(): {
  root: { unmount: () => void };
  container: HTMLElement;
  text: () => string;
} {
  const qc = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  qc.setQueryData(["public-config"] as const, {
    turnstileSiteKey: null,
    emailVerification: { enabled: false, required: false },
  });
  const router = createRouter({
    routeTree: createRootRoute({ component: () => null }).addChildren([
      createRoute({
        getParentRoute: () => createRootRoute(),
        path: "/login",
        component: LoginPage,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/login"] }),
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const reactRoot = createRoot(container);
  act(() =>
    reactRoot.render(
      <routerContext.Provider value={router}>
        <QueryClientProvider client={qc}>
          <LanguageToggle />
          <LoginPage />
        </QueryClientProvider>
      </routerContext.Provider>,
    ),
  );
  return {
    root: reactRoot,
    container,
    text: () => container.textContent ?? "",
  };
}

function unmount(mounted: ReturnType<typeof mountLogin>) {
  // Real act(unmount): leaving the root mounted keeps scheduler callbacks
  // alive that later fire after the jsdom globals are restored and crash.
  act(() => mounted.root.unmount());
  mounted.container.remove();
}

async function clickToggle(container: HTMLElement) {
  const button = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Switch to Vietnamese"], button[aria-label="Chuyển sang tiếng Anh"]',
  );
  if (!button) throw new Error("language toggle button not found");
  act(() => button.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
  await Promise.resolve();
}

test("clicking the toggle translates the login page EN → VI and persists the choice", async () => {
  useLocaleStore.getState().setLocale("en");
  const mounted = mountLogin();
  try {
    expect(mounted.text()).toContain("Sign in");
    await clickToggle(mounted.container);
    // Visible translated text, not just store state.
    expect(mounted.text()).toContain("Đăng nhập");
    expect(mounted.text()).toContain("Mật khẩu");
    expect(document.documentElement.lang).toBe("vi");
    // Persisted to the hbr-locale entry the store rehydrates from.
    expect(window.localStorage.getItem("hbr-locale")).toContain('"locale":"vi"');
  } finally {
    unmount(mounted);
  }
});

test("the persisted locale survives a simulated reload (fresh store rehydrate)", async () => {
  useLocaleStore.setState({ locale: "en" }); // fresh-session default before rehydrate
  // Set the stored payload AFTER the setState above: persist writes back to
  // storage on every state change, so setting it first would be overwritten.
  window.localStorage.setItem(
    "hbr-locale",
    JSON.stringify({ state: { locale: "vi" }, version: 0 }),
  );
  await useLocaleStore.persist.rehydrate();
  const mounted = mountLogin();
  try {
    // Vietnamese renders without any click: the reload kept the choice.
    expect(mounted.text()).toContain("Đăng nhập");
    expect(mounted.text()).not.toContain("Welcome back. No account?");
  } finally {
    unmount(mounted);
  }
});

test("clicking the toggle again returns the page to English", async () => {
  useLocaleStore.getState().setLocale("vi");
  const mounted = mountLogin();
  try {
    expect(mounted.text()).toContain("Đăng nhập");
    await clickToggle(mounted.container);
    expect(mounted.text()).toContain("Sign in");
    expect(mounted.text()).not.toContain("Đăng nhập");
    expect(window.localStorage.getItem("hbr-locale")).toContain('"locale":"en"');
    expect(document.documentElement.lang).toBe("en");
  } finally {
    unmount(mounted);
  }
});

// --- Shell + public chrome (the labels a first-time visitor actually sees) --

// Generic mount for any chrome tree: queries disabled so no network runs.
function mountChrome(node: React.ReactNode): ReturnType<typeof mountLogin> {
  const qc = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  const router = createRouter({
    routeTree: createRootRoute({ component: () => null }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const reactRoot = createRoot(container);
  act(() =>
    reactRoot.render(
      <routerContext.Provider value={router}>
        <QueryClientProvider client={qc}>{node}</QueryClientProvider>
      </routerContext.Provider>,
    ),
  );
  return { root: reactRoot, container, text: () => container.textContent ?? "" };
}

function renderStaticChrome(node: React.ReactNode): string {
  const qc = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  const router = createRouter({
    routeTree: createRootRoute({ component: () => null }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return renderToStaticMarkup(
    <routerContext.Provider value={router}>
      <QueryClientProvider client={qc}>{node}</QueryClientProvider>
    </routerContext.Provider>,
  );
}

test("the app-shell sidebar is English at the default locale", () => {
  useLocaleStore.getState().setLocale("en");
  // Sibling suites (e.g. sidebar-hover) leave the cached sidebar store
  // collapsed; a collapsed rail renders no nav text, which would fail the
  // label assertions for isolation reasons rather than behavior.
  useSidebarStore.setState({ collapsed: false });
  const html = renderStaticChrome(
    <AppShell>
      <p>page body</p>
    </AppShell>,
  );
  expect(html).toContain("Overview");
  expect(html).toContain("AI Gateway");
  expect(html).not.toContain("Tổng quan");
});

test("clicking the shell's own toggle translates the sidebar EN → VI", async () => {
  useLocaleStore.getState().setLocale("en");
  useSidebarStore.setState({ collapsed: false }); // see isolation note above
  const mounted = mountChrome(
    <AppShell>
      <p>page body</p>
    </AppShell>,
  );
  try {
    expect(mounted.text()).toContain("Overview");
    await clickToggle(mounted.container);
    expect(mounted.text()).toContain("Tổng quan");
    expect(mounted.text()).toContain("Mô hình");
    expect(mounted.text()).toContain("Khoá API");
    expect(mounted.text()).toContain("Thanh toán");
    expect(mounted.text()).not.toContain("API Keys");
    // Back to English via the same button.
    await clickToggle(mounted.container);
    expect(mounted.text()).toContain("API Keys");
  } finally {
    unmount(mounted);
  }
});

test("clicking the toggle translates the public header/footer chrome EN → VI", async () => {
  useLocaleStore.getState().setLocale("en");
  const mounted = mountChrome(
    <PublicLayout instance={null}>
      <p>landing body</p>
    </PublicLayout>,
  );
  try {
    expect(mounted.text()).toContain("Sign in");
    expect(mounted.text()).toContain("Sign up");
    await clickToggle(mounted.container);
    expect(mounted.text()).toContain("Đăng nhập");
    expect(mounted.text()).toContain("Đăng ký");
    expect(mounted.text()).toContain("Bảng giá");
    expect(mounted.text()).toContain("Điều khoản");
    expect(mounted.text()).toContain("Quyền riêng tư");
    expect(mounted.text()).not.toContain("Sign up");
  } finally {
    unmount(mounted);
  }
});
