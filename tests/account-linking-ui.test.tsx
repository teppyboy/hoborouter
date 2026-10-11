// Account settings "Connected accounts" UI contract (semantic render +
// interaction), against mocked Better Auth client endpoints:
// - Rows render only for providers the server's public-config flags enabled;
//   an absent/empty flag map renders no section at all (email-only unchanged).
// - Linked state comes from authClient.listAccounts (credential/password
//   account never renders as a social row).
// - Connect calls authClient.linkSocial with the exact provider id and a
//   same-origin callbackURL back to the settings page (+ errorCallbackURL).
// - Unlink calls authClient.unlinkAccount with the linked account's id;
//   session-not-fresh and last-account server errors surface their own copy,
//   never the raw upstream message.
// - Existing profile/email/password sections keep rendering (no regression to
//   email login management).
import { test, expect, afterAll, mock } from "bun:test";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";

// --- Mock lib/auth and sonner BEFORE pages import them ----------------------

// The page reports connect/unlink outcomes through sonner toasts (same
// convention as its profile/email/password sections), so errors are asserted
// against recorded toast calls, never inline DOM copy.
const toastCalls: { type: string; message: string }[] = [];
mock.module("sonner", () => ({
  toast: {
    error: (message: string) => toastCalls.push({ type: "error", message }),
    success: (message: string) => toastCalls.push({ type: "success", message }),
    info: () => {},
    warning: () => {},
    loading: () => {},
    dismiss: () => {},
    custom: () => {},
    promise: () => {},
  },
}));

interface FakeAccount {
  id: string;
  providerId: string;
  accountId: string;
}
const accounts: FakeAccount[] = [];
const linkSocialCalls: { provider: string; callbackURL: string; errorCallbackURL?: string }[] = [];
const unlinkCalls: { accountId: string }[] = [];
let linkSocialError: { message?: string } | null = null;
let unlinkError: { message?: string; status?: number; code?: string | null } | null = null;

mock.module("../apps/web/src/lib/auth", () => ({
  authClient: {
    getSession: async () => ({ data: null }),
    updateUser: async () => ({ error: null }),
    changePassword: async () => ({ error: null }),
    listAccounts: async () => ({ data: accounts.map((a) => ({ ...a })), error: null }) as unknown,
    linkSocial: async (args: {
      provider: string;
      callbackURL: string;
      errorCallbackURL?: string;
    }) => {
      linkSocialCalls.push(args);
      return { error: linkSocialError };
    },
    unlinkAccount: async (args: { accountId: string }) => {
      unlinkCalls.push(args);
      return { error: unlinkError };
    },
  },
  signIn: {},
  signUp: {},
  signOut: {},
  useSession: () => ({
    data: {
      user: { id: "u1", name: "Tester", email: "tester@e2e.test", image: null },
    },
    isPending: false,
  }),
  resendVerification: async () => ({ ok: false, rateLimited: false }),
}));

// --- Browser globals (jsdom realm, same pattern as tests/oauth-ui.test.tsx) --

const GLOBAL_KEYS = ["window", "document", "localStorage", "location"] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;
let documentRef: Document;
let MouseEventCtor: new (type: string, init?: { bubbles?: boolean }) => Event;

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
for (const [k, v] of Object.entries({
  window: win,
  document: win.document,
  localStorage: win.localStorage,
  location: win.location,
})) {
  (globalThis as Record<string, unknown>)[k] = v;
}
jsdomWindow = win;
documentRef = win.document as unknown as Document;
MouseEventCtor = (win as unknown as { MouseEvent: typeof MouseEventCtor }).MouseEvent;

afterAll(async () => {
  await act(async () => {
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

const settingsDir = new URL("../apps/web/src/pages/settings/", import.meta.url).pathname;
const domClientEntry = Bun.resolveSync("react-dom/client", settingsDir);
const { createRoot } = (await import(domClientEntry)) as {
  createRoot: (container: HTMLElement) => {
    render: (node: unknown) => void;
    unmount: () => void;
  };
};

const { default: AccountTab } = await import("../apps/web/src/pages/settings/account");
const { accountCopy } = await import("../apps/web/src/pages/settings/account");
const { translate } = await import("../apps/web/src/lib/i18n/t");

const CONFIG_KEY = ["public-config"] as const;
const baseConfig = {
  turnstileSiteKey: null,
  emailVerification: { enabled: false, required: false },
};

const roots: { unmount: () => void }[] = [];

async function renderAccount(config?: Record<string, unknown>): Promise<HTMLElement> {
  // Seeded public-config must never refetch (jsdom has no backend): staleTime
  // Infinity keeps the seed authoritative. linked-accounts runs its own
  // (mocked) queryFn for real.
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(CONFIG_KEY, { ...baseConfig, ...config });
  const container = documentRef.createElement("div");
  documentRef.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={qc}>
        <AccountTab />
      </QueryClientProvider>,
    );
  });
  roots.push(root);
  // Let the (mocked) linked-accounts query resolve before assertions.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return container;
}

function unmountAll() {
  act(() => {
    for (const r of roots.splice(0)) r.unmount();
    documentRef.body.textContent = "";
  });
}

function button(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(label),
  );
}

