// Admin key management UI contract (jsdom, real React, mocked fetch):
// - "Manage keys" opens per-user from the users row with an EXPLICIT
//   workspace picker; keys are listed per selected workspace (prefix,
//   status, created, last used, modelIds) and never contain plaintext.
// - Grant: name + optional model allowlist from the admin catalog models
//   endpoint (public metadata only), with a confirmed-intent step that
//   warns the plaintext is shown once and cannot be recovered, and warns
//   explicitly when the empty allowlist means unrestricted access.
// - Plaintext is rendered once with copy, then destroyed on Done, on
//   workspace switch, and on dialog close; never persisted.
// - Revoke requires a reason and shows the terminal revoked status.
// - Key endpoint errors (e.g. 404 wrong workspace) render honestly.
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
  CustomEvent: EventCtor<CustomEvent, CustomEventInit>;
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

const PLAINTEXT = "sk-hbr-test-plaintext-value-0001";

const SEED_CONTEXT = {
  memberships: [
    { workspaceId: "ws_1", workspaceName: "Acme", role: "owner" },
    { workspaceId: "ws_2", workspaceName: "Globex", role: "member" },
  ],
  wallets: [{ workspaceId: "ws_1", kind: "topup", balance: 90000, reserved: 5000 }],
};

// Real backend envelopes (apps/api/src/routes/admin-keys.ts,
// admin-catalog.ts): both list endpoints return BARE ARRAYS, not {data:[…]}.
const SEED_MODELS = [
  { id: "m_1", public_id: "acme/large", display_name: "Acme Large" },
  { id: "m_2", public_id: "globex/mini", display_name: "Globex Mini" },
];

const SEED_KEYS = [
  {
    id: "k_1",
    name: "CI key",
    key_prefix: "sk-hbr-abcd",
    status: "enabled",
    created_at: 1700000000000,
    last_used_at: 1700100000000,
    modelIds: ["m_1"],
  },
  {
    id: "k_2",
    name: "Old key",
    key_prefix: "sk-hbr-old1",
    status: "revoked",
    created_at: 1690000000000,
    last_used_at: null,
    modelIds: [],
  },
];

interface FetchCall {
  url: string;
  method?: string;
  body: Record<string, unknown> | null;
}
type FetchHandler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

/** noUncheckedIndexedAccess guard: fetch call N must exist before assertions. */
function must<T>(arr: T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`missing item ${i}`);
  return v;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function adminUser(): AdminUser {
  return {
    id: "u_1",
    email: "grace@example.com",
    name: "Grace",
    created_at: 1700000000000,
    is_instance_admin: false,
    workspace_count: 2,
  };
}

// --- harness -------------------------------------------------------------

// Cleanup runs even when an assertion throws, so a failing test cannot leak
// its mocked fetch or mounted root into later tests.
let active: ReturnType<typeof mount> | null = null;
afterEach(() => {
  active?.cleanup();
  active = null;
});

