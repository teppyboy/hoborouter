import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { History, Send, Square } from "lucide-react";
import { createSseParser, type StreamDelta } from "./sse";
import { ConversationList, conversationListKey } from "./conversation-list";
import { buildPersistMessages, findRetryTurn, isEmptyAssistant, type TurnMessage } from "./turn";
import {
  ConversationError,
  createConversation,
  getConversation,
  saveConversation,
} from "./conversations";
import { renderMarkdown } from "../legal/legal-page";
import { ErrorState, CopyButton } from "../../components/page";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Switch } from "../../components/ui/switch";
import { Textarea } from "../../components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "../../components/ui/sheet";
import { useSession } from "../../lib/auth";
import { useCurrentWorkspaceId } from "../../lib/workspace-queries";
import { useCatalogModels } from "../models/data";
import {
  ManagedKeyError,
  chatKeyStorageKey,
  clearManagedChatKey,
  useManagedChatKey,
} from "./managed-key";

// Manual pasted key (Advanced): memory by default; the remember switch opts
// into sessionStorage under a per-user+workspace scoped key, so a remembered
// key can only ever be restored by the identity that saved it. The legacy
// unscoped "hbr-chat-key" is never read — it could hand one user's key to
// the next person on the browser. Never localStorage, never logged, never
// sent anywhere except the gateway Authorization header.

// Turn message shape shared with the pure helpers in ./turn.
type ChatMessage = TurnMessage;

// Actionable starters: each is a real prompt a user can send or edit.
const PROMPT_CHIPS = [
  "Help me write a debounce function in TypeScript.",
  "Explain how HTTP streaming works, end to end.",
  "Debug why my React component renders twice.",
];

function readableError(status: number, body: { error?: { message?: string } } | null): string {
  const msg = body?.error?.message;
  if (status === 401)
    return msg ?? "Invalid API key. Paste a valid sk-hbr- key from the API keys page.";
  if (status === 402) return msg ?? "Insufficient wallet balance for this request.";
  if (status === 404) return msg ?? "Model not found. Pick another model.";
  return msg ?? `Request failed (${status}).`;
}

function appendDelta(msg: ChatMessage, delta: StreamDelta): ChatMessage {
  return {
    ...msg,
    content: msg.content + delta.content,
    reasoning: msg.reasoning + delta.reasoning,
  };
}

