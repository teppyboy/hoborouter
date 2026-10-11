// Admin support-settings UI contract (jsdom, real React hooks, mocked fetch only):
// the /admin/settings page gains one "Support & contact" card backed by the
// exact GET/PUT /api/v1/admin/support-settings contract (nested GET response,
// flat PUT body of the five whitelisted keys). The server is the validation
// authority: client checks only mirror it for feedback, a 400 is displayed
// inline with no false success and no local-state reset. The email fallback
// (contact@hoborouter.tretrauit.me) is display-only — never written to the DB.
// The six existing /admin/settings fields keep rendering; money fields and
// integer VND values are untouched by this card.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const GLOBAL_KEYS = [
  "window",
  "document",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLFormElement",
  "HTMLButtonElement",
  "DocumentFragment",
  "getComputedStyle",
  "MutationObserver",
  "CustomEvent",
  "Event",
  "MouseEvent",
  "localStorage",
] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;
let W: {
  document: Document;
  Node: typeof Node;
  NodeFilter: typeof NodeFilter;
  Element: typeof Element;
  HTMLElement: typeof HTMLElement;
  HTMLInputElement: typeof HTMLInputElement;
  HTMLFormElement: typeof HTMLFormElement;
  HTMLButtonElement: typeof HTMLButtonElement;
  DocumentFragment: typeof DocumentFragment;
  getComputedStyle: typeof getComputedStyle;
  MutationObserver: typeof MutationObserver;
  CustomEvent: new (type: string, init?: CustomEventInit) => CustomEvent;
  Event: new (type: string, init?: EventInit) => Event;
  MouseEvent: new (type: string, init?: MouseEventInit) => MouseEvent;
  localStorage: Storage;
  close: () => void;
};
let createRoot: (c: HTMLElement) => { render: (n: unknown) => void; unmount: () => void };
let AdminSettingsPage: React.ComponentType;
let SupportSettingsCard: (typeof import("../apps/web/src/pages/admin/settings"))["SupportSettingsCard"];
let adminSettingsCopy: (typeof import("../apps/web/src/pages/admin/settings"))["adminSettingsCopy"];
let useLocaleStore: (typeof import("../apps/web/src/lib/i18n/locale"))["useLocaleStore"];
let realFetch: typeof fetch | undefined;

beforeAll(async () => {
  await new Promise((r) => setTimeout(r, 60));
  W = new JSDOM("", { url: "http://localhost:5173" }).window as unknown as typeof W;
  for (const k of GLOBAL_KEYS) originals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  for (const [k, v] of Object.entries({
    window: W,
    document: W.document,
    Node: W.Node,
    NodeFilter: W.NodeFilter,
    Element: W.Element,
    HTMLElement: W.HTMLElement,
    HTMLInputElement: W.HTMLInputElement,
    HTMLFormElement: W.HTMLFormElement,
    HTMLButtonElement: W.HTMLButtonElement,
    DocumentFragment: W.DocumentFragment,
    getComputedStyle: W.getComputedStyle.bind(W),
    MutationObserver: W.MutationObserver,
    CustomEvent: W.CustomEvent,
    Event: W.Event,
    MouseEvent: W.MouseEvent,
    localStorage: W.localStorage,
  })) {
    (globalThis as Record<string, unknown>)[k] = v;
  }
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  jsdomWindow = W;

  // @ts-expect-error relative specifier has no declaration file under tests tsconfig
  createRoot = (await import("../apps/web/node_modules/react-dom/client")).createRoot;
  const mod = await import("../apps/web/src/pages/admin/settings");
  AdminSettingsPage = mod.default;
  SupportSettingsCard = mod.SupportSettingsCard;
  adminSettingsCopy = mod.adminSettingsCopy;
  ({ useLocaleStore } = await import("../apps/web/src/lib/i18n/locale"));
});

