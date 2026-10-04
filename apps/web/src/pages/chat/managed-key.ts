// Managed chat key: lazily mints exactly one "Browser Chat" key per session
// user + workspace via POST /api/v1/workspaces/:id/keys (owner/admin only —
// members get 403 and fall back to the manual key UI, never a weaker endpoint).
// Plaintext is cached in memory and mirrored to sessionStorage for this tab
// only. Never localStorage, never URLs, never logs. Failures are never cached;
// every retry is an explicit caller action.
import * as React from "react";

export interface ManagedKey {
  id: string;
  plaintext: string;
}

export type ManagedKeyFailure =
  | "unauthorized" // 401 / no session: reconnect explicitly, then a fresh create
  | "forbidden" // 403: not owner/admin in this workspace
  | "network" // fetch threw before a response: retry explicitly
  | "invalid"; // response shape wrong or unexpected status: never trust it

export class ManagedKeyError extends Error {
  kind: ManagedKeyFailure;
  status?: number;

  constructor(kind: ManagedKeyFailure, message: string, status?: number) {
    super(message);
    this.name = "ManagedKeyError";
    this.kind = kind;
    this.status = status;
  }
}

/** Minimal storage surface so unit tests can inject a Map-backed fake. */
export type KeyStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const STORAGE_PREFIX = "hbr-managed-key:";

// Per-tab plaintext cache, keyed by `${userId}:${workspaceId}`. Keying by both
// means a completion that resolves under an old identity can never overwrite
// or be served to a different user/workspace — it lands in its own slot.
const cache = new Map<string, ManagedKey>();
// In-flight creation dedup: parallel callers share one POST. clearManagedChatKey
// marks a pending entry invalid: the promise still resolves to its original
// callers (they discard it via their own generation guards), but nothing is
// cached or persisted — a later explicit start mints a fresh key (the backend
// may keep the minted row; we never reuse it locally after a clear).
interface InflightEntry {
  promise: Promise<ManagedKey>;
  invalid: boolean;
}
const inflight = new Map<string, InflightEntry>();

const cacheKey = (userId: string, workspaceId: string) => `${userId}:${workspaceId}`;

function resolveStorage(storage?: KeyStorage): KeyStorage {
  const s = storage ?? globalThis.sessionStorage;
  if (!s) throw new ManagedKeyError("invalid", "sessionStorage is not available.");
  return s;
}

// Server returns { id, name, key_prefix, status, plaintext }; plaintext always
// starts with the sk-hbr- prefix. Anything else is treated as invalid.
function parseManagedKey(body: unknown): ManagedKey {
  const b = body as { id?: unknown; plaintext?: unknown } | null;
  if (
    typeof b?.id === "string" &&
    b.id !== "" &&
    typeof b.plaintext === "string" &&
    b.plaintext.startsWith("sk-hbr-")
  ) {
    return { id: b.id, plaintext: b.plaintext };
  }
  throw new ManagedKeyError("invalid", "Key service returned an unexpected response. Try again.");
}

export interface StartManagedChatKeyOptions {
  userId: string;
  workspaceId: string;
  storage?: KeyStorage;
  fetch?: typeof fetch;
  /** Best-effort cancel: aborted creation fails and caches nothing. */
  signal?: AbortSignal;
}

/**
 * Resolve the managed chat key for this user+workspace: cached in memory,
 * else restored from sessionStorage, else created once (parallel callers
 * share the in-flight promise). Throws ManagedKeyError on failure and caches
 * nothing in that case — retry is explicit.
 */
