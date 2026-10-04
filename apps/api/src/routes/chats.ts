// Chat history storage routes (context storage ONLY — never billed, never
// touches wallet/ledger; the paid gateway stays in v1-gateway.ts). One row per
// conversation in chat_conversations; messages are a plain-text jsonb array.
// Access = owner (session user) AND current workspace membership; workspace
// admins/owners and instance admins get no visibility into other users'
// conversations. Optimistic concurrency via conditional version UPDATE.
import { Elysia, t } from "elysia";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireWsRole, jsonError, writeAudit } from "../authz";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { type Db, chatConversations } from "@hoborouter/db";

const MAX_BODY_BYTES = 512 * 1024; // 512 KiB inbound JSON body limit
const MAX_MESSAGES = 500;
const MAX_MESSAGE_CONTENT = 64 * 1024; // 64 KiB per message content
const MAX_TITLE = 120;
const LIST_LIMIT = 50;

type ChatMessage = { role: "user" | "assistant"; content: string; reasoning?: string };

/** Read the request body with a hard byte cap, canceling the stream on overflow. */
async function readBoundedBody(
  request: Request,
): Promise<{ body?: Record<string, unknown>; error?: Response }> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isSafeInteger(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return { error: jsonError(413, "PAYLOAD_TOO_LARGE", "Request body exceeds 512 KiB") };
  }
  const reader = request.body?.getReader();
  if (!reader) return { error: jsonError(400, "INVALID", "Body must be a JSON object") };
  let total = 0;
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return { error: jsonError(413, "PAYLOAD_TOO_LARGE", "Request body exceeds 512 KiB") };
    }
    chunks.push(value);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(Buffer.concat(chunks))) as unknown;
  } catch {
    return { error: jsonError(400, "INVALID", "Body must be a JSON object") };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: jsonError(400, "INVALID", "Body must be a JSON object") };
  }
  return { body: parsed as Record<string, unknown> };
}

/** Validate the PUT message array; returns sanitized plain-text messages or an error. */
function validateMessages(raw: unknown): { messages?: ChatMessage[]; error?: Response } {
  if (!Array.isArray(raw)) {
    return { error: jsonError(400, "INVALID", "messages must be an array") };
  }
  if (raw.length > MAX_MESSAGES) {
    return {
      error: jsonError(400, "INVALID", `messages must have at most ${MAX_MESSAGES} entries`),
    };
  }
  const messages: ChatMessage[] = [];
  for (const m of raw) {
    if (typeof m !== "object" || m === null) {
      return { error: jsonError(400, "INVALID", "each message must be an object") };
    }
    const rec = m as Record<string, unknown>;
    // Plain-text user/assistant only — system/tool roles and any other
    // metadata fields are rejected, never stored.
    if (rec.role !== "user" && rec.role !== "assistant") {
      return { error: jsonError(400, "INVALID", "message role must be 'user' or 'assistant'") };
    }
    if (
      typeof rec.content !== "string" ||
      Buffer.byteLength(rec.content, "utf8") > MAX_MESSAGE_CONTENT
    ) {
      return {
        error: jsonError(
          400,
          "INVALID",
          `message content must be a string of at most ${MAX_MESSAGE_CONTENT} bytes`,
        ),
      };
    }
    const msg: ChatMessage = { role: rec.role, content: rec.content };
    if (rec.reasoning !== undefined) {
      if (typeof rec.reasoning !== "string") {
        return { error: jsonError(400, "INVALID", "message reasoning must be a string") };
      }
      msg.reasoning = rec.reasoning;
    }
    messages.push(msg);
  }
  return { messages };
}

/** Parse the opaque list cursor (`updated_at.id`); null = no cursor. */
function parseCursor(raw: string | null): { updatedAt?: number; id?: string; error?: Response } {
  if (!raw) return {};
  const dot = raw.indexOf(".");
  if (dot < 1) return { error: jsonError(400, "INVALID", "Invalid cursor") };
  const updatedAt = Number(raw.slice(0, dot));
  const id = raw.slice(dot + 1);
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0 || !id) {
    return { error: jsonError(400, "INVALID", "Invalid cursor") };
  }
  return { updatedAt, id };
}

