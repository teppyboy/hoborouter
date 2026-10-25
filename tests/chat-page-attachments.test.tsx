// Chat page attachment lifecycle regressions, exercised through the MOUNTED
// page (jsdom + real React root), not helpers or SSR markup alone:
//  1. a file read finishing after New chat is discarded — it must never
//     repopulate another view's composer (view-generation pin);
//  2. overlapping file picks serialize against the LIVE list (count/total
//     budget cannot be bypassed by a stale snapshot);
//  3. an oversized payload is rejected BEFORE any side effect (no key mint,
//     no gateway call, no conversation create) and the draft survives;
//  4. attachments ride the sent request as image_url content parts, are
//     retained in-session for follow-ups AND retries, and the UI discloses
//     the session-only retention.
import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import { mock } from "bun:test";
import { clearManagedChatKey } from "../apps/web/src/pages/chat/managed-key";

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
let responder: (call: FetchCall) => Promise<Response> = async () =>
  new Response("{}", { status: 500 });
let putResponse: ((call: FetchCall) => Response) | null = null;
let keyResponse: Response | null = null;
let completionResponse: Response | null = null;
const mockFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const call: FetchCall = { path: String(input), init };
  calls.push(call);
  return responder(call);
};

// Identity + catalog are fixed for the whole file: the page mounts as a
// signed-in owner of ws1 with one vision-capable model.
mock.module("../apps/web/src/lib/auth", () => ({
  useSession: () => ({ data: { user: { id: "u1" } }, isPending: false }),
}));
mock.module("../apps/web/src/lib/workspace-queries", () => ({
  useCurrentWorkspaceId: () => "ws1",
}));
mock.module("../apps/web/src/pages/models/data", () => ({
  useCatalogModels: () => ({
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
    error: null,
  }),
}));

let ChatPage: (typeof import("../apps/web/src/pages/chat"))["ChatPage"];
let createRoot: (typeof import("react-dom/client"))["createRoot"];
type Root = import("react-dom/client").Root;

const roots: Root[] = [];
const realFetch = globalThis.fetch;
const flush = () => new Promise((r) => setTimeout(r, 0));

