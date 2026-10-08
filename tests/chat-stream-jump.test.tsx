// Jump-to-latest on the mounted chat page (jsdom + real React root):
// the button appears whenever the user reads older messages (static loaded
// history included, not just mid-stream), one user-triggered scroll re-engages
// follow only when the scroll arrives near the bottom, the layout-effect pin
// must not override the smooth animation while the user is away, and
// prefers-reduced-motion gets an instant pin instead of a smooth scroll.
// jsdom has no real layout: scroll geometry is simulated with explicit
// scrollHeight/clientHeight/scrollTop stubs (inputs only — no pixel or
// smoothness claims are made or testable here).
import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import { mock } from "bun:test";

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

// Controllable completions stream: tests enqueue deltas explicitly.
let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
const encoder = new TextEncoder();
const sseChunk = (content: string) =>
  encoder.encode(
    `data: {"model":"test/model","choices":[{"delta":{"content":${JSON.stringify(content)}}}]}\n\n`,
  );

const staticHistory = [
  { role: "user", content: "first question" },
  { role: "assistant", content: "first answer" },
  { role: "user", content: "second question" },
  { role: "assistant", content: "second answer" },
];

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const now = Date.now();
const snapshot = (id: string, version: number, messages: unknown[]) => ({
  id,
  title: "T",
  model: "test/model",
  version,
  created_at: now,
  updated_at: now,
  archived_at: null,
  messages,
});

const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const path = String(input);
  const method = init?.method ?? "GET";
  if (path === "/v1/chat/completions") {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          controller.enqueue(sseChunk("Hello"));
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }
  if (path === "/api/v1/workspaces/ws1/chat-key" && method === "POST")
    return Promise.resolve(
      jsonRes(200, { id: "k1", plaintext: "sk-hbr-TESTKEY123", name: "Chat", purpose: "chat" }),
    );
  if (path === "/api/v1/workspaces/ws1/chats/c1" && method === "GET")
    return Promise.resolve(jsonRes(200, snapshot("c1", 1, staticHistory)));
  if (/^\/api\/v1\/workspaces\/ws1\/chats\/[^/]+$/.test(path) && method === "PUT") {
    const body = JSON.parse(String(init?.body)) as { messages?: unknown[] };
    const chatId = path.split("/").at(-1)!;
    return Promise.resolve(jsonRes(200, snapshot(chatId, 99, body.messages ?? [])));
  }
  if (path === "/api/v1/workspaces/ws1/chats" && method === "POST")
    return Promise.resolve(jsonRes(201, snapshot("c2", 1, [])));
  if (path === "/api/v1/workspaces/ws1/chats" || path.startsWith("/api/v1/workspaces/ws1/chats?"))
    return Promise.resolve(
      jsonRes(200, {
        data: [
          {
            id: "c1",
            title: "T",
            model: "test/model",
            version: 1,
            created_at: now,
            updated_at: now,
          },
        ],
        nextCursor: null,
      }),
    );
  return Promise.resolve(jsonRes(200, {}));
};

mock.module("../apps/web/src/lib/auth", () => ({
  useSession: () => ({ data: { user: { id: "u1" } }, isPending: false }),
}));
mock.module("../apps/web/src/lib/workspace-queries", () => ({
  useCurrentWorkspaceId: () => "ws1",
}));
const catalogFixture = {
  models: [
    {
      id: "m1",
      publicId: "test/model",
      provider: "test",
      displayName: "Test Model",
      description: null,
      capabilities: ["vision"],
    },
  ],
  loading: false,
  error: null as string | null,
};
mock.module("../apps/web/src/pages/models/data", () => ({
  useCatalogModels: () => ({
    models: catalogFixture.models,
    loading: catalogFixture.loading,
    error: catalogFixture.error,
  }),
}));

let ChatPage: (typeof import("../apps/web/src/pages/chat"))["ChatPage"];
let clearManagedChatKey: (typeof import("../apps/web/src/pages/chat/managed-key"))["clearManagedChatKey"];
let createRoot: (typeof import("react-dom/client"))["createRoot"];
type Root = import("react-dom/client").Root;
const roots: Root[] = [];
const realFetch = globalThis.fetch;
let jsdomMatchMedia: typeof matchMedia | null = null;
const flush = () => new Promise((r) => setTimeout(r, 0));
// jsdom lacks the platform pieces Radix Select (popper) needs to open.
interface ProtoExtras {
  hasPointerCapture?: (id: number) => boolean;
  setPointerCapture?: (id: number) => void;
  releasePointerCapture?: (id: number) => void;
  scrollIntoView?: () => void;
}
let stubbedProto: (ProtoExtras & Record<string, unknown>) | null = null;
let resizeObserverCtor: unknown = undefined;

async function waitFor(cond: () => boolean, label: string, timeoutMs = 4000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs)
      throw new Error(
        `waitFor timeout: ${label} | BODY=${document.body.textContent?.slice(0, 300)}`,
      );
    await flush();
  }
}

