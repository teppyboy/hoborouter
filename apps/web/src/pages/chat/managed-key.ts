// Managed chat key: lazily mints exactly one device-named key ("Chat -
// iPhone") per user + workspace via POST /api/v1/workspaces/:id/chat-key
// (owner/admin only — members get 403 and cannot chat from the UI, never a
// weaker endpoint), which mints with server-side purpose "chat" (16 MiB
// gateway allowance). Plaintext is cached in memory and persisted to
// localStorage (sessionStorage fallback when localStorage is unavailable)
// under a user+workspace-scoped key, so the SAME identity reuses its browser
// chat key across sessions instead of minting a duplicate on every visit.
// The server can never return a stored plaintext again, so local persistence
// is the only reuse path: no stored copy ⇒ mint once, then persist. Storage
// is always namespaced by user id — switching identity never serves another
// user's key, and logout wipes every stored copy. Never URLs, never logs.
// Failures are never cached; every retry is an explicit caller action.
import * as React from "react";

export type ManagedKeyPurpose = "generic" | "chat" | "chat_member";

export interface ManagedKey {
  id: string;
  plaintext: string;
  /** Client-side UX metadata ONLY — which 413 recovery flow the page offers.
   *  Never an authorization anchor: the gateway reads server-side
   *  api_keys.purpose exclusively; a metadata mismatch degrades safely to
   *  the generic flow. Legacy stored records without the field restore as
   *  "generic" (every pre-change key was generic). */
  purpose: ManagedKeyPurpose;
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

/** Display label for this device, derived only from the public User-Agent —
 *  no IDs, no secrets. Used in the minted key name ("Chat - iPhone") so the
 *  owner can recognize which device created a key. Unknown browsers degrade
 *  to "Browser". */
export function deviceLabel(userAgent?: string): string {
  const ua = userAgent ?? (typeof navigator === "undefined" ? "" : navigator.userAgent);
  const u = ua.toLowerCase();
  const has = (s: string) => u.includes(s);
  if (has("iphone")) return "iPhone";
  if (has("ipad")) return "iPad";
  if (has("android")) {
    // Android UAs usually carry the model, e.g. "; SM-G991B)". The model
    // becomes part of a stored name, so keep a strict allowlist charset and
    // a short cap — hostile UA text cannot inject quotes/HTML into it.
    const m = /Android[^;)]*;\s*([^;)]+?)(?:\s+Build\/|\))/.exec(ua);
    const model = m?.[1]
      ?.replace(/[^A-Za-z0-9 ._-]/g, "")
      .trim()
      .slice(0, 32);
    return model ? `Android ${model}` : "Android";
  }
  if (has("windows")) return "Windows";
  if (has("mac os") || has("macintosh")) return "Mac";
  if (has("cros")) return "Chromebook";
  if (has("linux")) return "Linux";
  return "Browser";
}

/** Name for the minted browser chat key, e.g. "Chat - iPhone 13". */
export const deviceChatName = (userAgent?: string): string => `Chat - ${deviceLabel(userAgent)}`;

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

/** Ordered storage slots: `persistent: true` = survives browser restarts
 *  (localStorage), false = dies with the tab (sessionStorage). The `storage`
 *  test seam keeps its old shape: injected stores are persistent candidates;
 *  when a two-element array is injected the SECOND slot is treated as the
 *  session store so the member-key rules below are testable. */
interface StorageSlot {
  store: KeyStorage;
  persistent: boolean;
}

function resolveStorages(preferred?: KeyStorage | KeyStorage[]): StorageSlot[] {
  if (preferred) {
    const list = Array.isArray(preferred) ? preferred : [preferred];
    return list.map((store, i) => ({ store, persistent: i !== list.length - 1 || list.length === 1 }));
  }
// localStorage persists across browser sessions (so the same user+workspace
// reuses its chat key), sessionStorage is the fallback when localStorage is
// unavailable (private mode, quota errors). MEMBER keys (purpose
// "chat_member") are sessionStorage-ONLY — they never touch localStorage and
// are never restored from it — because a member key is a delegated,
// quota-metered credential that must die with the tab session; the server
// remains the only quota authority either way. Any access is best-effort:
// total storage failure degrades to the in-memory cache for this tab only.
  const slots: StorageSlot[] = [];
  for (const s of [globalThis.localStorage, globalThis.sessionStorage])
    if (s) slots.push({ store: s, persistent: s === globalThis.localStorage });
  return slots;
}

// Stored browser records: { id, plaintext, purpose? }. Legacy records lack
// purpose and restore as "generic"; anything without a valid id/plaintext is
// corrupt and dropped. "chat" stays "chat"; "chat_member" stays
// "chat_member"; any other purpose value is stored/restore as "generic".
function parseStoredKey(body: unknown): ManagedKey | null {
  const b = body as { id?: unknown; plaintext?: unknown; purpose?: unknown } | null;
  if (typeof b?.id !== "string" || b.id === "") return null;
  if (typeof b?.plaintext !== "string" || !b.plaintext.startsWith("sk-hbr-")) return null;
  return {
    id: b.id,
    plaintext: b.plaintext,
    purpose: b.purpose === "chat" || b.purpose === "chat_member" ? b.purpose : "generic",
  };
}

// Mint response from POST /chat-key: the server picks the purpose from its
// own workspace policy (owner/admin → "chat", member with an enabled chat
// policy → "chat_member", server-canonical — the client NEVER sends a
// purpose). A response without one of those two values is never trusted.
function parseMintResponse(body: unknown): ManagedKey {
  const b = body as { purpose?: unknown } | null;
  const key = parseStoredKey(body);
  if (key && (b?.purpose === "chat" || b?.purpose === "chat_member")) {
    return { ...key, purpose: b.purpose };
  }
  throw new ManagedKeyError("invalid", "Key service returned an unexpected response. Try again.");
}

