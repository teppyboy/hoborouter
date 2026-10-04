// Auth CAPTCHA wiring contract (semantic SSR render):
// - Public-config pending/error blocks submit and surfaces a readable Retry;
//   captcha is never silently skipped on a config load failure.
// - Config with a Turnstile site key requires a token (submit disabled until
//   solved); config without one keeps the plain form working.
// - Signup keeps the shared password checklist/confirm-password flow.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRouter,
  createRootRoute,
  createRoute,
  createMemoryHistory,
} from "@tanstack/react-router";
// routerContext is not part of the package's public surface; providing it
// directly lets SSR tests render pages that use Link/useNavigate without a
// full RouterProvider mount (which renders nothing under renderToStaticMarkup).
import { routerContext } from "@tanstack/react-router/dist/esm/routerContext.js";

// lib/auth reads window.location.origin and theme reads matchMedia at module
// load; SSR tests need minimal browser stubs.
(globalThis as { window?: unknown }).window ??= {
  location: { origin: "http://localhost" },
  matchMedia: () => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }),
};
const { default: LoginPage } = await import("../apps/web/src/pages/auth/login");
const { default: SignupPage } = await import("../apps/web/src/pages/auth/signup");

const CONFIG_KEY = ["public-config"] as const;
const config = {
  turnstileSiteKey: "0xSITE",
  emailVerification: { enabled: false, required: false },
};

function renderPage(page: "login" | "signup", prepare?: (qc: QueryClient) => void): string {
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        // Seeded-error queries must not mount-refetch back to pending: the
        // test asserts the error UI, not the real-client retry policy.
        enabled: false,
      },
    },
  });
  prepare?.(qc);

  const rootRoute = createRootRoute({ component: () => null });
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/login",
    component: LoginPage,
  });
  const signupRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/signup",
    component: SignupPage,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([loginRoute, signupRoute]),
    history: createMemoryHistory({ initialEntries: [`/${page}`] }),
  });
  return renderToStaticMarkup(
    <routerContext.Provider value={router}>
      <QueryClientProvider client={qc}>
        {page === "login" ? <LoginPage /> : <SignupPage />}
      </QueryClientProvider>
    </routerContext.Provider>,
  );
}

function seedConfigError(qc: QueryClient) {
  const query = qc.getQueryCache().build(qc, qc.defaultQueryOptions({ queryKey: CONFIG_KEY }));
  query.setState({ status: "error", fetchStatus: "idle", error: new Error("503") });
}

test("config pending blocks submit and shows a loading notice", () => {
  const html = renderPage("login");
  expect(html).toContain("Checking security options");
  expect(html).toContain("disabled");
  expect(html).not.toContain("Retry");
});

test("config load error blocks submit and offers readable Retry", () => {
  const html = renderPage("login", seedConfigError);
  expect(html).toContain("Could not load security options");
  expect(html).toContain("Retry");
  expect(html).toContain("disabled");
});

test("site key present: submit disabled until token solved", () => {
  const html = renderPage("login", (qc) => qc.setQueryData(CONFIG_KEY, config));
  expect(html).toContain("Sign in");
  expect(html).toContain("disabled");
  expect(html).not.toContain("Retry");
});

test("no site key: plain login form works, no captcha UI", () => {
  const html = renderPage("login", (qc) =>
    qc.setQueryData(CONFIG_KEY, { ...config, turnstileSiteKey: null }),
  );
  expect(html).toContain("Sign in");
  expect(html).not.toContain("Checking security options");
  expect(html).not.toContain("Could not load security options");
  // Nothing on the form is gated: the submit button is enabled.
  expect(html).not.toMatch(/type="submit"[^>]*disabled/);
});

test("signup keeps password checklist and confirm field alongside captcha", () => {
  const html = renderPage("signup", (qc) => qc.setQueryData(CONFIG_KEY, config));
  expect(html).toContain("Password requirements");
  expect(html).toContain("Confirm password");
  expect(html).toContain("disabled");
});

test("signup config error keeps checklist and still blocks submit", () => {
  const html = renderPage("signup", seedConfigError);
  expect(html).toContain("Password requirements");
  expect(html).toContain("Retry");
  expect(html).toContain("disabled");
});
