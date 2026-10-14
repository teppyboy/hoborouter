// Logout ordering contract: no request may fire against the dead cookie.
// Cancel in-flight queries, sign out, then navigate. The navigation must be a
// FULL document navigation (window.location.assign), which discards the whole
// query cache: clearing or invalidating the cache in-place instead re-fires
// active observers whose `enabled` still reads the stale Better Auth session
// snapshot, sending dead-cookie requests (401 console noise on logout).
import type { QueryClient } from "@tanstack/react-query";

/**
 * sessionStorage key prefix for Chat text drafts (user/workspace/chat scoped).
 * Cross-lane contract: the Chat draft module must key drafts under this prefix
 * so logout can clear them without importing chat page internals. Clearing is
 * required because the full-document navigation below preserves sessionStorage.
 */
export const CHAT_DRAFT_STORAGE_PREFIX = "hbr-chat-draft:";

function clearChatDrafts() {
  try {
    // Collect first: Storage is a live list, and removing while iterating
    // would skip keys (also keeps this independent of Storage's own-property
    // enumeration quirks).
    const keys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key) keys.push(key);
    }
    for (const key of keys) {
      if (key.startsWith(CHAT_DRAFT_STORAGE_PREFIX)) sessionStorage.removeItem(key);
    }
  } catch {
    // Storage unavailable (privacy mode): drafts were never writable either.
  }
}

export async function signOutAndReset(
  queryClient: QueryClient,
  signOut: () => Promise<unknown>,
  navigate: () => void,
): Promise<void> {
  // Must be awaited: fire-and-forget cancellation lets signOut clear the auth
  // cookie while an in-flight query is still running, so the request lands
  // against the dead session (401 on logout).
  await queryClient.cancelQueries();
  clearChatDrafts();
  await signOut();
  navigate();
}
