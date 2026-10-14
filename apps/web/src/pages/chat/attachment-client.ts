// Persistent attachment uploads: sends the raw file bytes to
// POST /api/v1/workspaces/:id/attachments right after a validated pick, so
// the attachment survives reload/fork via its canonical ChatAttachmentRef.
// Local read/validation stays in ./attachments.ts (same limits); this module
// only talks to the wire. Upload failures never cache anything — retry is an
// explicit caller action. Bytes go in the request body only; never URLs,
// never logs (filenames are metadata and percent-encoded on the header).
import type { ChatAttachmentDto, ChatAttachmentRef } from "@hoborouter/shared";
import { AttachError, type ChatAttachment, createAttachment, validateFile } from "./attachments";

export type AttachmentUploadFailure =
  | "unauthorized" // 401 / no session: reconnect explicitly, then retry
  | "forbidden" // 403: not a workspace member
  | "tooLarge" // 413: over the per-kind byte cap
  | "unsupported" // 415: type not on the server allowlist
  | "quota" // 507: per-user storage quota exceeded
  | "network" // fetch threw before a response: retry explicitly
  | "invalid"; // unexpected status or response shape: never trust it

export class AttachmentUploadError extends Error {
  readonly kind: AttachmentUploadFailure;
  readonly status?: number;

  constructor(kind: AttachmentUploadFailure, message: string, status?: number) {
    super(message);
    this.name = "AttachmentUploadError";
    this.kind = kind;
    this.status = status;
  }
}

export interface UploadAttachmentOptions {
  /** Test seam: replaces the global fetch. */
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/** Extract the wire ref (the user-message attachments[] entry) from a DTO. */
export function attachmentRefOf(dto: ChatAttachmentDto): ChatAttachmentRef {
  return {
    id: dto.id,
    name: dto.name,
    kind: dto.kind,
    bytes: dto.bytes,
    mime: dto.mime,
    expires_at: dto.expires_at,
  };
}

/** Minimal runtime shape check — no Zod on the frontend (shared types are the
 *  frozen wire contract; a wrong shape is never trusted). */
function parseDto(body: unknown): ChatAttachmentDto {
  const b = body as Partial<ChatAttachmentDto> | null;
  if (
    typeof b?.id === "string" &&
    b.id !== "" &&
    (b.kind === "image" || b.kind === "text") &&
    typeof b.name === "string" &&
    typeof b.bytes === "number" &&
    typeof b.mime === "string" &&
    typeof b.expires_at === "number"
  ) {
    return b as ChatAttachmentDto;
  }
  throw new AttachmentUploadError(
    "invalid",
    "The server returned an unexpected attachment response. Try again.",
  );
}

/** Upload one supported File (raw bytes + percent-encoded filename header)
 *  and return the server's canonical DTO. Throws AttachmentUploadError on
 *  failure. The file is validated locally first so an oversized/unsupported
 *  pick never hits the network. */
export async function uploadChatAttachment(
  workspaceId: string,
  file: File,
  opts: UploadAttachmentOptions = {},
): Promise<ChatAttachmentDto> {
  try {
    validateFile(file);
  } catch (e) {
    // Local rejects join the same typed contract as server rejects — the
    // composer binding only has to handle AttachmentUploadError kinds.
    if (e instanceof AttachError) {
      if (e.code === "imageTooLarge" || e.code === "textTooLarge")
        throw new AttachmentUploadError("tooLarge", e.message);
      if (e.code === "unsupported") throw new AttachmentUploadError("unsupported", e.message);
    }
    throw e;
  }
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`/api/v1/workspaces/${workspaceId}/attachments`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Hbr-Filename": encodeURIComponent(file.name),
      },
      body: file,
      signal: opts.signal,
    });
  } catch {
    throw new AttachmentUploadError(
      "network",
      "Could not upload the attachment. Check your connection and try again.",
    );
  }
  if (res.ok) return parseDto(await res.json().catch(() => null));
  const kindByStatus: Record<number, AttachmentUploadFailure> = {
    401: "unauthorized",
    403: "forbidden",
    413: "tooLarge",
    415: "unsupported",
    507: "quota",
  };
  const kind = kindByStatus[res.status] ?? "invalid";
  throw new AttachmentUploadError(
    kind,
    `Attachment upload failed (${res.status}).`,
    res.status,
  );
}

/** Pick → validate → read locally → upload: one call for the composer
 *  binding. Returns the local ChatAttachment (immediately renderable, bytes
 *  in memory) plus `serverRef` for send-time persistence. If the upload
 *  fails the caller keeps full control: nothing was partially stored. */
export async function createPersistedAttachment(
  workspaceId: string,
  file: File,
  opts: UploadAttachmentOptions = {},
): Promise<ChatAttachment> {
  const local = await createAttachment(file);
  const dto = await uploadChatAttachment(workspaceId, file, opts);
  return { ...local, serverRef: attachmentRefOf(dto) };
}
