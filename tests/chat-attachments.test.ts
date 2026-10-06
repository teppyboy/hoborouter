// Chat file attachments: pure helper behavior — accepted file shapes (browser-
// read images as multimodal parts, bounded plain text as prompt content),
// rejection of unsupported/oversized files, total budget, and payload building.
// Real File objects are constructed in-memory; no network, no provider.
import { test, expect } from "bun:test";
import {
  ATTACHMENT_LIMITS,
  addAttachments,
  buildUserContent,
  createAttachment,
  removeAttachment,
  truncateToUtf8Bytes,
  utf8ByteLength,
  withMultimodalContent,
  type ChatAttachment,
} from "../apps/web/src/pages/chat/attachments";

const png = (bytes: number): File =>
  new File([new Uint8Array(bytes)], "shot.png", { type: "image/png" });

const textFile = (content: string, name = "notes.txt"): File =>
  new File([content], name, { type: "text/plain" });

test("accepts an in-limit image and reads it as a data URL", async () => {
  const a = await createAttachment(png(1024));
  expect(a.kind).toBe("image");
  expect(a.name).toBe("shot.png");
  expect(a.dataUrl).toStartWith("data:image/png;base64,");
  expect(a.bytes).toBe(1024);
});

test("accepts a plain-text file and keeps its text content", async () => {
  const a = await createAttachment(textFile("hello world"));
  expect(a.kind).toBe("text");
  expect(a.text).toBe("hello world");
  expect(a.dataUrl).toBeUndefined();
});

test("accepts code files by extension even without a text/ MIME type", async () => {
  const a = await createAttachment(new File(["x=1"], "main.ts", { type: "" }));
  expect(a.kind).toBe("text");
  expect(a.text).toBe("x=1");
});

test("rejects unsupported file types with a message naming the limits, not the bytes", async () => {
  const pdf = new File([new Uint8Array(10)], "doc.pdf", { type: "application/pdf" });
  expect(() => createAttachment(pdf)).toThrow(
    `"doc.pdf" is not a supported file type. Supported: PNG, JPEG, WebP, GIF images and plain text/code files.`,
  );
});

test("rejects an oversized image", async () => {
  const big = png(ATTACHMENT_LIMITS.maxImageBytes + 1);
  expect(() => createAttachment(big)).toThrow(
    `"shot.png" is too large (max ${Math.floor(ATTACHMENT_LIMITS.maxImageBytes / 1024)} KB per image).`,
  );
});

test("rejects an oversized text file", async () => {
  const big = textFile("a".repeat(ATTACHMENT_LIMITS.maxTextBytes + 1));
  expect(() => createAttachment(big)).toThrow(`"notes.txt" is too large`);
});

test("addAttachments is all-or-nothing: one bad file rejects the whole batch", async () => {
  const good = png(64);
  const bad = new File([new Uint8Array(4)], "doc.pdf", { type: "application/pdf" });
  const res = await addAttachments([], [good, bad]);
  expect(res.added).toHaveLength(0);
  expect(res.error).toContain("doc.pdf");
});

test("addAttachments enforces the per-message count limit", async () => {
  const files = Array.from({ length: ATTACHMENT_LIMITS.maxCount + 1 }, (_, i) =>
    textFile("x", `f${i}.txt`),
  );
  const res = await addAttachments([], files);
  expect(res.error).toContain(`at most ${ATTACHMENT_LIMITS.maxCount}`);
});

test("addAttachments enforces the total-size budget across images", async () => {
  const half = Math.floor(ATTACHMENT_LIMITS.maxTotalBytes / 2) + 1;
  const res = await addAttachments([], [png(half), png(half)]);
  expect(res.error).toContain("total attachment");
});

test("removeAttachment drops only the targeted attachment", async () => {
  const a = await createAttachment(textFile("a", "a.txt"));
  const b = await createAttachment(textFile("b", "b.txt"));
  const rest = removeAttachment([a, b], a.id);
  expect(rest).toHaveLength(1);
  expect(rest[0]?.id).toBe(b.id);
});

