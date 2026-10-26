// Typed API client for chat history. Cookie session only: same-origin paths,
// credentials include, never an API key field, never localStorage. Server
// responses are the only source of truth — a failure (including a 409 stale
// version) rejects and the caller must reload; nothing is ever faked locally.
// Framework-free so tests drive it with an injected fetch.
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  hadAttachments?: boolean;
  reasoning?: string;
  /** Assistant only: the public model ID actually used. */
  model?: string;
}

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

  constructor(kind: ConversationFailure, message: string, status?: number) {
    super(message);
    this.name = "ConversationError";
    this.kind = kind;
    this.status = status;
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
    throw new ConversationError(
      kindForStatus(res.status),
      `Chat request failed (${res.status})`,
      res.status,
    );
  }
  try {
    return JSON.parse(await res.text()) as T;
  } catch {
    throw new ConversationError("invalid", "Chat service returned an unexpected response.");
  }
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
    return {
      id: b.id,
      title: b.title,
      model: b.model === null ? null : (b.model as string),
      messages: b.messages as ChatMessage[],
      version: b.version,
      created_at: b.created_at,
      updated_at: b.updated_at,
      archived_at: b.archived_at === null ? null : (b.archived_at as number),
    };
  }
  throw new ConversationError("invalid", "Chat service returned an unexpected response.");
}

/** GET /api/v1/workspaces/:id/chats — active conversations, newest first. */
export async function listConversations(
  workspaceId: string,
  cursor?: string | null,
  opts?: ConversationsFetch,
): Promise<ConversationPage> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
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
