// Shared help pages context contract (jsdom, real router.tsx routeTree):
// - /about and /docs/quickstart keep ONE public URL each. The layout is
//   context-adaptive: signed-in users navigate by the sidebar Help links and
//   stay inside the AppShell (the same mounted shell node — sidebar/header/
//   identity persist, no remount flash), anonymous visitors get the page with
//   its own public chrome.
// - Anonymous rendering must not touch protected resources (no /api/v1/me,
//   no /api/v1/workspaces) and must not leak session identity.
// - Each help page shows exactly one content heading (<h1>).
import { test, expect, beforeAll, afterAll, mock } from "bun:test";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SESSION_QUERY_KEY } from "../apps/web/src/lib/session";
import {
  createRouter,
  createMemoryHistory,
  RouterProvider,
  type AnyRouter,
} from "@tanstack/react-router";
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
  "scrollTo",
  "history",
] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;

import * as ReactNS from "react";
mock.module("@radix-ui/react-use-layout-effect", () => ({
  useLayoutEffect: ReactNS.useLayoutEffect,
}));

const INSTANCE = {
  name: "Hoborouter",
  api_base_url: "https://hoborouter.example",
  support: { email: "support@example.test", telegram: null, facebook: null, threads: null },
};

const state = { authenticated: false };
const fetchLog: string[] = [];

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const stubFetch = (input: RequestInfo | URL): Promise<Response> => {
  const path = String(input);
  fetchLog.push(path);
  if (path.includes("/api/auth/get-session")) {
    if (!state.authenticated)
      return Promise.resolve(
        new Response("null", { status: 401, headers: { "content-type": "application/json" } }),
      );
    return Promise.resolve(
      ok({
        user: { id: "u1", name: "T", email: "t@example.test", emailVerified: true },
        session: { userId: "u1" },
      }),
    );
  }
  if (path.includes("/api/v1/me")) return Promise.resolve(ok({ is_instance_admin: false }));
  if (path.includes("/api/v1/public-config"))
    return Promise.resolve(ok({ turnstileSiteKey: null, emailVerification: { enabled: false } }));
  if (path.includes("/usage-summary"))
    return Promise.resolve(
      ok({
        totals: {
          requests: 0,
          spend_vnd: 0,
          input_tokens: 0,
          output_tokens: 0,
          errors: 0,
          visible_requests: 0,
          visible_errors: 0,
        },
        daily: [],
        by_model: [],
      }),
    );
  if (path.includes("/usage-logs")) return Promise.resolve(ok({ data: [] }));
  if (path.includes("/api/v1/workspaces")) return Promise.resolve(ok([{ id: "ws1", name: "WS" }]));
  if (path.includes("/api/v1/public/instance")) return Promise.resolve(ok(INSTANCE));
  if (path.includes("/api/v1/public/catalog")) return Promise.resolve(ok({ data: [] }));
  return Promise.resolve(ok({}));
};

let routeTree: AnyRouter["routeTree"];
let routerQueryClient: QueryClient;
let authClientRef: {
  $store: { notify: (signal?: string) => void };
} | null = null;
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
  ({ routeTree } = await import("../apps/web/src/router"));
  ({ queryClient: routerQueryClient } = await import("../apps/web/src/lib/query-client"));
  // Same origin better-auth client the app uses: its session atom caches the
  // last session across tests in one bun process — notify($sessionSignal)
  // drops the freshness window so the next getSession hits the stub again.
  // ($store ships at runtime but not in this client's public type; cast.)
  const { authClient } = await import("../apps/web/src/lib/auth");
  authClientRef = authClient as unknown as { $store: { notify: (signal?: string) => void } };
  createRoot = (await import("react-dom/client")).createRoot as typeof createRoot;
});

