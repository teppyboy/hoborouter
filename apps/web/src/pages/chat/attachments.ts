// Chat file attachments: browser-side only, no storage service. Images are
// read as data URLs and sent as OpenAI `image_url` content parts (the gateway
// forwards the JSON body unchanged and auto-resolve already classifies
// image_url parts as vision); text/code files are read as strings and inlined
// (capped) into the prompt text part. Chat-purpose keys accept bodies up to
// 16 MiB (the approved attachment budget: 10 MiB raw total × 4/3 base64 plus
// prompt/history headroom), so per-file and total budgets keep the final
// request body below that cap — attachment bytes never reach logs or error
// messages, only filenames.
// Persistence of the raw bytes is a separate, explicit upload step — see
// ./attachment-client.ts (upload on pick) and ./persistent-attachments.ts
// (rehydration of persisted refs on reload).
import type { ChatAttachmentRef } from "@hoborouter/shared";
export interface ChatAttachment {
  id: string;
  kind: "image" | "text";
  name: string;
  bytes: number;
  /** Images only: full data URL (data:image/...;base64,...). */
  dataUrl?: string;
  /** Text files only: decoded file content. */
  text?: string;
  /** Server-persisted reference (canonical ChatAttachmentRef DTO) when this
   *  attachment was uploaded via POST /workspaces/:id/attachments. Optional
   *  for backward compatibility: session-only attachments and history
   *  snapshots written before persistent uploads have no ref. */
  serverRef?: ChatAttachmentRef;
}

/** UTF-8 byte length (the gateway caps bytes, not UTF-16 chars). */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Shorten to at most maxBytes UTF-8 bytes without splitting a code point. */
export function truncateToUtf8Bytes(text: string, maxBytes: number): string {
  if (utf8ByteLength(text) <= maxBytes) return text;
  const enc = new TextEncoder();
  let bytes = 0;
  let out = "";
  for (const ch of text) {
    const b = enc.encode(ch).length;
    if (bytes + b > maxBytes) break;
    out += ch;
    bytes += b;
  }
  return out;
}

export const ATTACHMENT_LIMITS = {
  maxCount: 4,
  maxImageBytes: 10 * 1024 * 1024,
  maxTextBytes: 64 * 1024,
  /** Sum of raw attachment bytes per message — the binding budget. With
   *  4/3 base64 expansion a full 10 MiB batch becomes ~13.4 MiB of JSON,
   *  inside the chat-purpose gateway's 16 MiB cap. */
  maxTotalBytes: 10 * 1024 * 1024,
  /** Cap on how much of a text file is inlined into the prompt. */
  maxTextInlineBytes: 16 * 1024,
} as const;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "json",
  "yaml",
  "yml",
  "toml",
  "log",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "css",
  "html",
  "py",
  "go",
  "rs",
  "java",
  "c",
  "h",
  "cpp",
  "sh",
  "sql",
  "env.example",
]);

const extension = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
};

const isImageFile = (file: { type: string; name: string }): boolean => IMAGE_TYPES.has(file.type);

const isTextFile = (file: { type: string; name: string }): boolean =>
  file.type.startsWith("text/") || TEXT_EXTENSIONS.has(extension(file.name));

/** Machine-readable rejection reasons. The chat page localizes these via
 *  chatCopy; the `message` strings here remain English fallbacks so unknown
 *  consumers keep readable detail. */
export type AttachErrorCode =
  | "unsupported"
  | "imageTooLarge"
  | "textTooLarge"
  | "tooMany"
  | "totalTooLarge";

export class AttachError extends Error {
  readonly code: AttachErrorCode;
  /** offending file name, when the rejection is about one specific file */
  readonly name2: string | null;

  constructor(code: AttachErrorCode, message: string, name?: string) {
    super(message);
    this.code = code;
    this.name2 = name ?? null;
  }
}

function unsupportedMessage(name: string): string {
  return `"${name}" is not a supported file type. Supported: PNG, JPEG, WebP, GIF images and plain text/code files.`;
}

function tooLargeMessage(name: string, maxBytes: number): string {
  return `"${name}" is too large (max ${Math.floor(maxBytes / (1024 * 1024))} MB per image).`;
}

function tooLargeTextMessage(name: string, maxBytes: number): string {
  return `"${name}" is too large (max ${Math.floor(maxBytes / 1024)} KB as text).`;
}

/** Type and per-file size validation only — no reads. Thrown before any
 *  arrayBuffer()/text() so a budget-busting file is never read. Shared by
 *  the local-read path and the persistent-upload path (attachment-client). */
export function validateFile(file: File): void {
  const { name, size } = file;
  if (isImageFile(file)) {
    if (size > ATTACHMENT_LIMITS.maxImageBytes) {
      throw new AttachError(
        "imageTooLarge",
        tooLargeMessage(name, ATTACHMENT_LIMITS.maxImageBytes),
        name,
      );
    }
    return;
  }
  if (isTextFile(file)) {
    if (size > ATTACHMENT_LIMITS.maxTextBytes) {
      throw new AttachError(
        "textTooLarge",
        tooLargeTextMessage(name, ATTACHMENT_LIMITS.maxTextBytes),
        name,
      );
    }
    return;
  }
  throw new AttachError("unsupported", unsupportedMessage(name), name);
}

/** Read one pre-validated File into a ChatAttachment. Attachment bytes are
 *  held only in memory, never logged. */
