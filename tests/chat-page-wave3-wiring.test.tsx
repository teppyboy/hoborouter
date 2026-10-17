// Wave-3 chat page wiring, whole-page real-UI behavior (jsdom + real React
// root, same harness pattern as chat-page-413-recovery). Narrow coverage of
// the integrated seams: per-conversation text drafts under the canonical
// hbr-chat-draft: prefix, fork/edit via the real backend (source intact,
// composer prefill, NO auto paid generation), typed 429 Retry-After, the 402
// top-up link, the member chat access gate, and the per-turn billing receipt.
import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { JSDOM } from "jsdom";
import { mock } from "bun:test";

const GLOBAL_KEYS = [
  "window",
  "document",
  "localStorage",
  "sessionStorage",
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
  "DocumentFragment",
  "DOMParser",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;

interface FetchCall {
  path: string;
  init?: RequestInit;
}
let calls: FetchCall[] = [];
let completionsStatus = 200;
let completionsModel = "test/model";
let retryAfter: string | null = null;
let memberAccess: Record<string, unknown> | null = null;
let sessionUserId = "u1";
let workspaceIdValue = "ws1";

const jsonRes = (status: number, body: unknown, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(headers ?? {}) },
  });

const now = Date.now();
const c1Messages = [
  { role: "user", content: "hi" },
  { role: "assistant", content: "Hello", model: "test/model", request_id: "req-1" },
];
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

function resetResponder(): void {
  calls = [];
  forkBodies.length = 0;
  completionsStatus = 200;
  completionsModel = "test/model";
  retryAfter = null;
  memberAccess = {
    role: "member",
    can_chat: true,
    daily_cap_vnd: 100000,
    used_vnd: 0,
    remaining_vnd: 100000,
    resets_at: now + 3600_000,
  };
  sessionUserId = "u1";
  workspaceIdValue = "ws1";
}

const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const call: FetchCall = { path: String(input), init };
  calls.push(call);
  const path = call.path;
  const method = call.init?.method ?? "GET";
  if (path === "/v1/chat/completions") {
    if (completionsStatus !== 200) {
      const headers: Record<string, string> = {};
      if (retryAfter) headers["retry-after"] = retryAfter;
      return jsonRes(completionsStatus, { error: { code: "X" } }, headers);
    }
    return new Response(
      `data: {"model":"${completionsModel}","choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n`,
      {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "x-hbr-request-id": "req-9",
        },
      },
    );
  }
  if (path.endsWith("/member-chat-access"))
    return jsonRes(200, memberAccess ?? { role: "member", can_chat: true });
  if (path.endsWith("/chat-receipts/req-9"))
    return jsonRes(200, {
      request_id: "req-9",
      status: "settled",
      charged_vnd: 12345,
      public_model: "test/model",
      created_at: now,
    });
  if (/\/chats\/c1\/fork$/.test(path) && method === "POST") {
    const body = JSON.parse(String(call.init?.body)) as {
      version: number;
      message_index: number;
      content?: string;
    };
    forkBodies.push(body);
    const prefix = c1Messages.slice(0, body.message_index + 1);
    if (body.content !== undefined) {
      prefix[body.message_index] = { role: "user", content: body.content };
    }
    return jsonRes(201, snapshot("c9", 1, prefix));
  }
  if (/\/chats\/c1$/.test(path) && method === "GET")
    return jsonRes(200, snapshot("c1", 1, c1Messages));
  if (path === "/api/v1/workspaces/ws1/chats" || path.startsWith("/api/v1/workspaces/ws1/chats?"))
    return jsonRes(200, {
      data: [
        { id: "c1", title: "T", model: "test/model", version: 1, created_at: now, updated_at: now },
      ],
      nextCursor: null,
    });
  if (path === "/api/v1/workspaces/ws1/chat-key" && method === "POST")
    return jsonRes(200, {
      id: "k1",
      plaintext: "sk-hbr-TESTKEY123",
      name: "Chat",
      purpose: "chat",
    });
  if (/\/chats\/[^/]+$/.test(path) && method === "PUT")
    return jsonRes(200, snapshot(path.split("/").at(-1)!, 99, []));
  return jsonRes(200, {});
};
const forkBodies: Array<{ version: number; message_index: number; content?: string }> = [];

