// Persistent attachment rehydration (apps/web/src/pages/chat/
// persistent-attachments.ts): refs from a persisted conversation rebuild the
// exact multimodal content of the original send via authenticated session
// GET; unavailable refs (404/410) block the send with a typed error carrying
// ids/names until the user explicitly omits them; the raw-bytes budget across
// all historical turns is enforced BEFORE any fetch. No live provider, no
// network — fetch is injected.
import { test, expect } from "bun:test";
import {
  REHYDRATION_MAX_TOTAL_RAW_BYTES,
  AttachmentBudgetExceededError,
  UnavailableAttachmentsError,
  estimateEncodedAttachmentBytes,
  messageRefBytes,
  rehydrateMultimodalContents,
  refToAttachment,
  stripAttachments,
} from "../apps/web/src/pages/chat/persistent-attachments";
import { withMultimodalContent, type UserContent } from "../apps/web/src/pages/chat/attachments";
import type { ChatAttachmentRef, ConversationMessage } from "@hoborouter/shared";

const ref = (over: Partial<ChatAttachmentRef>): ChatAttachmentRef => ({
  id: over.id ?? crypto.randomUUID(),
  name: over.name ?? "file.bin",
  kind: over.kind ?? "text",
  bytes: over.bytes ?? 4,
  mime: over.mime ?? "text/plain",
  expires_at: over.expires_at ?? Date.now() + 86_400_000,
});

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8,
]);

