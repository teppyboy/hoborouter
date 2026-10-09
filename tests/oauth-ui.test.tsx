// OAuth social sign-in UI contract (semantic render + interaction):
// - Provider buttons appear only for providers the server's public-config
//   socialProviders map flags enabled (absent map -> no buttons, email-only).
// - Exact accessible labels: "Continue with Google/Discord/GitHub"; provider
//   names are proper nouns and never translated.
// - A pending provider attempt locks every provider button (no duplicate
//   clicks); an initiation failure shows the shared non-leaky recovery error
//   ("Sign-in could not complete. Try again or use email.") — never the raw
//   upstream message — and re-enables the buttons.
// - signIn.social is called with the exact installed Better Auth client
//   provider id and a same-origin post-login callbackURL ("/" SPA path).
// - Email path and captcha fail-closed behavior are untouched: a public-config
//   load error still disables the email submit and hides OAuth buttons.
import { test, expect, afterAll, mock } from "bun:test";
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

// --- Mock lib/auth BEFORE pages import it -----------------------------------

const socialCalls: { provider: string; callbackURL: string }[] = [];
let socialResponse: Promise<{ error: { message?: string } | null }> = Promise.resolve({
  error: null,
});

mock.module("../apps/web/src/lib/auth", () => ({
  authClient: {},
  signIn: {
    social: (args: { provider: string; callbackURL: string }) => {
      socialCalls.push(args);
      return socialResponse;
    },
  },
  signUp: {},
  signOut: {},
  useSession: () => ({ data: null, isPending: false }),
  resendVerification: async () => ({ ok: false, rateLimited: false }),
}));

// --- Browser globals (pages/toggles read window/matchMedia at module load) --

const GLOBAL_KEYS = ["window", "document", "localStorage", "location"] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;
let documentRef: Document;
// Test-realm event constructor: clicks dispatch via the jsdom window's own
// MouseEvent (the real constructor of the rendered document), never a global.
let MouseEventCtor: new (type: string, init?: { bubbles?: boolean }) => Event;

beforeAllGlobals();
function beforeAllGlobals() {
  const win = new JSDOM("", { url: "http://localhost:5173" }).window as unknown as {
    document: object;
    localStorage: Storage;
    location: unknown;
    matchMedia: unknown;
    close: () => void;
  };
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
  documentRef = win.document as unknown as Document;
  MouseEventCtor = (win as unknown as { MouseEvent: typeof MouseEventCtor }).MouseEvent;
}
afterAll(async () => {
  // Drain react-dom's scheduled work while the jsdom window still exists:
  // scheduler callbacks (performWorkUntilDeadline) read window.event at flush
  // time, so restoring globals first turns the drain into cross-file crashes
  // (window is not defined) for whichever test file loads next.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  jsdomWindow?.close();
  jsdomWindow = null;
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// react-dom/client resolves through the web app's own node_modules (see
// tests/auth-i18n.test.tsx for the same read-only resolution pattern).
const authPageDir = new URL("../apps/web/src/pages/auth/", import.meta.url).pathname;
const domClientEntry = Bun.resolveSync("react-dom/client", authPageDir);
const { createRoot } = (await import(domClientEntry)) as {
  createRoot: (container: HTMLElement) => {
    render: (node: unknown) => void;
    unmount: () => void;
  };
};

const { default: LoginPage } = await import("../apps/web/src/pages/auth/login");
const { default: SignupPage } = await import("../apps/web/src/pages/auth/signup");
const { authCopy } = await import("../apps/web/src/pages/auth/copy");
const { translate } = await import("../apps/web/src/lib/i18n/t");
const { socialProvidersFrom } = await import("../apps/web/src/lib/public-config");

const CONFIG_KEY = ["public-config"] as const;
const baseConfig = {
  turnstileSiteKey: null,
  emailVerification: { enabled: false, required: false },
};

function renderPage(page: "login" | "signup", prepare?: (qc: QueryClient) => void): HTMLElement {
  const qc = new QueryClient({
    defaultOptions: { queries: { enabled: false } },
  });
  prepare?.(qc);
  const rootRoute = createRootRoute({ component: () => null });
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: `/${page}`,
    component: page === "login" ? LoginPage : SignupPage,
  });
  const container = documentRef.createElement("div");
  documentRef.body.appendChild(container);
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [`/${page}`] }),
  });
  const root = createRoot(container);
  act(() =>
    root.render(
      <routerContext.Provider value={router}>
        <QueryClientProvider client={qc}>
          {page === "login" ? <LoginPage /> : <SignupPage />}
        </QueryClientProvider>
      </routerContext.Provider>,
    ),
  );
  // The root must be REALLY unmounted (not just detached) before this file's
  // jsdom globals are restored: react-dom keeps scheduler callbacks alive that
  // read window.event at flush time, and a detached container leaks renders.
  lastRoot = root;
  return container;
}

