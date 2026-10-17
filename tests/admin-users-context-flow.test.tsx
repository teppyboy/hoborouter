// Admin users interaction contract (row activation + context menu + server
// list controls), jsdom + real React + mocked fetch:
// - No per-row button wall: all actions live in the detail dialog footer and
//   the right-click / Shift+F10 context menu.
// - Context menu opens on contextmenu event and Shift+F10, closes on Escape
//   (keyboard cancel) without errors.
// - Server-driven search/sort/pagination: debounced q, sort headers, offset
//   pager; requests carry the exact query params.
// - WORKSPACE_FUNDED blocked-wallet flow: reserved amount click opens the
//   bounded pending-billing read; rows link to the request log; no fake
//   money/settle controls anywhere.
import { test, expect, afterAll, afterEach } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import type { AdminUser, UsersServerControls } from "../apps/web/src/pages/admin/users";
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
type EventCtor<T, I> = new (type: string, init?: I) => T;
interface JsdomRealm {
  Event: EventCtor<Event, EventInit>;
  MouseEvent: EventCtor<MouseEvent, MouseEventInit>;
  KeyboardEvent: EventCtor<KeyboardEvent, KeyboardEventInit>;
  document: Document;
  Node: typeof Node;
  NodeFilter: typeof NodeFilter;
  Element: typeof Element;
  HTMLElement: typeof HTMLElement;
  HTMLInputElement: typeof HTMLInputElement;
  getComputedStyle: typeof getComputedStyle;
  MutationObserver: typeof MutationObserver;
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
  getComputedStyle: W.getComputedStyle,
  MutationObserver: W.MutationObserver,
  CustomEvent: W.Event,
  localStorage: W.localStorage,
})) {
  Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
}
// KeyboardEvent is dispatched through the jsdom realm's window object.
Object.defineProperty(globalThis, "KeyboardEvent", {
  value: W.KeyboardEvent as unknown,
  configurable: true,
  writable: true,
});

const { UsersTable } = await import("../apps/web/src/pages/admin/users");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// @ts-expect-error relative specifier has no declaration file under tests tsconfig
const { createRoot } = await import("../apps/web/node_modules/react-dom/client");

type FetchCall = { url: string; method?: string; body?: string };
type FetchHandler = (url: string, init?: RequestInit) => Response;

