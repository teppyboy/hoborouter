// Email-verification UI contract (semantic SSR render):
// - /verify-email reports status only from the real session flag; a
//   logged-in-unverified or no-session visitor can never see "Email verified"
//   (no token/ forged-query parsing exists in the page).
// - The unverified-session banner appears only when public-config says mail is
//   actually enabled; no SMTP → no banner. Verified users never see it.
// - Admin users table badges the email_verified flag honestly: true/false,
//   and "Unavailable" when the payload omits it.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRouter,
  createRootRoute,
  createMemoryHistory,
} from "@tanstack/react-router";
// routerContext is not part of the package's public surface; providing it
// directly lets SSR tests render pages that use Link without a full
// RouterProvider mount (which renders nothing under renderToStaticMarkup).
import { routerContext } from "@tanstack/react-router/dist/esm/routerContext.js";

// lib/auth reads window.location.origin at module load; signup's Turnstile
// wiring reads matchMedia. Stub a minimal window for the SSR render.
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
const { VerifyEmailView } = await import("../apps/web/src/pages/auth/verify-email");
const { UnverifiedEmailBanner } = await import("../apps/web/src/components/app-shell");
const { UsersTable } = await import("../apps/web/src/pages/admin/users");
const { default: SignupPage } = await import("../apps/web/src/pages/auth/signup");
type SessionUser = import("../apps/web/src/lib/auth").SessionUser;
type AdminUser = import("../apps/web/src/pages/admin/users").AdminUser;

const CONFIG_KEY = ["public-config"] as const;
const mailOn = {
  turnstileSiteKey: null,
  emailVerification: { enabled: true, required: false },
};

function withProviders(html: (qc: QueryClient) => React.ReactNode): string {
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        // Seeded queries must not mount-refetch during the sync SSR render.
        enabled: false,
      },
    },
  });
  const rootRoute = createRootRoute({ component: () => null });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return renderToStaticMarkup(
    <routerContext.Provider value={router}>
      <QueryClientProvider client={qc}>{html(qc)}</QueryClientProvider>
    </routerContext.Provider>,
  );
}

function adminUser(partial: Partial<AdminUser>): AdminUser {
  return {
    id: "u_1",
    email: "grace@example.com",
    name: "Grace",
    created_at: 1700000000000,
    is_instance_admin: false,
    workspace_count: 2,
    ...partial,
  };
}

test("verify page: logged-in user with real verified flag sees confirmation", () => {
  const html = withProviders(() => (
    <VerifyEmailView user={{ email: "a@b.c", emailVerified: true }} loading={false} />
  ));
  expect(html).toContain("Email verified");
  expect(html).toContain("Go to Hoborouter");
  expect(html).not.toContain("Resend verification email");
});

test("verify page: logged-in unverified user gets clear state + resend, never 'verified'", () => {
  const html = withProviders(() => (
    <VerifyEmailView user={{ email: "a@b.c", emailVerified: false }} loading={false} />
  ));
  expect(html).toContain("Email not verified yet");
  expect(html).toContain("Resend verification email");
  expect(html).not.toContain("Email verified</h1>");
});

test("verify page: no session shows processed-message with sign-in link, no verified claim", () => {
  const html = withProviders(() => (
    <VerifyEmailView user={null} loading={false} />
  ));
  expect(html).toContain("Verification link processed; sign in to check your email status");
  expect(html).toContain("Sign in");
  expect(html).not.toContain("Email verified");
});

test("banner: SMTP enabled + unverified session shows Dismiss/Resend", () => {
  const html = withProviders((qc) => {
    qc.setQueryData(CONFIG_KEY, mailOn);
    const user: SessionUser = { email: "a@b.c", emailVerified: false };
    return <UnverifiedEmailBanner user={user} />;
  });
  expect(html).toContain("Please verify your email address");
  expect(html).toContain("Resend");
  expect(html).toContain("Dismiss");
});

test("banner: no SMTP (enabled false) means no banner, even for unverified users", () => {
  const html = withProviders((qc) => {
    qc.setQueryData(CONFIG_KEY, {
      ...mailOn,
      emailVerification: { enabled: false, required: false },
    });
    return <UnverifiedEmailBanner user={{ email: "a@b.c", emailVerified: false }} />;
  });
  expect(html).not.toContain("Please verify your email address");
});

test("banner: verified session never shows the banner", () => {
  const html = withProviders((qc) => {
    qc.setQueryData(CONFIG_KEY, mailOn);
    return <UnverifiedEmailBanner user={{ email: "a@b.c", emailVerified: true }} />;
  });
  expect(html).not.toContain("Please verify your email address");
});

test("admin users: verified flag badges Verified/Unverified/Unavailable", () => {
  const render = (users: AdminUser[]) =>
    withProviders(() => <UsersTable users={users} currentUserId={null} />);
  expect(render([adminUser({ email_verified: true })])).toContain("Verified");
  expect(render([adminUser({ email_verified: false })])).toContain("Unverified");
  expect(render([adminUser({ email_verified: undefined })])).toContain("Unavailable");
});

test("signup with verification enabled keeps auto-signin form, no mail gate", () => {
  const html = withProviders((qc) => {
    qc.setQueryData(CONFIG_KEY, mailOn);
    return <SignupPage />;
  });
  expect(html).toContain("Sign up");
  expect(html).toContain("Password requirements");
  // Optional verification must not add any signup-blocking messaging.
  expect(html).not.toContain("verify your email before");
});