let lastRoot: { unmount: () => void } | null = null;

function unmountPage(container: HTMLElement) {
  act(() => {
    lastRoot?.unmount();
    lastRoot = null;
    container.remove();
  });
}

function seedConfigError(qc: QueryClient) {
  const query = qc.getQueryCache().build(qc, qc.defaultQueryOptions({ queryKey: CONFIG_KEY }));
  query.setState({ status: "error", fetchStatus: "idle", error: new Error("503") });
}

function providerButtons(html: string): string[] {
  return [...html.matchAll(/>(Continue with [A-Za-z]+)</g)].flatMap((m) =>
    m[1] === undefined ? [] : [m[1]],
  );
}

// --- SSR: availability flags -------------------------------------------------

test("no socialProviders in config: no provider buttons on login or signup", () => {
  for (const page of ["login", "signup"] as const) {
    const c = renderPage(page, (qc) => qc.setQueryData(CONFIG_KEY, baseConfig));
    expect(providerButtons(c.innerHTML)).toEqual([]);
    unmountPage(c);
  }
});

test("enabled providers render exact 'Continue with <Provider>' labels", () => {
  const c = renderPage("login", (qc) =>
    qc.setQueryData(CONFIG_KEY, {
      ...baseConfig,
      socialProviders: { google: true, discord: true, github: true },
    }),
  );
  expect(providerButtons(c.innerHTML)).toEqual([
    "Continue with Google",
    "Continue with Discord",
    "Continue with GitHub",
  ]);
  unmountPage(c);
});

test("partial provider map renders only enabled providers (login and signup consistent)", () => {
  const partial = { socialProviders: { google: false, discord: true, github: true } };
  for (const page of ["login", "signup"] as const) {
    const c = renderPage(page, (qc) => qc.setQueryData(CONFIG_KEY, { ...baseConfig, ...partial }));
    expect(providerButtons(c.innerHTML)).toEqual(["Continue with Discord", "Continue with GitHub"]);
    unmountPage(c);
  }
});

test("config load error hides provider buttons and keeps email submit fail-closed", () => {
  const c = renderPage("login", seedConfigError);
  expect(providerButtons(c.innerHTML)).toEqual([]);
  expect(c.innerHTML).toContain("Could not load security options");
  expect(c.innerHTML).toMatch(/type="submit"[^>]*disabled/);
  unmountPage(c);
});

test("provider buttons render stable proper-noun names in both locales", () => {
  const key = (name: string): { en: string; vi: string } => {
    const entry = (authCopy as unknown as Record<string, { en: string; vi: string }>)[name];
    // Throws (test red) until pages/auth/copy.ts ships the OAuth keys.
    if (!entry) throw new Error(`missing auth copy key: ${name}`);
    return entry;
  };
  // Rendered labels: translated frame, verbatim proper-noun provider names.
  expect(translate(authCopy, "continueWith" as never, "en", { provider: "Google" })).toBe(
    "Continue with Google",
  );
  expect(translate(authCopy, "continueWith" as never, "en", { provider: "Discord" })).toBe(
    "Continue with Discord",
  );
  expect(translate(authCopy, "continueWith" as never, "en", { provider: "GitHub" })).toBe(
    "Continue with GitHub",
  );
  expect(translate(authCopy, "continueWith" as never, "vi", { provider: "Google" })).toBe(
    "Tiếp tục với Google",
  );
  // The templates themselves interpolate a {provider} placeholder (names are
  // never localized), and the recovery copy points at the email fallback.
  expect(key("continueWith").en).toBe("Continue with {provider}");
  expect(key("continueWith").vi).toBe("Tiếp tục với {provider}");
  expect(key("oauthFailed").vi).toContain("email");
});

