import { lazy, Suspense } from "react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { authClient } from "./lib/auth";
import { AppShell } from "./components/app-shell";
import { Button } from "./components/ui/button";

// --- Public auth pages ---
const Login = lazy(() => import("./pages/auth/login"));
const Signup = lazy(() => import("./pages/auth/signup"));

// --- Placeholder pages; page writers fill these in ---
const overview = lazy(() => import("./pages/overview"));
const models = lazy(() => import("./pages/models"));
const modelDetail = lazy(() => import("./pages/models/detail"));
const keys = lazy(() => import("./pages/keys"));
const logs = lazy(() => import("./pages/logs"));
const usage = lazy(() => import("./pages/usage"));
const credits = lazy(() => import("./pages/billing/credits"));
const payments = lazy(() => import("./pages/billing/payments"));
const settings = lazy(() => import("./pages/settings"));
const adminUsers = lazy(() => import("./pages/admin/users"));
const adminModels = lazy(() => import("./pages/admin/models"));
const adminProviders = lazy(() => import("./pages/admin/providers"));
const adminPricing = lazy(() => import("./pages/admin/pricing"));
const adminPayments = lazy(() => import("./pages/admin/payments"));
const adminSystem = lazy(() => import("./pages/admin/system"));

function Page({ children }: { children: React.ReactNode }) {
  return <div className="p-6">{children}</div>;
}

const rootRoute = createRootRoute({
  component: () => (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      <Outlet />
    </Suspense>
  ),
  notFoundComponent: () => (
    <Page>
      <p className="text-sm text-muted-foreground">Page not found.</p>
      <Button asChild variant="outline" size="sm" className="mt-3">
        <Link to="/">Go home</Link>
      </Button>
    </Page>
  ),
});

// --- Protected layout: redirect to /login without a session ---
const protectedLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: "protected",
  beforeLoad: async () => {
    const { data } = await authClient.getSession();
    if (!data) {
      throw redirect({ to: "/login" });
    }
  },
  component: () => <Outlet />,
});

/** Protected page route wrapped in the app shell. */
function protectedRoute(path: string, PageComponent: React.ComponentType) {
  return createRoute({
    getParentRoute: () => protectedLayout,
    path,
    component: () => (
      <AppShell>
        <Page>
          <PageComponent />
        </Page>
      </AppShell>
    ),
  });
}

const publicRoutes = [
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/login",
    component: () => (
      <Page>
        <Login />
      </Page>
    ),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/signup",
    component: () => (
      <Page>
        <Signup />
      </Page>
    ),
  }),
];

const protectedRoutes = [
  protectedRoute("/", overview),
  protectedRoute("/models", models),
  // Detail path uses a dedicated prefix so the splat cannot also match the
  // empty /models path (which would collide with the models index route).
  protectedRoute("/models/view/$", modelDetail),
  protectedRoute("/keys", keys),
  protectedRoute("/logs", logs),
  protectedRoute("/usage", usage),
  protectedRoute("/billing/credits", credits),
  protectedRoute("/billing/payments", payments),
  protectedRoute("/settings", settings),
  // Admin
  protectedRoute("/admin/users", adminUsers),
  protectedRoute("/admin/models", adminModels),
  protectedRoute("/admin/providers", adminProviders),
  protectedRoute("/admin/pricing", adminPricing),
  protectedRoute("/admin/payments", adminPayments),
  protectedRoute("/admin/system", adminSystem),
];

export const routeTree = rootRoute.addChildren([
  ...publicRoutes,
  protectedLayout.addChildren(protectedRoutes),
]);

export const router = createRouter({
  routeTree,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