afterAll(async () => {
  useLocaleStore.getState().setLocale("en");
  if (realFetch) globalThis.fetch = realFetch;
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise<void>((r) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        ch.port1.close();
        r();
      };
      ch.port2.postMessage(0);
    });
  }
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  delete (globalThis as Record<string, unknown>).ResizeObserver;
  if (jsdomWindow) jsdomWindow.close();
  jsdomWindow = null;
});

// --- fixtures -------------------------------------------------------------

interface SupportShape {
  display_name: string | null;
  support: {
    email: string | null;
    telegram: string | null;
    facebook: string | null;
    threads: string | null;
    custom: { label: string; url: string }[];
  };
}

const SUPPORTED: SupportShape = {
  display_name: "Hoborouter",
  support: {
    email: "support@example.com",
    telegram: "https://t.me/hoborouter",
    facebook: "https://facebook.com/hoborouter",
    threads: null,
    custom: [],
  },
};

const ADMIN_SETTINGS = {
  prompt_caching_enabled: true,
  first_topup_bonus_enabled: true,
  first_topup_bonus_amount_vnd: null,
  payment_timeout_minutes: 30,
  payment_max_amount_vnd: 100_000_000,
  payment_usd_vnd_rate: 26_000,
};

// /api/v1/admin/system payload (AdminSystem contract) for page-level mounts.
const ADMIN_SYSTEM = {
  gateway_enabled: true,
  usd_vnd_rate: 26300,
  payos_configured: false,
  manual_payments: true,
  db: { wal: "wal" },
  counts: { users: 3, workspaces: 2, models: 5, requests: 42 },
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

interface FetchCall {
  url: string;
  method: string;
  body: string | undefined;
}

let calls: FetchCall[] = [];

function serve(handler: (call: FetchCall) => Response) {
  realFetch = realFetch ?? globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const call: FetchCall = {
      url: String(url),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
}

function mountPage(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  act(() => {
    root.render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
  });
  const settle = async () => {
    await act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
    });
  };
  const bodyText = () => document.body.textContent ?? "";
  const input = (id: string) => document.getElementById(id) as HTMLInputElement | null;
  const setInput = (el: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(el, value);
    act(() => {
      el.dispatchEvent(new W.Event("input", { bubbles: true }));
    });
  };
  const clickButton = (label: string) => {
    const button = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === label,
    );
    if (!button) throw new Error(`button "${label}" not found`);
    act(() => {
      button.dispatchEvent(new W.MouseEvent("click", { bubbles: true }));
    });
  };
  const unmount = async () => {
    await act(async () => {
      await qc.cancelQueries();
    });
    act(() => root.unmount());
    qc.clear();
    container.remove();
    await act(async () => {
      for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
    });
  };
  return { container, settle, bodyText, input, setInput, clickButton, unmount };
}

// --- rendering: GET populates ---------------------------------------------

test("support card renders configured values from GET and EN labels", async () => {
  useLocaleStore.getState().setLocale("en");
  serve((call) =>
    call.url.includes("/admin/support-settings")
      ? jsonResponse(200, SUPPORTED)
      : jsonResponse(200, {}),
  );
  const page = mountPage(<SupportSettingsCard />);
  await page.settle();
  try {
    expect(page.bodyText()).toContain("Support & contact");
    expect(page.bodyText()).toContain("Display name");
    expect(page.bodyText()).toContain("Support email");
    expect(page.bodyText()).toContain("Telegram URL");
    expect(page.bodyText()).toContain("Facebook URL");
    expect(page.bodyText()).toContain("Threads URL");
    // Configured DB values populate the inputs verbatim (server is authority).
    expect(page.input("display_name")!.value).toBe("Hoborouter");
    expect(page.input("support_email")!.value).toBe("support@example.com");
    expect(page.input("support_telegram")!.value).toBe("https://t.me/hoborouter");
    expect(page.input("support_facebook")!.value).toBe("https://facebook.com/hoborouter");
    expect(page.input("support_threads")!.value).toBe("");
    // Unset email shows the display-only fallback hint.
    expect(page.bodyText()).not.toContain("contact@hoborouter.tretrauit.me");
    // Save starts disabled: nothing dirty yet.
    const save = Array.from(page.container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Save",
    )!;
    expect(save.disabled).toBe(true);
  } finally {
    await page.unmount();
  }
});

