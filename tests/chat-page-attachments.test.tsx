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
let uploadStatus = 201;
let responder: (call: FetchCall) => Promise<Response> = async () =>
  new Response("{}", { status: 500 });
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
  uploadStatus = 201;
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
  responder = async (call) => {
    const path = call.path;
    if (path === "/api/v1/workspaces/ws1/chats/c1" && (call.init?.method ?? "GET") === "GET")
      return jsonRes(200, snapshot(1, historyMessages));
    if (path === "/api/v1/workspaces/ws1/chats/c1" && call.init?.method === "PUT")
      return jsonRes(200, snapshot(99, historyMessages));
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
      return jsonRes(200, snapshot(99, historyMessages));
    if (path === "/api/v1/workspaces/ws1/attachments" && call.init?.method === "POST") {
      const filename = String(new Headers(call.init.headers).get("X-Hbr-Filename"));
      if (uploadStatus !== 201)
        return jsonRes(
          uploadStatus,
          uploadStatus === 413 ? { error: { code: "QUOTA_EXCEEDED", message: "Attachment storage quota exceeded" } } : {},
        );
      return jsonRes(201, {
        id: "attachment-1",
        name: decodeURIComponent(filename),
        kind: "image",
        bytes: 2048,
        mime: "image/png",
        expires_at: Date.now() + 86400000,
      });
    }
    if (path === "/api/v1/workspaces/ws1/chat-key")
      return jsonRes(200, {
        id: "k1",
        plaintext: "sk-hbr-TESTKEY123",
        name: "Chat",
        purpose: "chat",
      });
    if (path === "/v1/chat/completions")
      return new Response('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n', {
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

test("file selection uploads raw bytes and saved user turn contains only canonical server refs", async () => {
  await mountPage([{ role: "user", content: "hi" }]);
  await openConversation();
  await pickFiles([pngFile(2048)]);
  await waitFor(() => chipCount() === 1, "chip attached");
  const upload = calls.find((c) => c.path === "/api/v1/workspaces/ws1/attachments");
  expect(upload?.init?.method).toBe("POST");
  expect(upload?.init?.body).toBeInstanceOf(File);
  expect(await (upload?.init?.body as File).arrayBuffer()).toEqual(await pngFile(2048).arrayBuffer());
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
  const save = calls.find((c) => c.path === "/api/v1/workspaces/ws1/chats/c1" && c.init?.method === "PUT");
  expect(save).toBeDefined();
  const saved = JSON.parse(String(save?.init?.body)) as { messages: Array<{ role: string; attachments?: unknown[]; content: string }> };
  const savedUser = saved.messages.findLast((m) => m.role === "user");
  expect(savedUser?.attachments).toEqual([{
    id: "attachment-1", name: "shot.png", kind: "image", bytes: 2048,
    mime: "image/png", expires_at: expect.any(Number),
  }]);
  expect(JSON.stringify(savedUser)).not.toContain("data:image");
  expect(JSON.stringify(savedUser)).not.toContain("base64");
  expect(JSON.stringify(savedUser)).not.toContain("Hello");
  // The composer draft reset after a successful send.
  await waitFor(
    () =>
      (document.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement).value ===
      "",
    "draft cleared",
  );

  // Retry preserves in-session multimodal content without adding a duplicate upload.
  await waitFor(() => buttonByText("Retry last reply") !== undefined, "retry button");
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
  expect(calls.filter((c) => c.path === "/api/v1/workspaces/ws1/attachments")).toHaveLength(1);
});

test("quota-exhausted upload adds no sendable chip and shows storage-full copy", async () => {
  uploadStatus = 413;
  await mountPage();
  await pickFiles([pngFile(1024)]);
  await waitFor(() => bodyText().includes("storage is full"), "upload failure message");
  expect(chipCount()).toBe(0);
  expect(buttonByLabel("Send message")?.disabled).toBe(true);
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

test("clicking a prompt chip focuses the composer", async () => {
  await mountPage();
  const chip = buttonByText("Help me write a debounce function in TypeScript.");
  expect(chip).toBeDefined();
  click(chip!);
  await flush();
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Message");
});