afterAll(() => {
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

async function waitFor(cond: () => boolean, what: string, tries = 400) {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await flush();
  }
  throw new Error(`condition not met: ${what}`);
}

interface Mounted {
  root: { unmount: () => void };
  container: HTMLElement;
  router: {
    state: { location: { pathname: string } };
    history: { back: () => void; push: (path: string) => void };
  };
}

/** Deterministic session-state reset: router module queryClient (shared in
 * one bun process) plus the better-auth session atom freshness window. */
function resetSessionState() {
  routerQueryClient.clear();
  authClientRef?.$store.notify("$sessionSignal");
}

async function mountApp(initial: string): Promise<Mounted> {
  // The router's module-level queryClient IS the provider client here, so
  // beforeLoad's session warm-up and the layout's useShellSession read one
  // cache. Reset it so every mount reflects the fetch stub's CURRENT
  // authentication state (no cross-test leakage).
  resetSessionState();
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initial] }),
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const reactRoot = createRoot(container);
  await act(async () => {
    reactRoot.render(
      <QueryClientProvider client={routerQueryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await flush();
    await flush();
  });
  return { root: reactRoot, container, router: router as never };
}

async function unmount(mounted: Mounted) {
  await act(async () => {
    await flush();
    mounted.root.unmount();
  });
  mounted.container.remove();
  await act(async () => {
    resetSessionState();
    await flush();
  });
}

async function clickHelpLink(href: string) {
  const link = document.querySelector<HTMLAnchorElement>(`aside a[href="${href}"]`);
  if (!link) throw new Error(`sidebar link ${href} not found`);
  await act(async () => {
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    await flush();
  });
}

const h1Texts = () => [...document.querySelectorAll("h1")].map((h) => (h.textContent ?? "").trim());

test("signed-in: About stays inside the same mounted AppShell with one heading", async () => {
  state.authenticated = true;
  const mounted = await mountApp("/");
  try {
    await waitFor(() => !!document.querySelector("aside"), "app shell aside");
    const asideBefore = document.querySelector("aside");
    await clickHelpLink("/about");
    await waitFor(
      () => mounted.router.state.location.pathname === "/about" && h1Texts().includes("About"),
      "About route rendered",
    );
    // Same shell node: sidebar/header/session identity persist (no remount).
    expect(document.querySelector("aside")).toBe(asideBefore);
    // Signed-in identity: the workspace switcher carries the session workspace.
    expect(document.body.textContent).toContain("WS");
    // Exactly one content heading.
    expect(h1Texts()).toEqual(["About"]);
    // Configured DB contact email wins inside the shell too (not the
    // project fallback).
    await waitFor(
      () => document.body.innerHTML.includes("mailto:support@example.test"),
      "configured contact rendered",
    );
  } finally {
    await unmount(mounted);
  }
});

test("signed-in: Tutorials (/docs/quickstart) stays inside the AppShell", async () => {
  state.authenticated = true;
  const mounted = await mountApp("/");
  try {
    await waitFor(() => !!document.querySelector("aside"), "app shell aside");
    const asideBefore = document.querySelector("aside");
    await clickHelpLink("/docs/quickstart");
    await waitFor(
      () =>
        mounted.router.state.location.pathname === "/docs/quickstart" &&
        h1Texts().includes("Quickstart"),
      "Quickstart route rendered",
    );
    expect(document.querySelector("aside")).toBe(asideBefore);
    expect(document.body.textContent).toContain("WS");
    expect(h1Texts()).toEqual(["Quickstart"]);
  } finally {
    await unmount(mounted);
  }
});

test("signed-in: browser back returns to the app with the shell still mounted", async () => {
  state.authenticated = true;
  const mounted = await mountApp("/");
  try {
    await waitFor(() => !!document.querySelector("aside"), "app shell aside");
    const asideBefore = document.querySelector("aside");
    await clickHelpLink("/about");
    await waitFor(() => h1Texts().includes("About"), "About rendered");
    await act(async () => {
      mounted.router.history.back();
      await flush();
    });
    await waitFor(() => mounted.router.state.location.pathname === "/", "back to overview");
    expect(document.querySelector("aside")).toBe(asideBefore);
  } finally {
    await unmount(mounted);
  }
});

test("anonymous deep link /about: public chrome, one heading, no protected resource calls", async () => {
  state.authenticated = false;
  fetchLog.length = 0;
  const mounted = await mountApp("/about");
  try {
    await waitFor(() => h1Texts().includes("About"), "About rendered");
    expect(document.querySelector("aside")).toBeNull();
    // Public chrome, not the app shell.
    expect(document.body.textContent).toContain("Sign in");
    expect(h1Texts()).toEqual(["About"]);
    // No session identity, no protected resources fetched.
    expect(document.body.textContent).not.toContain("t@example.test");
    expect(fetchLog.some((p) => p.includes("/api/v1/me"))).toBe(false);
    expect(fetchLog.some((p) => p.includes("/api/v1/workspaces"))).toBe(false);
  } finally {
    await unmount(mounted);
  }
});

test("anonymous deep link /docs/quickstart: public chrome and public docs access", async () => {
  state.authenticated = false;
  fetchLog.length = 0;
  const mounted = await mountApp("/docs/quickstart");
  try {
    await waitFor(() => h1Texts().includes("Quickstart"), "Quickstart rendered");
    expect(document.querySelector("aside")).toBeNull();
    expect(document.body.textContent).toContain("Sign in");
    expect(h1Texts()).toEqual(["Quickstart"]);
    // Public snippet content uses the configured base URL; docs stay public.
    await waitFor(
      () => document.body.textContent!.includes("https://hoborouter.example/v1"),
      "instance data rendered",
    );
    expect(fetchLog.some((p) => p.includes("/api/v1/me"))).toBe(false);
    expect(fetchLog.some((p) => p.includes("/api/v1/workspaces"))).toBe(false);
  } finally {
    await unmount(mounted);
  }
});

test("authenticated -> logout -> anonymous: help renders public chrome, no stale shell, no protected calls", async () => {
  state.authenticated = true;
  const mounted = await mountApp("/");
  try {
    await waitFor(() => !!document.querySelector("aside"), "app shell aside");
    // Same logout path as the AppShell sign-out button: the better-auth client
    // sign-out, then the shared queryClient clear (drops the ["session"] RQ
    // entry so the next gate read refetches instead of replaying the cache).
    state.authenticated = false;
    fetchLog.length = 0;
    await act(async () => {
      await (authClientRef as unknown as { signOut: () => Promise<unknown> }).signOut();
      // Invalidate FIRST: the active shell observer must refetch (401) and
      // re-render anonymous before the cache wipe, else a removed cache entry
      // leaves the mounted observer rendering its stale in-memory session.
      await routerQueryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      routerQueryClient.clear();
      await flush();
    });
    await act(async () => {
      mounted.router.history.push("/about");
      await flush();
    });
    // The shell's embedded About page renders the same h1, so the shell
    // removal is the authoritative signal: the stale RQ session entry must
    // drop (refetch after clear -> 401) before the public chrome appears.
    await waitFor(() => !document.querySelector("aside"), "stale shell unmounted after logout");
    // From here on, only the /about leg matters: the bare "/" render between
    // logout and navigation (real app assigns /login) may still have fired
    // protected refetches; they are out of scope for this assertion.
    fetchLog.length = 0;
    await waitFor(() => h1Texts().includes("About"), "public About rendered");
    expect(document.querySelector("aside")).toBeNull();
    expect(document.body.textContent).toContain("Sign in");
    expect(h1Texts()).toEqual(["About"]);
    // The revoked session must not have pulled protected resources after
    // logout, and the identity must not leak into the public render.
    expect(fetchLog.some((p) => p.includes("/api/v1/me"))).toBe(false);
    expect(fetchLog.some((p) => p.includes("/api/v1/workspaces"))).toBe(false);
    expect(document.body.textContent).not.toContain("t@example.test");
  } finally {
    await unmount(mounted);
  }
});