test("support card shows display-only email fallback hint when email unset", async () => {
  useLocaleStore.getState().setLocale("en");
  serve(() =>
    jsonResponse(200, {
      display_name: null,
      support: { email: null, telegram: null, facebook: null, threads: null, custom: [] },
    }),
  );
  const page = mountPage(<SupportSettingsCard />);
  await page.settle();
  try {
    expect(page.bodyText()).toContain("contact@hoborouter.tretrauit.me");
    expect(page.input("support_email")!.value).toBe("");
  } finally {
    await page.unmount();
  }
});

// --- save: exact PUT body, refetch ----------------------------------------

test("save sends exact flat PUT body with all five keys and refetches", async () => {
  useLocaleStore.getState().setLocale("en");
  let putCount = 0;
  let savedEmail: string | null = "support@example.com";
  serve((call) => {
    if (!call.url.includes("/admin/support-settings")) return jsonResponse(200, {});
    if (call.method === "PUT") {
      putCount++;
      expect(call.body).toBeDefined();
      const body = JSON.parse(call.body!);
      // Exact flat body: edited email plus the untouched current values
      // (including the empty custom-links array).
      expect(body).toEqual({
        display_name: "Hoborouter",
        support_email: "help@example.com",
        support_telegram: "https://t.me/hoborouter",
        support_facebook: "https://facebook.com/hoborouter",
        support_threads: null,
        support_custom: [],
      });
      savedEmail = body.support_email;
      return jsonResponse(200, {
        ...SUPPORTED,
        support: { ...SUPPORTED.support, email: savedEmail },
      });
    }
    return jsonResponse(200, {
      ...SUPPORTED,
      support: { ...SUPPORTED.support, email: savedEmail },
    });
  });
  const page = mountPage(<SupportSettingsCard />);
  await page.settle();
  try {
    const getsBefore = calls.filter((c) => c.method === "GET").length;
    page.setInput(page.input("support_email")!, "help@example.com");
    page.clickButton("Save");
    await page.settle();
    expect(putCount).toBe(1);
    // Success path refetches (invalidation), and the saved value round-trips.
    expect(calls.filter((c) => c.method === "GET").length).toBeGreaterThan(getsBefore);
    expect(page.input("support_email")!.value).toBe("help@example.com");
    expect(page.bodyText()).not.toContain("must be");
  } finally {
    await page.unmount();
  }
});

// --- server is the authority: 400 displayed, no false success --------------

test("server 400 error is displayed inline, local edits preserved, no success", async () => {
  useLocaleStore.getState().setLocale("en");
  serve((call) => {
    if (!call.url.includes("/admin/support-settings")) return jsonResponse(200, {});
    if (call.method === "PUT")
      return jsonResponse(400, {
        error: { code: "INVALID", message: "support_email must be a valid email address" },
      });
    return jsonResponse(200, SUPPORTED);
  });
  const page = mountPage(<SupportSettingsCard />);
  await page.settle();
  try {
    page.setInput(page.input("support_email")!, "help@example.com");
    page.clickButton("Save");
    await page.settle();
    // Server message displayed; no success; local edit state untouched.
    expect(page.bodyText()).toContain("support_email must be a valid email address");
    expect(page.input("support_email")!.value).toBe("help@example.com");
  } finally {
    await page.unmount();
  }
});

// --- client mirrors server validation (feedback only) ----------------------

