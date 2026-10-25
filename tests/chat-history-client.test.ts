// Chat conversations client: real helper outputs against a mocked native
// fetch. Verifies same-origin URLs, methods, bodies, optimistic version
// passthrough, abort-signal passthrough, cross-workspace URL isolation, and
// failure semantics — a server failure (including 409 stale version) rejects;
// nothing is ever pretended to succeed locally.
import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  archiveConversation,
  createConversation,
  ConversationError,
  getConversation,
  listConversations,
  saveConversation,
  type ConversationSnapshot,
} from "../apps/web/src/pages/chat/conversations";

interface CapturedCall {
  url: string;
  init: RequestInit;
}

let calls: CapturedCall[];
let realFetch: typeof fetch;

// noUncheckedIndexedAccess: assert presence instead of sprinkling `!`.
function call(i: number): CapturedCall {
  const c = calls[i];
  if (!c) throw new Error(`expected fetch call #${i}`);
  return c;
}

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function snapshot(over: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  return {
    id: "chat-1",
    title: "New chat",
    model: null,
    messages: [],
    version: 1,
    created_at: 1700000000000,
    updated_at: 1700000000000,
    archived_at: null,
    ...over,
  };
}

beforeEach(() => {
  realFetch = globalThis.fetch;
  calls = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, init: init ?? {} });
    // Minimal valid payloads so URL/method assertions can complete.
    if (method === "GET" && /\/chats(\?|$)/.test(url))
      return respond(200, { data: [], nextCursor: null });
    return respond(200, snapshot());
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("list: GET on the workspace chats URL, no cursor by default", async () => {
  await listConversations("ws-1");
  expect(calls).toHaveLength(1);
  expect(call(0).url).toBe("/api/v1/workspaces/ws-1/chats");
  expect(call(0).init.method).toBe("GET");
});

test("list: cursor goes in the query string, encoded", async () => {
  await listConversations("ws-1", "1700000000000.chat-9");
  expect(call(0).url).toBe("/api/v1/workspaces/ws-1/chats?cursor=1700000000000.chat-9");
});

test("list: cross-workspace requests hit their own workspace URL", async () => {
  await listConversations("ws-1");
  await listConversations("ws-2");
  expect(calls.map((c) => c.url)).toEqual([
    "/api/v1/workspaces/ws-1/chats",
    "/api/v1/workspaces/ws-2/chats",
  ]);
});

test("create: POST, no request body, returns server snapshot as-is", async () => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return respond(201, snapshot({ id: "chat-new", version: 1 }));
  }) as unknown as typeof fetch;
  const conv = await createConversation("ws-1");
  expect(conv.id).toBe("chat-new");
  expect(call(0).url).toBe("/api/v1/workspaces/ws-1/chats");
  expect(call(0).init.method).toBe("POST");
  expect(call(0).init.credentials).toBe("include");
  expect(call(0).init.body).toBeUndefined();
});

test("load and save preserve hadAttachments while legacy messages stay absent", async () => {
  const marked = { role: "user" as const, content: "file prompt", hadAttachments: true };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    if (init?.method === "GET") return respond(200, snapshot({ messages: [marked] }));
    return respond(200, snapshot({ version: 2, messages: [marked] }));
  }) as unknown as typeof fetch;

  const loaded = await getConversation("ws-1", "chat-1");
  expect(loaded.messages).toEqual([marked]);
  const saved = await saveConversation("ws-1", "chat-1", { version: 1, messages: loaded.messages });
  expect(JSON.parse(String(call(1).init.body)).messages).toEqual([marked]);
  expect(saved.messages).toEqual([marked]);

  globalThis.fetch = (async () =>
    respond(
      200,
      snapshot({ messages: [{ role: "user", content: "old" }] }),
    )) as unknown as typeof fetch;
  const legacy = await getConversation("ws-1", "chat-legacy");
  expect(legacy.messages).toEqual([{ role: "user", content: "old" }]);
  expect("hadAttachments" in legacy.messages[0]!).toBe(false);
});

