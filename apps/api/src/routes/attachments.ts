// Chat file attachments API (files lane): raw-byte upload/download with
// session + workspace-membership + owner authorization — Bearer keys never
// grant access. Bytes live at data/chat-attachments/<uuid>; the client never
// supplies any path component. Quota (500 MiB live per user) is enforced
// under a per-user in-process lock so concurrent uploads cannot double-spend.
import { Elysia } from "elysia";
import { closeSync, constants, openSync, readFileSync } from "node:fs";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@hoborouter/db";
import { chatAttachments } from "@hoborouter/db";
import {
  CHAT_ATTACHMENT_MAX_IMAGE_BYTES,
  CHAT_ATTACHMENT_MAX_TEXT_BYTES,
  CHAT_ATTACHMENT_QUOTA_BYTES,
  CHAT_ATTACHMENT_TTL_MS,
  type ChatAttachmentDto,
} from "@hoborouter/shared";
import type { BetterAuthInstance } from "../auth-types";
import { jsonError, requireSession, requireWsRole } from "../authz";
import {
  attachmentDir,
  attachmentPath,
  persistAttachmentFile,
  removeAttachmentFile,
  withUserLock,
} from "../chat-attachment-store";

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Magic-byte sniff (client mime is untrusted); mirrors account.ts avatar logic. */
function magicMime(bytes: Uint8Array): string | null {
  if (
    bytes.length > 12 &&
    bytes[0] === 0x52 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return "image/png";
  return null;
}

/** Decode the percent-encoded X-Hbr-Filename header exactly once; reject
 *  malformed escapes, control characters, and path separators. */
export function decodeFilename(raw: string | null): string | null {
  if (!raw) return null;
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return null; // malformed percent-escape
  }
  if (!name || name.length > 255) return null;
  if (/[\\/]/.test(name)) return null;
  for (const ch of name) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || c === 0x7f) return null;
  }
  return name;
}

/** RFC 5987 Content-Disposition with an ASCII fallback; never reflects raw bytes. */
function contentDisposition(name: string, inline: boolean): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(name);
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * CSRF boundary for unsafe methods: when a browser sends an Origin header it
 * must match the configured trusted origins (base URL + HBR_TRUSTED_ORIGINS).
 * The Host header is never reflected. Absent Origin (server-to-server, tests)
 * relies on SameSite session cookies.
 */
function originAllowed(env: Record<string, string | undefined>, origin: string): boolean {
  const allowed = new Set<string>();
  const base = env.BETTER_AUTH_URL || env.HBR_BASE_URL || "http://localhost:3000";
  try {
    allowed.add(new URL(base).origin);
  } catch {
    /* misconfigured base: trusted-origins list still applies */
  }
  for (const o of env.HBR_TRUSTED_ORIGINS?.split(",") ?? []) {
    const t = o.trim();
    if (!t) continue;
    try {
      allowed.add(new URL(t).origin);
    } catch {
      allowed.add(t);
    }
  }
  try {
    return allowed.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

function csrfGate(env: Record<string, string | undefined>, request: Request): Response | null {
  const origin = request.headers.get("origin");
  if (origin && !originAllowed(env, origin)) {
    return jsonError(403, "UNTRUSTED_ORIGIN", "Origin is not a trusted origin");
  }
  return null;
}

/** Read the request body with a hard byte cap (stream-counted; rejects before
 *  buffering on a lying-or-oversized Content-Length). */
async function readCapped(request: Request, cap: number) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isSafeInteger(declared) && declared > cap) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return total === 0 ? null : Buffer.concat(chunks);
}

function dto(row: typeof chatAttachments.$inferSelect): ChatAttachmentDto {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as "image" | "text",
    bytes: Number(row.bytes),
    mime: row.mime,
    expires_at: Number(row.expires_at),
    workspace_id: row.workspace_id,
    created_at: Number(row.created_at),
    deleted_at: row.deleted_at === null ? null : Number(row.deleted_at),
  };
}

/**
 * Load an attachment the caller owns. Anything not owned by the session user
 * (other members' uploads, other workspaces, nonexistent ids) is a uniform
 * 404; own expired/deleted rows are 410 with metadata retained in history.
 */
export async function loadOwnedAttachment(
  db: Db,
  workspaceId: string,
  attachmentId: string,
  userId: string,
) {
  const rows = await db
    .select()
    .from(chatAttachments)
    .where(
      and(eq(chatAttachments.id, attachmentId), eq(chatAttachments.workspace_id, workspaceId)),
    )
    .limit(1);
  const row = rows[0];
  if (!row || row.user_id !== userId) return { error: jsonError(404, "NOT_FOUND", "Not found") };
  if (row.deleted_at !== null || row.expires_at < Date.now()) {
    return { error: jsonError(410, "GONE", "Attachment expired") };
  }
  return { row } as const;
}

