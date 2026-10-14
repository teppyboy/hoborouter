// Session-only composer text draft persistence (Chat lane). Scoped per
// user/workspace/chat so one context can never read another's draft; text
// only — the contract forbids binary data in storage. The 64 KiB UTF-8 byte
// cap matches the contract; an oversized draft simply stays memory-only.

const DRAFT_PREFIX = "chat.draft.";
const encoder = new TextEncoder();

/** Largest persisted draft, measured in UTF-8 bytes (not UTF-16 length). */
export const DRAFT_MAX_BYTES = 64 * 1024;

export interface ChatDraftScope {
  userId: string;
  workspaceId: string;
  /** Active saved conversation, or null for the unsaved "new chat" view. */
  chatId: string | null;
}

export function chatDraftKey(scope: ChatDraftScope): string {
  return `${DRAFT_PREFIX}${scope.userId}.${scope.workspaceId}.${scope.chatId ?? "new"}`;
}

function sessionStore(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null; // privacy modes / SSR: drafts stay memory-only
  }
}

function utf8ByteLength(text: string): number {
  return encoder.encode(text).length;
}

export function readChatDraft(scope: ChatDraftScope): string {
  const store = sessionStore();
  try {
    const raw = store?.getItem(chatDraftKey(scope));
    return typeof raw === "string" ? raw : "";
  } catch {
    return "";
  }
}

/** Immediate (debounce-bypassing) write. Oversized drafts are never
 *  persisted and unavailable storage is a silent no-op. */
export function writeChatDraft(scope: ChatDraftScope, text: string): boolean {
  if (utf8ByteLength(text) > DRAFT_MAX_BYTES) return false;
  const store = sessionStore();
  try {
    store?.setItem(chatDraftKey(scope), text);
    return true;
  } catch {
    return false;
  }
}

export function clearChatDraft(scope: ChatDraftScope): void {
  try {
    sessionStore()?.removeItem(chatDraftKey(scope));
  } catch {
    // Unavailable storage: nothing persisted to clear.
  }
}

/** Prefix sweep for identity teardown (logout): clears every chat draft
 *  under the chat.draft prefix, optionally narrowed to one user/workspace.
 *  Never touches unrelated keys sharing the storage. */
export function clearChatDrafts(filter?: { userId?: string; workspaceId?: string }): void {
  const store = sessionStore();
  if (!store) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key?.startsWith(DRAFT_PREFIX)) keys.push(key);
    }
    const user = filter?.userId ? `${DRAFT_PREFIX}${filter.userId}.` : null;
    const ws = filter?.workspaceId ? `.${filter.workspaceId}.` : null;
    for (const key of keys) {
      if (user && !key.startsWith(user)) continue;
      if (ws && !key.includes(ws)) continue;
      store.removeItem(key);
    }
  } catch {
    // Best-effort sweep; a partial clear is safe (session-only data).
  }
}