test("client validation mirrors server: invalid email and non-HTTPS URLs flagged", async () => {
  useLocaleStore.getState().setLocale("en");
  serve((call) =>
    call.url.includes("/admin/support-settings")
      ? jsonResponse(200, SUPPORTED)
      : jsonResponse(200, {}),
  );
  const page = mountPage(<SupportSettingsCard />);
  await page.settle();
  try {
    const email = page.input("support_email")!;
    page.setInput(email, "not-an-email");
    expect(email.getAttribute("aria-invalid")).toBe("true");
    page.setInput(email, "a@b.co");
    expect(email.getAttribute("aria-invalid")).not.toBe("true");

    const telegram = page.input("support_telegram")!;
    page.setInput(telegram, "http://t.me/hoborouter");
    expect(telegram.getAttribute("aria-invalid")).toBe("true");
    page.setInput(telegram, "https://user:pass@t.me/x");
    expect(telegram.getAttribute("aria-invalid")).toBe("true");
    page.setInput(telegram, "https://t.me/hoborouter");
    expect(telegram.getAttribute("aria-invalid")).not.toBe("true");
  } finally {
    await page.unmount();
  }
});

// --- i18n -------------------------------------------------------------------

test("support card copy has natural EN and VI strings", () => {
  const keys = [
    "support",
    "displayName",
    "emailLabel",
    "telegramLabel",
    "facebookLabel",
    "threadsLabel",
    "urlHint",
    "emailFallbackHint",
    "invalidName",
    "invalidEmail",
    "invalidUrl",
    "customSection",
    "customLabel",
    "customUrl",
    "customHint",
    "addCustomLink",
    "removeCustomLink",
    "invalidCustomLabel",
  ] as const;
  for (const key of keys) {
    const entry = adminSettingsCopy[key];
    expect(entry.en.length).toBeGreaterThan(0);
    expect(entry.vi.length).toBeGreaterThan(0);
    expect(entry.vi).not.toBe(entry.en);
  }
});

// --- page integration: existing fields remain + admin gate ------------------

test("admin settings page keeps the six existing fields next to the support card", async () => {
  useLocaleStore.getState().setLocale("en");
  serve((call) => {
    if (call.url.includes("/admin/support-settings")) return jsonResponse(200, SUPPORTED);
    if (call.url.endsWith("/api/v1/admin/settings")) return jsonResponse(200, ADMIN_SETTINGS);
    if (call.url.includes("/admin/system")) return jsonResponse(200, ADMIN_SYSTEM);
    return jsonResponse(200, {});
  });
  const page = mountPage(<AdminSettingsPage />);
  await page.settle();
  try {
    // Existing six fields (2 switches + 4 money/integer fields) stay.
    expect(page.bodyText()).toContain("Prompt caching");
    expect(page.bodyText()).toContain("First top-up bonus");
    expect(page.bodyText()).toContain("Payment timeout (minutes)");
    expect(page.bodyText()).toContain("Max top-up amount (VND)");
    expect(page.bodyText()).toContain("USD → VND rate");
    expect(page.input("payment_timeout_minutes")!.value).toBe("30");
    // New support card renders alongside.
    expect(page.bodyText()).toContain("Support & contact");
    expect(page.input("support_email")!.value).toBe("support@example.com");
  } finally {
    await page.unmount();
  }
});

test("non-admin (403) sees the Admin only gate instead of any fields", async () => {
  useLocaleStore.getState().setLocale("en");
  serve(() => jsonResponse(403, { error: { code: "FORBIDDEN", message: "Forbidden" } }));
  const page = mountPage(<AdminSettingsPage />);
  await page.settle();
  try {
    expect(page.bodyText()).toContain("Admin only");
    expect(page.bodyText()).not.toContain("Support & contact");
    expect(page.bodyText()).not.toContain("Payment timeout (minutes)");
  } finally {
    await page.unmount();
  }
});

test("support GET failure renders the error message instead of the form", async () => {
  useLocaleStore.getState().setLocale("en");
  serve(() => jsonResponse(500, { error: { code: "UNKNOWN", message: "Request failed (500)" } }));
  const page = mountPage(<SupportSettingsCard />);
  await page.settle();
  try {
    expect(page.bodyText()).toContain("Request failed (500)");
    expect(page.bodyText()).not.toContain("Support email");
  } finally {
    await page.unmount();
  }
});