export const chatsRoutes = (db: Db, auth: BetterAuthInstance) =>
  new Elysia({ name: "chats" })
    // List active (non-archived) conversations, newest activity first, 50 max,
    // deterministic keyset pagination. Metadata only — never messages.
    .get(
      "/api/v1/workspaces/:id/chats",
      {
        params: t.Object({ id: t.String() }),
        detail: { tags: ["Chats"], summary: "List chat conversations" },
      },
      async ({ request, params }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const denied = await requireWsRole(db, params.id, userId, "member");
        if (denied) return denied;
        const cursor = parseCursor(new URL(request.url).searchParams.get("cursor"));
        if (cursor.error) return cursor.error;

        const filters = [
          eq(chatConversations.user_id, userId),
          eq(chatConversations.workspace_id, params.id),
          sql`${chatConversations.archived_at} IS NULL`,
        ];
        if (cursor.updatedAt !== undefined && cursor.id !== undefined) {
          filters.push(
            or(
              lt(chatConversations.updated_at, cursor.updatedAt),
              and(
                eq(chatConversations.updated_at, cursor.updatedAt),
                lt(chatConversations.id, cursor.id),
              ),
            )!,
          );
        }
        const rows = await db
          .select({
            id: chatConversations.id,
            title: chatConversations.title,
            model: chatConversations.model,
            version: chatConversations.version,
            created_at: chatConversations.created_at,
            updated_at: chatConversations.updated_at,
          })
          .from(chatConversations)
          .where(and(...filters))
          .orderBy(desc(chatConversations.updated_at), desc(chatConversations.id))
          .limit(LIST_LIMIT + 1);
        const hasMore = rows.length > LIST_LIMIT;
        const page = hasMore ? rows.slice(0, LIST_LIMIT) : rows;
        const last = page[page.length - 1];
        return {
          data: page,
          nextCursor: hasMore && last ? `${last.updated_at}.${last.id}` : null,
        };
      },
    )
    // Create a conversation. Storage only — no wallet hold, no charge, no key.
    .post(
      "/api/v1/workspaces/:id/chats",
      {
        params: t.Object({ id: t.String() }),
        detail: { tags: ["Chats"], summary: "Create chat conversation" },
      },
      async ({ request, params }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const denied = await requireWsRole(db, params.id, userId, "member");
        if (denied) return denied;
        const now = Date.now();
        const row = {
          id: crypto.randomUUID(),
          user_id: userId,
          workspace_id: params.id,
          title: "New chat",
          model: null,
          messages: [],
          version: 1,
          created_at: now,
          updated_at: now,
          archived_at: null,
        };
        await db.insert(chatConversations).values(row);
        return new Response(JSON.stringify(row), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    )
    // Full conversation snapshot (includes messages).
    .get(
      "/api/v1/workspaces/:id/chats/:chatId",
      {
        params: t.Object({ id: t.String(), chatId: t.String() }),
        detail: { tags: ["Chats"], summary: "Get chat conversation" },
      },
      async ({ request, params }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const denied = await requireWsRole(db, params.id, userId, "member");
        if (denied) return denied;
        // Ownership is part of the lookup: wrong owner / wrong workspace is a
        // plain 404 — no existence leak to other members or admins.
        const rows = await db
          .select()
          .from(chatConversations)
          .where(
            and(
              eq(chatConversations.id, params.chatId),
              eq(chatConversations.user_id, userId),
              eq(chatConversations.workspace_id, params.id),
            ),
          )
          .limit(1);
        if (!rows[0]) return jsonError(404, "NOT_FOUND", "Conversation not found");
        return rows[0];
      },
    )
    // Replace the conversation. Conditional version UPDATE → stale writers
    // get 409 and the stored snapshot is never overwritten by them. Body is
    // read raw with a hard 512 KiB cap BEFORE full buffering.
    .put(
      "/api/v1/workspaces/:id/chats/:chatId",
      {
        params: t.Object({ id: t.String(), chatId: t.String() }),
        detail: { tags: ["Chats"], summary: "Update chat conversation" },
      },
      async ({ request, params }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const denied = await requireWsRole(db, params.id, userId, "member");
        if (denied) return denied;
        const read = await readBoundedBody(request);
        if (read.error) return read.error;
        const body = read.body!;

        const version = body.version;
        if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
          return jsonError(400, "INVALID", "version must be a positive integer");
        }
        let title: string | undefined;
        if (body.title !== undefined) {
          if (typeof body.title !== "string") {
            return jsonError(400, "INVALID", "title must be a string");
          }
          title = body.title.trim();
          if (!title || title.length > MAX_TITLE) {
            return jsonError(
              400,
              "INVALID",
              `title must be non-empty and at most ${MAX_TITLE} characters`,
            );
          }
        }
        let model: string | null | undefined;
        if (body.model !== undefined) {
          if (body.model !== null && typeof body.model !== "string") {
            return jsonError(400, "INVALID", "model must be a string or null");
          }
          model = body.model;
        }
        const messages = validateMessages(body.messages);
        if (messages.error) return messages.error;

        const now = Date.now();
        // Lock the row so version/title checks and the update+audit are atomic;
        // title-based audit reads the pre-update title under the same lock.
        const updated = await db.transaction(async (tx) => {
          const rows = await tx
            .select({
              id: chatConversations.id,
              title: chatConversations.title,
              version: chatConversations.version,
              archived_at: chatConversations.archived_at,
            })
            .from(chatConversations)
            .where(
              and(
                eq(chatConversations.id, params.chatId),
                eq(chatConversations.user_id, userId),
                eq(chatConversations.workspace_id, params.id),
              ),
            )
            .limit(1)
            .for("update");
          const row = rows[0];
          if (!row) return jsonError(404, "NOT_FOUND", "Conversation not found");
          if (row.archived_at !== null) {
            return jsonError(409, "ARCHIVED", "Conversation is archived");
          }
          if (row.version !== version) {
            return jsonError(409, "CONFLICT", "Version conflict");
          }
          const saved = await tx
            .update(chatConversations)
            .set({
              ...(title !== undefined ? { title } : {}),
              ...(model !== undefined ? { model } : {}),
              messages: messages.messages!,
              version: version + 1,
              updated_at: now,
            })
            .where(eq(chatConversations.id, params.chatId))
            .returning();
          // Rename audit only when the title genuinely changes. Detail carries
          // field names only — titles and messages can expose chat content.
          if (title !== undefined && title !== row.title) {
            await writeAudit(tx, {
              actorUserId: userId,
              workspaceId: params.id,
              action: "chat.rename",
              target: params.chatId,
              detail: { fields: ["title"] },
            });
          }
          return saved[0]!;
        });
        return updated;
      },
    )
    // Soft archive only — there is deliberately no DELETE endpoint. Idempotent.
    .patch(
      "/api/v1/workspaces/:id/chats/:chatId",
      {
        params: t.Object({ id: t.String(), chatId: t.String() }),
        detail: { tags: ["Chats"], summary: "Archive chat conversation" },
      },
      async ({ request, params }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const denied = await requireWsRole(db, params.id, userId, "member");
        if (denied) return denied;
        // Body is read manually AFTER auth: a declared Elysia body schema would
        // validate untrusted input before the auth guard (422 beat 401).
        const read = await readBoundedBody(request);
        if (read.error && read.error.status === 413) return read.error;
        const body = read.error ? undefined : read.body;
        if ((body as { archived?: unknown } | undefined)?.archived !== true) {
          return jsonError(422, "INVALID", "Expected body { archived: true }");
        }
        const now = Date.now();
        // Lock the row to serialize concurrent archives; audit fires only on
        // the null→timestamp transition, inside the same transaction.
        const result = await db.transaction(async (tx) => {
          const rows = await tx
            .select({ id: chatConversations.id, archived_at: chatConversations.archived_at })
            .from(chatConversations)
            .where(
              and(
                eq(chatConversations.id, params.chatId),
                eq(chatConversations.user_id, userId),
                eq(chatConversations.workspace_id, params.id),
              ),
            )
            .limit(1)
            .for("update");
          const row = rows[0];
          if (!row) return jsonError(404, "NOT_FOUND", "Conversation not found");
          if (row.archived_at !== null) {
            // Idempotent: already archived → return existing timestamp, no audit.
            return { id: row.id, archived_at: row.archived_at };
          }
          await tx
            .update(chatConversations)
            .set({ archived_at: now })
            .where(eq(chatConversations.id, params.chatId));
          await writeAudit(tx, {
            actorUserId: userId,
            workspaceId: params.id,
            action: "chat.archive",
            target: params.chatId,
          });
          return { id: row.id, archived_at: now };
        });
        return result;
      },
    );