test("socialProvidersFrom maps absent/undefined config to an empty list", () => {
  expect(socialProvidersFrom(undefined)).toEqual([]);
  expect(socialProvidersFrom(baseConfig)).toEqual([]);
});

// --- Interaction: initiation, pending lockout, shared error ------------------

test("clicking a provider calls signIn.social with its client id and same-origin '/' callback, locks duplicates, and recovers with the shared error on failure", async () => {
  socialCalls.length = 0;
  let resolveSocial!: (v: { error: { message?: string } | null }) => void;
  socialResponse = new Promise((res) => {
    resolveSocial = res;
  });

  const c = renderPage("login", (qc) =>
    qc.setQueryData(CONFIG_KEY, {
      ...baseConfig,
      socialProviders: { google: true, discord: true, github: true },
    }),
  );

  const googleButton = [...c.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Continue with Google"),
  );
  expect(googleButton).toBeDefined();
  await act(async () => {
    googleButton!.dispatchEvent(new MouseEventCtor("click", { bubbles: true }));
  });

  expect(socialCalls).toHaveLength(1);
  const initiated = socialCalls[0];
  expect(initiated).toBeDefined();
  expect(initiated?.provider).toBe("google");
  // Same-origin post-login SPA path: jsdom origin + "/" (no invented
  // provider-callback route; matches the JSDOM url in the test realm setup).
  expect(initiated?.callbackURL).toBe("http://localhost:5173/");

  // Pending initiation: every provider button is locked (no duplicate clicks).
  const pendingHtml = c.innerHTML;
  for (const label of ["Google", "Discord", "GitHub"]) {
    const btn = [...c.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes(`Continue with ${label}`),
    );
    expect(btn?.hasAttribute("disabled")).toBe(true);
  }
  expect(pendingHtml).not.toContain("Sign-in could not complete");

  await act(async () => {
    resolveSocial({ error: { message: "provider setup broken: secret xyz" } });
    await socialResponse;
  });

  const html = c.innerHTML;
  // Shared recovery error, non-leaky: the raw upstream message never renders.
  expect(html).toContain("Sign-in could not complete. Try again or use email.");
  expect(html).not.toContain("provider setup broken");
  expect(html).not.toContain("secret xyz");
  // Buttons unlocked for retry; the email path remains fully present.
  expect(
    [...c.querySelectorAll("button")].filter(
      (b) => (b.textContent ?? "").includes("Continue with") && b.hasAttribute("disabled"),
    ),
  ).toHaveLength(0);
  expect(html).toContain('type="email"');
  unmountPage(c);
});

test("signup initiation failure shows the same shared recovery error and keeps the form", async () => {
  socialCalls.length = 0;
  socialResponse = Promise.resolve({ error: { message: "nope" } });

  const c = renderPage("signup", (qc) =>
    qc.setQueryData(CONFIG_KEY, {
      ...baseConfig,
      socialProviders: { google: true, discord: false, github: false },
    }),
  );
  const googleButton = [...c.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Continue with Google"),
  );
  await act(async () => {
    googleButton!.dispatchEvent(new MouseEventCtor("click", { bubbles: true }));
  });
  await act(async () => {
    await socialResponse;
  });
  expect(c.innerHTML).toContain("Sign-in could not complete. Try again or use email.");
  expect(c.innerHTML).toContain("Create account");
  expect(c.innerHTML).toContain('type="email"');
  unmountPage(c);
});

test("auth pages render the shared auth layout chrome (brand + locale/theme toggles)", () => {
  const c = renderPage("login", (qc) => qc.setQueryData(CONFIG_KEY, baseConfig));
  const html = c.innerHTML;
  expect(html).toContain("Hoborouter");
  expect(html).toContain("Switch to Vietnamese");
  unmountPage(c);
});