export const attachmentRoutes = (
  db: Db,
  auth: BetterAuthInstance,
  env: Record<string, string | undefined> = process.env,
) =>
  new Elysia({ name: "chat-attachments" })
    .post(
      "/api/v1/workspaces/:workspaceId/attachments",
      {
        detail: {
          tags: ["Workspaces"],
          summary: "Upload a chat attachment",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, set }) => {
        const csrf = csrfGate(env, request);
        if (csrf) return csrf;
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const roleErr = await requireWsRole(db, params.workspaceId, userId, "member");
        if (roleErr) return roleErr;

        const declaredMime = (request.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
        const isImage = IMAGE_MIMES.has(declaredMime);
        const isText = declaredMime === "text/plain";
        if (!isImage && !isText)
          return jsonError(
            415,
            "UNSUPPORTED_TYPE",
            "Allowed types: image/png, image/jpeg, image/webp, text/plain",
          );
        const cap = isImage ? CHAT_ATTACHMENT_MAX_IMAGE_BYTES : CHAT_ATTACHMENT_MAX_TEXT_BYTES;
        const bytes = await readCapped(request, cap);
        if (!bytes) return jsonError(413, "TOO_LARGE", `Attachment exceeds ${cap} bytes`);

        let mime: string;
        let kind: "image" | "text";
        if (isImage) {
          const sniffed = magicMime(bytes);
          if (!sniffed || sniffed !== declaredMime)
            return jsonError(400, "INVALID_IMAGE", "File does not match its image MIME type");
          mime = sniffed; // canonical: magic-derived, never the client header
          kind = "image";
        } else {
          let text: string;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            return jsonError(400, "INVALID_TEXT", "Text attachment must be valid UTF-8");
          }
          if (text.includes("\u0000"))
            return jsonError(400, "INVALID_TEXT", "Text attachment must not contain NUL bytes");
          mime = "text/plain"; // canonical; client charset hints are dropped
          kind = "text";
        }

        const name = decodeFilename(request.headers.get("x-hbr-filename"));
        if (!name) return jsonError(400, "INVALID_NAME", "Invalid or missing X-Hbr-Filename");

        const dir = attachmentDir(env);
        const id = crypto.randomUUID();
        const now = Date.now();
        try {
          // Quota check + insert serialize per user: no concurrent double-spend.
          const row = await withUserLock(userId, () =>
            persistAttachmentFile(dir, id, bytes, async (finalize) => {
              return db.transaction(async (tx) => {
                const [sum] = await tx
                  .select({ total: sql<string | null>`coalesce(sum(${chatAttachments.bytes}), 0)` })
                  .from(chatAttachments)
                  .where(
                    and(eq(chatAttachments.user_id, userId), isNull(chatAttachments.deleted_at)),
                  );
                if (Number(sum?.total ?? 0) + bytes.byteLength > CHAT_ATTACHMENT_QUOTA_BYTES) {
                  return { quotaExceeded: true as const };
                }
                const inserted = (
                  await tx
                    .insert(chatAttachments)
                    .values({
                      id,
                      user_id: userId,
                      workspace_id: params.workspaceId,
                      kind,
                      name,
                      mime,
                      bytes: bytes.byteLength,
                      created_at: now,
                      expires_at: now + CHAT_ATTACHMENT_TTL_MS,
                    })
                    .returning()
                )[0];
                if (!inserted) throw new Error("chat attachment insert returned no row");
                finalize();
                return { row: inserted };
              });
            }),
          );
          if ("quotaExceeded" in row && row.quotaExceeded) {
            return jsonError(413, "QUOTA_EXCEEDED", "Attachment storage quota exceeded");
          }
          set.status = 201;
          return dto(row.row);
        } catch (e) {
          // DB failure after the bytes landed: the store already cleaned the
          // temp file; make sure no half-renamed file outlives the failed row.
          try {
            removeAttachmentFile(dir, id);
          } catch {
            /* GC orphan sweep reaps it; nothing else to do */
          }
          if (e instanceof Error && e.message.includes("quota")) {
            return jsonError(413, "QUOTA_EXCEEDED", "Attachment storage quota exceeded");
          }
          return jsonError(500, "INTERNAL", "Upload failed");
        }
      },
    )
    .get(
      "/api/v1/workspaces/:workspaceId/attachments/:attachmentId",
      {
        detail: {
          tags: ["Workspaces"],
          summary: "Download a chat attachment",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const roleErr = await requireWsRole(db, params.workspaceId, gate.session.user.id, "member");
        if (roleErr) return roleErr;
        const owned = await loadOwnedAttachment(
          db,
          params.workspaceId,
          params.attachmentId,
          gate.session.user.id,
        );
        if ("error" in owned) return owned.error;
        const row = owned.row;
        // Row is live but the bytes are gone or replaced by a symlink: same answer.
        let bytes: Buffer;
        try {
          const path = attachmentPath(attachmentDir(env), row.id);
          const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            bytes = readFileSync(fd);
          } finally {
            closeSync(fd);
          }
        } catch {
          return jsonError(410, "GONE", "Attachment expired");
        }
        return new Response(new Uint8Array(bytes), {
          headers: {
            "content-type": row.kind === "text" ? "text/plain; charset=utf-8" : row.mime,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "content-disposition": contentDisposition(row.name, row.kind === "image"),
          },
        });
      },
    )
    .delete(
      "/api/v1/workspaces/:workspaceId/attachments/:attachmentId",
      {
        detail: {
          tags: ["Workspaces"],
          summary: "Delete a chat attachment",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
        const csrf = csrfGate(env, request);
        if (csrf) return csrf;
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const roleErr = await requireWsRole(db, params.workspaceId, gate.session.user.id, "member");
        if (roleErr) return roleErr;
        const userId = gate.session.user.id;
        const rows = await db
          .select()
          .from(chatAttachments)
          .where(
            and(
              eq(chatAttachments.id, params.attachmentId),
              eq(chatAttachments.workspace_id, params.workspaceId),
            ),
          )
          .limit(1);
        const row = rows[0];
        if (!row || row.user_id !== userId)
          return jsonError(404, "NOT_FOUND", "Not found");
        // Idempotent tombstone: history snapshots keep the metadata forever.
        if (row.deleted_at === null) {
          await db
            .update(chatAttachments)
            .set({ deleted_at: Date.now() })
            .where(and(eq(chatAttachments.id, row.id), isNull(chatAttachments.deleted_at)));
        }
        try {
          removeAttachmentFile(attachmentDir(env), row.id);
        } catch {
          /* GC sweep retries unlink; delete stays idempotent */
        }
        return { id: row.id, deleted: true };
      },
    );