async function readAttachment(file: File): Promise<ChatAttachment> {
  const { name, type, size } = file;
  if (isImageFile(file)) {
    const buf = await file.arrayBuffer();
    return {
      id: crypto.randomUUID(),
      kind: "image",
      name,
      bytes: size,
      dataUrl: bytesToDataUrl(type, buf),
    };
  }
  return {
    id: crypto.randomUUID(),
    kind: "text",
    name,
    bytes: size,
    text: await file.text(),
  };
}

/** Read one supported File into a ChatAttachment; throws a user-facing
 *  message on unsupported types or oversized files. */
export async function createAttachment(file: File): Promise<ChatAttachment> {
  validateFile(file);
  return readAttachment(file);
}

/** data URL without FileReader: identical shape the gateway forwards. */
export function bytesToDataUrl(mime: string, buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

export interface AddAttachmentsResult {
  /** All validated attachments, or [] when the batch was rejected. */
  added: ChatAttachment[];
  /** First rejection reason. Structured codes localize; a bare string is an
   *  unexpected failure whose raw detail passes through. null on success. */
  error: AttachError | string | null;
}

/** All-or-nothing batch add: one invalid file rejects the whole selection
 *  (predictable UX — the user fixes the list instead of guessing what made
 *  it in). Enforces the per-message count and total-size budgets. */
export async function addAttachments(
  current: ChatAttachment[],
  files: File[],
): Promise<AddAttachmentsResult> {
  if (files.length === 0) return { added: [], error: null };
  if (current.length + files.length > ATTACHMENT_LIMITS.maxCount) {
    return {
      added: [],
      error: new AttachError(
        "tooMany",
        `You can attach at most ${ATTACHMENT_LIMITS.maxCount} files per message.`,
      ),
    };
  }
  const totalAfter =
    current.reduce((sum, a) => sum + a.bytes, 0) + files.reduce((sum, f) => sum + f.size, 0);
  if (totalAfter > ATTACHMENT_LIMITS.maxTotalBytes) {
    return {
      added: [],
      error: new AttachError(
        "totalTooLarge",
        `Attachments exceed the ${Math.floor(ATTACHMENT_LIMITS.maxTotalBytes / (1024 * 1024))} MB total limit. Remove something and try again.`,
      ),
    };
  }
  // Whole-batch preflight: EVERY file's type + size is validated before ANY
  // read, so a batch with an invalid second file never reads the first.
  const added: ChatAttachment[] = [];
  try {
    for (const file of files) validateFile(file);
    for (const file of files) added.push(await readAttachment(file));
  } catch (e) {
    // Structured rejections localize; anything else surfaces its raw detail.
    return {
      added: [],
      error:
        e instanceof AttachError ? e : e instanceof Error ? e.message : "Could not read that file.",
    };
  }
  return { added, error: null };
}

export function removeAttachment(list: ChatAttachment[], id: string): ChatAttachment[] {
  return list.filter((a) => a.id !== id);
}

export type UserContent =
  | string
  | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;

/** Prompt content for one user turn. Without attachments this is the plain
 *  string the text-only path has always sent; with attachments it becomes
 *  OpenAI content parts — text first, then each image as an image_url part.
 *  Text files are fenced inline into the text part, capped at
 *  maxTextInlineBytes so a single file cannot dominate the prompt. */
export function buildUserContent(text: string, attachments: ChatAttachment[]): UserContent {
  if (attachments.length === 0) return text;
  let prompt = text;
  for (const a of attachments) {
    if (a.kind !== "text" || !a.text) continue;
    const truncated = truncateToUtf8Bytes(a.text, ATTACHMENT_LIMITS.maxTextInlineBytes);
    const excerpt =
      truncated.length === a.text.length
        ? truncated
        : `${truncated}\n… (truncated, full file is ${a.bytes} bytes)`;
    prompt += `\n\n--- Attached file: ${a.name} ---\n${excerpt}\n--- End of ${a.name} ---`;
  }
  const parts: UserContent = [{ type: "text", text: prompt }];
  for (const a of attachments) {
    if (a.kind === "image" && a.dataUrl) {
      parts.push({ type: "image_url", image_url: { url: a.dataUrl } });
    }
  }
  return parts;
}

/** Human-readable limits for the attach UI (title/help text). */
export const ATTACHMENT_HINT = `PNG, JPEG, WebP or GIF images and text/code files up to ${Math.floor(
  ATTACHMENT_LIMITS.maxTextBytes / 1024,
)} KB; up to ${ATTACHMENT_LIMITS.maxCount} files, ${Math.floor(
  ATTACHMENT_LIMITS.maxTotalBytes / (1024 * 1024),
)} MB total per message.`;

/** Session-only retention disclosure shown wherever attachments are visible. */
export const ATTACHMENT_RETENTION_NOTICE =
  "Attachments are sent only with this message — they are not saved to your chat history and are lost after reload or New chat.";

/** Base history strings plus retained per-turn multimodal content becomes the
 *  request history. `contents` maps the 0-based user-turn index to the full
 *  content captured when that turn was sent (string or content parts); a
 *  missing entry degrades to the plain string (reloaded conversations). */
export function withMultimodalContent(
  base: Array<{ role: "user" | "assistant"; content: string }>,
  contents: Map<number, UserContent> | undefined,
): Array<{ role: "user" | "assistant"; content: string | UserContent }> {
  let userIdx = 0;
  return base.map((m) =>
    m.role === "user"
      ? { role: "user", content: contents?.get(userIdx++) ?? m.content }
      : { role: m.role, content: m.content },
  );
}
