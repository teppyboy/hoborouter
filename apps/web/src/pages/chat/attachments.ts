// Chat file attachments: browser-side only, no storage service. Images are
// read as data URLs and sent as OpenAI `image_url` content parts (the gateway
// forwards the JSON body unchanged and auto-resolve already classifies
// image_url parts as vision); text/code files are read as strings and inlined
// (capped) into the prompt text part. The gateway accepts bodies up to 1 MiB,
// so per-file and total budgets keep the final request body far below that
// cap — attachment bytes never reach logs or error messages, only filenames.
export interface ChatAttachment {
  id: string;
  kind: "image" | "text";
  name: string;
  bytes: number;
  /** Images only: full data URL (data:image/...;base64,...). */
  dataUrl?: string;
  /** Text files only: decoded file content. */
  text?: string;
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
  maxImageBytes: 384 * 1024,
  maxTextBytes: 64 * 1024,
  /** Sum of raw attachment bytes per message — keeps the JSON body well
   *  under the gateway's 1 MiB cap even at 4/3 base64 expansion. */
  maxTotalBytes: 384 * 1024,
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

function unsupportedMessage(name: string): string {
  return `"${name}" is not a supported file type. Supported: PNG, JPEG, WebP, GIF images and plain text/code files.`;
}

function tooLargeMessage(name: string, maxBytes: number): string {
  return `"${name}" is too large (max ${Math.floor(maxBytes / 1024)} KB per image).`;
}

function tooLargeTextMessage(name: string, maxBytes: number): string {
  return `"${name}" is too large (max ${Math.floor(maxBytes / 1024)} KB as text).`;
}

/** Read one supported File into a ChatAttachment; throws a user-facing
 *  message on unsupported types or oversized files. Attachment bytes are
 *  held only in memory, never logged. */
export async function createAttachment(file: File): Promise<ChatAttachment> {
  const { name, type, size } = file;
  if (isImageFile(file)) {
    if (size > ATTACHMENT_LIMITS.maxImageBytes) {
      throw new Error(tooLargeMessage(name, ATTACHMENT_LIMITS.maxImageBytes));
    }
    const buf = await file.arrayBuffer();
    return {
      id: crypto.randomUUID(),
      kind: "image",
      name,
      bytes: size,
      dataUrl: bytesToDataUrl(type, buf),
    };
  }
  if (isTextFile(file)) {
    if (size > ATTACHMENT_LIMITS.maxTextBytes) {
      throw new Error(tooLargeTextMessage(name, ATTACHMENT_LIMITS.maxTextBytes));
    }
    return {
      id: crypto.randomUUID(),
      kind: "text",
      name,
      bytes: size,
      text: await file.text(),
    };
  }
  throw new Error(unsupportedMessage(name));
}

/** data URL without FileReader: identical shape the gateway forwards. */
function bytesToDataUrl(mime: string, buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
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
  /** First rejection reason, user-facing; null on success. */
  error: string | null;
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
      error: `You can attach at most ${ATTACHMENT_LIMITS.maxCount} files per message.`,
    };
  }
  const totalAfter =
    current.reduce((sum, a) => sum + a.bytes, 0) + files.reduce((sum, f) => sum + f.size, 0);
  if (totalAfter > ATTACHMENT_LIMITS.maxTotalBytes) {
    return {
      added: [],
      error: `Attachments exceed the total attachment size limit (${Math.floor(ATTACHMENT_LIMITS.maxTotalBytes / 1024)} KB per message). Remove something and try again.`,
    };
  }
  const added: ChatAttachment[] = [];
  for (const file of files) {
    try {
      added.push(await createAttachment(file));
    } catch (e) {
      return { added: [], error: e instanceof Error ? e.message : "Could not read that file." };
    }
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
export const ATTACHMENT_HINT = `PNG, JPEG, WebP or GIF up to ${Math.floor(
  ATTACHMENT_LIMITS.maxImageBytes / 1024,
)} KB; text or code files up to ${Math.floor(ATTACHMENT_LIMITS.maxTextBytes / 1024)} KB; up to ${ATTACHMENT_LIMITS.maxCount} files, ${Math.floor(ATTACHMENT_LIMITS.maxTotalBytes / 1024)} KB total.`;

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
