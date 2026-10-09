// Admin wallet adjustment UI contract (jsdom, real React, mocked fetch):
// - "Adjust wallet" opens per-user from the users row; existing Edit/Reset/
//   Remove actions stay untouched.
// - Workspace selection is EXPLICIT: every membership from the user-context
//   endpoint is offered, nothing is assumed (no single-wallet default), and
//   no target/balance exists until a workspace is picked.
// - Credit/debit toggle + positive integer VND amount compose the signed
//   delta; reason is required; a confirm step shows the integer before→after
//   estimate BEFORE any POST.
// - The idempotency key is a UUID generated once per submit attempt and is
//   REUSED on retry after a failed dispatch (replay/lost-response safety).
// - Server errors (409 insufficient) render honestly; no automatic retries.
// - The receipt renders the authoritative response before/after and a link
//   into the workspace ledger carrying the workspace context.
// - A stale completion (older attempt finishing after a newer one) never
//   overwrites the newer receipt; switching context drops pending UX without
//   cancelling the in-flight financial dispatch.
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

const SEED_CONTEXT = {
  memberships: [
    { workspaceId: "ws_1", workspaceName: "Acme", role: "owner" },
    { workspaceId: "ws_2", workspaceName: "Globex", role: "member" },
  ],
  wallets: [{ workspaceId: "ws_1", kind: "topup", balance: 90000, reserved: 5000 }],
};

function receipt(
  workspaceId: string,
  balanceBefore: number,
  balanceAfter: number,
  replayed = false,
) {
  return {
    ledgerEntryId: `led_${workspaceId}`,
    balanceBefore,
    balanceAfter,
    reserved: 5000,
    workspaceId,
    replayed,
  };
}

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