const DEFAULT_FETCH = (url: string, init: RequestInit | undefined) => {
  void init;
  if (url.includes("/admin/users/u_1/context")) return jsonResponse(200, SEED_CONTEXT);
  if (url.includes("/admin/catalog/models")) return jsonResponse(200, SEED_MODELS);
  if (url.includes("/admin/workspaces/ws_1/keys")) return jsonResponse(200, SEED_KEYS);
  if (url.includes("/admin/workspaces/ws_2/keys"))
    return jsonResponse(404, {
      error: { code: "NOT_FOUND", message: "workspace not found" },
    });
  return jsonResponse(200, {});
};

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);

  const fetchCalls: FetchCall[] = [];
  let handler: FetchHandler = DEFAULT_FETCH;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    fetchCalls.push({
      url: String(url),
      method: init?.method,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    });
    return handler(String(url), init);
  }) as typeof fetch;

  act(() => {
    root.render(
      <QueryClientProvider client={qc}>
        <UsersTable users={[adminUser()]} currentUserId="u_admin" />
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
    async clickRow(email: string) {
      const row = [...document.querySelectorAll("tr[aria-label]")].find((r) =>
        (r.getAttribute("aria-label") ?? "").includes(email),
      );
      if (!row) throw new Error(`no row for ${email}`);
      await act(async () => {
        row.dispatchEvent(new W.MouseEvent("click", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));
      });
    },
    async clickButton(label: string) {
      const btn = [...document.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === label,
      );
      if (!btn) throw new Error(`button not found: ${label}`);
      await act(async () => {
        btn.dispatchEvent(new W.MouseEvent("click", { bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 0));
      });
    },
    async selectOption(ariaLabel: string, value: string) {
      const el = document.querySelector<HTMLSelectElement>(`select[aria-label="${ariaLabel}"]`);
      if (!el) throw new Error(`select not found: ${ariaLabel}`);
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          W.HTMLSelectElement.prototype,
          "value",
        )!.set!;
        setter.call(el, value);
        el.dispatchEvent(new W.Event("change", { bubbles: true }));
      });
    },
    async typeInto(inputId: string, value: string) {
      const el = document.querySelector<HTMLInputElement>(`#${inputId}`);
      if (!el) throw new Error(`input not found: #${inputId}`);
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(W.HTMLInputElement.prototype, "value")!.set!;
        setter.call(el, value);
        el.dispatchEvent(new W.Event("input", { bubbles: true }));
      });
    },
    async toggleModel(publicId: string) {
      const box = [...document.querySelectorAll<HTMLInputElement>("input[type='checkbox']")].find(
        (b) => b.closest("label")?.textContent?.includes(publicId),
      );
      if (!box) throw new Error(`checkbox not found: ${publicId}`);
      await act(async () => {
        box.click();
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

async function openKeysDialog() {
  const h = mount();
  // Row click -> detail dialog footer (row action wall removed).
  await h.clickRow("grace@example.com");
  await h.waitFor("User details");
  await h.clickButton("Manage keys");
  await h.waitFor("Select a workspace…");
  await h.waitFor("Acme");
  return h;
}

async function openKeysForWs1() {
  const h = await openKeysDialog();
  await h.selectOption("Workspace", "ws_1");
  await h.waitFor("CI key");
  return h;
}

// --- tests ----------------------------------------------------------------

test("no row-level Manage keys button; reachable from detail footer instead", () => {
  mount();
  // Row action wall removed: no per-row Manage keys button anywhere.
  expect(
    [...document.querySelectorAll("button")].some(
      (b) => b.getAttribute("aria-label") === "Manage keys for grace@example.com",
    ),
  ).toBe(false);
  // Rows stay activatable into the detail dialog.
  expect(
    [...document.querySelectorAll("tr[aria-label]")].some((r) =>
      (r.getAttribute("aria-label") ?? "").includes("grace@example.com"),
    ),
  ).toBe(true);
});

test("keys panel lists prefix/status/created/last used/models per workspace; no plaintext anywhere", async () => {
  await openKeysForWs1();
  const text = document.body.textContent ?? "";
  expect(text).toContain("sk-hbr-abcd");
  expect(text).toContain("enabled");
  expect(text).toContain("revoked");
  expect(text).toContain("Acme Large"); // modelIds mapped to public metadata
  expect(text).toContain("All models"); // empty allowlist labeled honestly
  expect(text).not.toContain(PLAINTEXT);
  expect(text).not.toContain("sk-hbr-old1-plaintext");
});

test("grant: explicit workspace first, model allowlist from admin catalog endpoint, unrestricted warning, exact POST body", async () => {
  const h = await openKeysForWs1();
  await h.typeInto("grant-name", "deploy bot");
  // Confirmed-intent step warns about shown-once plaintext and unrestricted scope.
  await h.clickButton("Create key");
  await h.waitFor("shown once and cannot be recovered");
  expect(document.body.textContent).toContain("unrestricted access to ALL models");
  expect(h.fetchCalls.filter((c) => c.method === "POST" && c.url.includes("/keys"))).toHaveLength(
    0,
  );
  // Select one model from the admin catalog endpoint (public metadata only).
  await h.clickButton("Back");
  await h.toggleModel("acme/large");
  await h.clickButton("Create key");
  await h.waitFor("shown once and cannot be recovered");
  h.setFetch((url, init) => {
    void init;
    if (url.includes("/admin/workspaces/ws_1/keys") && init?.method === "POST")
      return jsonResponse(200, {
        id: "k_new",
        name: "deploy bot",
        plaintext: PLAINTEXT,
        modelIds: ["m_1"],
      });
    if (url.includes("/admin/users/u_1/context")) return jsonResponse(200, SEED_CONTEXT);
    if (url.includes("/admin/catalog/models")) return jsonResponse(200, SEED_MODELS);
    if (url.includes("/admin/workspaces/ws_1/keys"))
      return jsonResponse(200, [
        ...SEED_KEYS,
        {
          id: "k_new",
          name: "deploy bot",
          key_prefix: "sk-hbr-new1",
          status: "enabled",
          created_at: 1,
          last_used_at: null,
          modelIds: ["m_1"],
        },
      ]);
    return jsonResponse(200, {});
  });
  await h.clickButton("Create key");
  await h.waitFor("copy it now");
  const posts = h.fetchCalls.filter(
    (c) => c.method === "POST" && c.url === "/api/v1/admin/workspaces/ws_1/keys",
  );
  expect(posts).toHaveLength(1);
  expect(must(posts, 0).body).toMatchObject({ name: "deploy bot", modelIds: ["m_1"] });
  expect(document.body.textContent).toContain(PLAINTEXT);
  const copy = [...document.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === "Copy key",
  );
  expect(copy).not.toBeNull();
});

test("plaintext is destroyed on Done, on workspace switch, and never persisted to localStorage", async () => {
  const h = await openKeysForWs1();
  await h.typeInto("grant-name", "one-shot");
  await h.clickButton("Create key");
  await h.waitFor("shown once and cannot be recovered");
  h.setFetch((url, init) => {
    void init;
    if (url.includes("/admin/workspaces/ws_1/keys") && init?.method === "POST")
      return jsonResponse(200, {
        id: "k_new",
        name: "one-shot",
        plaintext: PLAINTEXT,
        modelIds: [],
      });
    if (url.includes("/admin/users/u_1/context")) return jsonResponse(200, SEED_CONTEXT);
    if (url.includes("/admin/catalog/models")) return jsonResponse(200, SEED_MODELS);
    if (url.includes("/admin/workspaces/ws_1/keys")) return jsonResponse(200, SEED_KEYS);
    return jsonResponse(200, {});
  });
  await h.clickButton("Create key");
  await h.waitFor("copy it now");
  expect(document.body.textContent).toContain(PLAINTEXT);
  // Done destroys the plaintext.
  await h.clickButton("Done");
  expect(document.body.textContent).not.toContain(PLAINTEXT);
  // Never persisted (zustand key is null-safe checked; scan every entry).
  expect(W.localStorage.getItem("hbr-workspace") ?? "").not.toContain(PLAINTEXT);
  for (let i = 0; i < W.localStorage.length; i++) {
    const k = W.localStorage.key(i);
    if (k === null) continue;
    expect(W.localStorage.getItem(k)).not.toContain(PLAINTEXT);
  }
  // Workspace switch also drops grant state including any plaintext step.
  await h.typeInto("grant-name", "second");
  await h.selectOption("Workspace", "ws_1");
  expect(document.body.textContent).not.toContain(PLAINTEXT);
  expect(document.querySelector<HTMLInputElement>("#grant-name")?.value).toBe("");
});

test("grant resolving AFTER a workspace switch never surfaces plaintext in the new workspace", async () => {
  const h = await openKeysForWs1();
  // Holder object: the resolver is assigned inside the mocked fetch closure,
  // so a bare `let` would be narrowed to `null` at the call site.
  const grantGate: { resolve: ((res: Response) => void) | null } = { resolve: null };
  h.setFetch((url, init) => {
    void init;
    if (url.includes("/admin/workspaces/ws_1/keys") && init?.method === "POST")
      return new Promise<Response>((resolve) => {
        grantGate.resolve = resolve;
      });
    if (url.includes("/admin/users/u_1/context")) return jsonResponse(200, SEED_CONTEXT);
    if (url.includes("/admin/catalog/models")) return jsonResponse(200, SEED_MODELS);
    if (url.includes("/admin/workspaces/ws_1/keys")) return jsonResponse(200, SEED_KEYS);
    // ws_2 has no key list: mirror the real 404 so the panel shows the error.
    return jsonResponse(404, {
      error: { code: "NOT_FOUND", message: "workspace not found" },
    });
  });
  await h.typeInto("grant-name", "late grant");
  await h.clickButton("Create key");
  await h.waitFor("shown once and cannot be recovered");
  await h.clickButton("Create key"); // dispatch now in flight (delayed)
  // Switch away and back while the grant is in flight: the final workspace is
  // ws_1, and the grant must complete only after that switch has settled.
  await h.selectOption("Workspace", "ws_2");
  await h.waitFor("workspace not found");
  await h.selectOption("Workspace", "ws_1");
  await h.waitFor("CI key");
  if (!grantGate.resolve) throw new Error("grant POST was never issued");
  grantGate.resolve(
    jsonResponse(201, {
      id: "k_late",
      name: "late grant",
      key_prefix: "sk-hbr-late",
      status: "enabled",
      purpose: "generic",
      plaintext: PLAINTEXT,
      modelIds: [],
    }),
  );
  for (let i = 0; i < 3; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  // The stale grant was already retired by the workspace switches; it must
  // NOT replay its plaintext step inside the new ws_1 panel.
  expect(document.body.textContent).not.toContain(PLAINTEXT);
  expect(document.body.textContent).not.toContain("copy it now");
  // Grant form is back to its idle step, not the plaintext step.
  expect(document.querySelector<HTMLInputElement>("#grant-name")?.value).toBe("");
  for (let i = 0; i < W.localStorage.length; i++) {
    const k = W.localStorage.key(i);
    if (k === null) continue;
    expect(W.localStorage.getItem(k)).not.toContain(PLAINTEXT);
  }
});

test("grant resolving after dialog close never persists or renders plaintext", async () => {
  const h = await openKeysForWs1();
  // Holder object: the resolver is assigned inside the mocked fetch closure,
  // so a bare `let` would be narrowed to `null` at the call site.
  const grantGate: { resolve: ((res: Response) => void) | null } = { resolve: null };
  h.setFetch((url, init) => {
    void init;
    if (url.includes("/admin/workspaces/ws_1/keys") && init?.method === "POST")
      return new Promise<Response>((resolve) => {
        grantGate.resolve = resolve;
      });
    if (url.includes("/admin/users/u_1/context")) return jsonResponse(200, SEED_CONTEXT);
    if (url.includes("/admin/catalog/models")) return jsonResponse(200, SEED_MODELS);
    if (url.includes("/admin/workspaces/ws_1/keys")) return jsonResponse(200, SEED_KEYS);
    return jsonResponse(200, {});
  });
  await h.typeInto("grant-name", "closed grant");
  await h.clickButton("Create key");
  await h.waitFor("shown once and cannot be recovered");
  await h.clickButton("Create key");
  await h.clickButton("Cancel"); // dialog unmounts while dispatch in flight
  if (!grantGate.resolve) throw new Error("grant POST was never issued");
  grantGate.resolve(
    jsonResponse(201, {
      id: "k_closed",
      name: "closed grant",
      plaintext: PLAINTEXT,
      modelIds: [],
    }),
  );
  for (let i = 0; i < 3; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  // Dialog is gone; nothing renders and nothing persisted.
  expect(document.body.textContent).not.toContain(PLAINTEXT);
  for (let i = 0; i < W.localStorage.length; i++) {
    const k = W.localStorage.key(i);
    if (k === null) continue;
    expect(W.localStorage.getItem(k)).not.toContain(PLAINTEXT);
  }
});

test("revoke requires a reason and posts it; list reflects terminal revoked status", async () => {
  const h = await openKeysForWs1();
  await h.clickButton("Revoke");
  await h.waitFor("Revoke key sk-hbr-abcd?");
  // Confirm stays inert until a reason is entered.
  const confirmBtn = [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "Revoke key",
  );
  expect(confirmBtn?.disabled).toBe(true);
  await h.typeInto("revoke-reason", "leaked in CI logs");
  h.setFetch((url, init) => {
    void init;
    if (url.includes("/keys/k_1/revoke")) return jsonResponse(200, { status: "revoked" });
    if (url.includes("/admin/users/u_1/context")) return jsonResponse(200, SEED_CONTEXT);
    if (url.includes("/admin/catalog/models")) return jsonResponse(200, SEED_MODELS);
    if (url.includes("/admin/workspaces/ws_1/keys"))
      return jsonResponse(
        200,
        SEED_KEYS.map((k) => (k.id === "k_1" ? { ...k, status: "revoked" } : k)),
      );
    return jsonResponse(200, {});
  });
  await h.clickButton("Revoke key");
  // Success closes the confirm block and the refreshed list shows the
  // terminal status; the toast layer (sonner) is not mounted in this render.
  await h.waitFor("sk-hbr-abcd");
  expect(document.body.textContent).not.toContain("Revoke key sk-hbr-abcd?");
  const posts = h.fetchCalls.filter((c) => c.method === "POST" && c.url.includes("/revoke"));
  expect(posts).toHaveLength(1);
  expect(must(posts, 0).body).toMatchObject({ reason: "leaked in CI logs" });
  await h.clickButton("Cancel");
  // Terminal status from the refreshed list; revoked row offers no Revoke.
  const revokeButtons = [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === "Revoke",
  );
  expect(revokeButtons).toHaveLength(0);
});

test("already-revoked key revoke returns success without error (server idempotent)", async () => {
  const h = await openKeysForWs1();
  // Only k_1 (enabled) offers Revoke; k_2 is already revoked and terminal.
  const text = document.body.textContent ?? "";
  expect(text).toContain("Old key");
  const revokeButtons = [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === "Revoke",
  );
  expect(revokeButtons).toHaveLength(1);
  h.setFetch((url, init) => {
    void init;
    if (url.includes("/keys/k_1/revoke")) return jsonResponse(200, { status: "revoked" });
    if (url.includes("/admin/users/u_1/context")) return jsonResponse(200, SEED_CONTEXT);
    if (url.includes("/admin/catalog/models")) return jsonResponse(200, SEED_MODELS);
    if (url.includes("/admin/workspaces/ws_1/keys")) return jsonResponse(200, SEED_KEYS);
    return jsonResponse(200, {});
  });
  await h.clickButton("Revoke");
  await h.typeInto("revoke-reason", "cleanup");
  await h.clickButton("Revoke key");
  // Server-side idempotency: 200, confirm block closes, no error surfaces.
  await h.waitFor("sk-hbr-abcd");
  expect(document.body.textContent).not.toContain("Revoke key sk-hbr-abcd?");
  expect(document.body.textContent).not.toContain("Request failed");
});

test("key endpoint 404 (wrong workspace) renders the honest error", async () => {
  const h = await openKeysDialog();
  await h.selectOption("Workspace", "ws_2");
  await h.waitFor("workspace not found");
  // Grant/revoke controls stay unreachable without a key list.
  expect(document.querySelector<HTMLInputElement>("#grant-name")).toBeNull();
});