/** Member keys are tab-session credentials: session slots only, never
 *  persistent ones (restore or persist). Server stays the quota authority —
 *  this is hygiene, not a bypass. */
const isMemberKey = (key: ManagedKey): boolean => key.purpose === "chat_member";

/** First valid stored copy across the ordered slots; corrupt entries are
 *  dropped (best-effort) so a fresh key can be minted below. A chat_member
 *  record found in a persistent slot is dropped, never restored. */
function restoreManagedKey(slots: StorageSlot[], ck: string): ManagedKey | null {
  for (const { store } of slots) {
    let raw: string | null = null;
    try {
      raw = store.getItem(STORAGE_PREFIX + ck);
    } catch {
      continue; // unreadable store: try the next candidate
    }
    if (!raw) continue;
    try {
      const key = parseStoredKey(JSON.parse(raw));
      if (key && !(isMemberKey(key) && slots.find((s) => s.store === store)?.persistent)) {
        cache.set(ck, key);
        return key;
      }
      // Shape-invalid entry, or a member key illegally in a persistent slot:
      // drop it and mint a fresh key below.
      try {
        store.removeItem(STORAGE_PREFIX + ck);
      } catch {
        // Read-only store: the entry is simply ignored on every read.
      }
    } catch {
      // Corrupt or stale entry: drop it and mint a fresh key below.
      try {
        store.removeItem(STORAGE_PREFIX + ck);
      } catch {
        // Read-only store: the entry is simply ignored on every read.
      }
    }
  }
  return null;
}

/** Persist to the first eligible slot; failure degrades to memory-only.
 *  Member keys are eligible for session slots only. */
function persistManagedKey(slots: StorageSlot[], ck: string, key: ManagedKey): void {
  for (const { store, persistent } of slots) {
    if (isMemberKey(key) && persistent) continue;
    try {
      store.setItem(STORAGE_PREFIX + ck, JSON.stringify(key));
      return;
    } catch {
      // Unavailable or full: try the next store; memory still holds the key.
    }
  }
}

export interface StartManagedChatKeyOptions {
  userId: string;
  workspaceId: string;
  /** Test seam: one store (or ordered candidates) replacing the globals. */
  storage?: KeyStorage | KeyStorage[];
  fetch?: typeof fetch;
  /** Best-effort cancel: aborted creation fails and caches nothing. */
  signal?: AbortSignal;
  /** Key name override (tests). Defaults to the device-derived name. */
  name?: string;
}

/**
 * Resolve the managed chat key for this user+workspace: cached in memory,
 * else restored from persistent storage (localStorage, then sessionStorage),
 * else created once (parallel callers share the in-flight promise). Throws
 * ManagedKeyError on failure and caches nothing in that case — retry is
 * explicit.
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

  const storages = resolveStorages(opts.storage);
  const doFetch = opts.fetch ?? fetch;

  // The entry is assigned synchronously right after the IIFE suspends at its
  // first await, and isInvalidated() is only reachable from the fetch path
  // (after that await), so it always sees the live entry.
  let entry: InflightEntry | null = null;
  const isInvalidated = () => entry?.invalid ?? false;
  const task = (async (): Promise<ManagedKey> => {
    const stored = restoreManagedKey(storages, ck);
    if (stored) {
      cache.set(ck, stored);
      return stored;
    }

    let res: Response;
    try {
      res = await doFetch(`/api/v1/workspaces/${workspaceId}/chat-key`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: opts.name ?? deviceChatName() }),
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
          "You need owner or admin role in this workspace to create a chat key. Ask a workspace admin for help.",
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
    const key = parseMintResponse(body);
    if (isInvalidated()) return key; // cleared mid-flight: persist nothing
    cache.set(ck, key);
    persistManagedKey(storages, ck, key);
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
  for (const k of doomed) {
    try {
      storage.removeItem(k);
    } catch {
      // Unavailable store: nothing to remove; memory is already cleared.
    }
  }
}

/**
 * With an identity: clear only that user+workspace's cached key (the 401
 * "reconnect" path — the next explicit start creates a fresh key). Without:
 * wipe every managed key from memory and persistent storage (logout path, so
 * the next person on this browser cannot reuse the previous user's key).
 */
export function clearManagedChatKey(
  identity?: { userId: string; workspaceId: string },
  storage?: KeyStorage,
): void {
  // Storage is best-effort: the in-memory cache is the primary clearing target
  // and the stores may not exist (tests, non-browser contexts).
  const slots: StorageSlot[] = storage
    ? [{ store: storage, persistent: true }]
    : resolveStorages();
  if (identity) {
    const ck = cacheKey(identity.userId, identity.workspaceId);
    cache.delete(ck);
    const pendingEntry = inflight.get(ck);
    if (pendingEntry) {
      pendingEntry.invalid = true;
      inflight.delete(ck);
    }
    for (const { store } of slots) {
      try {
        store.removeItem(STORAGE_PREFIX + ck);
      } catch {
        // Unavailable store: the scoped entry just stays unreferenced.
      }
    }
  } else {
    cache.clear();
    for (const e of inflight.values()) e.invalid = true;
    inflight.clear();
    for (const { store } of slots) clearPrefixedEntries(store);
  }
}

/**
 * UI seam for the chat page. Pass the session user id and the resolved
 * workspace id from useCurrentWorkspaceId(). Clears all managed keys when the
 * session goes null (logout). ensureKey creates lazily on first explicit call
 * (first send/connect) — never on render — and reuses the locally stored
 * browser key first, so an existing key is never minted twice.
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