const DEFAULT_CONTEXT_FETCH = (url: string, init: RequestInit | undefined) => {
  void init;
  if (url.includes("/admin/users/u_1/context")) return jsonResponse(200, SEED_CONTEXT);
  if (url.includes("/workspaces/ws_1/wallet/adjust"))
    return jsonResponse(200, receipt("ws_1", 90000, 70000));
  return jsonResponse(200, {});
};

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);

  const fetchCalls: FetchCall[] = [];
  let handler: FetchHandler = DEFAULT_CONTEXT_FETCH;
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
    async typeInto(ariaLabel: string, value: string) {
      const el = document.querySelector<HTMLInputElement>(`input[aria-label="${ariaLabel}"]`);
      if (!el) throw new Error(`input not found: ${ariaLabel}`);
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(W.HTMLInputElement.prototype, "value")!.set!;
        setter.call(el, value);
        el.dispatchEvent(new W.Event("input", { bubbles: true }));
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

async function openWalletDialog() {
  const h = mount();
  await h.clickButton("Adjust wallet");
  // "Workspace" alone matches the table header; wait for the dialog body
  // AND the loaded membership options so selection is deterministic.
  await h.waitFor("Select a workspace…");
  await h.waitFor("Acme");
  return h;
}

// --- tests ----------------------------------------------------------------

test("users row offers Adjust wallet; existing Edit/Reset/Remove actions untouched", async () => {
  mount();
  expect(
    [...document.querySelectorAll("button")].some(
      (b) => b.getAttribute("aria-label") === "Adjust wallet for grace@example.com",
    ),
  ).toBe(true);
  expect(
    [...document.querySelectorAll("button")].some(
      (b) => b.getAttribute("aria-label") === "Edit grace@example.com",
    ),
  ).toBe(true);
  expect(
    [...document.querySelectorAll("button")].some(
      (b) => b.getAttribute("aria-label") === "Reset password for grace@example.com",
    ),
  ).toBe(true);
  expect(
    [...document.querySelectorAll("button")].some(
      (b) => b.getAttribute("aria-label") === "Remove grace@example.com",
    ),
  ).toBe(true);
});

test("dialog offers EVERY membership explicitly; no balance or submit until a workspace is picked", async () => {
  const h = await openWalletDialog();
  // Both memberships are options in the picker (wait for context load).
  await h.waitFor("Acme");
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="Workspace"]');
  expect(select).not.toBeNull();
  const options = [...select!.options].map((o) => o.value);
  expect(options).toContain("ws_1");
  expect(options).toContain("ws_2");
  // Nothing is preselected: no balance shown before an explicit pick.
  expect(document.body.textContent).not.toContain("Acme —");
  // Apply is not reachable before a target exists.
  expect(
    [...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Review"),
  ).toBe(false);
});

test("selected workspace shows name, topup balance and reserved", async () => {
  const h = await openWalletDialog();
  h.setFetch(DEFAULT_CONTEXT_FETCH);
  await h.selectOption("Workspace", "ws_1");
  await h.waitFor("Balance");
  expect(document.body.textContent).toContain("Acme");
  expect(document.body.textContent).toContain("90.000 ₫");
  expect(document.body.textContent).toContain("5.000 ₫");
});

test("credit/debit toggle + positive amount composes signed delta; confirm shows integer before→after; POST only after confirm", async () => {
  const h = await openWalletDialog();
  h.setFetch(DEFAULT_CONTEXT_FETCH);
  await h.selectOption("Workspace", "ws_1");
  await h.typeInto("Amount (VND)", "20000");
  await h.typeInto("Reason", "Compensation for outage");
  // Debit mode composes a negative delta.
  await h.clickButton("Debit");
  await h.clickButton("Review");
  await h.waitFor("70.000 ₫");
  expect(document.body.textContent).toContain("90.000 ₫ → 70.000 ₫");
  // No financial dispatch happened during form fill or confirm display.
  expect(h.fetchCalls.filter((c) => c.method === "POST")).toHaveLength(0);
  await h.clickButton("Apply adjustment");
  await h.waitFor("Adjustment recorded");
  const posts = h.fetchCalls.filter(
    (c) => c.url === "/api/v1/admin/workspaces/ws_1/wallet/adjust" && c.method === "POST",
  );
  expect(posts).toHaveLength(1);
  expect(must(posts, 0).body).toMatchObject({
    delta: -20000,
    reason: "Compensation for outage",
  });
  const key = must(posts, 0).body?.idempotencyKey;
  expect(typeof key).toBe("string");
  expect((key as string).length).toBe(36);
  // Receipt renders the authoritative response values.
  expect(document.body.textContent).toContain("70.000 ₫");
});

test("failed dispatch keeps the SAME idempotency key on retry (replay/lost-response safe)", async () => {
  const h = await openWalletDialog();
  h.setFetch(DEFAULT_CONTEXT_FETCH);
  await h.selectOption("Workspace", "ws_1");
  await h.typeInto("Amount (VND)", "10000");
  await h.typeInto("Reason", "grant");
  await h.clickButton("Review");
  let failNext = true;
  h.setFetch((url, init) => {
    void init;
    if (url.includes("/wallet/adjust")) {
      if (failNext) {
        failNext = false;
        return jsonResponse(503, { error: { code: "UNAVAILABLE", message: "try again" } });
      }
      return jsonResponse(200, receipt("ws_1", 90000, 100000));
    }
    if (url.includes("/admin/users/u_1/context")) return jsonResponse(200, SEED_CONTEXT);
    return jsonResponse(200, {});
  });
  await h.clickButton("Apply adjustment");
  await h.waitFor("try again");
  await h.clickButton("Apply adjustment");
  await h.waitFor("Adjustment recorded");
  const posts = h.fetchCalls.filter((c) => c.method === "POST" && c.url.includes("/wallet/adjust"));
  expect(posts).toHaveLength(2);
  expect(must(posts, 0).body?.idempotencyKey).toBe(must(posts, 1).body?.idempotencyKey);
});

test("409 INSUFFICIENT renders an honest error; no automatic retry", async () => {
  const h = await openWalletDialog();
  h.setFetch(DEFAULT_CONTEXT_FETCH);
  await h.selectOption("Workspace", "ws_1");
  await h.typeInto("Amount (VND)", "50000");
  await h.typeInto("Reason", "debit too large");
  await h.clickButton("Debit");
  await h.clickButton("Review");
  h.setFetch((url, init) => {
    void init;
    if (url.includes("/wallet/adjust"))
      return jsonResponse(409, {
        error: { code: "INSUFFICIENT", message: "balance would breach reserved" },
      });
    if (url.includes("/admin/users/u_1/context")) return jsonResponse(200, SEED_CONTEXT);
    return jsonResponse(200, {});
  });
  await h.clickButton("Apply adjustment");
  await h.waitFor("Insufficient");
  expect(
    h.fetchCalls.filter((c) => c.method === "POST" && c.url.includes("/wallet/adjust")),
  ).toHaveLength(1);
});

test("membership without a TOPUP wallet is offered but cannot become a target", async () => {
  const h = await openWalletDialog();
  h.setFetch(DEFAULT_CONTEXT_FETCH);
  await h.selectOption("Workspace", "ws_2");
  await h.waitFor("no TOPUP wallet");
  expect(
    [...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Review"),
  ).toBe(false);
});

test("receipt links into the workspace ledger with the workspace context set", async () => {
  const h = await openWalletDialog();
  h.setFetch(DEFAULT_CONTEXT_FETCH);
  await h.selectOption("Workspace", "ws_1");
  await h.typeInto("Amount (VND)", "10000");
  await h.typeInto("Reason", "topup");
  await h.clickButton("Review");
  h.setFetch((url, init) => {
    void init;
    if (url.includes("/wallet/adjust")) return jsonResponse(200, receipt("ws_1", 90000, 100000));
    if (url.includes("/admin/users/u_1/context")) return jsonResponse(200, SEED_CONTEXT);
    return jsonResponse(200, {});
  });
  await h.clickButton("Apply adjustment");
  await h.waitFor("Adjustment recorded");
  const link = document.querySelector<HTMLAnchorElement>('a[href="/billing/credits"]');
  expect(link).not.toBeNull();
  expect(link!.dataset.workspaceId).toBe("ws_1");
});

test("a stale completion never overwrites the newer attempt's receipt", async () => {
  const h = mount();
  // ws_2 must own a TOPUP wallet here: it becomes the second target.
  const context = {
    memberships: SEED_CONTEXT.memberships,
    wallets: [
      ...SEED_CONTEXT.wallets,
      { workspaceId: "ws_2", kind: "topup", balance: 0, reserved: 0 },
    ],
  };
  h.setFetch((url, init) => {
    void init;
    if (url.includes("/admin/users/u_1/context")) return jsonResponse(200, context);
    return jsonResponse(200, {});
  });
  await h.clickButton("Adjust wallet");
  await h.waitFor("Select a workspace…");
  await h.waitFor("Acme");
  await h.selectOption("Workspace", "ws_1");
  await h.typeInto("Amount (VND)", "10000");
  await h.typeInto("Reason", "first attempt");
  await h.clickButton("Review");
  // Slow dispatch for ws_1; user backs out and targets ws_2 instead.
  h.setFetch((url, init) => {
    void init;
    if (url.includes("/workspaces/ws_1/wallet/adjust"))
      return new Promise((resolve) =>
        setTimeout(() => resolve(jsonResponse(200, receipt("ws_1", 90000, 100000))), 80),
      );
    if (url.includes("/workspaces/ws_2/wallet/adjust"))
      return jsonResponse(200, receipt("ws_2", 0, 25000));
    if (url.includes("/admin/users/u_1/context")) return jsonResponse(200, SEED_CONTEXT);
    return jsonResponse(200, {});
  });
  await h.clickButton("Apply adjustment");
  // Drop the pending UX: back out and switch the target workspace.
  await h.clickButton("Back");
  await h.selectOption("Workspace", "ws_2");
  await h.typeInto("Amount (VND)", "25000");
  await h.typeInto("Reason", "second attempt");
  await h.clickButton("Review");
  await h.clickButton("Apply adjustment");
  await h.waitFor("Adjustment recorded");
  expect(document.body.textContent).toContain("0 ₫ → 25.000 ₫");
  // Let the stale ws_1 response land; the displayed receipt must not change.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 150));
  });
  expect(document.body.textContent).toContain("0 ₫ → 25.000 ₫");
  expect(document.body.textContent).not.toContain("100.000 ₫");
});

