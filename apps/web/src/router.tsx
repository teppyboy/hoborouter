import { lazy, Suspense } from "react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  redirect,
  useRouterState,
} from "@tanstack/react-router";
import { AppShell } from "./components/app-shell";
import { Button } from "./components/ui/button";
import {
  adminModels,
  adminPayments,
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
  analytics,
  lazyRoute,
} from "./lib/prefetch";
import { queryClient } from "./lib/query-client";
import { fetchSession, SESSION_QUERY_KEY, SESSION_STALE_MS, useShellSession } from "./lib/session";

const AdminAudit = lazy(() => import("./pages/admin/audit"));
const AdminCpa = lazy(() => import("./pages/admin/cpa"));
const AdminRequestLog = lazy(() => import("./pages/admin/request-log"));
const AdminBundles = lazy(() => import("./pages/admin/bundles"));
const AdminPromotions = lazy(() => import("./pages/admin/promotions"));

// Chat page exports a named component; remap to default for lazyRoute.
const Chat = lazyRoute(() => import("./pages/chat").then((m) => ({ default: m.ChatPage })));

// Public auth pages (not part of nav prefetching).
const Login = lazy(() => import("./pages/auth/login"));
const Signup = lazy(() => import("./pages/auth/signup"));
const VerifyEmail = lazy(() => import("./pages/auth/verify-email"));
// Public legal pages.
const Terms = lazy(() => import("./pages/legal/terms"));
const Privacy = lazy(() => import("./pages/legal/privacy"));
// Public marketing/support pages (each renders its own PublicLayout).
const Pricing = lazy(() => import("./pages/public/pricing"));
const Quickstart = lazy(() => import("./pages/public/quickstart"));
const About = lazy(() => import("./pages/public/about"));
const Faq = lazy(() => import("./pages/public/faq"));

function Page({ children }: { children: React.ReactNode }) {
  // Bounded flex column: pages opting into `fill` ScrollPanels stretch to the
  // remaining shell height; tall form content still overflows into main's
  // scroll (min-h-0, visible overflow propagates to main).
  return <div className="flex min-h-0 flex-1 flex-col p-4 sm:p-6">{children}</div>;
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
 * Fetcher/key live in lib/session.ts so help pages read the same cache.
 */

// --- Protected layout: owns the AppShell so the shell stays mounted (no
// sidebar/header flash) while lazy page chunks load inside <Outlet>.
// Context-adaptive for the shared help pages: anonymous visitors keep public
// access to /about and /docs/quickstart (no redirect, no shell, no protected
// resource calls); signed-in users get the shell and it persists across
// navigation into these pages because they are children of this layout.
const HELP_PUBLIC_PATHS = new Set(["/about", "/faq", "/docs/quickstart"]);

const protectedLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: "protected",
  beforeLoad: async ({ location }) => {
    // fetchSession resolves null when unauthenticated (never throws), so a
    // failed refetch updates the gate instead of TanStack Query replaying the
    // previous session snapshot on error.
    const session = await queryClient.ensureQueryData({
      queryKey: SESSION_QUERY_KEY,
      staleTime: SESSION_STALE_MS,
      queryFn: fetchSession,
    });
    // Only the shared help pages are public; everything else requires a
    // session (same gate as before — no protected route is widened).
    if (!session && !HELP_PUBLIC_PATHS.has(location.pathname)) {
      throw redirect({ to: "/login" });
    }
  },
  component: ProtectedOutlet,
});

/** AppShell when signed in; bare outlet for the anonymous public help pages. */
function ProtectedOutlet() {
  const { data: session } = useShellSession();
  const content = (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      <Outlet />
    </Suspense>
  );
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // session is synchronously cached by beforeLoad for signed-in visitors;
  // anonymous visitors only ever reach the help pages here.
  if (!session) return content;
  return <AppShell variant={pathname === "/chat" ? "chat" : "default"}>{content}</AppShell>;
}

/** Protected page route (chunk loaded from lib/prefetch). */
// `<const P>` keeps the call-site path literal so typed `Link to=` targets
// (e.g. the account-menu Settings item) include protected routes.
function protectedRoute<const P extends string>(path: P, PageComponent: React.ComponentType) {
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

/** Shared help page route: Page padding only inside the shell (embedded);
 * anonymous visitors get the page component with its own PublicLayout. */
function helpRoute<const P extends string>(path: P, PageComponent: React.ComponentType) {
  return createRoute({
    getParentRoute: () => protectedLayout,
    path,
    component: function HelpPage() {
      const { data: session } = useShellSession();
      const page = <PageComponent />;
      return session ? <Page>{page}</Page> : page;
    },
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
  // Pages render their own PublicLayout (same contract as Terms/Privacy).
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/pricing",
    component: () => <Pricing />,
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
  protectedRoute("/analytics", analytics),
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
  protectedRoute("/admin/promotions", AdminPromotions),
  protectedRoute("/admin/payments", adminPayments),
  // System folded into Settings; old URL redirects there.
  redirectRoute("/admin/system", "/admin/settings"),
  protectedRoute("/admin/request-log", AdminRequestLog),
  protectedRoute("/admin/cpa", AdminCpa),
  protectedRoute("/admin/audit", AdminAudit),
  // Shared help pages: ONE public URL each, context-adaptive layout (see
  // protectedLayout). Signed-in: inside the persistent AppShell. Anonymous:
  // the same page components render their own PublicLayout.
  helpRoute("/docs/quickstart", Quickstart),
  helpRoute("/about", About),
  helpRoute("/faq", Faq),
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
