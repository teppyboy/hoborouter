// Chat history storage routes (context storage ONLY — never billed, never
// touches wallet/ledger; the paid gateway stays in v1-gateway.ts). One row per
// conversation in chat_conversations; messages are a plain-text jsonb array.
// Access = owner (session user) AND current workspace membership; workspace
// admins/owners and instance admins get no visibility into other users'
// conversations. Optimistic concurrency via conditional version UPDATE.
import { Elysia, t } from "elysia";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireWsRole, jsonError, writeAudit } from "../authz";
import type { ChatAttachmentRef } from "@hoborouter/shared";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { type Db, type Tx, chatAttachments, chatConversations, models } from "@hoborouter/db";

const MAX_BODY_BYTES = 512 * 1024; // 512 KiB inbound JSON body limit
const MAX_MESSAGES = 500;
const MAX_MESSAGE_CONTENT = 64 * 1024; // 64 KiB per message content
const MAX_TITLE = 120;
const LIST_LIMIT = 50;
const MAX_Q = 120;
// Small per-message ref cap; total NEW-ref bytes also capped at 10 MiB below.
const MAX_ATTACHMENTS_PER_MESSAGE = 4;
const MAX_REF_ID = 64;
const MAX_REQUEST_ID = 128;
// Upper bound on newly attached live bytes per save (grandfathered historic
// refs are exempt — history is never pruned or re-billed).
const MAX_NEW_ATTACHMENT_BYTES = 10 * 1024 * 1024;

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  // Assistant-only public model ID (validated against enabled+published
  // models.public_id under the row lock); no DB column — lives in this JSONB.
  model?: string;
  // User-only attachment refs; request_id below is assistant-only.
  attachments?: { id: string }[];
  request_id?: string;
};

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
    // Model is assistant-only metadata; shape validation here, catalog
    // membership under the row lock in the PUT handler (all-or-nothing).
    if (rec.model !== undefined) {
      if (rec.role !== "assistant") {
        return { error: jsonError(400, "INVALID", "model is only allowed on assistant messages") };
      }
      if (typeof rec.model !== "string") {
        return { error: jsonError(400, "INVALID", "message model must be a string") };
      }
      msg.model = rec.model;
    }
    if (rec.attachments !== undefined) {
      if (rec.role !== "user") {
        return {
          error: jsonError(400, "INVALID", "attachments are only allowed on user messages"),
        };
      }
      if (!Array.isArray(rec.attachments) || rec.attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
        return {
          error: jsonError(
            400,
            "INVALID",
            `attachments must be an array of at most ${MAX_ATTACHMENTS_PER_MESSAGE} refs`,
          ),
        };
      }
      const refs: { id: string }[] = [];
      for (const a of rec.attachments) {
        if (typeof a !== "object" || a === null) {
          return { error: jsonError(400, "INVALID", "each attachment must be an object") };
        }
        const id = (a as Record<string, unknown>).id;
        // Only the ref id is read here; name/mime/bytes/expiry come from the
        // canonical chat_attachments row, never the client.
        if (typeof id !== "string" || !id || id.length > MAX_REF_ID) {
          return { error: jsonError(400, "INVALID", "attachment id must be a short string") };
        }
        refs.push({ id });
      }
      msg.attachments = refs;
    }
    if (rec.request_id !== undefined) {
      if (rec.role !== "assistant") {
        return {
          error: jsonError(400, "INVALID", "request_id is only allowed on assistant messages"),
        };
      }
      if (
        typeof rec.request_id !== "string" ||
        !rec.request_id ||
        rec.request_id.length > MAX_REQUEST_ID
      ) {
        return { error: jsonError(400, "INVALID", "message request_id must be a short string") };
      }
      msg.request_id = rec.request_id;
    }
    messages.push(msg);
  }
  return { messages };
}

/**
 * Replace client-sent attachment refs with canonical chat_attachments metadata
 * (name/mime/bytes/expiry NEVER trusted from the client). Refs already present
 * in the stored snapshot are grandfathered verbatim — expired/tombstoned
 * history is retained, never rewritten. NEW refs must resolve to a live,
 * owner+workspace-matching, non-deleted, unexpired row; one bounded query.
 * All-or-nothing: any dead/unowned ref fails the whole save before a write.
 */
