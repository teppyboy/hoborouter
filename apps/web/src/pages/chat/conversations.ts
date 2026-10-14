// Typed API client for chat history. Cookie session only: same-origin paths,
// credentials include, never an API key field, never localStorage. Server
// responses are the only source of truth — a failure (including a 409 stale
// version) rejects and the caller must reload; nothing is ever faked locally.
// Framework-free so tests drive it with an injected fetch.
import type { ChatAttachmentRef } from "@hoborouter/shared";

/** Exact shared wire shape (packages/shared/src/chat.ts ConversationMessage). */
export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  /** Assistant only: the public model ID actually used. */
  model?: string;
  /** User only: private attachment refs (metadata, never bytes). */
  attachments?: ChatAttachmentRef[];
  /** Assistant only: gateway request id for the billing receipt. */
  request_id?: string;
};

export interface ConversationSummary {
  id: string;
  title: string;
  model: string | null;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface ConversationSnapshot extends ConversationSummary {
  messages: ChatMessage[];
  archived_at: number | null;
}

export interface ConversationPage {
  data: ConversationSummary[];
  nextCursor: string | null;
}

export type ConversationFailure =
  | "unauthorized" // 401: no/lost session — sign in again
  | "forbidden" // 403: lost workspace membership
  | "notFound" // 404: chat missing or not owned by this user+workspace
  | "conflict" // 409: stale version — reload, never overwrite blindly
  | "tooLarge" // 413: body over the server cap
  | "network" // fetch threw before a response
  | "invalid"; // unexpected status or response shape: never trust it

export class ConversationError extends Error {
  kind: ConversationFailure;
  status?: number;
  /** Parsed from a Retry-After header (seconds) when the server sent one. */
  retryAfterMs?: number;

  constructor(
    kind: ConversationFailure,
    message: string,
    status?: number,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ConversationError";
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface ConversationsFetch {
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

function kindForStatus(status: number): ConversationFailure {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "notFound";
  if (status === 409) return "conflict";
  if (status === 413) return "tooLarge";
  return "invalid";
}

async function request<T>(path: string, init: RequestInit, opts?: ConversationsFetch): Promise<T> {
  const doFetch = opts?.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(path, { credentials: "include", ...init, signal: opts?.signal });
  } catch {
    throw new ConversationError(
      "network",
      "Could not reach the server. Check your connection and try again.",
    );
  }
  if (!res.ok) {
    // Unknown status codes still surface as a typed failure (never trusted as
    // success); a Retry-After hint is preserved so callers can pace retries.
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new ConversationError(
      kindForStatus(res.status),
      `Chat request failed (${res.status})`,
      res.status,
      Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : undefined,
    );
  }
  try {
    return JSON.parse(await res.text()) as T;
  } catch {
    throw new ConversationError("invalid", "Chat service returned an unexpected response.");
  }
}

/** ChatAttachmentRef runtime check: metadata only, but still never trusted. */
function parseAttachmentRef(v: unknown): ChatAttachmentRef | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (
    typeof r.id !== "string" ||
    r.id === "" ||
    typeof r.name !== "string" ||
    (r.kind !== "image" && r.kind !== "text") ||
    typeof r.bytes !== "number" ||
    !Number.isInteger(r.bytes) ||
    r.bytes < 0 ||
    typeof r.mime !== "string" ||
    typeof r.expires_at !== "number"
  ) {
    return null;
  }
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    bytes: r.bytes,
    mime: r.mime,
    expires_at: r.expires_at,
  };
}

/**
 * Strict per-message parse of the shared ConversationMessage wire: role and
 * content are required, reasoning/model/request_id/attachments are additive
 * optionals with shape constraints, and unknown fields are dropped — a
 * malformed message makes the whole snapshot invalid, never partially shown.
 */
function parseMessage(v: unknown): ChatMessage | null {
  if (typeof v !== "object" || v === null) return null;
  const m = v as Record<string, unknown>;
  if (
    (m.role !== "user" && m.role !== "assistant") ||
    typeof m.content !== "string"
  ) {
    return null;
  }
  const msg: ChatMessage = { role: m.role, content: m.content };
  if (typeof m.reasoning === "string") msg.reasoning = m.reasoning;
  if (typeof m.model === "string") msg.model = m.model;
  if (typeof m.request_id === "string") {
    // request_id is assistant-only on the wire; ignore it on user turns.
    if (m.role === "assistant") msg.request_id = m.request_id;
  }
  if (Array.isArray(m.attachments)) {
    // attachments are user-only; every ref must validate or the snapshot is
    // rejected (an expired ref still keeps its metadata per the contract).
    if (m.role !== "user") return null;
    const refs: ChatAttachmentRef[] = [];
    for (const a of m.attachments) {
      const ref = parseAttachmentRef(a);
      if (!ref) return null;
      refs.push(ref);
    }
    msg.attachments = refs;
  }
  return msg;
}

function parseSnapshot(body: unknown): ConversationSnapshot {
  const b = body as {
    id?: unknown;
    title?: unknown;
    model?: unknown;
    messages?: unknown;
    version?: unknown;
    created_at?: unknown;
    updated_at?: unknown;
    archived_at?: unknown;
  } | null;
  if (
    typeof b?.id === "string" &&
    b.id !== "" &&
    typeof b?.title === "string" &&
    typeof b?.version === "number" &&
    typeof b?.created_at === "number" &&
    typeof b?.updated_at === "number" &&
    Array.isArray(b?.messages)
  ) {
    const messages: ChatMessage[] = [];
    for (const raw of b.messages) {
      const msg = parseMessage(raw);
      if (!msg) {
        throw new ConversationError("invalid", "Chat service returned an unexpected response.");
      }
      messages.push(msg);
    }
    return {
      id: b.id,
      title: b.title,
      model: b.model === null ? null : (b.model as string),
      messages,
      version: b.version,
      created_at: b.created_at,
      updated_at: b.updated_at,
      archived_at: b.archived_at === null ? null : (b.archived_at as number),
    };
  }
  throw new ConversationError("invalid", "Chat service returned an unexpected response.");
}

export interface ListConversationsOptions extends ConversationsFetch {
  /** Server-side title filter (case-insensitive substring) — never a client filter. */
  q?: string;
}

/** GET /api/v1/workspaces/:id/chats — active conversations, newest first. */
export async function listConversations(
  workspaceId: string,
  cursor?: string | null,
  opts?: ListConversationsOptions,
): Promise<ConversationPage> {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  if (opts?.q) params.set("q", opts.q);
  const qs = params.size > 0 ? `?${params.toString()}` : "";
  const body = await request<{ data?: unknown; nextCursor?: unknown }>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chats${qs}`,
    { method: "GET" },
    opts,
  );
  if (
    !Array.isArray(body?.data) ||
    (body.nextCursor !== null && typeof body.nextCursor !== "string")
  ) {
    throw new ConversationError("invalid", "Chat service returned an unexpected response.");
  }
  return { data: body.data as ConversationSummary[], nextCursor: body.nextCursor ?? null };
}

/** POST /api/v1/workspaces/:id/chats — 201 with a "New chat" snapshot. */
export async function createConversation(
  workspaceId: string,
  opts?: ConversationsFetch,
): Promise<ConversationSnapshot> {
  return parseSnapshot(
    await request(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chats`,
      { method: "POST" },
      opts,
    ),
  );
}