test("late adjust completion after workspace switches never re-opens a receipt in the new workspace", async () => {
  const h = await openWalletDialog();
  h.setFetch(DEFAULT_CONTEXT_FETCH);
  await h.selectOption("Workspace", "ws_1");
  await h.typeInto("Amount (VND)", "20000");
  await h.typeInto("Reason", "slow dispatch");
  await h.clickButton("Review");
  // Holder object: the resolver is assigned inside the mocked fetch closure,
  // so a bare `let` would be narrowed to `null` at the call site.
  const gate: { resolve: ((res: Response) => void) | null } = { resolve: null };
  h.setFetch((url, init) => {
    void init;
    if (url.includes("/workspaces/ws_1/wallet/adjust"))
      return new Promise<Response>((resolve) => {
        gate.resolve = resolve;
      });
    if (url.includes("/workspaces/ws_2/wallet/adjust"))
      return jsonResponse(200, receipt("ws_2", 0, 25000));
    if (url.includes("/admin/users/u_1/context")) return jsonResponse(200, SEED_CONTEXT);
    return jsonResponse(200, {});
  });
  await h.clickButton("Apply adjustment"); // dispatch now in flight (delayed)
  // Return to the form (this never cancels the dispatch) so the workspace
  // picker is reachable; then switch away and back while it is in flight.
  await h.clickButton("Back");
  await h.selectOption("Workspace", "ws_2");
  await h.waitFor("no TOPUP wallet");
  await h.selectOption("Workspace", "ws_1");
  await h.waitFor("90.000 ₫");
  if (!gate.resolve) throw new Error("adjust POST was never issued");
  gate.resolve(jsonResponse(200, receipt("ws_1", 90000, 100000)));
  for (let i = 0; i < 3; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  // The retired attempt must NOT replay its receipt step in the new workspace.
  expect(document.body.textContent).not.toContain("Adjustment recorded");
  expect(document.body.textContent).not.toContain("100.000 ₫");
  // Exactly one financial dispatch: no cancel, no automatic retry.
  const posts = h.fetchCalls.filter((c) => c.method === "POST" && c.url.includes("/wallet/adjust"));
  expect(posts).toHaveLength(1);
  // The completed (old-context) dispatch still refreshes the context cache.
  const contextFetches = h.fetchCalls.filter((c) => c.url.includes("/admin/users/u_1/context"));
  expect(contextFetches.length).toBeGreaterThanOrEqual(2);
});
