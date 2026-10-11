// Admin user detail UI contract (jsdom, real React, mocked fetch):
// - The email column is clickable and opens a read-only "User details"
//   dialog showing safe account info (id/email/name/joined/verified/role),
//   workspace memberships with roles, topup wallet balances, and the
//   per-workspace API key overview (prefix/status/created/last used/models).
//   Plaintext secrets are never rendered.
// - A failed per-workspace key list degrades to an honest unavailable note
//   instead of failing the whole dialog.
// - The dialog footer hands off to the existing Edit / Reset password /
//   Remove flows (Remove stays self-hidden).
// - Sole-owner removal: the 409 SOLE_OWNER payload names the workspaces and
//   the guidance points at the workspace-level transfer path
//   (Settings → Members); the server 409 stays authoritative.
import { test, expect, afterAll, afterEach } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const GLOBAL_KEYS = [
  "window",
  "document",
  "Node",
  "Element",
  "NodeFilter",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLSelectElement",
  "getComputedStyle",
  "MutationObserver",
  "CustomEvent",
  "localStorage",
] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;
type EventCtor<T, I> = new (type: string, init?: I) => T;
interface JsdomRealm {
  Event: EventCtor<Event, EventInit>;
  MouseEvent: EventCtor<MouseEvent, MouseEventInit>;
  document: Document;
  Node: typeof Node;
  Element: typeof Element;
  NodeFilter: typeof NodeFilter;
  HTMLElement: typeof HTMLElement;
  HTMLInputElement: typeof HTMLInputElement;
  HTMLSelectElement: typeof HTMLSelectElement;
  getComputedStyle: typeof getComputedStyle;
  MutationObserver: typeof MutationObserver;
  CustomEvent: EventCtor<CustomEvent, EventInit>;
  localStorage: Storage;
  close: () => void;
}
const W = new JSDOM("", { url: "http://localhost:5173" }).window as unknown as JsdomRealm;

