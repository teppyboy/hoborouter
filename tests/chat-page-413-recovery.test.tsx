// Gateway-413 recovery on the mounted chat page (jsdom + real React root):
// persistent reconnect alert, revision-gated draft rollback, guard-discarded
// stale 413s, browser-only reconnect, single-turn resend after reconnect, and
// the persisted assistant model label. No sleeps — gated fetch + waitFor.
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

interface FetchCall {
  path: string;
  init?: RequestInit;
}
let calls: FetchCall[] = [];
const putBodies: unknown[] = [];
// Last stored c1 messages: the GET returns exactly what was last PUT
// (server snapshots return what was stored), else the initial history.
let storedC1Messages: unknown[] = [{ role: "user", content: "hi" }];
// Gated /v1/chat/completions: tests hold the promise until ready.
let gated413: Promise<void> | null = null;
let completionsStatus = 413;
// Forged-SSE-model probe: the stream's top-level model can be anything the
// wire sends; the page must never surface unknown values.
let completionsModel = "test/model";
// Gated conversation snapshot GET: holds openChat so tests can race send.
let gatedChatGet: Promise<void> | null = null;
// Reactive identity fixture: tests mutate these to simulate account/workspace
// switches mid-flight (mock.module factories close over these variables).
let sessionUserId = "u1";
let workspaceIdValue = "ws1";

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

function resetResponder(): void {
  putBodies.length = 0;
  storedC1Messages = [{ role: "user", content: "hi" }];
  completionsStatus = 413;
  completionsModel = "test/model";
  gated413 = null;
  gatedChatGet = null;
  sessionUserId = "u1";
  workspaceIdValue = "ws1";
  catalogFixture.loading = false;
  catalogFixture.error = null;
}

