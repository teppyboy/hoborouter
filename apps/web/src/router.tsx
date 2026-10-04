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
import {
  adminModels,
  adminPayments,
  adminSystem,
  adminUsers,
  adminSettings,
  credits,
  bundles,
  keys,
  logs,
  modelDetail,
  models,
  overview,
  payments,
  settings,
  usage,
  lazyRoute,
} from "./lib/prefetch";
import { queryClient } from "./lib/query-client";

const AdminAudit = lazy(() => import("./pages/admin/audit"));
const AdminBundles = lazy(() => import("./pages/admin/bundles"));

// Chat page exports a named component; remap to default for lazyRoute.
const Chat = lazyRoute(() =>
  import("./pages/chat").then((m) => ({ default: m.ChatPage })),
);

// Public auth pages (not part of nav prefetching).
const Login = lazy(() => import("./pages/auth/login"));
const Signup = lazy(() => import("./pages/auth/signup"));
const VerifyEmail = lazy(() => import("./pages/auth/verify-email"));
// Public legal pages.
const Terms = lazy(() => import("./pages/legal/terms"));
const Privacy = lazy(() => import("./pages/legal/privacy"));

function Page({ children }: { children: React.ReactNode }) {
  return <div className="p-4 sm:p-6">{children}</div>;
}

const rootRoute = createRootRoute({
  component: () => <Outlet />,
  notFoundComponent: () => (
    <Page>
      <p className="text-sm text-muted-foreground">Page not found.</p>
      <Button asChild variant="outline" size="sm" className="mt-3">
        <Link to="/">Go home</Link>
      </Button>
    </Page>
  ),
});

/**
 * Cached session check: one network round-trip per staleTime window instead
 * of one per navigation. Cleared on sign-out via queryClient.clear() in the
 * app shell, and queryClient.clear() on sign-in transitions keeps it honest.
 */
const SESSION_STALE_MS = 5 * 60_000;

// --- Protected layout: owns the AppShell so the shell stays mounted (no
// sidebar/header flash) while lazy page chunks load inside <Outlet>.
const protectedLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: "protected",
  beforeLoad: async () => {
    try {
      await queryClient.ensureQueryData({
        queryKey: ["session"],
        staleTime: SESSION_STALE_MS,
        queryFn: async () => {
          const { data } = await authClient.getSession();
          if (!data) throw new Error("unauthenticated");
          return data;
        },
      });
    } catch {
      throw redirect({ to: "/login" });
    }
  },
  component: () => (
    <AppShell>
      <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
        <Outlet />
      </Suspense>
    </AppShell>
  ),
});

/** Protected page route (chunk loaded from lib/prefetch). */
function protectedRoute(path: string, PageComponent: React.ComponentType) {
  return createRoute({
    getParentRoute: () => protectedLayout,
    path,
    component: () => (
      <Page>
        <PageComponent />
      </Page>
    ),
  });
}

/** Legacy admin path -> new path, preserving query params (books). */
function redirectRoute(path: string, to: string) {
  return createRoute({
    getParentRoute: () => protectedLayout,
    path,
    beforeLoad: ({ search }) => {
      throw redirect({
        to,
        search: search as { [k: string]: string },
      });
    },
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
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/verify-email",
    component: () => (
      <Page>
        <VerifyEmail />
      </Page>
    ),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/terms",
    component: () => <Terms />,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/privacy",
    component: () => <Privacy />,
  }),
];

const protectedRoutes = [
  protectedRoute("/", overview),
  protectedRoute("/chat", Chat),
  protectedRoute("/models", models),
  // Detail path uses a dedicated prefix so the splat cannot also match the
  // empty /models path (which would collide with the models index route).
  protectedRoute("/models/view/$", modelDetail),
  protectedRoute("/keys", keys),
  protectedRoute("/logs", logs),
  protectedRoute("/usage", usage),
  protectedRoute("/billing/credits", credits),
  protectedRoute("/billing/bundles", bundles),
  protectedRoute("/billing/payments", payments),
  protectedRoute("/settings", settings),
  // Admin
  protectedRoute("/admin/users", adminUsers),
  protectedRoute("/admin/settings", adminSettings),
  protectedRoute("/admin/models", adminModels),
  // Obsolete pages: old URLs land on the unified Models page.
  redirectRoute("/admin/providers", "/admin/models"),
  redirectRoute("/admin/pricing", "/admin/models"),
  protectedRoute("/admin/bundles", AdminBundles),
  protectedRoute("/admin/payments", adminPayments),
  protectedRoute("/admin/system", adminSystem),
  protectedRoute("/admin/audit", AdminAudit),
];

export const routeTree = rootRoute.addChildren([
  ...publicRoutes,
  protectedLayout.addChildren(protectedRoutes),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  // Preloaded route data stays fresh briefly so hover-then-click reuses it.
  defaultPreloadStaleTime: 30_000,
  // Fast navigations never flash the Suspense fallback.
  defaultPendingMs: 150,
  defaultPendingMinMs: 300,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