export async function startManagedChatKey(opts: StartManagedChatKeyOptions): Promise<ManagedKey> {
  const { userId, workspaceId } = opts;
  if (!userId || !workspaceId)
    throw new ManagedKeyError("unauthorized", "Sign in and pick a workspace first.");
  const ck = cacheKey(userId, workspaceId);

  const cached = cache.get(ck);
  if (cached) return cached;
  const pending = inflight.get(ck);
  if (pending) return pending.promise;

  const storage = resolveStorage(opts.storage);
  const doFetch = opts.fetch ?? fetch;

  // The entry is assigned synchronously right after the IIFE suspends at its
  // first await, and isInvalidated() is only reachable from the fetch path
  // (after that await), so it always sees the live entry.
  let entry: InflightEntry | null = null;
  const isInvalidated = () => entry?.invalid ?? false;
  const task = (async (): Promise<ManagedKey> => {
    const stored = storage.getItem(STORAGE_PREFIX + ck);
    if (stored) {
      try {
        const key = parseManagedKey(JSON.parse(stored));
        cache.set(ck, key);
        return key;
      } catch {
        // Corrupt or stale entry: drop it and mint a fresh key below.
        storage.removeItem(STORAGE_PREFIX + ck);
      }
    }

    let res: Response;
    try {
      res = await doFetch(`/api/v1/workspaces/${workspaceId}/keys`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Browser Chat" }),
        signal: opts.signal,
      });
    } catch {
      throw new ManagedKeyError(
        "network",
        "Could not reach the server to create a chat key. Check your connection and try again.",
      );
    }

    if (!res.ok) {
      if (res.status === 403)
        throw new ManagedKeyError(
          "forbidden",
          "You need owner or admin role in this workspace to create a chat key. Ask a workspace admin, or paste your own key from the API keys page.",
          res.status,
        );
      if (res.status === 401)
        throw new ManagedKeyError(
          "unauthorized",
          "Your session has expired. Sign in again.",
          res.status,
        );
      throw new ManagedKeyError(
        "invalid",
        `Could not create a chat key (${res.status}).`,
        res.status,
      );
    }

    const body: unknown = await res.json().catch(() => null);
    const key = parseManagedKey(body);
    if (isInvalidated()) return key; // cleared mid-flight: persist nothing
    cache.set(ck, key);
    storage.setItem(STORAGE_PREFIX + ck, JSON.stringify(key));
    return key;
  })();

  entry = { promise: task, invalid: false };
  inflight.set(ck, entry);
  try {
    return await task;
  } finally {
    if (inflight.get(ck)?.promise === task) inflight.delete(ck);
  }
}

function clearPrefixedEntries(storage: KeyStorage): void {
  const doomed: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k?.startsWith(STORAGE_PREFIX)) doomed.push(k);
  }
  for (const k of doomed) storage.removeItem(k);
}

/**
 * With an identity: clear only that user+workspace's cached key (the 401
 * "reconnect" path — the next explicit start creates a fresh key). Without:
 * wipe every managed key from memory and sessionStorage (logout path, so the
 * next person on this browser cannot reuse the previous user's key).
 */
export function clearManagedChatKey(
  identity?: { userId: string; workspaceId: string },
  storage?: KeyStorage,
): void {
  // Storage is best-effort: the in-memory cache is the primary clearing target
  // and sessionStorage may not exist (tests, non-browser contexts).
  const s = storage ?? globalThis.sessionStorage ?? null;
  if (identity) {
    const ck = cacheKey(identity.userId, identity.workspaceId);
    cache.delete(ck);
    const pendingEntry = inflight.get(ck);
    if (pendingEntry) {
      pendingEntry.invalid = true;
      inflight.delete(ck);
    }
    s?.removeItem(STORAGE_PREFIX + ck);
  } else {
    cache.clear();
    for (const e of inflight.values()) e.invalid = true;
    inflight.clear();
    if (s) clearPrefixedEntries(s);
  }
}

/**
 * Scoped sessionStorage key for the manual "remember for this tab" chat key
 * (Advanced option on the chat page). Namespacing by session user + workspace
 * means a remembered key can only ever be restored by the identity that saved
 * it — the legacy unscoped `hbr-chat-key` is never read on behalf of another
 * user.
 */
export const chatKeyStorageKey = (userId: string, workspaceId: string): string =>
  `hbr-chat-key:${userId}:${workspaceId}`;

/**
 * UI seam for the chat page. Pass the session user id and the resolved
 * workspace id from useCurrentWorkspaceId(). Clears all managed keys when the
 * session goes null (logout). ensureKey creates lazily on first explicit call
 * (first send/connect), never on render.
 */
export function useManagedChatKey(userId: string | null, workspaceId: string | null) {
  const prevUserId = React.useRef<string | null>(null);
  React.useEffect(() => {
    const prev = prevUserId.current;
    prevUserId.current = userId;
    // Any change away from a known user — logout (→ null) or switching to a
    // different session user — invalidates every cached key (memory +
    // storage + in-flight). A pending session (null → null, null → user)
    // clears nothing: the first mount must not wipe a valid cache before the
    // identity is known.
    if (prev && prev !== userId) clearManagedChatKey();
  }, [userId]);

  const ensureKey = React.useCallback(
    (signal?: AbortSignal): Promise<ManagedKey> => {
      if (!userId || !workspaceId)
        return Promise.reject(new ManagedKeyError("unauthorized", "Sign in first."));
      return startManagedChatKey({ userId, workspaceId, signal });
    },
    [userId, workspaceId],
  );

  return { userId, workspaceId, ensureKey };
}