for (const k of GLOBAL_KEYS) originals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
for (const [k, v] of Object.entries({
  window: W,
  document: W.document,
  Node: W.Node,
  Element: W.Element,
  NodeFilter: W.NodeFilter,
  HTMLElement: W.HTMLElement,
  HTMLInputElement: W.HTMLInputElement,
  HTMLSelectElement: W.HTMLSelectElement,
  getComputedStyle: W.getComputedStyle,
  MutationObserver: W.MutationObserver,
  CustomEvent: W.CustomEvent,
  localStorage: W.localStorage,
})) {
  (globalThis as Record<string, unknown>)[k] = v;
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
jsdomWindow = W;

// @ts-expect-error relative specifier has no declaration file under tests tsconfig
const { createRoot } = await import("../apps/web/node_modules/react-dom/client");
const { UsersTable } = await import("../apps/web/src/pages/admin/users");
type AdminUser = import("../apps/web/src/pages/admin/users").AdminUser;

// --- fixtures -------------------------------------------------------------

const SEED_CONTEXT = {
  memberships: [
    { workspaceId: "ws_1", workspaceName: "Acme", role: "owner" },
    { workspaceId: "ws_2", workspaceName: "Globex", role: "member" },
  ],
  wallets: [
    { workspaceId: "ws_1", kind: "topup", balance: 90000, reserved: 5000 },
  ],
};

const SEED_MODELS = [
  { id: "m_1", public_id: "acme/large", display_name: "Acme Large" },
  { id: "m_2", public_id: "globex/mini", display_name: "Globex Mini" },
];

const SEED_WS1_KEYS = [
  {
    id: "k_1",
    name: "CI key",
    key_prefix: "sk-hbr-abcd",
    status: "enabled",
    created_at: 1700000000000,
    last_used_at: 1700100000000,
    modelIds: ["m_1"],
  },
];

const SEED_WS2_KEYS: unknown[] = [];

interface FetchCall {
  url: string;
  method?: string;
}
type FetchHandler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function adminUser(partial: Partial<AdminUser> = {}): AdminUser {
  return {
    id: "u_1",
    email: "grace@example.com",
    name: "Grace",
    created_at: 1700000000000,
    is_instance_admin: false,
    workspace_count: 2,
    email_verified: true,
    ...partial,
  };
}

// --- harness -------------------------------------------------------------

let active: ReturnType<typeof mount> | null = null;
afterEach(() => {
  active?.cleanup();
  active = null;
});

const DEFAULT_FETCH: FetchHandler = (url) => {
  if (url.includes("/admin/users/u_1/context")) return jsonResponse(200, SEED_CONTEXT);
  if (url.includes("/admin/catalog/models")) return jsonResponse(200, SEED_MODELS);
  if (url.includes("/admin/workspaces/ws_1/keys")) return jsonResponse(200, SEED_WS1_KEYS);
  if (url.includes("/admin/workspaces/ws_2/keys")) return jsonResponse(200, SEED_WS2_KEYS);
  return jsonResponse(200, {});
};

function mount(user: AdminUser = adminUser(), currentUserId = "u_admin") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);

  const fetchCalls: FetchCall[] = [];
  let handler: FetchHandler = DEFAULT_FETCH;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), method: init?.method });
    return handler(String(url), init);
  }) as typeof fetch;

  act(() => {
    root.render(
      <QueryClientProvider client={qc}>
        <UsersTable users={[user]} currentUserId={currentUserId} />
      </QueryClientProvider>,
    );
  });

  const settle = async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  };

  const h = {
    container,
    fetchCalls,
    setFetch: (fn: FetchHandler) => {
      handler = fn;
    },
    async waitFor(text: string) {
      for (let i = 0; i < 40; i++) {
        if (document.body.textContent?.includes(text)) return;
        await settle();
      }
      throw new Error(`never rendered: ${text}`);
    },
    async clickButton(label: string, occurrence: "first" | "last" = "first") {
      const buttons = [...document.querySelectorAll("button")].filter(
        (b) => b.textContent?.trim() === label,
      );
      const btn =
        occurrence === "last" ? buttons.at(-1) : buttons[0] === undefined ? undefined : buttons[0];
      if (!btn) throw new Error(`button not found: ${label}`);
      await act(async () => {
        btn.dispatchEvent(new W.MouseEvent("click", { bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 0));
      });
    },
    async clickAria(label: string) {
      const btn = [...document.querySelectorAll("button")].find(
        (b) => b.getAttribute("aria-label") === label,
      );
      if (!btn) throw new Error(`aria-labelled button not found: ${label}`);
      await act(async () => {
        btn.dispatchEvent(new W.MouseEvent("click", { bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 0));
      });
    },
    cleanup() {
      act(() => root.unmount());
      container.remove();
      globalThis.fetch = realFetch;
    },
  };
  active = h;
  return h;
}

async function flushPendingRealmEvents() {
  for (let i = 0; i < 2; i++) await new Promise((r) => setTimeout(r, 0));
  document.body.innerHTML = "";
}

afterAll(async () => {
  await flushPendingRealmEvents();
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  jsdomWindow?.close();
  jsdomWindow = null;
});

async function openDetail(h: ReturnType<typeof mount>) {
  await h.clickAria("Details for grace@example.com");
  await h.waitFor("Workspaces & roles");
}

// --- tests ----------------------------------------------------------------

test("email column opens a read-only detail dialog with the safe account info", async () => {
  const h = mount();
  await openDetail(h);
  const text = document.body.textContent ?? "";
  expect(text).toContain("User details");
  expect(text).toContain("u_1"); // full user id with copy affordance
  expect(text).toContain("grace@example.com");
  expect(text).toContain("Grace");
  expect(text).toContain("Verified");
  expect(text).toContain("user"); // role badge (fixture is not an instance admin)
  // No sensitive values are ever part of the payload surface: no password
  // field/input exists (the footer "Reset password" action is a button, not
  // a value).
  expect(document.querySelector('input[type="password"]')).toBeNull();
  expect(text).not.toContain("••••");
});

test("detail lists memberships, wallet balances and per-workspace key overview; no plaintext", async () => {
  const h = mount();
  await openDetail(h);
  await h.waitFor("CI key");
  const text = document.body.textContent ?? "";
  expect(text).toContain("Acme");
  expect(text).toContain("owner");
  expect(text).toContain("Globex");
  expect(text).toContain("member");
  expect(text).toContain("90.000 ₫"); // balance formatted VND
  expect(text).toContain("5.000 ₫"); // reserved formatted VND
  expect(text).toContain("This workspace has no TOPUP wallet."); // Globex
  expect(text).toContain("sk-hbr-abcd"); // prefix only
  expect(text).toContain("enabled");
  expect(text).toContain("Acme Large"); // model label resolved
  expect(text).not.toContain("sk-hbr-test-plaintext");
});

test("a failed per-workspace key list degrades to an honest unavailable note", async () => {
  const h = mount();
  h.setFetch((url) => {
    if (url.includes("/admin/workspaces/ws_1/keys"))
      return jsonResponse(404, { error: { code: "NOT_FOUND", message: "workspace not found" } });
    return DEFAULT_FETCH(url, undefined);
  });
  await openDetail(h);
  await h.waitFor("Keys for this workspace are unavailable");
  const text = document.body.textContent ?? "";
  expect(text).toContain("User details"); // dialog itself still renders
  expect(text).toContain("Globex"); // other workspace unaffected
});

test("detail footer hands off to Edit/Reset/Remove; Remove hidden on the self row", async () => {
  const h = mount(adminUser(), "u_admin");
  await openDetail(h);
  await h.clickButton("Edit", "last"); // the footer button, not the row action
  await h.waitFor("Change the name or email of");
  expect(document.body.textContent).toContain("Edit user");
});

test("detail footer never offers Remove on the admin's own account", async () => {
  mount(adminUser(), "u_1"); // viewing own account
  await openDetail(active!);
  const footer = [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === "Remove",
  );
  expect(footer.length).toBe(0); // self row: no Remove anywhere
});

test("sole-owner removal 409 names the workspaces and points to Settings → Members", async () => {
  const h = mount();
  h.setFetch((url, init) => {
    if (url.includes("/admin/users/u_1") && init?.method === "DELETE") {
      return jsonResponse(409, {
        error: {
          code: "SOLE_OWNER",
          message: "User is the sole owner of workspaces",
          workspaces: [{ id: "ws_1", name: "Acme" }],
        },
      });
    }
    return DEFAULT_FETCH(url, init);
  });
  await h.clickButton("Remove"); // row action opens the confirm dialog
  await h.waitFor("Remove user?");
  await h.clickButton("Remove", "last"); // dialog confirm
  await h.waitFor("Transfer ownership first");
  const text = document.body.textContent ?? "";
  expect(text).toContain("Acme"); // named workspaces
  expect(text).toContain("Settings → Members"); // transfer path guidance
});
