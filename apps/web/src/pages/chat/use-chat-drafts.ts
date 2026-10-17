import * as React from "react";
import { clearChatDraft, readChatDraft, writeChatDraft, type ChatDraftScope } from "./draft";

const DRAFT_DEBOUNCE_MS = 200;

function scopeKeyOf(scope: ChatDraftScope | null): string | null {
  return scope ? `${scope.userId}:${scope.workspaceId}:${scope.chatId ?? "new"}` : null;
}

/** Composer text-draft persistence wired to the page's ComposerDraft
 *  (input text + setInput). Text only, scoped per user/workspace/chat, so a
 *  draft never crosses identities, workspaces or conversations:
 *
 *  - On scope change the PREVIOUS scope's draft is flushed synchronously
 *    before the new scope's draft is hydrated — a pending debounce can never
 *    land in another context, and no foreign draft is ever shown.
 *  - Typing is debounced at 200 ms; pagehide, unmount and the explicit
 *    send/teardown calls flush immediately.
 *  - `clearCurrent()` (send) and `clearChatDrafts()` from ./draft (logout)
 *    are the only erase paths.
 *
 *  Storage-unavailable environments degrade to memory-only. */
export function useChatDraftSync(input: {
  /** Current scope; null while signed out / identity unresolved. */
  scope: ChatDraftScope | null;
  /** Reactive text value (re-arms the debounce on change). */
  text: string;
  /** Imperative reader for pagehide/unmount flushes. */
  getText(): string;
  /** Hydration target on scope change (the composer's setInput). */
  setText(text: string): void;
}): { flushNow(): void; clearCurrent(): void } {
  const { scope, text, getText, setText } = input;
  // Refs so pagehide/unmount/debounce callbacks read the current scope and
  // text without re-binding listeners on every keystroke.
  const currentScopeRef = React.useRef<ChatDraftScope | null>(null);
  const hydratedKeyRef = React.useRef<string | null>(null);
  // Hydration echo guard: after hydrating, the page's text prop is still the
  // PRE-hydration value for at least one render. While an echo is
  // outstanding, no debounced/flush write may run — it would persist the
  // stale (usually empty) text over the just-loaded draft. The guard clears
  // when the text prop catches up to the hydrated value.
  const pendingEchoRef = React.useRef<string | null>(null);
  const getTextRef = React.useRef(getText);
  const setTextRef = React.useRef(setText);
  getTextRef.current = getText;
  setTextRef.current = setText;
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const scopeKey = scopeKeyOf(scope);

  // Scope transitions + hydration. Keyed on the scope KEY (not the object)
  // so re-renders with the same scope never re-hydrate over the user's text.
  React.useEffect(() => {
    const prevKey = hydratedKeyRef.current;
    const prevScope = currentScopeRef.current;
    // Identity change (user/workspace): flush NOTHING and hydrate NOTHING —
    // text typed at switch time belongs to the view the user is looking at
    // (the page preserves it), and writing it under the OLD identity's key
    // would leak it across workspaces. Only a chat switch within one
    // identity lands the old draft and hydrates the new one.
    const identityChanged =
      prevScope !== null &&
      scope !== null &&
      (prevScope.userId !== scope.userId || prevScope.workspaceId !== scope.workspaceId);
    if (prevKey && prevKey !== scopeKey && scope !== null && !identityChanged) {
      // Explicit context switch: land the previous scope's draft before the
      // new scope hydrates. getText still reflects the previous scope's text
      // (the new draft has not been applied yet). A null NEW scope is an
      // identity teardown — never flush into the old identity's key.
      cancelTimer();
      if (prevScope) writeChatDraft(prevScope, getTextRef.current());
    }
    currentScopeRef.current = scope;
    hydratedKeyRef.current = scopeKey;
    if (scope && !identityChanged) {
      const stored = readChatDraft(scope);
      pendingEchoRef.current = stored;
      setTextRef.current(stored);
    } else {
      pendingEchoRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  // Debounced persistence on text change. While a hydration echo is
  // outstanding the text prop may still be the pre-hydration value (e.g. ""
  // on mount) — scheduling a write then would wipe the loaded draft with the
  // stale text, so the write waits until the echo confirms.
  React.useEffect(() => {
    const key = hydratedKeyRef.current;
    const s = currentScopeRef.current;
    if (!key || !s || key !== scopeKeyOf(s)) return;
    if (pendingEchoRef.current !== null) {
      if (text === pendingEchoRef.current) pendingEchoRef.current = null;
      return;
    }
    cancelTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      writeChatDraft(s, getTextRef.current());
    }, DRAFT_DEBOUNCE_MS);
    return cancelTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, scopeKey]);

  // Immediate flush on pagehide and unmount so closing the tab or leaving
  // the page never loses up to 200 ms of typing.
  const flushNow = React.useCallback(() => {
    const key = hydratedKeyRef.current;
    const s = currentScopeRef.current;
    if (!key || !s || key !== scopeKeyOf(s)) return; // mid-switch: own nothing yet
    if (pendingEchoRef.current !== null) return; // hydration just landed: nothing new to save
    cancelTimer();
    writeChatDraft(s, getTextRef.current());
  }, []);
  React.useEffect(() => {
    const onPageHide = () => flushNow();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      flushNow();
    };
  }, [flushNow]);

  /** Send-path erase: drops the CURRENT scope's stored draft immediately
   *  (and cancels any pending debounced write of it). */
  const clearCurrent = React.useCallback(() => {
    const key = hydratedKeyRef.current;
    const s = currentScopeRef.current;
    if (!key || !s || key !== scopeKeyOf(s)) return;
    cancelTimer();
    pendingEchoRef.current = ""; // the page clears its input next; treat "" as the echo
    clearChatDraft(s);
  }, []);

  return { flushNow, clearCurrent };
}