const jsonResponse = (status: number, body: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

function adminUser(partial: Partial<AdminUser> = {}): AdminUser {
  return {
    id: "u_1",
    email: "grace@example.com",
    name: "Grace",
    created_at: 1700000000000,
    is_instance_admin: false,
    workspace_count: 1,
    ...partial,
  };
}

let active: { cleanup: () => void } | null = null;
afterEach(() => {
  active?.cleanup();
  active = null;
});
afterAll(() => {
  for (const k of GLOBAL_KEYS) {
    const orig = originals[k];
    if (orig) Object.defineProperty(globalThis, k, orig);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  W.close();
});

const DEFAULT_FETCH: FetchHandler = () => jsonResponse(200, {});

function mount(serverControlsSetup?: () => UsersServerControls) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);

  const fetchCalls: FetchCall[] = [];
  let handler: FetchHandler = DEFAULT_FETCH;
  const setFetch = (fn: FetchHandler) => (handler = fn);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), method: init?.method, body: String(init?.body ?? "") };
    fetchCalls.push(call);
    return handler(String(url), init);
  }) as typeof fetch;

  act(() => {
    root.render(
      <QueryClientProvider client={qc}>
        <UsersTable
          users={[adminUser()]}
          currentUserId="u_admin"
          serverControls={serverControlsSetup?.()}
        />
      </QueryClientProvider>,
    );
  });

  const h = {
    fetchCalls,
    setFetch,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
      globalThis.fetch = realFetch;
    },
    waitFor: async (needle: string, absent = false) => {
      for (let i = 0; i < 50; i++) {
        const hit = (document.body.textContent ?? "").includes(needle);
        if (absent ? !hit : hit) return;
        await act(async () => {
          await new Promise((r) => setTimeout(r, 10));
        });
      }
      throw new Error(`waitFor miss: ${needle}`);
    },
    clickRow: async (email: string) => {
      const row = [...document.querySelectorAll("tr[aria-label]")].find((r) =>
        (r.getAttribute("aria-label") ?? "").includes(email),
      );
      if (!row) throw new Error(`no row for ${email}`);
      await act(async () => {
        row.dispatchEvent(new W.MouseEvent("click", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));
      });
    },
    rowKeydown: async (email: string, key: string, shift = false) => {
      const row = [...document.querySelectorAll("tr[aria-label]")].find((r) =>
        (r.getAttribute("aria-label") ?? "").includes(email),
      );
      if (!row) throw new Error(`no row for ${email}`);
      await act(async () => {
        row.dispatchEvent(
          new W.KeyboardEvent("keydown", { key, shiftKey: shift, bubbles: true, cancelable: true }),
        );
        await new Promise((r) => setTimeout(r, 0));
      });
    },
    rowContextmenu: async (email: string) => {
      const row = [...document.querySelectorAll("tr[aria-label]")].find((r) =>
        (r.getAttribute("aria-label") ?? "").includes(email),
      );
      if (!row) throw new Error(`no row for ${email}`);
      await act(async () => {
        row.dispatchEvent(
          new W.MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 40,
            clientY: 60,
          }),
        );
        await new Promise((r) => setTimeout(r, 0));
      });
    },
    clickButtonContaining: async (needle: string) => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").includes(needle),
      );
      if (!btn) throw new Error(`no button containing "${needle}"`);
      await act(async () => {
        btn.dispatchEvent(new W.MouseEvent("click", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));
      });
    },
    clickMenuItem: async (label: string) => {
      const items = [...document.querySelectorAll('[role="menuitem"]')];
      const item = items.find((el) => el.textContent?.trim() === label);
      if (!item)
        throw new Error(
          `no menu item "${label}" (have: ${items.map((i) => i.textContent?.trim()).join(",")})`,
        );
      await act(async () => {
        item.dispatchEvent(new W.MouseEvent("click", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));
      });
    },
    pressEscape: async () => {
      const target =
        document.querySelector('[role="menuitem"]') ?? document.querySelector("[role=dialog]");
      await act(async () => {
        (target as HTMLElement | null)?.focus();
        (target ?? document.body).dispatchEvent(
          new W.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
        await new Promise((r) => setTimeout(r, 0));
      });
    },
    clickButton: async (label: string, which: "first" | "last" = "first") => {
      const matches = [...document.querySelectorAll("button")].filter(
        (b) => b.textContent?.trim() === label,
      );
      const btn = which === "first" ? matches[0] : matches[matches.length - 1];
      if (!btn) throw new Error(`no button "${label}"`);
      await act(async () => {
        btn.dispatchEvent(new W.MouseEvent("click", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));
      });
    },
    typeInto: async (ariaLabel: string, text: string) => {
      const el = document.querySelector<HTMLInputElement>(`input[aria-label="${ariaLabel}"]`);
      if (!el) throw new Error(`no input "${ariaLabel}"`);
      const setter = Object.getOwnPropertyDescriptor(W.HTMLInputElement.prototype, "value")!.set!;
      setter.call(el, text);
      await act(async () => {
        el.dispatchEvent(new W.Event("input", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));
      });
    },
  };
  active = h;
  return { h };
}

// --- context menu -----------------------------------------------------------

test("right-click opens the context menu with every action; items dispatch the dialogs", async () => {
  const { h } = mount();
  await h.rowContextmenu("grace@example.com");
  await h.waitFor("View detail"); // menu content rendered
  const items = [...document.querySelectorAll('[role="menuitem"]')].map((el) =>
    el.textContent?.trim(),
  );
  expect(items).toContain("View detail");
  expect(items).toContain("Edit");
  expect(items).toContain("Reset password");
  expect(items).toContain("Adjust wallet");
  expect(items).toContain("Manage keys");
  expect(items).toContain("Remove");
  // Menu action -> the same dialogs the detail footer offers.
  await h.clickMenuItem("Adjust wallet");
  await h.waitFor("Select a workspace…");
});

test("Shift+F10 opens the context menu; Escape cancels it without errors", async () => {
  const { h } = mount();
  await h.rowKeydown("grace@example.com", "F10", true);
  await h.waitFor("View detail");
  await h.pressEscape();
  await h.waitFor("View detail", true); // menu closed, no error
  // Plain Enter (without Shift) opens detail, not the menu.
  await h.rowKeydown("grace@example.com", "Enter");
  await h.waitFor("User details");
});

test("row click and context menu do not coexist with a per-row button wall", async () => {
  const { h } = mount();
  const labels = [
    "Edit grace@example.com",
    "Reset password for grace@example.com",
    "Adjust wallet for grace@example.com",
    "Manage keys for grace@example.com",
    "Remove grace@example.com",
  ];
  expect(labels.every((l) => !document.querySelector(`button[aria-label="${l}"]`))).toBe(true);
  await h.clickRow("grace@example.com");
  await h.waitFor("User details");
});

// --- server-driven search / sort / pagination --------------------------------

