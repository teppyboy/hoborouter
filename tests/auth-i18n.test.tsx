// Auth pages i18n contract (semantic SSR render + schema-level validation):
// - The three auth pages (login, signup, verify-email) render copy from the
//   typed auth dictionary; English is the default locale, Vietnamese arrives
//   via the persisted hbr-locale store and is reactive per render.
// - Zod validation messages are produced by per-page schema factories taking
//   the active t function, so they follow the locale.
// - The dynamic email on /verify-email is interpolated into the translated
//   body and the resend label is translated (the shared ResendVerificationButton
//   keeps its own out-of-scope copy).
// IDs, API URLs and auth flows are never translated.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { act } from "react";
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
import { JSDOM } from "jsdom";

const GLOBAL_KEYS = ["window", "document", "localStorage", "location"] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;

let LoginPage: (typeof import("../apps/web/src/pages/auth/login"))["default"];
let makeLoginSchema: (typeof import("../apps/web/src/pages/auth/login"))["makeLoginSchema"];
let SignupPage: (typeof import("../apps/web/src/pages/auth/signup"))["default"];
let makeSignupSchema: (typeof import("../apps/web/src/pages/auth/signup"))["makeSignupSchema"];
let VerifyEmailView: (typeof import("../apps/web/src/pages/auth/verify-email"))["VerifyEmailView"];
let authCopy: (typeof import("../apps/web/src/pages/auth/copy"))["authCopy"];
let translate: (typeof import("../apps/web/src/lib/i18n/t"))["translate"];
let useLocaleStore: (typeof import("../apps/web/src/lib/i18n/locale"))["useLocaleStore"];

beforeAll(async () => {
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
  // Import AFTER the jsdom globals exist: lib/auth reads window.location
  // origin and zustand persist binds localStorage at first module load.
  ({ default: LoginPage, makeLoginSchema } = await import("../apps/web/src/pages/auth/login"));
  ({ default: SignupPage, makeSignupSchema } = await import("../apps/web/src/pages/auth/signup"));
  ({ VerifyEmailView } = await import("../apps/web/src/pages/auth/verify-email"));
  ({ authCopy } = await import("../apps/web/src/pages/auth/copy"));
  ({ translate } = await import("../apps/web/src/lib/i18n/t"));
  ({ useLocaleStore } = await import("../apps/web/src/lib/i18n/locale"));
});

afterAll(() => {
  // The locale store is process-global zustand state; reset it so files that
  // run after this one see the English default (see tests/i18n.test.tsx).
  useLocaleStore.getState().setLocale("en");
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  jsdomWindow?.close();
  jsdomWindow = null;
});

const CONFIG_KEY = ["public-config"] as const;
const plainConfig = {
  turnstileSiteKey: null,
  emailVerification: { enabled: false, required: false },
};

// Client mount (not renderToStaticMarkup): zustand v5's useSyncExternalStore
// serves the store's INITIAL state as the server snapshot, so SSR renders
// could never show a locale set at test time. A real jsdom mount reads the
// live store state, which is what the locale reactivity contract needs.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// react-dom/client cannot be resolved from the tests workspace (bun's isolated
// .bun store exposes no top-level react-dom link there; only react and
// react-dom/server fall back). Resolve it through the lane's own apps/web
// node_modules instead — read-only shared deps, no installs or config changes.
// Durable fix would be a tests tsconfig paths mapping (reported to supervisor).
const authPageDir = new URL("../apps/web/src/pages/auth/", import.meta.url).pathname;
const domClientEntry = Bun.resolveSync("react-dom/client", authPageDir);
const { createRoot } = (await import(domClientEntry)) as {
  createRoot: (container: HTMLElement) => {
    render: (node: unknown) => void;
    unmount: () => void;
  };
};

function renderNode(node: React.ReactNode): string {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  const html = container.innerHTML;
  act(() => root.unmount());
  container.remove();
  return html;
}