test("save: PUT carries the client version and returns the server snapshot", async () => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    // Server owns versioning: it comes back incremented, not locally bumped.
    return respond(200, snapshot({ version: 8, title: "Renamed" }));
  }) as unknown as typeof fetch;
  const conv = await saveConversation("ws-1", "chat-1", {
    version: 7,
    title: "Renamed",
    messages: [{ role: "user", content: "hi", hadAttachments: true }],
  });
  expect(conv.version).toBe(8);
  expect(call(0).url).toBe("/api/v1/workspaces/ws-1/chats/chat-1");
  expect(call(0).init.method).toBe("PUT");
  const sent = JSON.parse(String(call(0).init.body));
  expect(sent.version).toBe(7);
  expect(sent.messages).toEqual([{ role: "user", content: "hi", hadAttachments: true }]);
});

test("save: 409 stale version rejects with a readable conflict, no fake success", async () => {
  globalThis.fetch = (async () =>
    respond(409, { error: { code: "CONFLICT" } })) as unknown as typeof fetch;
  let err: unknown;
  try {
    await saveConversation("ws-1", "chat-1", { version: 3, messages: [] });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ConversationError);
  expect((err as ConversationError).kind).toBe("conflict");
  expect((err as ConversationError).status).toBe(409);
  expect((err as ConversationError).message).toContain("409");
});

test("load: GET on the chat URL with the workspace in the path", async () => {
  await getConversation("ws-2", "chat-3");
  expect(call(0).url).toBe("/api/v1/workspaces/ws-2/chats/chat-3");
  expect(call(0).init.method).toBe("GET");
});

test("archive: PATCH archived:true, server answers {id, archived_at}", async () => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return respond(200, { id: "chat-1", archived_at: 1700000001000 });
  }) as unknown as typeof fetch;
  const res = await archiveConversation("ws-1", "chat-1");
  expect(res).toEqual({ id: "chat-1", archived_at: 1700000001000 });
  expect(call(0).init.method).toBe("PATCH");
  expect(JSON.parse(String(call(0).init.body))).toEqual({ archived: true });
});

test("server 500 rejects — the helper never invents a local success", async () => {
  globalThis.fetch = (async () =>
    respond(500, { error: { code: "X" } })) as unknown as typeof fetch;
  let err: unknown;
  try {
    await listConversations("ws-1");
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ConversationError);
  expect((err as ConversationError).kind).toBe("invalid");
  expect((err as ConversationError).status).toBe(500);
});

test("network failure (fetch throws) rejects with kind network", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  let err: unknown;
  try {
    await getConversation("ws-1", "chat-1");
  } catch (e) {
    err = e;
  }
  expect((err as ConversationError).kind).toBe("network");
});

test("abort signal is passed through to fetch and aborting rejects", async () => {
  const controller = new AbortController();
  const abortErr = new DOMException("Aborted", "AbortError");
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    expect(init?.signal).toBe(controller.signal);
    throw abortErr;
  }) as unknown as typeof fetch;
  let err: unknown;
  try {
    await listConversations("ws-1", null, { signal: controller.signal });
  } catch (e) {
    err = e;
  }
  expect((err as ConversationError).kind).toBe("network");
});

test("unexpected response shape is rejected, not trusted", async () => {
  globalThis.fetch = (async () => respond(200, { id: "chat-1" })) as unknown as typeof fetch;
  let err: unknown;
  try {
    await getConversation("ws-1", "chat-1");
  } catch (e) {
    err = e;
  }
  expect((err as ConversationError).kind).toBe("invalid");
});

test("unauthorized (401) maps to kind unauthorized", async () => {
  globalThis.fetch = (async () => respond(401, { error: {} })) as unknown as typeof fetch;
  let err: unknown;
  try {
    await listConversations("ws-1");
  } catch (e) {
    err = e;
  }
  expect((err as ConversationError).kind).toBe("unauthorized");
});
