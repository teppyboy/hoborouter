// Chat auto-uncollapse (Open-WebUI-style UX): explicit conversation intent —
// starting a new chat or opening a saved conversation — expands the desktop
// conversation list for the session, but NEVER rewrites the sticky device
// pref: a remount/reload returns to the user's saved collapsed state. Only
// the toggle button persists the pref. Observable behavior only.
import { test, expect, beforeAll, afterAll, afterEach, mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";

const GLOBAL_KEYS = [
  "window",
  "document",
  "localStorage",
  "location",
  "getComputedStyle",
  "MutationObserver",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "KeyboardEvent",
  "InputEvent",
  "PointerEvent",
  "NodeFilter",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLButtonElement",
  "HTMLAnchorElement",
  "HTMLFormElement",
  "HTMLSelectElement",
  "HTMLLabelElement",
  "DocumentFragment",
  "DOMParser",
  "SVGElement",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;

const CHAT_ID = "c-auto-1";
// Identity + catalog are fixed for the whole file (same reactive-fixture
// pattern as chat-page-413-recovery.test.tsx). The fixture vars default to
// anonymous: bun's mock.module is process-global and later real-auth SSR
// files (e.g. chat-page.test.tsx) must keep seeing the anonymous default.
let sessionUserId: string | null = null;
mock.module("../apps/web/src/lib/auth", () => ({
  useSession: () => ({
    data: sessionUserId ? { user: { id: sessionUserId } } : null,
    isPending: false,
  }),
}));
mock.module("../apps/web/src/lib/workspace-queries", () => ({
  useCurrentWorkspaceId: () => (sessionUserId ? "ws-auto" : null),
}));
mock.module("../apps/web/src/pages/models/data", () => ({
  useCatalogModels: () => ({ models: [], loading: false, error: null }),
}));

const mockFetch = (input: RequestInfo | URL): Promise<Response> => {
  const path = String(input);
  let body: unknown = {};
  if (path.includes("/api/auth/get-session")) {
    body = {
      user: { id: "u-auto", name: "T", email: "t@example.test", emailVerified: true },
      session: { userId: "u-auto" },
    };
  } else if (path.includes("/api/v1/workspaces/ws-auto/chats") && path.endsWith("/chats")) {
    // List endpoint: one saved conversation so a row can be opened.
    body = {
      data: [
        {
          id: CHAT_ID,
          title: "Rewrite the intro",
          model: null,
          version: 1,
          created_at: 1700000000000,
          updated_at: 1700000000000,
        },
      ],
      nextCursor: null,
    };
  } else if (path.includes(`/chats/${CHAT_ID}`)) {
    body = {
      id: CHAT_ID,
      title: "Rewrite the intro",
      model: null,
      version: 1,
      created_at: 1700000000000,
      updated_at: 1700000000000,
      archived_at: null,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    };
  } else if (path.includes("/api/v1/workspaces")) {
    body = [{ id: "ws-auto", name: "WS" }];
  } else if (path.includes("/api/v1/catalog/models")) {
    body = { data: [] };
  }
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
};

let ChatPage: (typeof import("../apps/web/src/pages/chat"))["ChatPage"];
let createRoot: (typeof import("react-dom/client"))["createRoot"];
type Root = import("react-dom/client").Root;
const roots: Root[] = [];
const realFetch = globalThis.fetch;
const flush = () => new Promise((r) => setTimeout(r, 0));
const SIDEBAR_PREF = "chat.sidebar.collapsed";
let prevPref: string | null = null;

beforeAll(async () => {
  prevPref = globalThis.localStorage?.getItem(SIDEBAR_PREF) ?? null;
  const win = new JSDOM("", { url: "http://localhost:5173", pretendToBeVisual: true })
    .window as unknown as Record<string, unknown>;
  for (const k of GLOBAL_KEYS) originals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  for (const k of GLOBAL_KEYS) (globalThis as Record<string, unknown>)[k] = win[k];
  const elProto = win.Element as typeof Element;
  elProto.prototype.scrollIntoView = () => {};
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (win as { matchMedia: unknown }).matchMedia = () => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  jsdomWindow = win as unknown as { close: () => void };
  globalThis.fetch = mockFetch as typeof fetch;
  sessionUserId = "u-auto"; // signed-in fixture for this file's tests only
  ({ createRoot } = await import("react-dom/client"));
  ({ ChatPage } = await import("../apps/web/src/pages/chat"));
});

afterAll(() => {
  globalThis.fetch = realFetch;
  sessionUserId = null; // restore the anonymous default for later files
  try {
    if (prevPref === null) globalThis.localStorage?.removeItem(SIDEBAR_PREF);
    else globalThis.localStorage?.setItem(SIDEBAR_PREF, prevPref);
  } catch {
    // Unavailable storage: nothing to restore.
  }
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  jsdomWindow?.close();
  jsdomWindow = null;
});

afterEach(async () => {
  for (const root of roots.splice(0)) root.unmount();
  await flush();
  document.body.innerHTML = "";
  globalThis.localStorage?.clear();
});

type EventCtor = new (type: string, init?: { bubbles?: boolean; cancelable?: boolean }) => Event;
const click = (el: Element) =>
  el.dispatchEvent(
    new (window as unknown as { MouseEvent: EventCtor }).MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    }),
  );