/** Fake fetch mapping attachment ids → bytes or statuses. */
function fakeFetch(
  byId: Map<string, { bytes?: Uint8Array; status?: number }>,
): { fetch: typeof fetch; requested: string[] } {
  const requested: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const id = url.split("/attachments/")[1] ?? "";
    requested.push(id);
    const entry = byId.get(id);
    if (!entry) return new Response("nope", { status: 404 });
    if (entry.status !== undefined) return new Response("gone", { status: entry.status });
    return new Response(entry.bytes as unknown as BodyInit, { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: fn, requested };
}

const messagesWith = (...msgs: ConversationMessage[]): ConversationMessage[] => msgs;

test("rehydration rebuilds per-user-turn content with indices matching withMultimodalContent", async () => {
  const imageRef = ref({ kind: "image", mime: "image/png", name: "shot.png", bytes: PNG.byteLength });
  const textRef = ref({ kind: "text", name: "notes.txt", bytes: 5 });
  const messages = messagesWith(
    { role: "user", content: "look", attachments: [imageRef] },
    { role: "assistant", content: "ok" },
    { role: "user", content: "and this", attachments: [textRef] },
    { role: "user", content: "plain, no files" },
  );
  const { fetch } = fakeFetch(
    new Map([
      [imageRef.id, { bytes: PNG }],
      [textRef.id, { bytes: new TextEncoder().encode("hello") }],
    ]),
  );
  const contents = await rehydrateMultimodalContents("ws-1", messages, { fetch });
  expect(contents.size).toBe(2);
  expect(contents.has(0)).toBe(true);
  expect(contents.has(1)).toBe(true);
  expect(contents.has(2)).toBe(false);
  // Parity: overlaying onto the base strings yields content parts for turn 0.
  const base = messages.map((m) => ({ role: m.role, content: m.content }));
  const history = withMultimodalContent(base, contents);
  const first = history[0]?.content as unknown as Exclude<UserContent, string>;
  expect(Array.isArray(first)).toBe(true);
  expect(first[0]).toEqual({ type: "text", text: "look" });
  expect((first[1] as { image_url: { url: string } }).image_url.url).toStartWith("data:image/png;base64,");
  // Text turn: fenced inline through buildUserContent. history is the full
  // message array — the second USER turn sits at array index 2.
  const second = history[2]?.content as unknown as Exclude<UserContent, string>;
  expect((second[0] as { text: string }).text).toContain("--- Attached file: notes.txt ---");
});

test("a 404/410 ref raises UnavailableAttachmentsError with ids+names and blocks (no partial content)", async () => {
  const gone = ref({ name: "gone.txt" });
  const alive = ref({ name: "alive.txt" });
  const messages = messagesWith(
    { role: "user", content: "turn one", attachments: [gone] },
    { role: "user", content: "turn two", attachments: [alive] },
  );
  const { fetch } = fakeFetch(
    new Map([
      [gone.id, { status: 410 }],
      [alive.id, { bytes: new TextEncoder().encode("hi") }],
    ]),
  );
  let caught: unknown;
  try {
    await rehydrateMultimodalContents("ws-1", messages, { fetch });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(UnavailableAttachmentsError);
  const err = caught as UnavailableAttachmentsError;
  expect(err.unavailable).toEqual([{ id: gone.id, name: "gone.txt" }]);
});

test("foreign/missing refs (404) are unavailable too — never silently text-only", async () => {
  const missing = ref({ name: "missing.png" });
  const { fetch } = fakeFetch(new Map()); // everything 404s
  let caught: unknown;
  try {
    await rehydrateMultimodalContents(
      "ws-1",
      messagesWith({ role: "user", content: "x", attachments: [missing] }),
      { fetch },
    );
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(UnavailableAttachmentsError);
});

test("budget: refs exceeding the raw cap throw BEFORE any fetch", async () => {
  const big = ref({ bytes: REHYDRATION_MAX_TOTAL_RAW_BYTES + 1 });
  const { fetch, requested } = fakeFetch(new Map());
  let caught: unknown;
  try {
    await rehydrateMultimodalContents(
      "ws-1",
      messagesWith({ role: "user", content: "x", attachments: [big] }),
      { fetch },
    );
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(AttachmentBudgetExceededError);
  expect(requested).toEqual([]);
});

test("budget accounting sums across all historical turns (messageRefBytes)", () => {
  const half = Math.ceil(REHYDRATION_MAX_TOTAL_RAW_BYTES / 2);
  const total = messageRefBytes([
    { role: "user", content: "a", attachments: [ref({ bytes: half })] },
    { role: "assistant", content: "b" },
    { role: "user", content: "c", attachments: [ref({ bytes: half + 1 })] },
  ]);
  expect(total).toBe(REHYDRATION_MAX_TOTAL_RAW_BYTES + 1);
  expect(
    messageRefBytes([{ role: "assistant", content: "no refs here" }]),
  ).toBe(0);
});

test("estimateEncodedAttachmentBytes applies the 4/3 base64 upper bound", () => {
  expect(estimateEncodedAttachmentBytes(0)).toBe(0);
  expect(estimateEncodedAttachmentBytes(3)).toBe(4);
  expect(estimateEncodedAttachmentBytes(10 * 1024 * 1024)).toBeLessThanOrEqual(16 * 1024 * 1024);
});

test("refToAttachment rebuilds images as data URLs and text as decoded UTF-8", () => {
  const image = refToAttachment(
    ref({ kind: "image", mime: "image/png", name: "s.png", bytes: PNG.byteLength }),
    PNG,
  );
  expect(image.dataUrl).toStartWith("data:image/png;base64,");
  const text = refToAttachment(
    ref({ kind: "text", name: "n.txt", bytes: 5 }),
    new TextEncoder().encode("hello"),
  );
  expect(text.text).toBe("hello");
});

test("stripAttachments removes only the explicitly omitted refs (history text untouched)", () => {
  const a = ref({ name: "a.txt" });
  const b = ref({ name: "b.txt" });
  const messages = messagesWith(
    { role: "user", content: "keep text", attachments: [a, b] },
    { role: "assistant", content: "reply" },
  );
  const stripped = stripAttachments(messages, new Set([a.id]));
  expect(stripped[0]?.attachments).toEqual([b]);
  expect(stripped[0]?.content).toBe("keep text");
  expect(stripped[1]?.content).toBe("reply");
  // Input history is never mutated in place.
  expect(messages[0]?.attachments?.length).toBe(2);
});
