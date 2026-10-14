// Rehydration of persisted chat attachment refs into sendable content. After
// a reload (or fork) a conversation's user turns carry only refs
// (ChatAttachmentRef in the messages snapshot); the raw bytes come back via
// authenticated session GET /workspaces/:id/attachments/:id. This module
// rebuilds the exact multimodal content the original send produced
// (image data URLs + fenced inline text through the current buildUserContent)
// under hard bounds — it never concatenates unbounded bytes and never drops
// an unavailable file silently: a 404/410 ref raises
// UnavailableAttachmentsError and the caller must BLOCK the next generation
// until the user explicitly omits those files (never silently text-only).
// Retained history is never pruned or rewritten here — refs stay in the
// snapshot even when their bytes are gone (30-day TTL / tombstone).
import type { ChatAttachmentRef, ConversationMessage } from "@hoborouter/shared";
import {
  ATTACHMENT_LIMITS,
  buildUserContent,
  bytesToDataUrl,
  type ChatAttachment,
  type UserContent,
} from "./attachments";

/**
 * Bound on the TOTAL raw attachment bytes rehydrated across ALL historical
 * turns of one send. The chat-purpose gateway caps request bodies at 16 MiB;
 * base64 expands 4/3, so 10 MiB raw (the same per-message budget) keeps the
 * rehydrated body inside the cap with prompt/history headroom. The parent
 * additionally preflights the encoded body before dispatch (see
 * estimateEncodedAttachmentBytes).
 */
export const REHYDRATION_MAX_TOTAL_RAW_BYTES = ATTACHMENT_LIMITS.maxTotalBytes;

/** One file the user referenced but whose bytes the server no longer has. */
export interface UnavailableAttachment {
  id: string;
  name: string;
}

/**
 * Raised when any persisted ref 404s (foreign/missing/tombstoned) or 410s
 * (expired) during rehydration. Carries every unavailable id+name so the
 * caller can show them and require an explicit user omit decision before
 * the next generation. A generation NEVER proceeds with a partial subset.
 */
export class UnavailableAttachmentsError extends Error {
  readonly unavailable: UnavailableAttachment[];

  constructor(unavailable: UnavailableAttachment[]) {
    super(
      `${unavailable.length} attached file(s) are no longer available: ${unavailable
        .map((u) => u.name)
        .join(", ")}.`,
    );
    this.name = "UnavailableAttachmentsError";
    this.unavailable = unavailable;
  }
}

/** Raised BEFORE any fetch when the persisted refs alone exceed the raw
 *  rehydration budget — the send is blocked, nothing was fetched. */
export class AttachmentBudgetExceededError extends Error {
  constructor() {
    super("Persisted attachments exceed the rehydration budget for one request.");
    this.name = "AttachmentBudgetExceededError";
  }
}

export interface RehydrateOptions {
  /** Test seam: replaces the global fetch. */
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/** Fetch one ref's bytes as the authenticated owner. Returns null ONLY for
 *  404/410 (the typed-unavailable cases); any other failure throws so the
 *  caller surfaces an explicit retry instead of silently degrading. */
async function fetchRefBytes(
  workspaceId: string,
  ref: ChatAttachmentRef,
  opts: RehydrateOptions,
): Promise<Uint8Array | null> {
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`/api/v1/workspaces/${workspaceId}/attachments/${ref.id}`, {
      method: "GET",
      credentials: "include",
      signal: opts.signal,
    });
  } catch {
    throw new Error("Could not fetch an attached file. Check your connection and try again.");
  }
  if (res.ok) return new Uint8Array(await res.arrayBuffer());
  if (res.status === 404 || res.status === 410) return null;
  throw new Error(`Could not fetch an attached file (${res.status}).`);
}

/** Rebuild a ref + its fetched bytes into the same ChatAttachment shape the
 *  original pick produced (image → data URL, text → decoded string). */
export function refToAttachment(ref: ChatAttachmentRef, bytes: Uint8Array): ChatAttachment {
  if (ref.kind === "image") {
    // Copy into a fresh buffer: res.arrayBuffer() yields a non-resizable
    // buffer that bytesToDataUrl's chunked String.fromCharCode can consume,
    // but passing the Uint8Array view keeps the types honest.
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return {
      id: ref.id,
      kind: "image",
      name: ref.name,
      bytes: ref.bytes,
      dataUrl: bytesToDataUrl(ref.mime, copy),
    };
  }
  return {
    id: ref.id,
    kind: "text",
    name: ref.name,
    bytes: ref.bytes,
    text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  };
}

/** Total raw bytes a message's persisted refs claim — the cheap preflight
 *  (no fetching) for the whole-conversation budget. */
export function messageRefBytes(messages: ConversationMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (m.role === "user" && m.attachments) {
      for (const a of m.attachments) total += a.bytes;
    }
  }
  return total;
}

/** Upper bound of a JSON request body's attachment contribution once base64
 *  (4/3) expansion is applied. Parent preflight: keep
 *  prompt + history + this estimate under the 16 MiB chat-purpose cap. */
export function estimateEncodedAttachmentBytes(totalRawBytes: number): number {
  return Math.ceil((totalRawBytes * 4) / 3);
}

/**
 * Rebuild the per-user-turn multimodal contents Map (the input to
 * withMultimodalContent) for a persisted conversation. User-turn indices
 * match withMultimodalContent exactly (every user message counts, turns
 * without refs map to their plain string and are absent from the Map).
 *
 * Budget: the persisted refs are summed FIRST; exceeding the raw cap throws
 * AttachmentBudgetExceededError before any fetch. Unavailable refs (404/410)
 * accumulate across turns; if any exist the whole rehydration throws
 * UnavailableAttachmentsError — the caller blocks until the user explicitly
 * omits them (stripAttachments) and retries.
 */
export async function rehydrateMultimodalContents(
  workspaceId: string,
  messages: ConversationMessage[],
  opts: RehydrateOptions = {},
): Promise<Map<number, UserContent>> {
  if (messageRefBytes(messages) > REHYDRATION_MAX_TOTAL_RAW_BYTES) {
    throw new AttachmentBudgetExceededError();
  }
  const contents = new Map<number, UserContent>();
  const unavailable: UnavailableAttachment[] = [];
  let userIdx = 0;
  for (const m of messages) {
    if (m.role !== "user") continue;
    const refs = m.attachments ?? [];
    if (refs.length > 0) {
      const attachments: ChatAttachment[] = [];
      for (const ref of refs) {
        const bytes = await fetchRefBytes(workspaceId, ref, opts);
        if (bytes === null) {
          unavailable.push({ id: ref.id, name: ref.name });
          continue;
        }
        attachments.push(refToAttachment(ref, bytes));
      }
      if (unavailable.length === 0) contents.set(userIdx, buildUserContent(m.content, attachments));
    }
    userIdx++;
  }
  if (unavailable.length > 0) throw new UnavailableAttachmentsError(unavailable);
  return contents;
}

/**
 * Remove the given refs from user turns (and their content contribution from
 * the rehydrated map is implicit — the turn falls back to its plain string).
 * ONLY for an explicit user omit decision after UnavailableAttachmentsError:
 * persisted history snapshots themselves are never rewritten or pruned.
 */
export function stripAttachments(
  messages: ConversationMessage[],
  omitIds: ReadonlySet<string>,
): ConversationMessage[] {
  return messages.map((m) =>
    m.role === "user" && m.attachments
      ? { ...m, attachments: m.attachments.filter((a) => !omitIds.has(a.id)) }
      : m,
  );
}