async function canonicalizeRefs(
  tx: Tx,
  userId: string,
  workspaceId: string,
  stored: unknown,
  messages: ChatMessage[],
): Promise<{ messages?: ChatMessage[]; error?: Response }> {
  const storedRefs = new Map<string, { id: string }>();
  if (Array.isArray(stored)) {
    for (const m of stored) {
      const refs = (m as { attachments?: unknown } | null)?.attachments;
      if (!Array.isArray(refs)) continue;
      for (const r of refs) {
        const id = (r as { id?: unknown } | null)?.id;
        // Stored refs were canonicalized when written; trust the id key only.
        if (typeof id === "string") storedRefs.set(id, r as { id: string });
      }
    }
  }
  const newIds = new Set<string>();
  for (const m of messages) {
    if (!m.attachments) continue;
    for (const r of m.attachments) if (!storedRefs.has(r.id)) newIds.add(r.id);
  }
  const live = new Map<
    string,
    Pick<ChatAttachmentRef, "id" | "name" | "kind" | "bytes" | "mime" | "expires_at">
  >();
  let newBytesTotal = 0;
  if (newIds.size > 0) {
    const rows = await tx
      .select({
        id: chatAttachments.id,
        name: chatAttachments.name,
        kind: chatAttachments.kind,
        bytes: chatAttachments.bytes,
        mime: chatAttachments.mime,
        expires_at: chatAttachments.expires_at,
        deleted_at: chatAttachments.deleted_at,
      })
      .from(chatAttachments)
      .where(
        and(
          inArray(chatAttachments.id, [...newIds]),
          eq(chatAttachments.user_id, userId),
          eq(chatAttachments.workspace_id, workspaceId),
        ),
      );
    for (const row of rows) {
      if (row.deleted_at === null && row.expires_at > Date.now()) {
        live.set(row.id, row);
        newBytesTotal += row.bytes;
      }
    }
    // Total raw size of NEW refs is capped (canonical server bytes, not the
    // client's claim). Existing history refs are exempt — no pruning.
    if (newBytesTotal > MAX_NEW_ATTACHMENT_BYTES) {
      return { error: jsonError(400, "INVALID", "attachments exceed the 10 MiB total size cap") };
    }
  }
  for (const m of messages) {
    if (!m.attachments) continue;
    const refs: ChatMessage["attachments"] = [];
    for (const r of m.attachments) {
      const canonical = storedRefs.get(r.id) ?? live.get(r.id);
      if (!canonical) {
        return { error: jsonError(400, "INVALID", "attachment is not available") };
      }
      refs.push(canonical);
    }
    m.attachments = refs;
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
        // Title search filters BEFORE the keyset cursor so pages stay stable
        // and honest (every page is the filtered set, not the unfiltered one).
        const qRaw = new URL(request.url).searchParams.get("q");
        if (qRaw !== null) {
          const q = qRaw.trim();
          if (q.length > MAX_Q) {
            return jsonError(400, "INVALID", "q must be at most 120 characters");
          }
          if (q) {
            // Postgres LIKE default escape is backslash; neutralize % _ \\.
            const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
            filters.push(sql`${chatConversations.title} ILIKE ${pattern}`);
          }
        }
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
              messages: chatConversations.messages,
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
          // Canonical attachment refs (grandfathering stored history; new refs
          // verified live+owned) — before model validation, so the whole save
          // is all-or-nothing on any invalid ref.
          const canon = await canonicalizeRefs(
            tx,
            userId,
            params.id,
            row.messages,
            messages.messages!,
          );
          if (canon.error) return canon.error;
          const savedMessages = canon.messages!;
          // Historical-model retention, under the same row lock so a concurrent
          // save cannot change the stored snapshot mid-validation: model strings
          // already present on stored assistant messages pass even if now
          // unpublished/disabled (catalog churn never invalidates history);
          // NEWLY introduced values must be members of the enabled+published
          // models.public_id set (membership-only — no id/slug blacklist). One
          // catalog query per request, only when new values exist. Invalid →
          // 400 before any write (messages, title, version all-or-nothing).
          const retained = new Set<string>();
          if (Array.isArray(row.messages)) {
            for (const m of row.messages) {
              if (
                typeof m === "object" &&
                m !== null &&
                (m as Record<string, unknown>).role === "assistant" &&
                typeof (m as Record<string, unknown>).model === "string"
              ) {
                retained.add((m as Record<string, unknown>).model as string);
              }
            }
          }
          const fresh = new Set<string>();
          for (const m of savedMessages) {
            if (m.role === "assistant" && m.model !== undefined && !retained.has(m.model)) {
              fresh.add(m.model);
            }
          }
          if (fresh.size > 0) {
            const members = await tx
              .select({ public_id: models.public_id })
              .from(models)
              .where(
                and(
                  eq(models.enabled, true),
                  eq(models.published, true),
                  inArray(models.public_id, [...fresh]),
                ),
              );
            const memberSet = new Set(members.map((r) => r.public_id));
            for (const value of fresh) {
              if (!memberSet.has(value)) {
                return jsonError(400, "INVALID", "message model is not a published model");
              }
            }
          }
          const saved = await tx
            .update(chatConversations)
            .set({
              ...(title !== undefined ? { title } : {}),
              ...(model !== undefined ? { model } : {}),
              messages: savedMessages,
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
    // Rename only: conditional version UPDATE returning {id, version} — no
    // full transcript round-trip. Stale writers get 409 and change nothing.
    .put(
      "/api/v1/workspaces/:id/chats/:chatId/title",
      {
        params: t.Object({ id: t.String(), chatId: t.String() }),
        detail: { tags: ["Chats"], summary: "Rename chat conversation" },
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
        if (typeof body.title !== "string") {
          return jsonError(400, "INVALID", "title must be a string");
        }
        const title = body.title.trim();
        if (!title || title.length > MAX_TITLE) {
          return jsonError(
            400,
            "INVALID",
            `title must be non-empty and at most ${MAX_TITLE} characters`,
          );
        }
        const now = Date.now();
        const result = await db.transaction(async (tx) => {
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
          await tx
            .update(chatConversations)
            .set({ title, version: version + 1, updated_at: now })
            .where(eq(chatConversations.id, params.chatId));
          if (title !== row.title) {
            await writeAudit(tx, {
              actorUserId: userId,
              workspaceId: params.id,
              action: "chat.rename",
              target: params.chatId,
              detail: { fields: ["title"] },
            });
          }
          return { id: row.id, version: version + 1 };
        });
        return result;
      },
    )
    // Fork: new conversation holding the source prefix THROUGH the edited user
    // turn (source messages 0..message_index, that turn's content replaced by
    // `content` when provided). Source row is untouched; source version is
    // checked under the row lock (stale → 409, no fork). Prefix attachment
    // refs are grandfathered history (kept verbatim even if expired). Storage
    // only — no wallet hold, no charge, no second billing request.
    .post(
      "/api/v1/workspaces/:id/chats/:chatId/fork",
      {
        params: t.Object({ id: t.String(), chatId: t.String() }),
        detail: { tags: ["Chats"], summary: "Fork chat conversation" },
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
        const messageIndex = body.message_index;
        if (
          typeof messageIndex !== "number" ||
          !Number.isSafeInteger(messageIndex) ||
          messageIndex < 0
        ) {
          return jsonError(400, "INVALID", "message_index must be a non-negative integer");
        }
        let content: string | undefined;
        if (body.content !== undefined) {
          if (
            typeof body.content !== "string" ||
            Buffer.byteLength(body.content, "utf8") > MAX_MESSAGE_CONTENT
          ) {
            return jsonError(
              400,
              "INVALID",
              `content must be a string of at most ${MAX_MESSAGE_CONTENT} bytes`,
            );
          }
          content = body.content;
        }
        const now = Date.now();
        const forked = await db.transaction(async (tx) => {
          const rows = await tx
            .select()
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
          if (!Array.isArray(row.messages) || messageIndex >= row.messages.length) {
            return jsonError(400, "INVALID", "message_index out of range");
          }
          const target = row.messages[messageIndex] as Record<string, unknown> | null;
          if (!target || target.role !== "user") {
            return jsonError(400, "INVALID", "message_index must point at a user message");
          }
          const prefix = JSON.parse(
            JSON.stringify(row.messages.slice(0, messageIndex + 1)),
          ) as ChatMessage[];
          const last = prefix[prefix.length - 1]!;
          if (content !== undefined) last.content = content;
          const newRow = {
            id: crypto.randomUUID(),
            user_id: userId,
            workspace_id: params.id,
            title: row.title,
            model: row.model,
            messages: prefix,
            version: 1,
            created_at: now,
            updated_at: now,
            archived_at: null,
          };
          await tx.insert(chatConversations).values(newRow);
          await writeAudit(tx, {
            actorUserId: userId,
            workspaceId: params.id,
            action: "chat.fork",
            target: newRow.id,
            detail: { source: params.chatId },
          });
          return newRow;
        });
        if (forked instanceof Response) return forked;
        return new Response(JSON.stringify(forked), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
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
