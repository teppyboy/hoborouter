// Remembered chat model/effort per user+workspace (device preference, NOT a
// secret: only published public model IDs are ever stored — never raw
// upstream keys). Recall must be validated against the live catalog before
// use: a remembered ID that is no longer published is dropped, never applied.

const MODEL_PREFIX = "chat.pref.model.";
const EFFORT_PREFIX = "chat.pref.effort.";

function localStore(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // privacy modes / SSR: prefs stay session-only
  }
}

function setPref(key: string, value: string | null): void {
  try {
    const store = localStore();
    if (!store) return;
    if (value) store.setItem(key, value);
    else store.removeItem(key);
  } catch {
    // Unavailable storage: the pref stays session-only.
  }
}

function getPref(key: string): string | null {
  try {
    return localStore()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function rememberChatModel(userId: string, workspaceId: string, publicId: string | null): void {
  setPref(`${MODEL_PREFIX}${userId}.${workspaceId}`, publicId || null);
}

export function recallChatModel(userId: string, workspaceId: string): string | null {
  return getPref(`${MODEL_PREFIX}${userId}.${workspaceId}`);
}

export function rememberChatEffort(userId: string, workspaceId: string, effort: string | null): void {
  setPref(`${EFFORT_PREFIX}${userId}.${workspaceId}`, effort || null);
}

export function recallChatEffort(userId: string, workspaceId: string): string | null {
  return getPref(`${EFFORT_PREFIX}${userId}.${workspaceId}`);
}

/** Identity teardown (logout / workspace switch): clears both prefs. */
export function clearChatPreferences(userId: string, workspaceId: string): void {
  rememberChatModel(userId, workspaceId, null);
  rememberChatEffort(userId, workspaceId, null);
}

/** A remembered model is only usable while it is still a published public
 *  catalog ID; anything else is dropped instead of applied. */
export function validModelChoice(
  publicId: string | null,
  models: readonly { publicId: string }[],
): string | null {
  return publicId && models.some((m) => m.publicId === publicId) ? publicId : null;
}
