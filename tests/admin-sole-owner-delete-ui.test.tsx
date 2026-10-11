// Admin remove-dialog sole-owner confirm flow (jsdom, real React, mocked fetch):
// - Unconfirmed removal 409 SOLE_OWNER still names the workspaces (guidance).
// - The dialog then offers the explicit "Delete workspaces and remove" action,
//   which re-sends DELETE with body { confirm: true }.
// - A WORKSPACE_FUNDED 409 on the confirmed attempt surfaces the funds message
//   and never renders a destructive retry.
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

interface FetchCall {
  url: string;
  method?: string;
  body?: string;
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
    ...partial,
  };
}

let active: ReturnType<typeof mount> | null = null;
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
  jsdomWindow?.close();
});

const DEFAULT_FETCH: FetchHandler = () => jsonResponse(200, {});

function mount(user: AdminUser = adminUser()) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);

  const fetchCalls: FetchCall[] = [];
  let handler: FetchHandler = DEFAULT_FETCH;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), method: init?.method, body: String(init?.body ?? "") });
    return handler(String(url), init);
  }) as typeof fetch;

  act(() => {
    root.render(
      <QueryClientProvider client={qc}>
        <UsersTable users={[user]} currentUserId="u_admin" />
      </QueryClientProvider>,
    );
  });

  const h = {
    fetchCalls,
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
  };
  active = h;
  return h;
}

test("sole-owner confirm action resends DELETE with { confirm: true } and succeeds", async () => {
  const h = mount();
  let attempts = 0;
  const delBodies: string[] = [];
  h.fetchCalls.length = 0;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    attempts++;
    if (String(url).includes("/admin/users/u_1") && init?.method === "DELETE") {
      delBodies.push(String(init?.body ?? ""));
      if (attempts === 1) {
        return jsonResponse(409, {
          error: {
            code: "SOLE_OWNER",
            message: "User is the sole owner of workspaces",
            workspaces: [{ id: "ws_1", name: "Acme" }],
          },
        });
      }
      return jsonResponse(200, { removed: true });
    }
    return DEFAULT_FETCH(String(url), init);
  }) as typeof fetch;

  await h.clickButton("Remove"); // row action opens the confirm dialog
  await h.waitFor("Remove user?");
  await h.clickButton("Remove", "last"); // dialog confirm (unconfirmed attempt)
  await h.waitFor("Delete workspaces and remove");
  const text = document.body.textContent ?? "";
  expect(text).toContain("Acme"); // named workspaces
  expect(text).toContain("archived"); // archive semantics surfaced
  await h.clickButton("Delete workspaces and remove");
  await h.waitFor("Remove user?", true); // dialog closed after success
  const del = delBodies;
  expect(del).toHaveLength(2);
  expect(del[1]).toBe(JSON.stringify({ confirm: true }));
});

test("confirmed attempt on a funded workspace shows the funds message, no retry", async () => {
  const h = mount();
  let attempts = 0;
  const delBodies: string[] = [];
  h.fetchCalls.length = 0;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    attempts++;
    if (String(url).includes("/admin/users/u_1") && init?.method === "DELETE") {
      delBodies.push(String(init?.body ?? ""));
      if (attempts === 1) {
        return jsonResponse(409, {
          error: {
            code: "SOLE_OWNER",
            message: "User is the sole owner of workspaces",
            workspaces: [{ id: "ws_1", name: "Acme" }],
          },
        });
      }
      return jsonResponse(409, {
        error: {
          code: "WORKSPACE_FUNDED",
          message: "Workspace wallet holds funds or reservations",
          workspaces: [{ id: "ws_1", name: "Acme" }],
        },
      });
    }
    return DEFAULT_FETCH(String(url), init);
  }) as typeof fetch;

  await h.clickButton("Remove");
  await h.waitFor("Remove user?");
  await h.clickButton("Remove", "last");
  await h.waitFor("Delete workspaces and remove");
  await h.clickButton("Delete workspaces and remove");
  await h.waitFor("holds funds or a reservation");
  const text = document.body.textContent ?? "";
  expect(text).not.toContain("Delete workspaces and remove"); // no destructive retry on money
  expect(delBodies).toHaveLength(2);
  expect(delBodies[1]).toBe(JSON.stringify({ confirm: true }));
});