// Simulated scroll geometry for the conversation log. scrollHeight and
// clientHeight are stubbed (jsdom has no layout); scrollTop is an instance
// accessor that RECORDS every write so tests can prove whether the layout
// effect pinned (instant follow) or stayed quiet (smooth scroll in flight).
const LOG_H = 3000;
const VIEW_H = 600;
type ScrollEl = HTMLDivElement & {
  __scrollTopWrites: number[];
};
function instrumentLog(): ScrollEl {
  const el = document.querySelector<HTMLDivElement>('[role="log"]')!;
  Object.defineProperty(el, "scrollHeight", { value: LOG_H, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: VIEW_H, configurable: true });
  const writes: number[] = [];
  let scrollTop = 0;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v;
      writes.push(v);
    },
  });
  (el as ScrollEl).__scrollTopWrites = writes;
  // jsdom has no Element.scrollTo; record calls instead of scrolling.
  (el as { scrollTo: unknown }).scrollTo = (opts: { top: number; behavior?: string }) => {
    scrollToCalls.push(opts);
  };
  return el as ScrollEl;
}
const scrollToCalls: Array<{ top: number; behavior?: string }> = [];
const fireScroll = (el: Element) =>
  el.dispatchEvent(new (window as unknown as { Event: new (t: string) => Event }).Event("scroll"));

const jumpButton = () =>
  document.querySelector<HTMLButtonElement>('button[aria-label="Jump to latest"]');

async function mountPage(): Promise<void> {
  clearManagedChatKey({ userId: "u1", workspaceId: "ws1" });
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
  await waitFor(
    () => (document.body.textContent ?? "").includes("What would you like to build?"),
    "page rendered",
  );
}

async function openStaticConversation(): Promise<ScrollEl> {
  await waitFor(
    () =>
      Array.from(document.querySelectorAll("button")).some((b) =>
        Array.from(b.querySelectorAll("span")).some((s) => s.textContent === "T"),
      ),
    "history row rendered",
  );
  const row = Array.from(document.querySelectorAll("button")).find((b) =>
    Array.from(b.querySelectorAll("span")).some((s) => s.textContent === "T"),
  );
  row!.dispatchEvent(
    new (window as unknown as { MouseEvent: new (t: string, i?: object) => Event }).MouseEvent(
      "click",
      {
        bubbles: true,
        cancelable: true,
      },
    ),
  );
  await waitFor(() => (document.body.textContent ?? "").includes("first answer"), "history loaded");
  return instrumentLog();
}

beforeAll(async () => {
  const win = new JSDOM("", { url: "http://localhost:5173", pretendToBeVisual: true })
    .window as unknown as Record<string, unknown>;
  for (const k of GLOBAL_KEYS) originals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  for (const k of GLOBAL_KEYS) (globalThis as Record<string, unknown>)[k] = win[k];
  jsdomWindow = win as unknown as { close: () => void };
  globalThis.fetch = mockFetch as typeof fetch;
  // Keep jsdom's own matchMedia around: the page reads window.matchMedia,
  // not globalThis.matchMedia, and tests override it per preference.
  jsdomMatchMedia = (win as { matchMedia: typeof matchMedia }).matchMedia;
  ({ createRoot } = await import("react-dom/client"));
  ({ ChatPage } = await import("../apps/web/src/pages/chat"));
  ({ clearManagedChatKey } = await import("../apps/web/src/pages/chat/managed-key"));
  // Radix Select needs pointer capture, scrollIntoView and ResizeObserver —
  // none implemented by jsdom. Stub only what is missing; restore in afterAll.
  stubbedProto = (win as { Element: { prototype: ProtoExtras & Record<string, unknown> } }).Element
    .prototype;
  for (const name of [
    "hasPointerCapture",
    "setPointerCapture",
    "releasePointerCapture",
    "scrollIntoView",
  ] as const) {
    if (typeof stubbedProto[name] !== "function") {
      (stubbedProto as Record<string, unknown>)[name] =
        name === "hasPointerCapture" ? () => false : () => {};
    } else {
      stubbedProto = null; // everything present: nothing stubbed
      break;
    }
  }
  const g = globalThis as Record<string, unknown>;
  if (typeof g.ResizeObserver !== "function") {
    resizeObserverCtor = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    g.ResizeObserver = resizeObserverCtor;
  }
});

afterAll(() => {
  globalThis.fetch = realFetch;
  if (stubbedProto) {
    for (const name of [
      "hasPointerCapture",
      "setPointerCapture",
      "releasePointerCapture",
      "scrollIntoView",
    ] as const)
      delete stubbedProto[name];
  }
  if (resizeObserverCtor) delete (globalThis as Record<string, unknown>).ResizeObserver;
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
  streamController = null;
  scrollToCalls.length = 0;
  if (jsdomMatchMedia) (window as { matchMedia: typeof matchMedia }).matchMedia = jsdomMatchMedia;
});

test("opened conversation shows no jump button while following at the bottom", async () => {
  await mountPage();
  const el = await openStaticConversation();
  expect(jumpButton()).toBeNull();
  // Scroll event at the bottom: still following, button stays hidden.
  el.scrollTop = LOG_H;
  fireScroll(el);
  await flush();
  expect(jumpButton()).toBeNull();
});