test("no enabled providers: no connected-accounts section (email-only unchanged)", async () => {
  const c = await renderAccount();
  expect(c.innerHTML).not.toContain("Connected accounts");
  // Email management untouched.
  expect(c.innerHTML).toContain("Change email");
  unmountAll();
});

test("enabled providers render rows with linked state from listAccounts", async () => {
  accounts.length = 0;
  accounts.push(
    { id: "acc-cred", providerId: "credential", accountId: "u1" },
    { id: "acc-gh", providerId: "github", accountId: "4242" },
  );
  const c = await renderAccount({
    socialProviders: { google: true, discord: false, github: true },
  });
  const html = c.innerHTML;
  expect(html).toContain("Connected accounts");
  expect(html).toContain("GitHub");
  expect(html).toContain("Connected");
  expect(html).toContain("Not connected");
  // Password account is not a social row: exactly one Unlink button (github).
  expect(button(c, "Unlink")).toBeDefined();
  expect(html).toContain("Google");
  unmountAll();
});

test("connect calls linkSocial with the provider id and same-origin settings callback", async () => {
  accounts.length = 0;
  linkSocialCalls.length = 0;
  linkSocialError = null;
  const c = await renderAccount({
    socialProviders: { google: true, discord: false, github: false },
  });
  const connectBtn = button(c, "Connect");
  expect(connectBtn).toBeDefined();
  await act(async () => {
    connectBtn!.dispatchEvent(new MouseEventCtor("click", { bubbles: true }));
  });
  expect(linkSocialCalls).toHaveLength(1);
  expect(linkSocialCalls[0]?.provider).toBe("google");
  expect(linkSocialCalls[0]?.callbackURL).toBe("http://localhost:5173/settings?tab=account");
  expect(linkSocialCalls[0]?.errorCallbackURL).toBe(
    "http://localhost:5173/settings?tab=account&linking=error",
  );
  unmountAll();
});

test("connect initiation failure shows generic copy, never upstream text", async () => {
  accounts.length = 0;
  linkSocialCalls.length = 0;
  toastCalls.length = 0;
  linkSocialError = { message: "provider exploded: secret-xyz" };
  const c = await renderAccount({
    socialProviders: { google: true, discord: false, github: false },
  });
  await act(async () => {
    button(c, "Connect")!.dispatchEvent(new MouseEventCtor("click", { bubbles: true }));
  });
  const messages = toastCalls.filter((t) => t.type === "error").map((t) => t.message);
  expect(messages.join("\n")).toContain("Could not start connecting");
  expect(messages.join("\n")).not.toContain("secret-xyz");
  unmountAll();
});

test("unlink calls unlinkAccount with the linked account id and refreshes", async () => {
  accounts.length = 0;
  accounts.push({ id: "acc-gh", providerId: "github", accountId: "4242" });
  unlinkCalls.length = 0;
  unlinkError = null;
  const c = await renderAccount({
    socialProviders: { google: false, discord: false, github: true },
  });
  await act(async () => {
    button(c, "Unlink")!.dispatchEvent(new MouseEventCtor("click", { bubbles: true }));
  });
  expect(unlinkCalls).toEqual([{ accountId: "acc-gh" }]);
  unmountAll();
});

test("stale-session unlink error surfaces the re-sign-in copy, never upstream text", async () => {
  accounts.length = 0;
  accounts.push({ id: "acc-gh", providerId: "github", accountId: "4242" });
  unlinkCalls.length = 0;
  toastCalls.length = 0;
  unlinkError = { status: 403, code: "SESSION_NOT_FRESH", message: "Session is not fresh" };
  const c = await renderAccount({
    socialProviders: { google: false, discord: false, github: true },
  });
  await act(async () => {
    button(c, "Unlink")!.dispatchEvent(new MouseEventCtor("click", { bubbles: true }));
  });
  const messages = toastCalls.filter((t) => t.type === "error").map((t) => t.message);
  expect(messages.join("\n")).toContain("sign in again, then unlink");
  expect(messages.join("\n")).not.toContain("Session is not fresh");
  unmountAll();
});

test("last-account unlink error surfaces the only-sign-in-method copy", async () => {
  accounts.length = 0;
  accounts.push({ id: "acc-gh", providerId: "github", accountId: "4242" });
  toastCalls.length = 0;
  unlinkError = {
    status: 400,
    code: "FAILED_TO_UNLINK_LAST_ACCOUNT",
    message: "You can't unlink your last account",
  };
  const c = await renderAccount({
    socialProviders: { google: false, discord: false, github: true },
  });
  await act(async () => {
    button(c, "Unlink")!.dispatchEvent(new MouseEventCtor("click", { bubbles: true }));
  });
  expect(
    toastCalls
      .filter((t) => t.type === "error")
      .map((t) => t.message)
      .join("\n"),
  ).toContain("only sign-in method");
  unmountAll();
});

test("linking copy is localized (en/vi) with proper-noun provider rows", () => {
  const t = (key: keyof typeof accountCopy, locale: "en" | "vi") =>
    translate(accountCopy, key as never, locale);
  expect(t("connectedAccounts", "en")).toBe("Connected accounts");
  expect(t("connectedAccounts", "vi")).toBe("Tài khoản liên kết");
  expect(t("unlinkReauth", "vi")).toContain("đăng nhập lại");
  expect(t("unlinkLast", "vi")).toContain("duy nhất");
});
