import { test, expect } from "bun:test";
import type { ChatAttachmentRef, ConversationMessage } from "@hoborouter/shared";
import { prepareChatSend, MAX_CHAT_REQUEST_BODY_BYTES } from "../apps/web/src/pages/chat/prepare-send";

const ref = (over: Partial<ChatAttachmentRef> = {}): ChatAttachmentRef => ({
  id: over.id ?? crypto.randomUUID(),
  name: over.name ?? "notes.txt",
  kind: over.kind ?? "text",
  bytes: over.bytes ?? 5,
  mime: over.mime ?? "text/plain",
  expires_at: over.expires_at ?? Date.now() + 60_000,
});
const encode = (text: string) => new TextEncoder().encode(text);
const msg = (attachments: ChatAttachmentRef[]): ConversationMessage[] => [
  { role: "user", content: "read", attachments },
  { role: "assistant", content: "ok" },
];
function fakeFetch(statusOrBytes: number | Uint8Array) {
  let calls = 0;
  const fetch = (async () => {
    calls++;
    if (typeof statusOrBytes === "number") return new Response("failed", { status: statusOrBytes });
    return new Response(statusOrBytes.slice().buffer as ArrayBuffer);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls: () => calls };
}

test("prepares all rehydrated refs without changing canonical messages", async () => {
  const messages = msg([ref()]);
  const original = JSON.stringify(messages);
  const remote = fakeFetch(encode("hello"));
  const result = await prepareChatSend({ workspaceId: "ws", model: "m", messages, effort: "high", fetch: remote.fetch });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.conversationMessages).toEqual(messages);
  expect(result.conversationMessages).not.toBe(messages);
  expect(result.conversationMessages[0]?.attachments).not.toBe(messages[0]?.attachments);
  expect(JSON.parse(result.bodyJson).messages[0].content[0].text).toContain("hello");
  expect(JSON.stringify(messages)).toBe(original);
  expect(remote.calls()).toBe(1);
});

test("raw budget rejects before fetch", async () => {
  const messages = msg([ref({ bytes: 10 * 1024 * 1024 + 1 })]);
  const remote = fakeFetch(encode("unused"));
  const result = await prepareChatSend({ workspaceId: "ws", model: "m", messages, effort: "none", fetch: remote.fetch });
  expect(result).toMatchObject({ ok: false, kind: "tooLarge" });
  expect(remote.calls()).toBe(0);
});

test("404/410 returns unavailable with cloned outgoing refs and no body", async () => {
  const messages = msg([ref()]);
  const remote = fakeFetch(410);
  const result = await prepareChatSend({ workspaceId: "ws", model: "m", messages, effort: "none", fetch: remote.fetch });
  expect(result).toMatchObject({ ok: false, kind: "unavailable", files: [{ name: "notes.txt" }] });
  if (result.ok || result.kind !== "unavailable") return;
  expect(result).not.toHaveProperty("bodyJson");
  expect(result.outgoingMessages).toEqual(messages);
  expect(result.outgoingMessages).not.toBe(messages);
  expect(result.outgoingMessages[0]?.attachments).not.toBe(messages[0]?.attachments);
});

test("server and network failures block preparation", async () => {
  const messages = msg([ref()]);
  const server = fakeFetch(500);
  expect(await prepareChatSend({ workspaceId: "ws", model: "m", messages, effort: "none", fetch: server.fetch })).toMatchObject({ ok: false, kind: "failed" });
  const networkFetch = (async () => { throw new Error("offline"); }) as unknown as typeof globalThis.fetch;
  expect(await prepareChatSend({ workspaceId: "ws", model: "m", messages, effort: "none", fetch: networkFetch })).toMatchObject({ ok: false, kind: "failed" });
});

test("checks exact UTF-8 JSON size against the 16 MiB boundary", async () => {
  const emptyBodyBytes = new TextEncoder().encode(
    JSON.stringify({ model: "m", messages: [{ role: "user", content: "" }], stream: true, reasoning: { effort: "none" } }),
  ).byteLength;
  const contentBytes = MAX_CHAT_REQUEST_BODY_BYTES - emptyBodyBytes;
  const content = "é".repeat(Math.floor(contentBytes / 2)) + (contentBytes % 2 ? "a" : "");
  const exact = [{ role: "user", content } as ConversationMessage];
  const oversized = [{ role: "user", content: `${content}a` } as ConversationMessage];
  const exactResult = await prepareChatSend({ workspaceId: "ws", model: "m", messages: exact, effort: "none" });
  expect(exactResult.ok).toBe(true);
  if (exactResult.ok) expect(new TextEncoder().encode(exactResult.bodyJson).byteLength).toBe(MAX_CHAT_REQUEST_BODY_BYTES);
  expect(await prepareChatSend({ workspaceId: "ws", model: "m", messages: oversized, effort: "none" })).toMatchObject({ ok: false, kind: "tooLarge" });
});