export function ChatPage() {
  const { data: session } = useSession();
  const userId = session?.user?.id ?? null;
  const workspaceId = useCurrentWorkspaceId();
  const queryClient = useQueryClient();
  const { ensureKey } = useManagedChatKey(userId, workspaceId);

  // History list invalidation after a successful create/save: the sidebar
  // query keys on user+workspace, so invalidating the exact key refreshes the
  // saved-conversation list a new chat just joined.
  const invalidateConversationList = () => {
    if (!userId || !workspaceId) return;
    void queryClient.invalidateQueries({
      queryKey: conversationListKey(userId, workspaceId),
    });
  };

  // Public model catalog is session-scoped: models load without any API key,
  // so the picker never needs to mint a key just to be useful.
  const { models, loading: modelsLoading, error: modelsError } = useCatalogModels();
  const [model, setModel] = React.useState("");

  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [input, setInput] = React.useState("");
  const [streaming, setStreaming] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [keyError, setKeyError] = React.useState<ManagedKeyError | null>(null);
  const [autoKeyReady, setAutoKeyReady] = React.useState(false);
  // Saved conversation identity. null = a new, unsaved chat: it is blank until
  // the first send, which creates the server conversation exactly once. The
  // ref mirrors the state so the send lifecycle can read the id after awaits.
  const [activeChatId, setActiveChatId] = React.useState<string | null>(null);
  const activeChatIdRef = React.useRef<string | null>(null);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  // 409 from an optimistic save: the server snapshot moved under us. We never
  // overwrite blindly — the local transcript stays visible but is clearly
  // marked unsaved until the user explicitly reloads the saved version.
  const [conflict, setConflict] = React.useState(false);
  const [saveNotice, setSaveNotice] = React.useState<string | null>(null);
  const [loadingChat, setLoadingChat] = React.useState(false);
  // Server version per conversation id (a late save for a previous chat must
  // never touch the active chat's version).
  const versionsRef = React.useRef<Map<string, number>>(new Map());
  // Guards stale conversation loads (open another chat while one is loading).
  const loadSeqRef = React.useRef(0);
  // Streaming assistant partial for the current send, mirrored to a ref so the
  // terminal save can build the full transcript without re-reading state.
  const assistantPartialRef = React.useRef({ content: "", reasoning: "" });
  // Manual pasted key (Advanced). Memory only unless the remember switch opts
  // into sessionStorage below; while set it takes precedence over the managed
  // key and never auto-migrates anywhere else.
  const [manualKey, setManualKey] = React.useState("");
  const [remember, setRemember] = React.useState(false);

  const abortRef = React.useRef<AbortController | null>(null);
  // Sticky-bottom follow for the conversation log: ref to the scroll element
  // plus whether the user is near the bottom. While streaming, the log only
  // auto-scrolls when the user hasn't scrolled up to read history.
  const logRef = React.useRef<HTMLDivElement | null>(null);
  const followLogRef = React.useRef(true);
  // Last user prompt for the explicit Retry button. Retrying re-runs the same
  // paid gateway call — it is never fired automatically.
  const lastUserRef = React.useRef<string | null>(null);
  // Guards stale request lifecycles from clobbering newer state. Bumped (not
  // just aborted) on stop/new chat/model change/identity change/unmount: an
  // aborted await may still resume, so every state write re-checks seq AND
  // identity.
  const seqRef = React.useRef(0);
  // Synchronous busy flag: state alone lags a re-render, so two send events in
  // the same tick (Enter + click) must not both pass the guard.
  const busyRef = React.useRef(false);

  function invalidateGeneration() {
    seqRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    busyRef.current = false;
    setStreaming(false);
  }

  // Unmount: abort any in-flight stream and invalidate the generation so no
  // late continuation can write state.
  React.useEffect(
    () => () => {
      seqRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
    },
    [],
  );

  // Manual remembered key lifecycle, scoped to the session identity. The
  // legacy unscoped "hbr-chat-key" is never read (cross-user leak on shared
  // browsers). On any real identity/workspace transition the previous
  // identity's remembered key is dropped and the new identity's own scoped
  // entry, if any, is restored. A pending session (null → known, first mount
  // or re-login) wipes nothing: state survives until the identity is known.
  // All storage access is best-effort — failures leave the in-memory key
  // working for this tab.
  const manualIdentityRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const id = userId && workspaceId ? chatKeyStorageKey(userId, workspaceId) : null;
    const prevId = manualIdentityRef.current;
    if (prevId === id) {
      if (!id) return;
      try {
        if (remember && manualKey) sessionStorage.setItem(id, manualKey);
        else sessionStorage.removeItem(id);
      } catch {
        // sessionStorage unavailable/full: memory still works this tab.
      }
      return;
    }
    manualIdentityRef.current = id;
    if (prevId) {
      // Identity/workspace switch or logout: never carry the previous
      // identity's key over.
      setManualKey("");
      setRemember(false);
      try {
        sessionStorage.removeItem(prevId);
      } catch {
        // sessionStorage unavailable: the scoped key just stays unreferenced.
      }
    }
    if (!id) return;
    try {
      const saved = sessionStorage.getItem(id);
      if (saved) {
        setManualKey(saved);
        setRemember(true);
      }
    } catch {
      // sessionStorage unavailable: start from the empty in-memory state.
    }
  }, [userId, workspaceId, remember, manualKey]);

  // Identity or workspace change: abort any in-flight stream and drop the
  // transcript AND the saved-conversation identity so one workspace's context
  // (or one user's private history) can never leak into another's view or
  // follow-ups. The managed-key cache clears itself on logout (see hook).
  const identityRef = React.useRef<string>("null:null");
  React.useEffect(() => {
    const id = `${userId ?? "null"}:${workspaceId ?? "null"}`;
    if (identityRef.current === id) return;
    const prev = identityRef.current;
    identityRef.current = id;
    if (prev === "null:null") return; // initial resolution: nothing to leak
    invalidateGeneration();
    loadSeqRef.current += 1;
    activeChatIdRef.current = null;
    versionsRef.current = new Map();
    setMessages([]);
    setActiveChatId(null);
    setConflict(false);
    setSaveNotice(null);
    setLoadingChat(false);
    setHistoryOpen(false);
    setError(null);
    setKeyError(null);
    setAutoKeyReady(false);
    lastUserRef.current = null;
  }, [userId, workspaceId]);

  // Model changes are a per-message choice, not a conversation boundary:
  // switching models keeps the existing context (like ChatGPT). The model is
  // persisted with every save; an explicit "New chat" is how context resets.

  function stop() {
    // Abort only — the in-flight send's own terminal path persists the partial
    // reply and clears the busy flags. Bumping the generation here would skip
    // that save.
    abortRef.current?.abort();
  }

  function newChat() {
    // Abandoning the current view (stream included) — partials are not saved
    // on this path; the explicit Stop button is the way to keep one.
    invalidateGeneration();
    // Bump the load sequence too: an in-flight or late openChat response for
    // the abandoned view must never restore the old conversation here.
    loadSeqRef.current += 1;
    activeChatIdRef.current = null;
    setActiveChatId(null);
    setMessages([]);
    setError(null);
    setKeyError(null);
    setConflict(false);
    setSaveNotice(null);
    setLoadingChat(false);
    lastUserRef.current = null;
  }

  function dropTrailingEmptyAssistant() {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      return last && isEmptyAssistant(last) ? prev.slice(0, -1) : prev;
    });
    const partial = assistantPartialRef.current;
    if (partial.content === "" && partial.reasoning === "") return;
    assistantPartialRef.current = { content: "", reasoning: "" };
  }

  /** Explicit reconnect (401 path): clears ONLY the cached managed key; the
   *  next explicit send/connect mints a fresh one. No automatic retry loop. */
  function reconnect() {
    if (userId && workspaceId) clearManagedChatKey({ userId, workspaceId });
    setKeyError(null);
    setAutoKeyReady(false);
  }

  /** Open a saved conversation: abort any in-flight generation first, then
   *  load the server snapshot. Stale loads (user kept clicking) are guarded
   *  by loadSeqRef and the identity ref; a response from another identity or
   *  a superseded selection never lands in state. */
  async function openChat(chatId: string) {
    invalidateGeneration();
    const seq = ++loadSeqRef.current;
    const idAtLoad = identityRef.current;
    const ws = workspaceId;
    const isLoadCurrent = () => loadSeqRef.current === seq && identityRef.current === idAtLoad;
    activeChatIdRef.current = chatId;
    setActiveChatId(chatId);
    setMessages([]);
    setError(null);
    setConflict(false);
    setSaveNotice(null);
    lastUserRef.current = null;
    if (!ws) return;
    setLoadingChat(true);
    try {
      const snap = await getConversation(ws, chatId);
      if (!isLoadCurrent()) return;
      versionsRef.current.set(chatId, snap.version);
      setMessages(
        snap.messages.map((m) => ({
          role: m.role,
          content: m.content,
          reasoning: m.reasoning ?? "",
        })),
      );
      if (snap.model) setModel(snap.model);
    } catch (e) {
      if (!isLoadCurrent()) return;
      setError(
        e instanceof ConversationError && e.kind === "notFound"
          ? "Conversation not found (it may belong to another account)."
          : "Could not load this conversation. Try again.",
      );
    } finally {
      if (isLoadCurrent()) setLoadingChat(false);
    }
  }

  /** Reload the saved server snapshot after a 409 conflict. The unsaved local
   *  transcript is deliberately discarded — the user chose the saved version. */
  function reloadActive() {
    const chatId = activeChatIdRef.current;
    if (chatId) void openChat(chatId);
  }

  /** Immutable snapshot of one finished turn, captured before any await so a
   *  concurrent send can never mutate what gets persisted. */
  interface TurnSnapshot {
    seq: number;
    idAtSend: string;
    chatId: string;
    baseMessages: ChatMessage[];
    userText: string;
    isFirstTurn: boolean;
    model: string;
  }

  /** A save may only update the VIEW it belongs to: same identity, same
   *  generation (no new chat/open/identity change since), and still the
   *  active chat. A late save for a superseded view still reaches the
   *  SERVER (same identity = same private conversation) but never clobbers
   *  the new view's notice/conflict/version state. */
  const viewCurrent = (t: TurnSnapshot) =>
    identityRef.current === t.idAtSend &&
    seqRef.current === t.seq &&
    activeChatIdRef.current === t.chatId;

  /** Persist one finished turn (completed, stopped, or failed — never per
   *  token). The first turn of a new conversation also sets the literal title:
   *  the user's own prompt, truncated to the server's 120-char cap — never
   *  AI-generated, so storing history costs nothing extra. `partial` is the
   *  immutable assistant snapshot taken at the terminal point — never the
   *  live ref, which a newer send may already have reset. */
  async function persistTurn(
    t: TurnSnapshot,
    partial: { content: string; reasoning: string },
  ): Promise<void> {
    if (!userId || !workspaceId) return;
    const msgs = buildPersistMessages(t.baseMessages, t.userText, partial);
    const knownVersion = versionsRef.current.get(t.chatId);
    try {
      const snap = await saveConversation(workspaceId, t.chatId, {
        version: knownVersion ?? 1,
        title: t.isFirstTurn ? t.userText.slice(0, 120) : undefined,
        model: t.model,
        messages: msgs,
      });
      if (!viewCurrent(t)) return;
      versionsRef.current.set(t.chatId, snap.version);
      setSaveNotice(null);
      invalidateConversationList();
    } catch (e) {
      if (!viewCurrent(t)) return; // old turn, new view: never touch it
      if (e instanceof ConversationError && e.kind === "conflict") {
        setConflict(true);
      } else {
        setSaveNotice("This conversation could not be saved to your history.");
      }
    }
  }

  /** Resolve the key for one send/connect. After every await the generation
   *  and identity are re-checked: an identity switch or generation bump while
   *  a key is being created must never repopulate state. */
  async function resolveKey(gen?: number, signal?: AbortSignal): Promise<string | null> {
    if (manualKey) return manualKey;
    if (!userId || !workspaceId) {
      setKeyError(
        new ManagedKeyError("unauthorized", "Sign in and choose a workspace to start chatting."),
      );
      return null;
    }
    const id = identityRef.current;
    const isCurrent = () =>
      identityRef.current === id && (gen === undefined || seqRef.current === gen);
    try {
      const key = await ensureKey(signal);
      if (!isCurrent()) return null;
      setAutoKeyReady(true);
      return key.plaintext;
    } catch (e) {
      if (!isCurrent()) return null;
      setKeyError(
        e instanceof ManagedKeyError
          ? e
          : new ManagedKeyError("invalid", "Could not create a chat key. Try again."),
      );
      return null;
    }
  }

  async function send(textOverride?: string, isRetry = false) {
    if (busyRef.current || streaming || !model || conflict) return;
    // Retry regenerates the LAST assistant reply from the existing history:
    // the user turn is reused as-is, never appended a second time.
    const retryTurn = isRetry ? findRetryTurn(messages) : null;
    if (isRetry && (!retryTurn || lastUserRef.current === null)) return;
    const text = (isRetry ? retryTurn?.userText : (textOverride ?? input))?.trim() ?? "";
    if (!text) return;
    // Busy + generation BEFORE the first await: a slow key creation can never
    // double-send, and a later stop/identity change owns the whole lifecycle.
    busyRef.current = true;
    setStreaming(true);
    const seq = ++seqRef.current;
    const idAtSend = identityRef.current;
    const isCurrent = () => seqRef.current === seq && identityRef.current === idAtSend;
    const ws = workspaceId;
    const canPersist = Boolean(ws);
    const isFirstTurn = isRetry
      ? retryTurn!.baseMessages.length === 0
      : messages.every(isEmptyAssistant);
    // The transcript before this turn, copied as an immutable persistence
    // snapshot (reasoning is stripped only for the paid API call below).
    const baseMessages: ChatMessage[] = (
      isRetry ? retryTurn!.baseMessages : messages.filter((m) => !isEmptyAssistant(m))
    ).map((m) => ({ ...m }));
    const ac = new AbortController();
    abortRef.current = ac;
    assistantPartialRef.current = { content: "", reasoning: "" };
    let chatId = activeChatIdRef.current;
    // Terminal save, AWAITED while busy: the next send cannot start until the
    // server version has been tracked, so a back-to-back send never saves on
    // a stale version and loses its turn to a 409.
    const saveTurn = (partial: { content: string; reasoning: string }) => {
      if (!canPersist || !chatId || !ws) return Promise.resolve();
      return persistTurn(
        { seq, idAtSend, chatId, baseMessages, userText: text, isFirstTurn, model },
        partial,
      );
    };
    try {
      // Create the server conversation exactly once, on the first send of a
      // new chat — storage only, no key needed, never per token. If storage
      // fails the (paid) generation still proceeds; the chat just stays
      // unsaved and a notice says so.
      if (canPersist && !chatId && ws) {
        try {
          const snap = await createConversation(ws);
          if (!isCurrent()) return;
          chatId = snap.id;
          activeChatIdRef.current = chatId;
          versionsRef.current.set(chatId, snap.version);
          setActiveChatId(chatId);
          invalidateConversationList();
        } catch {
          if (isCurrent())
            setSaveNotice("This conversation could not be saved. Messages will not be kept.");
        }
      }
      const key = await resolveKey(seq, ac.signal);
      if (!key || !isCurrent()) return;
      if (!isRetry && textOverride === undefined) setInput("");
      setError(null);
      // Failed/empty assistant turns are excluded from follow-up context.
      const history: Array<{ role: "user" | "assistant"; content: string }> = [
        ...baseMessages.map(({ role, content }) => ({ role, content })),
        { role: "user", content: text },
      ];
      // A deliberate send (fresh or retry) always re-engages sticky-bottom
      // follow: the user must see their own message and the streaming reply,
      // even if they had scrolled up, and even if a late scroll event during
      // layout of the previous turn latched followLogRef off.
      followLogRef.current = true;
      // The view keeps each prior message's reasoning (the Reasoning section
      // stays visible across sends); only the paid request body above strips
      // it to role+content.
      setMessages([
        ...baseMessages,
        { role: "user", content: text, reasoning: "" },
        { role: "assistant", content: "", reasoning: "" },
      ]);
      lastUserRef.current = text;
      const res = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ model, messages: history, stream: true }),
        signal: ac.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        if (!isCurrent()) return;
        if (!manualKey && res.status === 401) {
          // Managed key revoked or session gone: offer explicit reconnect.
          setKeyError(
            new ManagedKeyError(
              "unauthorized",
              "Your chat key is no longer valid. Reconnect to create a fresh one.",
            ),
          );
        } else {
          setError(readableError(res.status, body));
        }
        const partial = { ...assistantPartialRef.current };
        dropTrailingEmptyAssistant();
        // Failed turn (HTTP error): persist the user message so the history
        // matches what is on screen.
        await saveTurn(partial);
        return;
      }
      const reader = res.body?.getReader();
      if (!reader) throw new Error("Streaming is not supported in this browser.");
      const decoder = new TextDecoder();
      const parser = createSseParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (!isCurrent()) return; // superseded: no delta may repopulate state
        if (done) break;
        for (const delta of parser.push(decoder.decode(value, { stream: true }))) {
          appendToLast(delta);
        }
        if (parser.done) break;
      }
      // Completed: persist the full turn (user + assistant) in one write.
      await saveTurn({ ...assistantPartialRef.current });
    } catch (e) {
      if (!isCurrent()) return;
      if (e instanceof DOMException && e.name === "AbortError") {
        // Explicit stop: keep whatever streamed so far and persist it.
      } else {
        setError(e instanceof Error ? e.message : "Request failed.");
      }
      await saveTurn({ ...assistantPartialRef.current });
    } finally {
      // A newer request (or an invalidation) owns the streaming/busy flags.
      if (isCurrent()) {
        busyRef.current = false;
        setStreaming(false);
        abortRef.current = null;
      }
    }
  }

  function appendToLast(delta: StreamDelta) {
    assistantPartialRef.current = {
      content: assistantPartialRef.current.content + delta.content,
      reasoning: assistantPartialRef.current.reasoning + delta.reasoning,
    };
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== "assistant") return prev;
      return [...prev.slice(0, -1), appendDelta(last, delta)];
    });
  }

  // New content arrived (stream delta or sent message): pin the log to the
  // bottom only while the user is still following. useLayoutEffect, not a
  // passive effect: a passive pin runs after the browser's rendering steps,
  // leaving a frame where the log sits unscrolled with the distance already
  // grown past the 80px threshold — the onScroll handler then latches
  // followLogRef off (and scroll anchoring can fight the late pin), so the
  // log never followed the new message or the stream and stayed at scrollTop
  // 0. Pinning synchronously before paint removes that window.
  React.useLayoutEffect(() => {
    const el = logRef.current;
    if (el && followLogRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const autoEligible = Boolean(userId && workspaceId);
  const canSend = Boolean(
    input.trim() && model && !streaming && !conflict && (manualKey || autoEligible),
  );
  const showRetry = !streaming && lastUserRef.current !== null;

  const historyList = (
    <ConversationList
      userId={userId ?? ""}
      workspaceId={workspaceId ?? ""}
      activeChatId={activeChatId}
      onOpen={(chatId) => void openChat(chatId)}
      onClose={() => setHistoryOpen(false)}
      onRenamed={({ chatId, version }) => {
        // Rename saved through the same optimistic-version PUT: track the
        // new server version so the active chat's next turn save never 409s.
        if (chatId === activeChatIdRef.current) versionsRef.current.set(chatId, version);
      }}
      onArchive={(chatId) => {
        // Archive of the active chat: blank the view (model kept) so archived
        // history does not linger on screen and the next send cannot hit the
        // archived (unlistable) conversation with a stale version.
        if (chatId === activeChatIdRef.current) newChat();
      }}
    />
  );

  const keyErrorBlock = keyError && (
    <div className="space-y-1">
      <ErrorState message={keyError.message} />
      {keyError.kind === "forbidden" ? (
        <p className="text-xs text-muted-foreground">
          Members without owner/admin can still chat with a personal key:{" "}
          <a href="/keys" className="underline underline-offset-2">
            open API keys
          </a>{" "}
          and paste it under Advanced below.
        </p>
      ) : keyError.kind === "unauthorized" ? (
        <div>
          <Button variant="outline" size="sm" onClick={reconnect}>
            Reconnect
          </Button>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="-m-4 flex h-[calc(100dvh-3rem)] min-h-0 min-w-0 flex-1 overflow-hidden sm:-m-6">
      {/* Fixed viewport height below the 48px sticky app header, with the
        router Page wrapper's p-4 sm:p-6 cancelled by the negative margins,
        so the log (flex-1 min-h-0 overflow-y-auto) is the only scroller and
        the composer stays pinned; the page itself never scrolls. */}
      {/* Desktop: conversation history lives inside the chat pane. */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border px-2 py-2 lg:flex">
        {historyList}
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Compact top bar: history (phone), model picker + New chat. */}
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
          <h1 className="sr-only">Chat</h1>
          {/* Phone: history opens in a sheet owned by this page, not the app
            nav drawer. */}
          <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
            <SheetTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="lg:hidden"
                aria-label="Conversation history"
              >
                <History className="size-4" aria-hidden />
                History
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-80">
              <SheetTitle className="sr-only">Conversation history</SheetTitle>
              {historyList}
            </SheetContent>
          </Sheet>
          <Select value={model} onValueChange={setModel} disabled={models.length === 0}>
            <SelectTrigger
              id="chat-model"
              aria-label="Model"
              className="h-9 w-auto min-w-0 max-w-56 gap-1 border-0 bg-muted/50 shadow-none"
            >
              <SelectValue
                className="min-w-0 truncate"
                placeholder={
                  modelsLoading
                    ? "Loading models…"
                    : modelsError
                      ? "Model list unavailable"
                      : "Choose a model"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m.publicId} value={m.publicId}>
                  {m.displayName ?? m.publicId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">
            {autoEligible && !autoKeyReady && !manualKey && !keyError && (
              <Button variant="ghost" size="sm" onClick={() => void resolveKey()}>
                Connect
              </Button>
            )}{" "}
            <Button
              variant="outline"
              size="sm"
              onClick={newChat}
              disabled={messages.length === 0 && !streaming && activeChatId === null}
            >
              New chat
            </Button>
          </div>
        </div>

        {modelsError && <ErrorState message={`Models: ${modelsError}`} />}

        {conflict && (
          <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2">
            <p className="text-sm font-medium">
              This conversation changed on another device or tab.
            </p>
            <p className="text-xs text-muted-foreground">
              Your newest messages below are still shown here but are NOT saved.
            </p>
            <Button variant="outline" size="sm" className="mt-1" onClick={reloadActive}>
              Reload saved version
            </Button>
          </div>
        )}
        {saveNotice && (
          <p className="px-4 py-1 text-xs text-amber-600" role="status">
            {saveNotice}
          </p>
        )}
        {loadingChat && messages.length === 0 && (
          <p className="px-4 py-2 text-sm text-muted-foreground">Loading conversation…</p>
        )}

        {messages.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 py-16 text-center">
            <h2 className="text-2xl font-semibold tracking-tight">What would you like to build?</h2>
            <div className="flex flex-wrap justify-center gap-2">
              {PROMPT_CHIPS.map((chip) => (
                <Button
                  key={chip}
                  variant="outline"
                  size="sm"
                  onClick={() => setInput(chip)}
                  className="h-auto max-w-full min-h-9 py-2 text-left whitespace-normal"
                >
                  {chip}
                </Button>
              ))}
            </div>
            <p className="max-w-md text-sm text-muted-foreground">
              A workspace chat key ("Browser Chat") is created automatically on your first message —
              no need to paste a key. Usage is charged to your selected workspace.
            </p>
            {!userId && (
              <p className="text-sm text-muted-foreground">
                Sign in to start chatting, or paste your own key under Advanced below.
              </p>
            )}
          </div>
        ) : (
          <div
            className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]"
            role="log"
            aria-live="polite"
            aria-label="Conversation"
            onScroll={() => {
              const el = logRef.current;
              if (!el) return;
              followLogRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
            ref={logRef}
          >
            <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-4">
              {messages.map((m, i) =>
                m.role === "user" ? (
                  <div key={i} className="flex justify-end">
                    <div className="max-w-[85%] wrap-anywhere whitespace-pre-wrap rounded-2xl bg-muted px-4 py-2 text-sm">
                      {m.content}
                    </div>
                  </div>
                ) : (
                  <div key={i} className="w-full space-y-1 text-sm leading-relaxed">
                    {m.reasoning && (
                      <details className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                        <summary className="cursor-pointer select-none font-medium">
                          Reasoning
                        </summary>
                        <div className="mt-1 wrap-anywhere whitespace-pre-wrap">{m.reasoning}</div>
                      </details>
                    )}
                    {m.content ? (
                      <>
                        <div className="[&_p]:my-2 [&_p]:[overflow-wrap:anywhere]">{renderMarkdown(m.content)}</div>
                        <div className="flex justify-end">
                          <CopyButton value={m.content} label="Copy reply" />
                        </div>
                      </>
                    ) : (
                      !m.reasoning &&
                      streaming &&
                      i === messages.length - 1 && (
                        <div className="animate-pulse text-muted-foreground">Thinking…</div>
                      )
                    )}
                  </div>
                ),
              )}
            </div>
          </div>
        )}

        <div className="mx-auto w-full max-w-3xl px-4 pb-safe">
          {error && <ErrorState message={error} />}
          {keyErrorBlock}
          {showRetry && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1">
              <Button variant="outline" size="sm" onClick={() => void send(undefined, true)}>
                Retry last reply
              </Button>
              <p className="min-w-0 text-xs text-muted-foreground">
                Regenerates the last reply — usage will be charged again.
              </p>
            </div>
          )}
          <div className="relative rounded-2xl border border-border bg-card p-2 shadow-sm">
            <Textarea
              aria-label="Message"
              rows={1}
              placeholder={
                model
                  ? "Send a message… (Enter to send, Shift+Enter for a new line)"
                  : "Choose a model first"
              }
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // IME composition: Enter confirms the candidate, not the message.
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              className="max-h-48 min-h-10 resize-none border-0 bg-transparent px-2 py-1 shadow-none field-sizing-content focus-visible:ring-0"
            />
            <div className="flex justify-end pt-1">
              {streaming ? (
                <Button size="icon" variant="outline" onClick={stop} aria-label="Stop generating">
                  <Square className="size-4" aria-hidden />
                </Button>
              ) : (
                <Button
                  size="icon"
                  onClick={() => void send()}
                  disabled={!canSend}
                  aria-label="Send message"
                >
                  <Send className="size-4" aria-hidden />
                </Button>
              )}
            </div>
          </div>
          <p className="py-2 text-center text-xs text-muted-foreground">
            Usage is charged to your selected workspace.
          </p>

          {/* Advanced: manual pasted key, collapsed by default. Kept for members
            who cannot (or prefer not to) use the managed workspace key. */}
          <details className="pb-2">
            <summary className="cursor-pointer select-none text-xs text-muted-foreground hover:text-foreground">
              Advanced: use your own API key
            </summary>
            <div className="mt-2 flex flex-wrap items-end gap-3 rounded-lg border border-border p-3">
              <div className="min-w-56 flex-1 space-y-1.5">
                <Label htmlFor="chat-api-key">API key</Label>
                <Input
                  id="chat-api-key"
                  type="password"
                  autoComplete="off"
                  placeholder="sk-hbr-…"
                  value={manualKey}
                  onChange={(e) => setManualKey(e.target.value.trim())}
                />
              </div>
              <div className="flex items-center gap-2 pb-1">
                <Switch
                  id="chat-remember"
                  checked={remember}
                  onCheckedChange={setRemember}
                  aria-label="Remember key for this tab"
                />
                <Label
                  htmlFor="chat-remember"
                  className="text-sm font-normal text-muted-foreground"
                >
                  Remember for this tab
                </Label>
              </div>
              <p className="w-full text-xs text-muted-foreground">
                While set, your pasted key is used for this tab instead of the workspace chat key.
              </p>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