const tEn = (k: keyof typeof authCopy) => translate(authCopy, k, "en");
const tVi = (k: keyof typeof authCopy) => translate(authCopy, k, "vi");
// Schema factories take the same shape useAuthT() returns (typed t function).
const tFor = (locale: "en" | "vi") => (k: keyof typeof authCopy) => translate(authCopy, k, locale);
const tEnF = tFor("en");
const tViF = tFor("vi");

function renderWithRouter(page: "login" | "signup"): string {
  const qc = new QueryClient({
    defaultOptions: { queries: { enabled: false } },
  });
  qc.setQueryData(CONFIG_KEY, plainConfig);
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
  return renderNode(
    <routerContext.Provider value={router}>
      <QueryClientProvider client={qc}>
        {page === "login" ? <LoginPage /> : <SignupPage />}
      </QueryClientProvider>
    </routerContext.Provider>,
  );
}

function renderVerify(
  user: {
    email?: string;
    emailVerified?: boolean;
  } | null,
): string {
  const qc = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  const router = createRouter({
    routeTree: createRootRoute({ component: () => null }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return renderNode(
    <routerContext.Provider value={router}>
      <QueryClientProvider client={qc}>
        <VerifyEmailView
          user={user === null ? null : { email: user.email, emailVerified: user.emailVerified }}
          loading={false}
        />
      </QueryClientProvider>
    </routerContext.Provider>,
  );
}

// --- English default --------------------------------------------------------

test("English is the default locale", () => {
  expect(useLocaleStore.getInitialState().locale).toBe("en");
});

test("login renders English copy by default", () => {
  useLocaleStore.getState().setLocale("en");
  const html = renderWithRouter("login");
  expect(html).toContain("Sign in");
  expect(html).toContain("Welcome back. No account?");
  expect(html).toContain("Sign up");
  expect(html).toContain("Terms");
  expect(html).toContain("Privacy");
  expect(html).not.toContain("Đăng nhập");
});

test("signup renders English copy by default", () => {
  const html = renderWithRouter("signup");
  expect(html).toContain("Create account");
  expect(html).toContain("Confirm password");
  expect(html).toContain("Password requirements");
  expect(html).toContain("Terms of Service");
  expect(html).toContain("Privacy Policy");
});

test("verify-email renders English copy by default (all three states)", () => {
  useLocaleStore.getState().setLocale("en");
  const verified = renderVerify({ email: "a@b.c", emailVerified: true });
  expect(verified).toContain("Email verified");
  expect(verified).toContain("Go to Hoborouter");

  const unverified = renderVerify({ email: "a@b.c", emailVerified: false });
  expect(unverified).toContain("Email not verified yet");
  expect(unverified).toContain("a new link can be sent to a@b.c");
  expect(unverified).toContain("Resend verification email");
  expect(unverified).toContain("Back to Hoborouter");

  const noSession = renderVerify(null);
  expect(noSession).toContain("Verification link processed");
  expect(noSession).toContain("Sign in");
});

// --- Vietnamese renders ------------------------------------------------------

test("login renders Vietnamese copy when the locale is vi", () => {
  useLocaleStore.getState().setLocale("vi");
  const html = renderWithRouter("login");
  expect(html).toContain("Đăng nhập");
  expect(html).toContain("Chào mừng trở lại. Chưa có tài khoản?");
  expect(html).toContain("Đăng ký");
  expect(html).toContain("Mật khẩu");
  expect(html).toContain("Điều khoản");
  expect(html).toContain("Quyền riêng tư");
  expect(html).not.toContain(">Sign in<");
});

test("signup renders Vietnamese copy when the locale is vi", () => {
  useLocaleStore.getState().setLocale("vi");
  const html = renderWithRouter("signup");
  expect(html).toContain("Tạo tài khoản");
  expect(html).toContain("Tên");
  expect(html).toContain("Xác nhận mật khẩu");
  expect(html).toContain("Khi tạo tài khoản");
  expect(html).toContain("Điều khoản dịch vụ");
  expect(html).toContain("Chính sách quyền riêng tư");
  expect(html).not.toContain(">Create account<");
});

test("verify-email renders Vietnamese copy including the dynamic email and resend label", () => {
  useLocaleStore.getState().setLocale("vi");
  const unverified = renderVerify({ email: "grace@example.com", emailVerified: false });
  expect(unverified).toContain("Email chưa được xác thực");
  // Dynamic email is interpolated verbatim (never translated or altered).
  expect(unverified).toContain("grace@example.com");
  expect(unverified).toContain("Gửi lại email xác thực");
  expect(unverified).toContain("Về Hoborouter");

  const noSession = renderVerify(null);
  expect(noSession).toContain("Đã xử lý liên kết xác thực");
  expect(noSession).toContain("Đăng nhập");

  const verified = renderVerify({ email: "a@b.c", emailVerified: true });
  expect(verified).toContain("Đã xác thực email");
  expect(verified).toContain("Đến Hoborouter");
});

test("verify-email without a known email uses the no-email Vietnamese body", () => {
  useLocaleStore.getState().setLocale("vi");
  const html = renderVerify({ emailVerified: false });
  expect(html).toContain("Email chưa được xác thực");
  expect(html).not.toContain("Gửi lại email xác thực");
});

// --- Validation messages follow the locale -----------------------------------

test("login schema messages follow the locale (vi and en)", () => {
  const vi = makeLoginSchema(tViF);
  const bad = vi.safeParse({ email: "nope", password: "short" });
  expect(bad.success).toBe(false);
  if (!bad.success) {
    const msgs = bad.error.issues.map((i) => i.message);
    expect(msgs).toContain(tVi("emailInvalid"));
    expect(msgs).toContain(tVi("passwordMin"));
  }

  const en = makeLoginSchema(tEnF);
  const badEn = en.safeParse({ email: "nope", password: "short" });
  expect(badEn.success).toBe(false);
  if (!badEn.success) {
    const msgs = badEn.error.issues.map((i) => i.message);
    expect(msgs).toContain(tEn("emailInvalid"));
    expect(msgs).toContain(tEn("passwordMin"));
  }
});

test("signup schema messages follow the locale (vi and en)", () => {
  const vi = makeSignupSchema(tViF);
  const empty = vi.safeParse({
    name: "",
    email: "nope",
    password: "weak",
    confirmPassword: "",
  });
  expect(empty.success).toBe(false);
  if (!empty.success) {
    const msgs = empty.error.issues.map((i) => i.message);
    expect(msgs).toContain(tVi("nameRequired"));
    expect(msgs).toContain(tVi("emailInvalid"));
    expect(msgs).toContain(tVi("passwordRuleFailed"));
    expect(msgs).toContain(tVi("confirmRequired"));
  }
  const mismatch = vi.safeParse({
    name: "Lan",
    email: "lan@example.com",
    password: "Str0ng!pass",
    confirmPassword: "Str0ng!pas2",
  });
  expect(mismatch.success).toBe(false);
  if (!mismatch.success) {
    const issue = mismatch.error.issues.find((i) => i.path[0] === "confirmPassword");
    expect(issue?.message).toBe(tVi("passwordMismatch"));
  }

  const en = makeSignupSchema(tEnF);
  const badEn = en.safeParse({
    name: "",
    email: "nope",
    password: "weak",
    confirmPassword: "other",
  });
  expect(badEn.success).toBe(false);
  if (!badEn.success) {
    const msgs = badEn.error.issues.map((i) => i.message);
    expect(msgs).toContain(tEn("nameRequired"));
    expect(msgs).toContain(tEn("emailInvalid"));
    expect(msgs).toContain(tEn("passwordRuleFailed"));
    expect(msgs).toContain(tEn("passwordMismatch"));
  }
});

// --- Toasts and status strings ------------------------------------------------

test("toast/status strings are provided for both locales", () => {
  expect(translate(authCopy, "signedInToast", "en")).toBe("Signed in");
  expect(translate(authCopy, "signedInToast", "vi")).toBe("Đã đăng nhập");
  expect(translate(authCopy, "verificationEmailToast", "vi")).toBe(
    "Đã gửi email xác thực — hãy kiểm tra hộp thư",
  );
  expect(translate(authCopy, "checkingSecurity", "vi")).toBe("Đang kiểm tra tuỳ chọn bảo mật…");
});