const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const call: FetchCall = { path: String(input), init };
  calls.push(call);
  const path = call.path;
  const method = call.init?.method ?? "GET";
  if (path === "/v1/chat/completions") {
    if (completionsStatus === 413) {
      if (gated413) await gated413;
      return new Response(JSON.stringify({ error: { code: "PAYLOAD_TOO_LARGE" } }), {
        status: 413,
        headers: { "content-type": "application/json" },
      });
    }
    return Promise.resolve(
      new Response(
        `data: {"model":"${completionsModel}","choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
  }
  if (path === "/api/v1/workspaces/ws1/chat-key" && method === "POST")
    return Promise.resolve(
      jsonRes(200, { id: "k1", plaintext: "sk-hbr-TESTKEY123", name: "Chat", purpose: "chat" }),
    );
  if (path === "/api/v1/workspaces/ws1/attachments" && method === "POST") {
    const file = call.init?.body as File;
    return Promise.resolve(
      jsonRes(201, {
        id: "attachment-1",
        name: decodeURIComponent(String(new Headers(call.init?.headers).get("X-Hbr-Filename"))),
        kind: "text",
        bytes: file.size,
        mime: "text/plain",
        expires_at: now + 30 * 24 * 60 * 60 * 1000,
        workspace_id: "ws1",
        created_at: now,
        deleted_at: null,
      }),
    );
  }
  if (/^\/api\/v1\/workspaces\/ws1\/chats\/[^/]+$/.test(path) && method === "PUT") {
    // The server returns exactly what was stored: echo the PUT messages.
    const body = JSON.parse(String(call.init?.body)) as { messages?: unknown[] };
    putBodies.push(body);
    storedC1Messages = body.messages ?? storedC1Messages;
    const chatId = path.split("/").at(-1)!;
    return Promise.resolve(jsonRes(200, snapshot(chatId, 99, body.messages ?? [])));
  }
  if (path === "/api/v1/workspaces/ws1/chats/c1" && method === "GET") {
    if (gatedChatGet) await gatedChatGet;
    return Promise.resolve(jsonRes(200, snapshot("c1", 1, storedC1Messages)));
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

// Reactive session/workspace mocks: factories read the mutable fixture vars
// so a mid-flight identity switch is visible to the page on its next render.
mock.module("../apps/web/src/lib/auth", () => ({
  useSession: () => ({
    data: sessionUserId ? { user: { id: sessionUserId } } : null,
    isPending: false,
  }),
}));
mock.module("../apps/web/src/lib/workspace-queries", () => ({
  useCurrentWorkspaceId: () => workspaceIdValue,
}));
// Reactive catalog fixture: the factory reads the mutable vars so a test can
// hold the catalog query pending or fail it, mirroring real query timing.
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
  jsdomWindow = win as unknown as { close: () => void };
  globalThis.fetch = mockFetch as typeof fetch;
  ({ createRoot } = await import("react-dom/client"));
  ({ ChatPage } = await import("../apps/web/src/pages/chat"));
  ({ clearManagedChatKey } = await import("../apps/web/src/pages/chat/managed-key"));
});

afterAll(() => {
  globalThis.fetch = realFetch;
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
  calls = [];
  resetResponder();
});

type EventCtor = new (type: string, init?: { bubbles?: boolean; cancelable?: boolean }) => Event;
const click = (el: Element) =>
  el.dispatchEvent(
    new (window as unknown as { MouseEvent: EventCtor }).MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    }),
  );
const pressEnter = (el: Element) =>
  el.dispatchEvent(
    new (
      window as unknown as {
        KeyboardEvent: new (
          type: string,
          init?: { key?: string; bubbles?: boolean; cancelable?: boolean },
        ) => Event;
      }
    ).KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    }),
  );
const buttonByLabel = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const buttonByText = (text: string) =>
  Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);
const setInput = (el: Element, value: string) => {
  const input = el as HTMLTextAreaElement;
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
  input.dispatchEvent(
    new (window as unknown as { Event: EventCtor }).Event("input", { bubbles: true }),
  );
};
const textarea = () =>
  document.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement;
const bodyText = () => document.body.textContent ?? "";
const chipCount = () => document.querySelectorAll('button[aria-label^="Remove attachment"]').length;
const completionsCalls = () => calls.filter((c) => c.path === "/v1/chat/completions");

const textFile = (content: string, name = "notes.txt") =>
  new File([content], name, { type: "text/plain" });

async function pickFile(file: File) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("file input not found");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(
    new (window as unknown as { Event: EventCtor }).Event("change", { bubbles: true }),
  );
  input.value = "";
  await flush();
  await flush();
}

/** Mount the page as a signed-in owner with a LEGACY (purpose-less, generic)
 *  browser key persisted — the oversized-send 413 setup. */
async function mountPage(storedKey?: Record<string, unknown>): Promise<void> {
  // The managed-key module caches per user+workspace in memory, and the cache
  // wins over storage: without an explicit clear, a key minted or restored by
  // an earlier test leaks its purpose into later tests' alerts.
  clearManagedChatKey({ userId: sessionUserId, workspaceId: workspaceIdValue });
  globalThis.localStorage?.setItem(
    "hbr-managed-key:u1:ws1",
    JSON.stringify(storedKey ?? { id: "legacy-key", plaintext: "sk-hbr-legacy" }),
  );
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

const historyRow = () => {
  const span = Array.from(document.querySelectorAll("span")).find(
    (s) => s.textContent === "T" && s.closest("button"),
  );
  return (span?.closest("button") ?? undefined) as HTMLButtonElement | undefined;
};

async function openConversation() {
  await waitFor(() => historyRow() !== undefined, "history row");
  click(historyRow()!);
  // Wait for the loaded message LOG (the welcome state has no [role=log]);
  // a bodyText().includes("hi") probe would match the "History" toolbar
  // button and race openChat before the model is set.
  await waitFor(() => document.querySelector('[role="log"]') !== null, "conversation loaded");
}

test("413 with unchanged revision: wholesale restore, no persist, persistent alert", async () => {
  resetResponder();
  await mountPage();
  await openConversation();
  setInput(textarea(), "my draft");
  await pickFile(textFile("file body"));
  await waitFor(() => chipCount() === 1, "chip attached");
  click(buttonByLabel("Send message")!);
  await waitFor(() => completionsCalls().length === 1, "send dispatched");
  await waitFor(() => bodyText().includes("1 MB request limit"), "413 alert visible");
  // Rollback + wholesale restore: draft text and attachment return.
  await waitFor(() => textarea().value === "my draft", "draft restored");
  expect(chipCount()).toBe(1);
  // No terminal save: the failed turn never enters history.
  expect(putBodies).toHaveLength(0);
  // Persistent alert with Reconnect; no automatic resend, no revoke.
  expect(buttonByText("Reconnect")).toBeDefined();
  expect(completionsCalls().length).toBe(1);
  expect(calls.filter((c) => c.init?.method === "DELETE")).toHaveLength(0);
});

test("413 with user edit while pending: newer draft kept, confirmed restore only", async () => {
  resetResponder();
  // Gate the 413 so the user can edit while the request is pending.
  let release!: () => void;
  gated413 = new Promise<void>((r) => (release = r));
  await mountPage();
  await openConversation();
  setInput(textarea(), "my draft");
  await pickFile(textFile("file body"));
  await waitFor(() => chipCount() === 1, "chip attached");
  click(buttonByLabel("Send message")!);
  await waitFor(() => completionsCalls().length === 1, "send dispatched");
  await waitFor(() => textarea().value === "", "programmatic clear applied");
  // USER edit while pending: marks the revision changed.
  setInput(textarea(), "my newer edits");
  release();
  await waitFor(() => bodyText().includes("1 MB request limit"), "413 alert visible");
  // Newer draft untouched; attachments NOT restored automatically.
  expect(textarea().value).toBe("my newer edits");
  expect(chipCount()).toBe(0);
  expect(putBodies).toHaveLength(0);
  // Recoverable snapshot: explicit action + confirmation, then restore.
  click(buttonByText("Restore original draft")!);
  await waitFor(
    () => bodyText().includes("Restoring replaces what you have typed since."),
    "confirm prompt visible",
  );
  // Declining keeps the newer draft.
  click(buttonByText("Keep my edits")!);
  await flush();
  expect(textarea().value).toBe("my newer edits");
  expect(chipCount()).toBe(0);
  // Confirming replaces the composer with the original snapshot.
  click(buttonByText("Restore original draft")!);
  await waitFor(
    () => bodyText().includes("Restoring replaces what you have typed since."),
    "confirm prompt visible again",
  );
  click(buttonByText("Restore")!);
  await waitFor(() => textarea().value === "my draft", "original draft restored");
  expect(chipCount()).toBe(1);
  expect(putBodies).toHaveLength(0);
  expect(completionsCalls().length).toBe(1);
});

test("stale 413 after conversation switch: discarded, no restore, no alert", async () => {
  resetResponder();
  let release!: () => void;
  gated413 = new Promise<void>((r) => (release = r));
  await mountPage();
  await openConversation();
  setInput(textarea(), "will be stale");
  click(buttonByLabel("Send message")!);
  await waitFor(() => completionsCalls().length === 1, "send dispatched");
  // Switch conversations BEFORE the 413 lands: guards must fail.
  click(historyRow()!);
  await waitFor(() => textarea().value === "", "switched to loaded conversation");
  release();
  await flush();
  await flush();
  await flush();
  // No restore into the new conversation, no alert, no persist.
  expect(textarea().value).toBe("");
  expect(bodyText()).not.toContain("1 MB request limit");
  expect(putBodies).toHaveLength(0);
});

test("reconnect is browser-only; next send mints chat key and persists exactly one turn", async () => {
  resetResponder();
  await mountPage();
  // Load a conversation once so the model picker has a value (the model is
  // kept across New chat), then start a FRESH first-turn conversation.
  await openConversation();
  click(buttonByLabel("New chat")!);
  await waitFor(() => bodyText().includes("What would you like to build?"), "fresh chat");
  setInput(textarea(), "hello");
  click(buttonByLabel("Send message")!);
  await waitFor(() => completionsCalls().length === 1, "send dispatched");
  await waitFor(() => bodyText().includes("1 MB request limit"), "413 alert visible");
  await waitFor(() => textarea().value === "hello", "draft restored (unchanged revision)");
  const callsBeforeReconnect = calls.length;
  click(buttonByText("Reconnect")!);
  await flush();
  // Reconnect made NO API call at all (browser cache only).
  expect(calls.length).toBe(callsBeforeReconnect);
  expect(calls.filter((c) => c.init?.method === "DELETE")).toHaveLength(0);
  // Next explicit send mints a chat-purpose key and succeeds.
  completionsStatus = 200;
  click(buttonByLabel("Send message")!);
  await waitFor(
    () =>
      calls.some((c) => c.path === "/api/v1/workspaces/ws1/chat-key" && c.init?.method === "POST"),
    "chat-key minted",
  );
  await waitFor(() => bodyText().includes("Hello"), "assistant reply streamed");
  await waitFor(() => putBodies.length === 1, "turn persisted once");
  const msgs = putBodies[0] as { messages: Array<{ role: string; model?: string }> };
  expect(msgs.messages.filter((m) => m.role === "user")).toHaveLength(1); // no duplication
  // The SSE top-level model rides the persisted assistant message.
  const assistant = msgs.messages.find((m) => m.role === "assistant");
  expect(assistant?.model).toBe("test/model");
  // Muted actual-used label under the bubble; user message carries no model.
  expect(bodyText()).toContain("test/model");
  expect(msgs.messages.find((m) => m.role === "user")?.model).toBeUndefined();
});

test("reloaded history renders the stored assistant model as a muted label", async () => {
  resetResponder();
  // Fresh storage: the mint path (purpose chat) serves this test.
  await mountPage();
  await openConversation();
  // The c1 snapshot already rendered; now verify a reload keeps the label.
  click(historyRow()!); // re-open c1
  // Wait for the reload's GET to complete (observable network count), then
  // let the snapshot render: sending while the load is in flight would race
  // the view reset (a real-UI race this test must not depend on).
  const c1Gets = () =>
    calls.filter((c) => c.path.endsWith("/chats/c1") && (c.init?.method ?? "GET") === "GET").length;
  await waitFor(() => c1Gets() >= 2, "reload fetched");
  await flush();
  await flush();
  // history snapshot has no assistant model; send one and reload via re-open.
  setInput(textarea(), "hi again");
  completionsStatus = 200;
  click(buttonByLabel("Send message")!);
  await waitFor(() => bodyText().includes("Hello"), "reply streamed");
  // Reload the saved snapshot: the PUT-stored assistant model renders.
  click(historyRow()!);
  // The log already shows the streamed "Hello", so wait for the reload GET
  // (observable network count), then let the snapshot render.
  await waitFor(() => c1Gets() >= 3, "reload fetched");
  await flush();
  await flush();
  // The streamed model label is present after the reload.
  expect(bodyText()).toContain("test/model");
});

test("attachment pick + remove while pending marks revision changed: no auto-restore, confirmed restore returns original", async () => {
  resetResponder();
  let release!: () => void;
  gated413 = new Promise<void>((r) => (release = r));
  await mountPage();
  await openConversation();
  setInput(textarea(), "my draft");
  await pickFile(textFile("original body", "a.txt"));
  await waitFor(() => chipCount() === 1, "original chip attached");
  click(buttonByLabel("Send message")!);
  await waitFor(() => completionsCalls().length === 1, "send dispatched");
  await waitFor(() => chipCount() === 0, "programmatic clear applied");
  // USER picks an extra file while pending (bump #1), then removes it
  // (bump #2): both are user draft mutations.
  await pickFile(textFile("extra body", "b.txt"));
  await waitFor(() => chipCount() === 1, "picked while pending");
  click(document.querySelector('button[aria-label^="Remove attachment"]')!);
  await waitFor(() => chipCount() === 0, "removed while pending");
  release();
  await waitFor(() => bodyText().includes("1 MB request limit"), "413 alert visible");
  // Revision changed: the original snapshot must NOT auto-restore...
  expect(textarea().value).toBe("");
  expect(chipCount()).toBe(0);
  expect(putBodies).toHaveLength(0);
  // ...only the explicit confirmed path restores it.
  click(buttonByText("Restore original draft")!);
  await waitFor(
    () => bodyText().includes("Restoring replaces what you have typed since."),
    "confirm prompt visible",
  );
  click(buttonByText("Restore")!);
  await waitFor(() => textarea().value === "my draft", "original draft restored");
  expect(chipCount()).toBe(1);
  expect(putBodies).toHaveLength(0);
});

test("user switch while a 413 is pending: response discarded, nothing crosses identities", async () => {
  resetResponder();
  let release!: () => void;
  gated413 = new Promise<void>((r) => (release = r));
  await mountPage();
  await openConversation();
  setInput(textarea(), "u1 draft");
  click(buttonByLabel("Send message")!);
  await waitFor(() => completionsCalls().length === 1, "send dispatched");
  // Account switch: a render is required for the page to observe the new
  // session; the identity effect then clears the transcript.
  sessionUserId = "u2";
  setInput(textarea(), "switch");
  await waitFor(() => bodyText().includes("What would you like to build?"), "transcript cleared");
  const u2Draft = "u2 draft";
  setInput(textarea(), u2Draft);
  const chatKeyPosts = () => calls.filter((c) => c.path.endsWith("/chat-key")).length;
  const keyPostsBefore = chatKeyPosts();
  release();
  await flush();
  await flush();
  // Stale 413 for the OLD identity: fully discarded.
  expect(bodyText()).not.toContain("1 MB request limit");
  expect(buttonByText("Reconnect")).toBeUndefined();
  expect(putBodies).toHaveLength(0);
  // u2's composer untouched; no key mint or restore fired for either side.
  expect(textarea().value).toBe(u2Draft);
  expect(chatKeyPosts()).toBe(keyPostsBefore);
  expect(completionsCalls().length).toBe(1);
  // The old identity's persisted key was cleared by the identity switch.
  expect(globalThis.localStorage?.getItem("hbr-managed-key:u1:ws1")).toBeNull();
});

test("workspace switch while a 413 is pending: response discarded across workspaces", async () => {
  resetResponder();
  let release!: () => void;
  gated413 = new Promise<void>((r) => (release = r));
  await mountPage();
  await openConversation();
  setInput(textarea(), "ws1 draft");
  click(buttonByLabel("Send message")!);
  await waitFor(() => completionsCalls().length === 1, "send dispatched");
  workspaceIdValue = "ws2";
  setInput(textarea(), "ws2 draft");
  release();
  await flush();
  await flush();
  expect(bodyText()).not.toContain("1 MB request limit");
  expect(putBodies).toHaveLength(0);
  expect(textarea().value).toBe("ws2 draft");
  expect(completionsCalls().length).toBe(1);
});

test("SSE model outside the published catalog is never displayed or persisted", async () => {
  resetResponder();
  completionsStatus = 200;
  completionsModel = "upstream/private-secret-9";
  await mountPage();
  await openConversation();
  setInput(textarea(), "hi there");
  click(buttonByLabel("Send message")!);
  await waitFor(() => bodyText().includes("Hello"), "reply streamed");
  // The forged upstream ID never reaches the DOM...
  expect(bodyText()).not.toContain("upstream/private-secret-9");
  // ...nor the persisted turn: the assistant message carries no model.
  await waitFor(() => putBodies.length >= 1, "turn persisted");
  const assistant = (
    putBodies[0] as { messages: { role: string; model?: string }[] }
  ).messages.find((m) => m.role === "assistant");
  expect(assistant?.model).toBeUndefined();
  // The genuine catalog member still labels normally.
  completionsModel = "test/model";
  setInput(textarea(), "second");
  click(buttonByLabel("Send message")!);
  await waitFor(() => bodyText().includes("test/model"), "genuine model label shown");
});

test("send during a slow conversation load is blocked until the snapshot lands", async () => {
  resetResponder();
  let release!: () => void;
  gatedChatGet = new Promise<void>((r) => (release = r));
  await mountPage();
  await waitFor(() => historyRow() !== undefined, "history row");
  click(historyRow()!);
  // The load is still pending: the send must be a no-op (no dispatch, no
  // optimistic state the snapshot could later wipe).
  click(buttonByLabel("Send message")!);
  await flush();
  await flush();
  expect(completionsCalls().length).toBe(0);
  release();
  await waitFor(() => document.querySelector('[role="log"]') !== null, "conversation loaded");
  setInput(textarea(), "after load");
  click(buttonByLabel("Send message")!);
  await waitFor(() => completionsCalls().length === 1, "send dispatched after load");
  // Optimistic turn is visible and the load (already settled) cannot wipe it.
  await waitFor(() => bodyText().includes("after load"), "optimistic turn visible");
  await flush();
  await flush();
  expect(bodyText()).toContain("after load");
});

test("send is blocked while the catalog is pending; the actual used model displays and persists once it resolves", async () => {
  resetResponder();
  completionsStatus = 200;
  completionsModel = "test/model";
  // Catalog query still in flight: the snapshot model is set by openChat,
  // but sends must wait — a pending catalog would drop the genuine public
  // ID before it could ever be displayed or persisted.
  catalogFixture.loading = true;
  await mountPage();
  await openConversation();
  setInput(textarea(), "before catalog");
  click(buttonByLabel("Send message")!);
  await flush();
  await flush();
  expect(completionsCalls().length).toBe(0);
  // Catalog resolves; the same draft sends and the real streamed model
  // (a published catalog member) labels the reply and lands in the PUT.
  catalogFixture.loading = false;
  setInput(textarea(), "after catalog");
  click(buttonByLabel("Send message")!);
  await waitFor(() => bodyText().includes("test/model"), "actual model label");
  await waitFor(() => putBodies.length >= 1, "turn persisted");
  const assistant = (
    putBodies[0] as { messages: { role: string; model?: string }[] }
  ).messages.find((m) => m.role === "assistant");
  expect(assistant?.model).toBe("test/model");
});

test("catalog failure disables sending behind a friendly error", async () => {
  resetResponder();
  completionsStatus = 200;
  catalogFixture.error = "boom";
  await mountPage();
  await openConversation();
  setInput(textarea(), "blocked");
  click(buttonByLabel("Send message")!);
  await flush();
  await flush();
  expect(completionsCalls().length).toBe(0);
  // Visible friendly copy, not a silent dead send button — with the raw
  // query error kept actionable per the repo's error-detail contract.
  expect(bodyText()).toContain("model catalog could not be loaded");
  expect(bodyText()).toContain("boom");
  expect(buttonByLabel("Send message")!.disabled).toBe(true);
});

test("413 on a chat-purpose key shows the 16 MB copy without a needless Reconnect", async () => {
  resetResponder();
  await mountPage({ id: "chat-key", plaintext: "sk-hbr-chat", purpose: "chat" });
  await openConversation();
  setInput(textarea(), "my draft");
  click(buttonByLabel("Send message")!);
  await waitFor(() => completionsCalls().length === 1, "send dispatched");
  // Chat-purpose keys allow 16 MiB, so the copy must not push a new key.
  await waitFor(() => bodyText().includes("16 MB request limit"), "chat-purpose 413 copy");
  expect(bodyText()).toContain("Reduce attachments or message history");
  expect(buttonByText("Reconnect")).toBeUndefined();
  // No automatic resend, no terminal save for the failed turn.
  expect(completionsCalls().length).toBe(1);
  expect(putBodies).toHaveLength(0);
});

test("Enter and Retry bypasses are guarded while the catalog is pending; send works once it resolves", async () => {
  resetResponder();
  completionsStatus = 200;
  completionsModel = "test/model";
  await mountPage();
  await openConversation();
  // Turn 1 succeeds so the Retry control exists for the bypass probe.
  setInput(textarea(), "first");
  click(buttonByLabel("Send message")!);
  await waitFor(() => bodyText().includes("Hello"), "first reply streamed");
  await waitFor(() => putBodies.length === 1, "first turn persisted");
  const chatKeyPosts = () => calls.filter((c) => c.path.endsWith("/chat-key")).length;
  const newChatPosts = () =>
    calls.filter((c) => c.path === "/api/v1/workspaces/ws1/chats" && c.init?.method === "POST")
      .length;
  const completionsBefore = completionsCalls().length;
  const chatKeyBefore = chatKeyPosts();
  const newChatBefore = newChatPosts();
  expect(buttonByText("Retry last reply")).toBeDefined();
  // Catalog goes pending AFTER openChat set the model: the disabled Send
  // button alone is not enough — Enter and Retry must also be no-ops, or the
  // reply dispatches without a resolved catalog and the public model ID is
  // dropped before it could ever be displayed or persisted.
  catalogFixture.loading = true;
  setInput(textarea(), "enter while pending");
  pressEnter(textarea());
  click(buttonByText("Retry last reply")!);
  await flush();
  await flush();
  expect(completionsCalls().length).toBe(completionsBefore);
  expect(chatKeyPosts()).toBe(chatKeyBefore);
  expect(newChatPosts()).toBe(newChatBefore);
  expect(putBodies).toHaveLength(1);
  // Catalog resolves: the same entry paths dispatch, and the genuine streamed
  // model (a published catalog member) labels the reply and lands in the PUT.
  catalogFixture.loading = false;
  setInput(textarea(), "after catalog");
  pressEnter(textarea());
  await waitFor(
    () => completionsCalls().length === completionsBefore + 1,
    "send dispatched after catalog resolved",
  );
  await waitFor(() => bodyText().includes("test/model"), "actual model label");
  await waitFor(() => putBodies.length === 2, "second turn saved");
  const assistant = (
    putBodies[1] as { messages: { role: string; model?: string }[] }
  ).messages.find((m) => m.role === "assistant");
  expect(assistant?.model).toBe("test/model");
  // The persisted browser key was reused the whole time: zero mints.
  expect(chatKeyPosts()).toBe(chatKeyBefore);
});