const aside = () => document.getElementById("chat-history-aside");
const toggle = () =>
  document.querySelector<HTMLButtonElement>('button[aria-controls="chat-history-aside"]');

async function mountPage(): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  roots.push(root);
  root.render(
    <QueryClientProvider client={qc}>
      <ChatPage />
    </QueryClientProvider>,
  );
  await flush();
  await flush();
}

/** Start with the sticky device pref explicitly collapsed. */
async function mountCollapsed(): Promise<void> {
  globalThis.localStorage?.setItem(SIDEBAR_PREF, "1");
  await mountPage();
  expect(aside()?.getAttribute("data-state")).toBe("collapsed");
}

test("starting a new chat from the collapsed rail expands the sidebar WITHOUT rewriting the pref", async () => {
  await mountCollapsed();
  // Collapsed rail keeps its own New chat affordance; the toolbar New chat
  // button is disabled on a fresh view, so target the rail's.
  const railNewChat = aside()!.querySelector<HTMLButtonElement>('button[aria-label="New chat"]');
  expect(railNewChat).not.toBeNull();
  click(railNewChat!);
  await flush();
  // Session expansion happened for this view…
  expect(aside()?.getAttribute("data-state")).toBe("expanded");
  // …but the sticky device pref was NOT rewritten: the user asked for a
  // collapsed default and a reload must return to it.
  expect(globalThis.localStorage?.getItem(SIDEBAR_PREF)).toBe("1");

  // Remount: the saved collapsed preference still wins.
  roots.splice(0).forEach((r) => r.unmount());
  await flush();
  document.body.innerHTML = "";
  await mountPage();
  expect(aside()?.getAttribute("data-state")).toBe("collapsed");
});

test("opening a saved conversation from history expands the sidebar WITHOUT rewriting the pref", async () => {
  await mountCollapsed();
  // With the desktop list collapsed, history is reachable through the
  // toolbar History control (the collapsed rail has no list). Open it.
  const historyButton = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Conversation history"]',
  );
  expect(historyButton).not.toBeNull();
  click(historyButton!);
  // Wait for the history list to load (needs session + workspace + list)
  // and for the Sheet to render its rows.
  let row: HTMLButtonElement | null = null;
  for (let i = 0; i < 300 && !row; i++) {
    await flush();
    row = document.body.querySelector<HTMLButtonElement>(
      'ul[aria-label="Conversations"] button',
    );
    // Only a conversation row (with a title), not the toggle or rail button.
    if (row && row.textContent?.includes("Rewrite the intro")) break;
    row = null;
  }
  expect(row).not.toBeNull();
  click(row!);
  await flush();
  await flush();
  // Opening a conversation is explicit intent: the desktop list expands…
  expect(aside()?.getAttribute("data-state")).toBe("expanded");
  // …and the view shows the loaded conversation.
  expect(document.body.textContent).toContain("hello");
  // Pref untouched.
  expect(globalThis.localStorage?.getItem(SIDEBAR_PREF)).toBe("1");
});

test("the explicit toggle still persists the pref both ways", async () => {
  await mountCollapsed();
  click(toggle()!);
  await flush();
  expect(aside()?.getAttribute("data-state")).toBe("expanded");
  expect(globalThis.localStorage?.getItem(SIDEBAR_PREF)).toBe("0");
  click(toggle()!);
  await flush();
  expect(aside()?.getAttribute("data-state")).toBe("collapsed");
  expect(globalThis.localStorage?.getItem(SIDEBAR_PREF)).toBe("1");
});