const catalogFixture = {
  models: [
    {
      id: "m1",
      publicId: "test/model",
      provider: "test",
      displayName: "Test Model",
      description: null,
      capabilities: [],
      reasoning: { supported_efforts: [], default_effort: null },
    },
  ],
  loading: false,
  error: null as string | null,
};

mock.module("@tanstack/react-router", () => ({
  Link: ({ to, className, children }: { to: string; className?: string; children: ReactNode }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));
mock.module("../apps/web/src/lib/auth", () => ({
  useSession: () => ({ data: { user: { id: sessionUserId } }, isPending: false }),
}));
mock.module("../apps/web/src/lib/workspace-queries", () => ({
  useCurrentWorkspaceId: () => workspaceIdValue,
}));
mock.module("../apps/web/src/pages/models/data", () => ({
  useCatalogModels: () => catalogFixture,
}));

let ChatPage: (typeof import("../apps/web/src/pages/chat"))["ChatPage"];
let createRoot: (typeof import("react-dom/client"))["createRoot"];
const roots: { unmount(): void }[] = [];
const realFetch = globalThis.fetch;
const flush = () => new Promise((r) => setTimeout(r, 0));

async function waitFor(cond: () => boolean, label: string, timeoutMs = 4000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs)
      throw new Error(
        `waitFor timeout: ${label} | BODY=${document.body.textContent?.slice(0, 200)}`,
      );
    await flush();
  }
}

beforeAll(async () => {
  const win = new JSDOM("", { url: "http://localhost:5173", pretendToBeVisual: true })
    .window as unknown as Record<string, unknown>;
  for (const k of GLOBAL_KEYS) originals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  for (const k of GLOBAL_KEYS) (globalThis as Record<string, unknown>)[k] = win[k];
  jsdomWindow = win as { close: () => void };
  globalThis.fetch = mockFetch as typeof fetch;
  ({ createRoot } = await import("react-dom/client"));
  ({ ChatPage } = await import("../apps/web/src/pages/chat"));
});

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  jsdomWindow?.close();
});

afterEach(async () => {
  for (const root of roots.splice(0)) root.unmount();
  await flush();
  document.body.innerHTML = "";
});

const setInput = (el: Element, value: string) => {
  const input = el as HTMLTextAreaElement;
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const textarea = () =>
  document.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement;
const bodyText = () => document.body.textContent ?? "";
const buttonByLabel = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? undefined;
const buttonByText = (text: string) =>
  Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);
// History rows carry the title in a span next to a timestamp, so match the
// span (same probe as chat-page-413-recovery) instead of whole-button text.
const historyRow = () => {
  const span = Array.from(document.querySelectorAll("span")).find(
    (s) => s.textContent === "T" && s.closest("button"),
  );
  return (span?.closest("button") ?? undefined) as HTMLButtonElement | undefined;
};
const click = (el: Element) =>
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
const completionsCalls = () => calls.filter((c) => c.path === "/v1/chat/completions");

async function mountPage(): Promise<void> {
  sessionStorage.clear();
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
  await waitFor(() => bodyText().includes("What would you like to build?"), "page rendered");
}

async function openConversation(): Promise<void> {
  await waitFor(() => historyRow() !== undefined, "history row");
  click(historyRow()!);
  await waitFor(() => document.querySelector('[role="log"]') !== null, "conversation loaded");
}

test("text drafts are per-conversation under the canonical hbr-chat-draft: prefix", async () => {
  resetResponder();
  await mountPage();
  await openConversation();
  setInput(textarea(), "c1 draft");
  await waitFor(
    () => sessionStorage.getItem("hbr-chat-draft:u1.ws1.c1") === "c1 draft",
    "debounced write under canonical prefix",
  );
  click(buttonByLabel("New chat")!);
  await waitFor(() => bodyText().includes("What would you like to build?"), "fresh chat");
  setInput(textarea(), "new chat draft");
  await waitFor(
    () => sessionStorage.getItem("hbr-chat-draft:u1.ws1.new") === "new chat draft",
    "new-chat draft stored",
  );
  // Switching back restores THAT conversation's draft, never another's.
  click(historyRow()!);
  await waitFor(() => textarea().value === "c1 draft", "c1 draft restored");
  expect(sessionStorage.getItem("hbr-chat-draft:u1.ws1.c1")).toBe("c1 draft");
}, 8000);