function serverControlsFixture() {
  const pushed: string[] = [];
  let q = "";
  let role = "";
  let sort: "created_at" | "email" | "name" = "created_at";
  let order: "asc" | "desc" = "desc";
  let offset = 0;
  const push = () => {
    const p = new URLSearchParams({ sort, order, limit: "200", offset: String(offset) });
    if (q) p.set("q", q);
    if (role) p.set("role", role);
    pushed.push(`/api/v1/admin/users?${p.toString()}`);
  };
  const controls: UsersServerControls = {
    get q() {
      return q;
    },
    onQChange: (v) => {
      q = v;
      void push();
    },
    get role() {
      return role;
    },
    onRoleChange: (v) => {
      role = v;
      void push();
    },
    get sort() {
      return sort;
    },
    get order() {
      return order;
    },
    onSortChange: (s, o) => {
      sort = s;
      order = o;
      void push();
    },
    total: 500,
    limit: 200,
    get offset() {
      return offset;
    },
    onOffsetChange: (o) => {
      offset = o;
      void push();
    },
  };
  return { controls, lastUrl: () => pushed.at(-1) ?? "", urls: () => pushed };
}

test("search input is debounced and queried server-side; pager pages by offset", async () => {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/v1/admin/users?")) {
      return jsonResponse(200, { data: [adminUser()], total: 500, limit: 200, offset: 0 });
    }
    return DEFAULT_FETCH(String(url), init);
  }) as typeof fetch;
  const fx = serverControlsFixture();
  const { h } = mount(() => fx.controls);
  // Search: debounce merges keystrokes; the pushed URL carries q.
  await h.typeInto("Search name, email or ID", "gr");
  await h.typeInto("Search name, email or ID", "ace");
  await new Promise((r) => setTimeout(r, 400));
  expect(fx.lastUrl()).toContain("q=ace");
  // Sort header click: email asc.
  await h.clickButton("Email");
  expect(fx.lastUrl()).toContain("sort=email");
  expect(fx.lastUrl()).toContain("order=asc");
  // Pager: total 500 > limit 200 -> Next moves offset.
  await h.waitFor("Showing");
  await h.clickButton("Next");
  expect(fx.lastUrl()).toContain("offset=200");
  await h.clickButton("Previous");
  expect(`N=${fx.urls().length} J=${fx.urls().join(" | ")}`).toContain("offset=0");
});

// --- blocked-wallet pending read ---------------------------------------------

test("reserved amount click fetches the bounded pending list with request-log links and no settle controls", async () => {
  const { h } = mount();
  h.setFetch((url, init) => {
    const u = String(url);
    if (init?.method === "DELETE" && u.includes("/admin/users/u_1")) {
      return jsonResponse(409, {
        error: {
          code: "WORKSPACE_FUNDED",
          message: "blocked",
          workspaces: [
            {
              id: "ws_1",
              name: "Acme",
              wallets: [
                {
                  id: "wal_1",
                  kind: "topup",
                  balance_vnd: 50000,
                  reserved_vnd: 12000,
                  available_vnd: 38000,
                },
              ],
            },
          ],
        },
      });
    }
    if (u.includes("/pending-billing")) {
      return jsonResponse(200, {
        data: [
          {
            request_id: "req_abc",
            created_at: 1700000000000,
            status: "pending",
            dispatch_state: "reserved",
            endpoint: "/v1/chat/completions",
            billing_reservation: { id: "br_1", status: "held", cap_vnd: 12000 },
          },
        ],
        total: 55,
        limit: 50,
      });
    }
    return DEFAULT_FETCH(String(url), init);
  });
  await h.clickRow("grace@example.com");
  await h.waitFor("User details");
  await h.clickButton("Remove");
  await h.waitFor("Remove user?");
  await h.clickButton("Remove", "last"); // confirm attempt -> 409 WORKSPACE_FUNDED
  await h.waitFor("50.000 ₫");
  // Reserved amount opens the bounded pending read.
  await h.clickButtonContaining("12.000 ₫");
  await h.waitFor("req_abc");
  const link = document.querySelector<HTMLAnchorElement>(
    'a[href="/admin/request-log?request=req_abc"]',
  );
  expect(link).not.toBeNull();
  await h.waitFor("older pending records"); // honest "…and N older" hint
  // No invented money controls: the hint names settle/withdraw but no
  // actionable control offers them.
  const actionables = [...document.querySelectorAll("button, [role=menuitem], a")].map((el) =>
    (el.textContent ?? "").trim(),
  );
  for (const banned of ["Settle", "Force cancel", "Withdraw"]) {
    expect(actionables.some((t) => t.includes(banned) && !t.startsWith("…and"))).toBe(false);
  }
});