/** GET /api/v1/workspaces/:id/chats/:chatId — full snapshot. */
export async function getConversation(
  workspaceId: string,
  chatId: string,
  opts?: ConversationsFetch,
): Promise<ConversationSnapshot> {
  return parseSnapshot(
    await request(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chats/${encodeURIComponent(chatId)}`,
      { method: "GET" },
      opts,
    ),
  );
}

export interface SaveConversationInput {
  version: number;
  title?: string;
  model?: string | null;
  messages: ChatMessage[];
}

/**
 * PUT /api/v1/workspaces/:id/chats/:chatId — optimistic version save.
 * Returns the server snapshot (with the incremented version); on 409 throws
 * ConversationError("conflict") — the caller reloads, it never overwrites.
 */
export async function saveConversation(
  workspaceId: string,
  chatId: string,
  input: SaveConversationInput,
  opts?: ConversationsFetch,
): Promise<ConversationSnapshot> {
  return parseSnapshot(
    await request(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chats/${encodeURIComponent(chatId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: input.version,
          title: input.title,
          model: input.model,
          messages: input.messages,
        }),
      },
      opts,
    ),
  );
}

/**
 * PATCH /api/v1/workspaces/:id/chats/:chatId — archive (idempotent). The
 * server answers with just { id, archived_at }, not a full snapshot.
 */
export async function archiveConversation(
  workspaceId: string,
  chatId: string,
  opts?: ConversationsFetch,
): Promise<{ id: string; archived_at: number | null }> {
  const body = await request<{ id?: unknown; archived_at?: unknown }>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chats/${encodeURIComponent(chatId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    },
    opts,
  );
  if (typeof body?.id === "string" && body.id !== "") {
    return {
      id: body.id,
      archived_at:
        body.archived_at === null || body.archived_at === undefined
          ? null
          : (body.archived_at as number),
    };
  }
  throw new ConversationError("invalid", "Chat service returned an unexpected response.");
}

/**
 * PUT /api/v1/workspaces/:id/chats/:chatId/title — title-only rename guarded
 * by the conversation version. Deliberately NOT a read-modify-write of the
 * transcript: messages are never downloaded or re-sent, so a rename cannot
 * clobber concurrent turns. A stale version still 409s (kind "conflict").
 */
export async function renameConversation(
  workspaceId: string,
  chatId: string,
  input: { version: number; title: string },
  opts?: ConversationsFetch,
): Promise<{ id: string; version: number }> {
  const body = await request<{ id?: unknown; version?: unknown }>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chats/${encodeURIComponent(chatId)}/title`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: input.version, title: input.title }),
    },
    opts,
  );
  if (
    typeof body?.id === "string" &&
    body.id !== "" &&
    typeof body?.version === "number"
  ) {
    return { id: body.id, version: body.version };
  }
  throw new ConversationError("invalid", "Chat service returned an unexpected response.");
}

/**
 * POST /api/v1/workspaces/:id/chats/:chatId/fork — server-side fork of the
 * conversation up to message_index (optionally replacing that user turn's
 * content). The server answers 201 with the full new snapshot (refs copied);
 * nothing is ever fabricated locally because the server owns id/version.
 */
export async function forkConversation(
  workspaceId: string,
  chatId: string,
  input: { version: number; message_index: number; content?: string },
  opts?: ConversationsFetch,
): Promise<ConversationSnapshot> {
  const body: Record<string, unknown> = {
    version: input.version,
    message_index: input.message_index,
  };
  if (input.content !== undefined) body.content = input.content;
  return parseSnapshot(
    await request(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chats/${encodeURIComponent(chatId)}/fork`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      opts,
    ),
  );
}