async function waitFor(cond: () => boolean, label: string, timeoutMs = 4000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout: ${label}`);
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
  calls = [];
});

type EventCtor = new (type: string, init?: { bubbles?: boolean; cancelable?: boolean }) => Event;
const winEvents = () => window as unknown as { Event: EventCtor; MouseEvent: EventCtor };
const click = (el: Element) =>
  el.dispatchEvent(new (winEvents().MouseEvent)("click", { bubbles: true, cancelable: true }));

const buttonByLabel = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const buttonByText = (text: string) =>
  Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);

const setInput = (el: Element, value: string) => {
  const input = el as HTMLInputElement;
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
  input.dispatchEvent(new (winEvents().Event)("input", { bubbles: true }));
};

const bodyText = () => document.body.textContent ?? "";
const chipCount = () => document.querySelectorAll('button[aria-label^="Remove attachment"]').length;
const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const now = Date.now();
const snapshot = (version: number, messages: unknown[], model = "test/model") => ({
  id: "c1",
  title: "T",
  model,
  version,
  created_at: now,
  updated_at: now,
  archived_at: null,
  messages,
});

/** Mount the page with a saved conversation "T" available in history. */
async function mountPage(historyMessages: unknown[] = []) {
  putResponse = null;
  keyResponse = null;
  completionResponse = null;
  responder = async (call) => {
    const path = call.path;
    if (path === "/api/v1/workspaces/ws1/chats/c1" && (call.init?.method ?? "GET") === "GET")
      return jsonRes(200, snapshot(1, historyMessages));
    if (path === "/api/v1/workspaces/ws1/chats/c1" && call.init?.method === "PUT")
      return putResponse?.(call) ?? jsonRes(200, snapshot(99, historyMessages));
    if (path === "/api/v1/workspaces/ws1/chats" || path.startsWith("/api/v1/workspaces/ws1/chats?"))
      return jsonRes(200, {
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
      });
    if (path === "/api/v1/workspaces/ws1/chats/c1" && (call.init?.method ?? "GET") === "GET")
      return jsonRes(200, snapshot(1, historyMessages));
    if (path === "/api/v1/workspaces/ws1/chats/c1" && call.init?.method === "PUT")
      return putResponse?.(call) ?? jsonRes(200, snapshot(99, historyMessages));
    if (path === "/api/v1/workspaces/ws1/chat-key")
      return keyResponse ?? jsonRes(200, {
        id: "k1",
        plaintext: "sk-hbr-TESTKEY123",
        name: "Chat",
        purpose: "chat",
      });
    if (path === "/v1/chat/completions")
      return completionResponse ?? new Response('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    return jsonRes(200, {});
  };
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

/** History row button (title span inside; row also carries a date span). */
const historyRow = () => {
  const span = Array.from(document.querySelectorAll("span")).find(
    (s) => s.textContent === "T" && s.closest("button"),
  );
  return (span?.closest("button") ?? undefined) as HTMLButtonElement | undefined;
};

/** Open the saved conversation via its history row (sets the model). */
async function openConversation() {
  await waitFor(() => historyRow() !== undefined, "history row");
  click(historyRow()!);
  // The model is set from the snapshot; the gateway body check uses it.
  await flush();
  await flush();
}

async function pickFiles(files: File[]) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("file input not found");
  Object.defineProperty(input, "files", { value: files, configurable: true });
  input.dispatchEvent(new (winEvents().Event)("change", { bubbles: true }));
  input.value = "";
  await flush();
}

const pngFile = (bytes: number, name = "shot.png") =>
  new File([new Uint8Array(bytes)], name, { type: "image/png" });
const textFile = (content: string, name = "notes.txt") =>
  new File([content], name, { type: "text/plain" });

/** Gate File reads so tests control when pick-processing completes. */
function gateFileReads() {
  const releaseFns: Array<() => void> = [];
  const gate = new Promise<void>((resolve) => releaseFns.push(resolve));
  const origArrayBuffer = File.prototype.arrayBuffer;
  const origText = File.prototype.text;
  File.prototype.arrayBuffer = function () {
    return gate.then(() => origArrayBuffer.call(this));
  };
  File.prototype.text = function () {
    return gate.then(() => origText.call(this));
  };
  return {
    releaseAll: () => releaseFns.forEach((fn) => fn()),
    restore: () => {
      File.prototype.arrayBuffer = origArrayBuffer;
      File.prototype.text = origText;
    },
  };
}

test("a file read finishing after New chat is discarded, not attached to the new view", async () => {
  await mountPage();
  await openConversation();
  const gate = gateFileReads();
  try {
    await pickFiles([pngFile(1024)]);
    // New chat is enabled here (a conversation is open).
    click(buttonByLabel("New chat")!);
    gate.releaseAll();
    await flush();
    await flush();
    // The late read must NOT repopulate the composer chips.
    expect(chipCount()).toBe(0);
  } finally {
    gate.restore();
  }
});

test("overlapping picks serialize against the live list: budget cannot be bypassed", async () => {
  await mountPage();
  const gate = gateFileReads();
  try {
    // First pick: 3 files. Second pick dispatched before the first completes:
    // with a stale-list bug both would validate against [] and attach 6.
    await pickFiles([textFile("a", "a.txt"), textFile("b", "b.txt"), textFile("c", "c.txt")]);
    await pickFiles([textFile("d", "d.txt"), textFile("e", "e.txt"), textFile("f", "f.txt")]);
    gate.releaseAll();
    await flush();
    await flush();
    expect(chipCount()).toBe(3);
    expect(bodyText()).toContain("at most 4");
  } finally {
    gate.restore();
  }
});

test("oversized payload is rejected before any side effect and the draft survives", async () => {
  // The chat-purpose cap is 16 MiB: a ~0.5 MiB data URL plus ~16.3 MB of
  // history pushes the JSON body over the client-side pre-send guard.
  await mountPage([{ role: "user", content: "x".repeat(16_300_000) }]);
  await openConversation();
  await pickFiles([pngFile(384 * 1024)]);
  await waitFor(() => chipCount() === 1, "chip attached");
  const textarea = document.querySelector('textarea[aria-label="Message"]')!;
  setInput(textarea, "hello");
  click(buttonByLabel("Send message")!);
  await waitFor(() => bodyText().includes("too large to send"), "size rejection");
  // Draft untouched; nothing was sent anywhere.
  expect((textarea as HTMLTextAreaElement).value).toBe("hello");
  expect(chipCount()).toBe(1);
  expect(calls.filter((c) => c.path === "/v1/chat/completions")).toHaveLength(0);
  expect(calls.filter((c) => c.path.endsWith("/chat-key"))).toHaveLength(0);
  expect(
    calls.filter((c) => c.path.endsWith("/chats/c1") && c.init?.method === "PUT"),
  ).toHaveLength(0);
});

test("attachments ride the request, persist in-session for follow-ups and retries", async () => {
  await mountPage([{ role: "user", content: "hi" }]);
  await openConversation();
  await pickFiles([pngFile(2048)]);
  await waitFor(() => chipCount() === 1, "chip attached");
  // Session-only retention disclosure is visible while attachments exist.
  expect(bodyText()).toContain("not saved to your chat history");
  const textarea = document.querySelector('textarea[aria-label="Message"]')!;
  setInput(textarea, "look at this");
  click(buttonByLabel("Send message")!);
  await waitFor(() => bodyText().includes("Hello"), "assistant reply");
  const sendCalls = calls.filter((c) => c.path === "/v1/chat/completions");
  expect(sendCalls).toHaveLength(1);
  const sent = JSON.parse(String(sendCalls[0]?.init?.body)) as {
    messages: Array<{ role: string; content: unknown }>;
  };
  const lastUser = sent.messages.filter((m) => m.role === "user").at(-1);
  expect(Array.isArray(lastUser?.content)).toBe(true);
  expect(JSON.stringify(lastUser?.content)).toContain("image_url");
  expect(JSON.stringify(lastUser?.content)).toContain("look at this");
  // The composer draft reset after a successful send.
  await waitFor(
    () =>
      (document.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement).value ===
      "",
    "draft cleared",
  );

  // Retry re-sends the retained multimodal content, and says so.
  await waitFor(() => buttonByText("Retry last reply") !== undefined, "retry button");
  expect(bodyText()).toContain("Retry re-sends this turn's attachments");
  click(buttonByText("Retry last reply")!);
  await waitFor(
    () => calls.filter((c) => c.path === "/v1/chat/completions").length === 2,
    "retry sent",
  );
  const retry = JSON.parse(
    String(calls.filter((c) => c.path === "/v1/chat/completions")[1]?.init?.body),
  ) as { messages: Array<{ role: string; content: unknown }> };
  const retryLastUser = retry.messages.filter((m) => m.role === "user").at(-1);
  expect(JSON.stringify(retryLastUser?.content)).toContain("image_url");
});

test("a pick in flight shows a Reading status that clears when reads finish", async () => {
  await mountPage();
  const gate = gateFileReads();
  try {
    await pickFiles([pngFile(1024)]);
    // While the file read is in flight the composer shows a live status and
    // no chip yet: the paperclip button never looks dead on large files.
    await waitFor(() => bodyText().includes("Reading file"), "reading status visible");
    expect(chipCount()).toBe(0);
    gate.releaseAll();
    await waitFor(() => !bodyText().includes("Reading file"), "reading status cleared");
    expect(chipCount()).toBe(1);
  } finally {
    gate.restore();
  }
});

test("pasting an image file from the clipboard attaches it like a pick", async () => {
  await mountPage();
  const textarea = document.querySelector('textarea[aria-label="Message"]')!;
  const paste = new (winEvents().Event)("paste", { bubbles: true, cancelable: true }) as Event & {
    clipboardData?: { files: File[] };
  };
  paste.clipboardData = { files: [pngFile(1024)] };
  textarea.dispatchEvent(paste);
  await waitFor(() => chipCount() === 1, "pasted attachment chip");
  // A text-only paste never touches attachments.
  const textPaste = new (winEvents().Event)("paste", {
    bubbles: true,
    cancelable: true,
  }) as Event & {
    clipboardData?: { files: File[] };
  };
  textPaste.clipboardData = { files: [] };
  textarea.dispatchEvent(textPaste);
  await flush();
  expect(chipCount()).toBe(1);
});

test("dropping a file on the composer attaches it like a pick", async () => {
  await mountPage();
  const textarea = document.querySelector('textarea[aria-label="Message"]')!;
  // Bubbles from the textarea up to the composer card that owns onDrop.
  const drop = new (winEvents().Event)("drop", { bubbles: true, cancelable: true }) as Event & {
    dataTransfer?: { files: File[] };
  };
  drop.dataTransfer = { files: [textFile("hello", "dropped.txt")] };
  textarea.dispatchEvent(drop);
  await waitFor(() => chipCount() === 1, "dropped attachment chip");
  expect(document.body.textContent).toContain("dropped.txt");
});

test("edit is prefilled, cancel leaves transcript unchanged, and confirmation trims before regeneration", async () => {
  await mountPage([
    { role: "user", content: "first" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "later" },
    { role: "assistant", content: "later reply" },
  ]);
  await openConversation();
  const initialEdits = Array.from(document.querySelectorAll('button[aria-label="Edit"]'));
  expect(initialEdits).toHaveLength(2);
  click(initialEdits[0]!);
  await flush();
  const editor = document.querySelector('textarea[aria-label="Edit"]') as HTMLTextAreaElement;
  expect(editor.value).toBe("first");
  click(buttonByText("Cancel edit")!);
  expect(bodyText()).toContain("later reply");

  click(document.querySelectorAll('button[aria-label="Edit"]')[0]!);
  await flush();
  setInput(document.querySelector('textarea[aria-label="Edit"]')!, "revised");
  expect(bodyText()).toContain("old reply and all later turns");
  expect(calls.filter((c) => c.path === "/v1/chat/completions")).toHaveLength(0);
  click(buttonByText("Confirm and regenerate")!);
  await flush();
  click(buttonByText("Confirm and regenerate")!);
  await waitFor(() => calls.some((c) => c.path === "/v1/chat/completions"), "replacement request");
  const puts = calls.filter((c) => c.path.endsWith("/chats/c1") && c.init?.method === "PUT");
  expect(puts.length).toBeGreaterThanOrEqual(1);
  expect(calls.findIndex((c) => c.path.endsWith("/chats/c1") && c.init?.method === "PUT")).toBeLessThan(calls.findIndex((c) => c.path === "/v1/chat/completions"));
  const saved = JSON.parse(String(puts[0]?.init?.body)) as { messages: Array<{ content: string }> };
  expect(saved.messages.map((m) => m.content)).toEqual(["revised"]);
  const request = calls.find((c) => c.path === "/v1/chat/completions");
  expect(JSON.parse(String(request?.init?.body)).model).toBe("test/model");
});

test("edit blocks a known attachment turn until a file is reattached", async () => {
  await mountPage([{ role: "user", content: "inspect", hadAttachments: true }, { role: "assistant", content: "reply" }]);
  await openConversation();
  click(document.querySelector('button[aria-label="Edit"]')!);
  await flush();
  expect(bodyText()).toContain("had attachments");
  click(buttonByText("Confirm and regenerate")!);
  expect(calls.filter((c) => c.path.endsWith("/chats/c1") && c.init?.method === "PUT")).toHaveLength(0);
  expect(calls.filter((c) => c.path === "/v1/chat/completions")).toHaveLength(0);
});

test("editing a later turn preserves attachments on retained earlier turns", async () => {
  await mountPage([{ role: "user", content: "inspect" }, { role: "assistant", content: "reply" }]);
  await openConversation();
  await pickFiles([pngFile(32)]);
  setInput(document.querySelector('textarea[aria-label="Message"]')!, "first image");
  click(buttonByLabel("Send message")!);
  await waitFor(() => bodyText().includes("Hello"), "first response");
  setInput(document.querySelector('textarea[aria-label="Message"]')!, "second turn");
  click(buttonByLabel("Send message")!);
  await waitFor(() => calls.filter((c) => c.path === "/v1/chat/completions").length === 2, "second response");
  click(document.querySelectorAll('button[aria-label="Edit"]')[2]!);
  await flush();
  setInput(document.querySelector('textarea[aria-label="Edit"]')!, "revised second");
  click(buttonByText("Confirm and regenerate")!);
  await flush();
  click(buttonByText("Confirm and regenerate")!);
  await waitFor(() => calls.filter((c) => c.path === "/v1/chat/completions").length === 3, "regeneration");
  const request = JSON.parse(String(calls.filter((c) => c.path === "/v1/chat/completions")[2]?.init?.body)) as { messages: Array<{ role: string; content: unknown }> };
  expect(JSON.stringify(request.messages[2]?.content)).toContain("image_url");
});

test("trim conflict blocks key resolution and gateway dispatch", async () => {
  await mountPage([{ role: "user", content: "inspect" }, { role: "assistant", content: "reply" }]);
  await openConversation();
  putResponse = () => jsonRes(409, { error: "conflict", version: 8 });
  click(buttonByLabel("Edit")!);
  await flush();
  setInput(document.querySelector('textarea[aria-label="Edit"]')!, "revised");
  click(buttonByText("Confirm and regenerate")!);
  await flush();
  click(buttonByText("Confirm and regenerate")!);
  await waitFor(() => bodyText().includes("This conversation changed on another device or tab."), "conflict state");
  expect(calls.filter((c) => c.path.endsWith("/chat-key"))).toHaveLength(0);
  expect(calls.filter((c) => c.path === "/v1/chat/completions")).toHaveLength(0);
});

test("managed-key failure after trim does not restore discarded turns", async () => {
  await mountPage([{ role: "user", content: "first" }, { role: "assistant", content: "reply" }, { role: "user", content: "later" }, { role: "assistant", content: "later reply" }]);
  await openConversation();
  clearManagedChatKey({ userId: "u1", workspaceId: "ws1" });
  keyResponse = jsonRes(500, {});
  click(document.querySelector('button[aria-label="Edit"]')!);
  await flush();
  setInput(document.querySelector('textarea[aria-label="Edit"]')!, "revised");
  click(buttonByText("Confirm and regenerate")!);
  await flush();
  click(buttonByText("Confirm and regenerate")!);
  await waitFor(() => calls.some((c) => c.path.endsWith("/chat-key")), "key attempt");
  await waitFor(() => !bodyText().includes("later reply"), "trim remains");
  expect(calls.filter((c) => c.path === "/v1/chat/completions")).toHaveLength(0);
});

test("reattached edit files are sent and saved as attachment-bearing metadata", async () => {
  await mountPage([{ role: "user", content: "inspect", hadAttachments: true }, { role: "assistant", content: "reply" }]);
  await openConversation();
  click(buttonByLabel("Edit")!);
  await flush();
  await pickFiles([pngFile(32)]);
  click(buttonByText("Confirm and regenerate")!);
  await flush();
  click(buttonByText("Confirm and regenerate")!);
  await waitFor(() => calls.some((c) => c.path === "/v1/chat/completions"), "replacement request");
  const put = calls.find((c) => c.path.endsWith("/chats/c1") && c.init?.method === "PUT");
  expect(String(put?.init?.body)).toContain('"hadAttachments":true');
  expect(JSON.stringify(JSON.parse(String(calls.find((c) => c.path === "/v1/chat/completions")?.init?.body)))).toContain("image_url");
});

test("unknown attachment metadata warns but permits confirmed edit", async () => {
  await mountPage([{ role: "user", content: "inspect" }, { role: "assistant", content: "reply" }]);
  await openConversation();
  click(buttonByLabel("Edit")!);
  await flush();
  expect(bodyText()).toContain("Attachment history is unknown.");
  setInput(document.querySelector('textarea[aria-label="Edit"]')!, "revised");
  click(buttonByText("Confirm and regenerate")!);
  await flush();
  click(buttonByText("Confirm and regenerate")!);
  await waitFor(() => calls.some((c) => c.path === "/v1/chat/completions"), "confirmed request");
});

test("edit 413 recovery leaves the persisted trim intact", async () => {
  await mountPage([{ role: "user", content: "first" }, { role: "assistant", content: "reply" }, { role: "user", content: "later" }, { role: "assistant", content: "later reply" }]);
  await openConversation();
  completionResponse = jsonRes(413, { error: { message: "too large" } });
  click(document.querySelector('button[aria-label="Edit"]')!);
  await flush();
  setInput(document.querySelector('textarea[aria-label="Edit"]')!, "revised");
  click(buttonByText("Confirm and regenerate")!);
  await flush();
  click(buttonByText("Confirm and regenerate")!);
  await waitFor(() => bodyText().includes("too large"), "413 error");
  expect(bodyText()).not.toContain("later reply");
  const put = calls.find((c) => c.path.endsWith("/chats/c1") && c.init?.method === "PUT");
  expect(String(put?.init?.body)).toContain("revised");
});

test("empty state has no suggestion prompt controls", async () => {
  await mountPage();
  expect(buttonByText("Help me write a debounce function in TypeScript.")).toBeUndefined();
});