test("buildUserContent with no attachments stays a plain string (text chat unchanged)", () => {
  expect(buildUserContent("hi", [])).toBe("hi");
});

test("buildUserContent with images returns OpenAI content parts in a stable order", () => {
  const img: ChatAttachment = {
    id: "i1",
    kind: "image",
    name: "shot.png",
    bytes: 4,
    dataUrl: "data:image/png;base64,AAAA",
  };
  const parts = buildUserContent("what is this?", [img]);
  expect(Array.isArray(parts)).toBe(true);
  const arr = parts as Array<Record<string, unknown>>;
  expect(arr).toHaveLength(2);
  expect(arr[0]).toEqual({ type: "text", text: "what is this?" });
  expect(arr[1]).toEqual({
    type: "image_url",
    image_url: { url: "data:image/png;base64,AAAA" },
  });
});

test("buildUserContent inlines text-file content into the text part", () => {
  const file: ChatAttachment = {
    id: "t1",
    kind: "text",
    name: "notes.txt",
    bytes: 5,
    text: "alpha",
  };
  const parts = buildUserContent("review this", [file]);
  const arr = parts as Array<Record<string, unknown>>;
  expect(arr[0]).toMatchObject({ type: "text" });
  expect(String((arr[0] as { text: string }).text)).toContain("review this");
  expect(String((arr[0] as { text: string }).text)).toContain("alpha");
});

test("buildUserContent keeps the payload bounded: text files are truncated into the prompt", () => {
  const file: ChatAttachment = {
    id: "t1",
    kind: "text",
    name: "big.log",
    bytes: ATTACHMENT_LIMITS.maxTextBytes,
    text: "b".repeat(ATTACHMENT_LIMITS.maxTextBytes),
  };
  const parts = buildUserContent("log:", [file]);
  expect(Array.isArray(parts)).toBe(true);
  const first = (parts as Array<{ text: string }>)[0];
  if (!first) throw new Error("expected a text part");
  // The inline excerpt is truncated; the fenced prompt stays far below the
  // raw file size even with the surrounding markers.
  expect(first.text).toContain("… (truncated");
  expect(first.text.length).toBeLessThan(ATTACHMENT_LIMITS.maxTextInlineBytes + 200);
});

test("utf8ByteLength counts UTF-8 bytes, not UTF-16 chars (gateway cap is bytes)", () => {
  expect(utf8ByteLength("abc")).toBe(3);
  // Emoji is 2 UTF-16 chars but 4 UTF-8 bytes.
  expect(utf8ByteLength("😀")).toBe(4);
  expect(utf8ByteLength("😀".repeat(3))).toBe(12);
});

test("truncateToUtf8Bytes enforces a byte ceiling without splitting code points", () => {
  expect(truncateToUtf8Bytes("hello", 10)).toBe("hello");
  const emojis = "😀".repeat(10); // 40 bytes
  const cut = truncateToUtf8Bytes(emojis, 12);
  expect(utf8ByteLength(cut)).toBeLessThanOrEqual(12);
  expect(cut).toBe("😀😀😀"); // 12 bytes exactly, no half-surrogate
});

test("withMultimodalContent overlays retained per-turn content by user-turn index", () => {
  const base = [
    { role: "user" as const, content: "first" },
    { role: "assistant" as const, content: "reply" },
    { role: "user" as const, content: "second" },
  ];
  const parts = [{ type: "text" as const, text: "first+img" }];
  const out = withMultimodalContent(base, new Map([[0, parts]]));
  expect(out[0]?.content).toBe(parts);
  expect(out[1]?.content).toBe("reply");
  // Missing entry degrades to the plain string (reloaded conversations).
  expect(out[2]?.content).toBe("second");
  expect(withMultimodalContent(base, undefined)).toEqual(base);
});