test("reading older static history shows Jump to latest; one smooth scroll re-engages follow only on arrival", async () => {
  await mountPage();
  const el = await openStaticConversation();

  // User scrolls up to read older messages (static history, not streaming).
  el.scrollTop = 0;
  fireScroll(el);
  el.__scrollTopWrites.length = 0;
  await waitFor(() => jumpButton() !== null, "jump button appears when away");

  // Click: exactly ONE user-triggered smooth scroll, no instant pin.
  jumpButton()!.dispatchEvent(
    new (window as unknown as { MouseEvent: new (t: string, i?: object) => Event }).MouseEvent(
      "click",
      {
        bubbles: true,
        cancelable: true,
      },
    ),
  );
  await flush();
  await flush();
  expect(scrollToCalls).toEqual([{ top: LOG_H, behavior: "smooth" }]);
  expect(el.__scrollTopWrites).toEqual([]);
  // Still away: the button stays until the scroll actually arrives.
  expect(jumpButton()).not.toBeNull();

  // The scroll arrives near the bottom: the onScroll latch re-engages follow
  // and the button disappears. No layout-effect override happened meanwhile.
  el.scrollTop = LOG_H;
  fireScroll(el);
  await waitFor(() => jumpButton() === null, "jump button hides on arrival");
});

test("prefers-reduced-motion: jump pins instantly instead of smooth scrolling", async () => {
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
  });
  await mountPage();
  const el = await openStaticConversation();
  el.scrollTop = 0;
  fireScroll(el);
  el.__scrollTopWrites.length = 0;
  await waitFor(() => jumpButton() !== null, "jump button appears when away");

  jumpButton()!.dispatchEvent(
    new (window as unknown as { MouseEvent: new (t: string, i?: object) => Event }).MouseEvent(
      "click",
      {
        bubbles: true,
        cancelable: true,
      },
    ),
  );
  await flush();
  // Instant pin, no smooth scroll call.
  expect(el.__scrollTopWrites).toEqual([LOG_H]);
  expect(scrollToCalls).toEqual([]);
  // jsdom does not fire scroll events for programmatic scrollTop writes; the
  // real browser re-engages follow via the onScroll latch on that event.
  fireScroll(el);
  await waitFor(() => jumpButton() === null, "follow re-engaged instantly");
});

test("while streaming and reading older messages, new chunks never pin over the smooth scroll", async () => {
  await mountPage();
  await openStaticConversation();
  // Start a send: user bubble + streaming assistant appear.
  const ta = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), "value")!.set!.call(ta, "hello");
  ta.dispatchEvent(
    new (window as unknown as { Event: new (t: string, i?: object) => Event }).Event("input", {
      bubbles: true,
    }),
  );
  await flush();
  const sendBtn = document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;
  sendBtn.dispatchEvent(
    new (window as unknown as { MouseEvent: new (t: string, i?: object) => Event }).MouseEvent(
      "click",
      {
        bubbles: true,
        cancelable: true,
      },
    ),
  );
  await waitFor(() => (document.body.textContent ?? "").includes("hello"), "user bubble rendered");
  await waitFor(() => (document.body.textContent ?? "").includes("Hello"), "first delta rendered");
  // Geometry moved to the NEW element (fresh log after messages render).
  const live = instrumentLog();
  live.__scrollTopWrites.length = 0;

  // User scrolls away mid-stream.
  live.scrollTop = 0;
  fireScroll(live);
  live.__scrollTopWrites.length = 0;
  await waitFor(() => jumpButton() !== null, "jump button appears mid-stream");

  // Another stream chunk arrives while away: the layout effect must NOT pin.
  streamController?.enqueue(sseChunk(" more"));
  await waitFor(
    () => (document.body.textContent ?? "").includes("Hello more"),
    "second delta rendered",
  );
  expect(live.__scrollTopWrites).toEqual([]);
  expect(jumpButton()).not.toBeNull();

  streamController?.close();
  await flush();
});

test("model picker shows server-published capabilities inline; the trigger shows the name only", async () => {
  await mountPage();
  const trigger = document.querySelector<HTMLButtonElement>("#chat-model")!;
  const WinCtors = window as unknown as {
    PointerEvent: new (
      t: string,
      i?: { bubbles?: boolean; button?: number; pointerId?: number; pointerType?: string },
    ) => Event;
  };
  trigger.dispatchEvent(
    new WinCtors.PointerEvent("pointerdown", {
      bubbles: true,
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
    }),
  );
  await waitFor(
    () => document.querySelector('[role="option"]') !== null,
    "select options rendered",
  );
  const option = document.querySelector('[role="option"]')!;
  // Capability metadata renders via the shared label helper: the known key
  // "vision" gets its localized EN label; unknown keys would stay verbatim.
  expect(option.textContent).toContain("Test Model");
  expect(option.textContent).toContain("Vision");
  // The trigger reflects the selected NAME, never the capability hint.
  expect(trigger.textContent).not.toContain("Vision");
}, 8000);