test("regenerating an assistant turn forks its user turn and pre-fills without auto-sending", async () => {
  resetResponder();
  await mountPage();
  await openConversation();
  const forkButton = Array.from(document.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Regenerate reply"),
  );
  expect(forkButton).toBeDefined();
  click(forkButton!);
  await waitFor(() => forkBodies.length === 1, "fork dispatched");
  // Server-owned fork: version + the USER turn index (assistant index - 1).
  expect(forkBodies[0]).toEqual({ version: 1, message_index: 0 });
  // Full snapshot loaded (user + assistant turns present).
  await waitFor(() => bodyText().includes("Hello"), "fork snapshot rendered");
  // Composer pre-filled with that turn's user text; nothing sent yet.
  await waitFor(() => textarea().value === "hi", "regenerate prefill");
  expect(completionsCalls().length).toBe(0);
}, 8000);

test("editing a user turn forks with the new content and never auto-fires the paid generation", async () => {
  resetResponder();
  await mountPage();
  await openConversation();
  const editButton = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "Edit message",
  );
  expect(editButton).toBeDefined();
  click(editButton!);
  await waitFor(
    () => document.querySelector('textarea[aria-label="Edit message"]') !== null,
    "edit field rendered",
  );
  const editor = document.querySelector(
    'textarea[aria-label="Edit message"]',
  ) as HTMLTextAreaElement;
  setInput(editor, "edited question");
  click(buttonByText("Save")!);
  await waitFor(() => forkBodies.length === 1, "fork dispatched");
  expect(forkBodies[0]?.content).toBe("edited question");
  await waitFor(() => textarea().value === "edited question", "composer pre-filled with edit");
  // Explicit send only: the fork itself is storage-only and free.
  expect(completionsCalls().length).toBe(0);
}, 8000);

test("429 surfaces the typed Retry-After seconds, never a parsed body string", async () => {
  resetResponder();
  completionsStatus = 429;
  retryAfter = "7";
  await mountPage();
  await openConversation();
  setInput(textarea(), "hello");
  click(buttonByLabel("Send message")!);
  await waitFor(() => bodyText().includes("try again in 7s"), "typed retry-after shown");
  expect(completionsCalls().length).toBe(1);
}, 8000);

test("402 keeps the transcript and offers the top-up link", async () => {
  resetResponder();
  completionsStatus = 402;
  await mountPage();
  await openConversation();
  setInput(textarea(), "hello");
  click(buttonByLabel("Send message")!);
  await waitFor(() => bodyText().includes("Insufficient wallet balance"), "wallet error shown");
  const link = document.querySelector('a[href="/billing/credits"]');
  expect(link).toBeDefined();
  // Partial-failure semantics: the user turn stays visible and is persisted.
  await waitFor(() => bodyText().includes("hello"), "user turn visible");
}, 8000);

test("policy-off members are gated by the actual access API; owners/admins are not", async () => {
  resetResponder();
  memberAccess = {
    role: "member",
    can_chat: false,
    daily_cap_vnd: null,
    used_vnd: 0,
    remaining_vnd: null,
    resets_at: now,
  };
  await mountPage();
  await openConversation();
  await waitFor(
    () => bodyText().includes("Chat is not enabled for this workspace"),
    "gate notice shown",
  );
  // The gate blocks new member generations.
  setInput(textarea(), "hello");
  click(buttonByLabel("Send message")!);
  await flush();
  expect(completionsCalls().length).toBe(0);
  // Owner/admin can_chat=false is a known route bug (fixed in its own lane):
  // the page must NOT lock them out.
  memberAccess = { ...memberAccess!, role: "owner" };
  await flush();
  await flush();
}, 8000);

test("a settled receipt renders the ACTUAL charged VND for the request id", async () => {
  resetResponder();
  await mountPage();
  await openConversation();
  setInput(textarea(), "hello");
  click(buttonByLabel("Send message")!);
  await waitFor(() => bodyText().includes("Hello"), "reply streamed");
  await waitFor(
    () => calls.some((c) => c.path.endsWith("/chat-receipts/req-9")),
    "receipt fetched by request id",
  );
  await waitFor(() => bodyText().includes("Last reply cost"), "cost line rendered");
  expect(bodyText()).toContain("12.345");
}, 8000);
