import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { History, PanelLeftClose, PanelLeftOpen, Plus } from "lucide-react";
import { createSseParser, type StreamDelta, type StreamUsage } from "./sse";
import { Transcript, type TranscriptHandle } from "./transcript";
import { ModelControls } from "./model-controls";
import { useChatDraftSync } from "./use-chat-drafts";
import {
  recallChatEffort,
  recallChatModel,
  rememberChatEffort,
  rememberChatModel,
  validModelChoice,
} from "./preferences";
import { writeChatDraft } from "./draft";
import { fetchChatReceipt, chargedVndLabel } from "./receipts";
import type { MemberChatAccess } from "@hoborouter/shared";
import { api } from "../../lib/api";
import { formatDate } from "../../lib/format";
import { ConversationList, conversationListKey } from "./conversation-list";
import {
  buildPersistMessages,
  createRenderCoalescer,
  findRetryTurn,
  isEmptyAssistant,
  type ChatAttachmentRef,
  type TurnMessage,
} from "./turn";
import { prepareChatSend } from "./prepare-send";
import { stripAttachments } from "./persistent-attachments";
import type { ConversationMessage } from "@hoborouter/shared";
import {
  ConversationError,
  createConversation,
  forkConversation,
  getConversation,
  saveConversation,
} from "./conversations";
import { ErrorState } from "../../components/page";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import {
  ManagedKeyError,
  clearManagedChatKey,
  useManagedChatKey,
  type ManagedKeyPurpose,
} from "./managed-key";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "../../components/ui/sheet";
import { useSession } from "../../lib/auth";
import { useCurrentWorkspaceId } from "../../lib/workspace-queries";
import { useCatalogModels } from "../models/data";
import { buildUserContent, type ChatAttachment, type UserContent } from "./attachments";
import { Composer, useComposerDraft } from "./composer";
import { useLocaleEntry, type LocaleEntry } from "../../lib/i18n/t";
import { PROMPT_CHIPS, readableError, useChatT } from "./copy";
import { EFFORT_UNSET, supportedEffortOptions, type ReasoningEffort } from "./reasoning";
import { useComposerT } from "./composer-copy";
// Chat page copy lives in ./copy.ts (see lib/i18n/common.ts). Model
// names, message content and API errors stay verbatim — only chrome, notices
// and controls are translated.

// Turn message shape shared with the pure helpers in ./turn.
type ChatMessage = TurnMessage;

// Desktop conversation-list collapse is a device UI preference — persisted
// in localStorage, independent of the signed-in identity.
const SIDEBAR_PREF_KEY = "chat.sidebar.collapsed";

function readSidebarPref(): boolean {
  try {
    return globalThis.localStorage?.getItem(SIDEBAR_PREF_KEY) === "1";
  } catch {
    return false; // unavailable storage: default expanded
  }
}

function appendDelta(msg: ChatMessage, delta: StreamDelta, model: string | null): ChatMessage {
  return {
    ...msg,
    content: msg.content + delta.content,
    reasoning: msg.reasoning + delta.reasoning,
    model: msg.model ?? model ?? undefined,
  };
}

/** One suggestion chip; component boundary keeps useLocaleEntry per-element. */
function PromptChip({ chip, onPick }: { chip: LocaleEntry; onPick: (text: string) => void }) {
  const text = useLocaleEntry(chip);
  return (
    <Button
      key={chip.en}
      variant="outline"
      size="sm"
      onClick={() => onPick(text)}
      className="h-auto max-w-full min-h-9 py-2 text-left whitespace-normal"
    >
      {text}
    </Button>
  );
}

export function ChatPage() {
  const t = useChatT();
  const composerT = useComposerT();
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
  // Only server-published public IDs may ever appear as a response label or be
  // persisted: a forged/unknown SSE `model` must never become user-facing.
  const catalogModelIds = React.useMemo(() => new Set(models.map((m) => m.publicId)), [models]);
  // Sends wait for the catalog query to settle successfully: the SSE response
  // model is validated against catalog membership, so a pending catalog would
  // silently drop the genuine public ID (never persisted, never re-supplied).
  // On failure, sending stays disabled behind a visible bilingual error —
  // never an infinite hidden wait.
  const catalogReady = !modelsLoading && !modelsError;
  const [model, setModel] = React.useState("");
  // Thinking effort for the canonical reasoning carrier (see ./reasoning).
  // "default" sends no reasoning field at all — legacy request shape.
  const [effort, setEffort] = React.useState<string>(EFFORT_UNSET);
  // Selected model's catalog-authored reasoning metadata drives the effort
  // selector: only models with authored supported_efforts show the picker, and
  // only those authored efforts are offered (never the full ladder — no
  // unsupported options). An effort picked for one model is dropped, never
  // leaked into another model's request.
  const effortOptions = supportedEffortOptions(models.find((m) => m.publicId === model)?.reasoning);
  const showEffort = effortOptions.length > 0;
  const effortForSend =
    showEffort && effortOptions.includes(effort as ReasoningEffort) ? effort : EFFORT_UNSET;

  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  // Session-only multimodal retention: conversation id -> user-turn index ->
  // the full request content captured when that turn was sent. Lets follow-ups
  // AND retries keep carrying this session's attachments (which persistence
  // drops, history being string-only). Cleared on identity change; bounded by
  // the session's own turn count.
  const multimodalRef = React.useRef<Map<string, Map<number, UserContent>>>(new Map());
  // Whether the most recently SENT turn carried attachments (drives the
  // truthful retry disclosure).
  const [lastTurnAttached, setLastTurnAttached] = React.useState(false);
  const [streaming, setStreaming] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // 402 wallet gate: the wallet alert carries a top-up link (SPA route),
  // cleared with every error so the link never outlives its cause.
  const [walletGate, setWalletGate] = React.useState(false);
  // Per-turn billing receipt + validated SSE usage for the last reply.
  const [receiptLine, setReceiptLine] = React.useState<string | null>(null);
  const [lastUsage, setLastUsage] = React.useState<StreamUsage | null>(null);
  // Persistent gateway-413 recovery state: the pre-send draft snapshot (text
  // + attachments captured BEFORE the programmatic clear) plus whether the
  // user mutated the draft since (revision changed). Snapshot is held only
  // while the 413 alert lives; dismissed/stale ⇒ dropped, never restored.
  const [send413, setSend413] = React.useState<{
    text: string;
    attachments: ChatAttachment[];
    revisionChanged: boolean;
    /** Server-echoed UX purpose of the key that got the 413: chat-purpose
     *  keys allow 16 MiB, so the copy must not push a needless new key. */
    keyPurpose: ManagedKeyPurpose;
  } | null>(null);
  const [restoreConfirm, setRestoreConfirm] = React.useState(false);
  const [unavailableSend, setUnavailableSend] = React.useState<{
    files: Array<{ id: string; name: string }>;
    textOverride?: string;
    isRetry: boolean;
    omitIds: ReadonlySet<string>;
  } | null>(null);
  const [keyError, setKeyError] = React.useState<ManagedKeyError | null>(null);
  // Saved conversation identity. null = a new, unsaved chat: it is blank until
  // the first send, which creates the server conversation exactly once. The
  // ref mirrors the state so the send lifecycle can read the id after awaits.
  const [activeChatId, setActiveChatId] = React.useState<string | null>(null);
  const activeChatIdRef = React.useRef<string | null>(null);
  // Draft persistence scope: changes ONLY on user-driven context switches
  // (open / new / fork) and identity teardown. The send's programmatic
  // conversation creation deliberately does NOT move it — the scope effect
  // would hydrate the fresh (empty) draft over the composer in the same
  // batch as the 413 rollback restore, wiping the recovered snapshot. One
  // explicit object (not derived from userId) so an identity switch is a
  // single atomic scope transition, never a half-applied pair.
  const [draftScope, setDraftScope] = React.useState<{
    userId: string;
    workspaceId: string;
    chatId: string | null;
  } | null>(null);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  // Desktop conversation-list collapse: device UI pref, identity-independent.
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(readSidebarPref);
  function toggleSidebar() {
    setSidebarCollapsed((v) => {
      const next = !v;
      try {
        globalThis.localStorage?.setItem(SIDEBAR_PREF_KEY, next ? "1" : "0");
      } catch {
        // Unavailable storage: the pref stays session-only.
      }
      return next;
    });
  }
  // Auto-uncollapse on explicit conversation intent (starting a new chat,
  // opening a saved conversation): Open-WebUI-style expansion of the list for
  // THIS view only. The sticky device pref is deliberately NOT rewritten —
  // only toggleSidebar persists it, so a reload returns to the user's saved
  // collapsed state.
  function expandSidebarSession() {
    setSidebarCollapsed(false);
  }
  /** New chat is explicit intent to see the conversation list again. */
  function startNewChat() {
    newChat();
    expandSidebarSession();
  }
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
  const assistantPartialRef = React.useRef<{
    content: string;
    reasoning: string;
    model?: string;
    /** Gateway correlation id for the billing receipt (assistant-only). */
    request_id?: string;
  }>({ content: "", reasoning: "" });
  const abortRef = React.useRef<AbortController | null>(null);
  // Sticky-bottom follow of the conversation log lives in <Transcript>; the
  // page re-engages it via the handle on deliberate sends and view resets.
  const transcriptRef = React.useRef<TranscriptHandle | null>(null);
  const followLog = () => transcriptRef.current?.follow();
  // Last user prompt for the explicit Retry button. Retrying re-runs the same
  // paid gateway call — it is never fired automatically.
  const lastUserRef = React.useRef<string | null>(null);
  // Guards stale request lifecycles from clobbering newer state. Bumped (not
  // just aborted) on stop/new chat/model change/identity change/unmount: an
  // aborted await may still resume, so every state write re-checks seq AND
  // identity.
  const seqRef = React.useRef(0);
  // Identity (user:workspace) of the current view; shared by the send
  // lifecycle and the composer's late-attachment-read guard.
  const identityRef = React.useRef<string>("null:null");
  // Synchronous busy flag: state alone lags a re-render, so two send events in
  // the same tick (Enter + click) must not both pass the guard.
  const busyRef = React.useRef(false);
  // Composer-owned draft (text, attachments, revision counter). identityRef
  // and seqRef guard late attachment reads; seqRef moves with the send seam.
  const draft = useComposerDraft({ identityRef, seqRef, workspaceId });

  // Session text-draft persistence (hbr-chat-draft: keys; cleared on logout by
  // lib/logout.ts). Scope includes the active chat id so drafts never cross
  // conversations; identity switches flush + hydrate through the hook.
  const drafts = useChatDraftSync({
    scope: draftScope,
    text: draft.input,
    getText: () => draft.input,
    setText: draft.setInput,
  });

  // Remembered model/effort (localStorage, public IDs only — never upstream
  // keys or raw prompts). Applied once per identity after the catalog settles:
  // a remembered ID no longer published is dropped, never applied.
  const prefsAppliedRef = React.useRef(false);
  React.useEffect(() => {
    if (!userId || !workspaceId || !catalogReady || prefsAppliedRef.current) return;
    prefsAppliedRef.current = true;
    const m = validModelChoice(recallChatModel(userId, workspaceId), models);
    if (m) setModel(m);
    const e = recallChatEffort(userId, workspaceId);
    if (e) setEffort(e);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, workspaceId, catalogReady]);

  function changeModel(publicId: string) {
    setModel(publicId);
    if (userId && workspaceId) rememberChatModel(userId, workspaceId, publicId);
  }
  function changeEffort(effort: string) {
    setEffort(effort);
    if (userId && workspaceId) rememberChatEffort(userId, workspaceId, effort);
  }

  // Member chat access gate (actual API DTO). can_chat=false blocks only
  // "member" roles here: owner/admin are wrongly reported as blocked while
  // the policy is off — a known member-chat-policy route bug being fixed by
  // that lane; the gate must not lock admins out meanwhile.
  const access = useQuery({
    queryKey: ["member-chat-access", workspaceId],
    queryFn: ({ signal }) =>
      api<MemberChatAccess>(`/api/v1/workspaces/${workspaceId}/member-chat-access`, { signal }),
    enabled: Boolean(userId && workspaceId),
    retry: false,
  });
  const memberBlocked =
    Boolean(access.data) && !access.data!.can_chat && access.data!.role === "member";
  const memberLimited =
    Boolean(access.data) &&
    access.data!.can_chat &&
    access.data!.daily_cap_vnd !== null &&
    access.data!.remaining_vnd === 0;

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

  // Identity or workspace change: abort any in-flight stream and drop the
  // transcript AND the saved-conversation identity so one workspace's context
  // (or one user's private history) can never leak into another's view or
  // follow-ups. The managed-key cache clears itself on logout (see hook).
  React.useEffect(() => {
    const id = `${userId ?? "null"}:${workspaceId ?? "null"}`;
    if (identityRef.current === id) return;
    const prev = identityRef.current;
    identityRef.current = id;
    if (prev === "null:null") {
      // Initial identity resolution: the unsaved "new chat" view still owns a
      // draft scope (chatId null → the `new` key), or fresh-page typing would
      // never persist.
      if (userId && workspaceId)
        setDraftScope({ userId, workspaceId, chatId: activeChatIdRef.current });
      return; // nothing to leak on first resolution
    }
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
    setSend413(null); // identity switch: the snapshot never crosses identities
    setRestoreConfirm(false);
    setLastTurnAttached(false);
    setWalletGate(false);
    setReceiptLine(null);
    setLastUsage(null);
    // Identity switch lands the NEW identity's scope (chatId null: the saved
    // chat was just dropped); a sign-out (null identity) tears the scope down.
    setDraftScope(userId && workspaceId ? { userId, workspaceId, chatId: null } : null);
    draft.clearAttachments();
    multimodalRef.current.clear();
    lastUserRef.current = null;
    followLog();
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
    // The unsaved view keeps a real scope (chatId null) so "New chat" typing
    // still persists under the `new` key.
    setDraftScope(userId && workspaceId ? { userId, workspaceId, chatId: null } : null);
    setMessages([]);
    setError(null);
    setUnavailableSend(null);
    setKeyError(null);
    setConflict(false);
    setSaveNotice(null);
    setLoadingChat(false);
    setSend413(null);
    setRestoreConfirm(false);
    setLastTurnAttached(false);
    setWalletGate(false);
    setReceiptLine(null);
    setLastUsage(null);
    draft.clearAttachments();
    lastUserRef.current = null;
    // A fresh view always starts pinned to its latest message (same contract
    // as a deliberate send): reading position from a previous view must not
    // leak into the new one.
    followLog();
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
  }

  /** Gateway-413 reconnect: clears ONLY the browser-side managed-key state
   *  (memory cache + namespaced storage). NO API call, never a revoke or
   *  disable of the old server-side key; the failed message is not retried —
   *  the next explicit send mints a chat-purpose key via /chat-key. */
  function reconnectKey() {
    if (userId && workspaceId) clearManagedChatKey({ userId, workspaceId });
  }

  /** Manual dismissal of the 413 alert: drops the recoverable snapshot. */
  function dismiss413() {
    setSend413(null);
    setRestoreConfirm(false);
  }

  /** Confirmed restore of the pre-send snapshot (revision-changed path only):
   *  replaces the newer draft + attachments. Never fired automatically. */
  function confirmRestore() {
    if (!send413) return;
    draft.setInput(send413.text);
    draft.applyAttachments([...send413.attachments]);
    setSend413(null);
    setRestoreConfirm(false);
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
    if (userId && ws) setDraftScope({ userId, workspaceId: ws, chatId });
    setMessages([]);
    setError(null);
    setUnavailableSend(null);
    setConflict(false);
    setSaveNotice(null);
    setSend413(null);
    setRestoreConfirm(false);
    setLastTurnAttached(false);
    setWalletGate(false);
    setReceiptLine(null);
    setLastUsage(null);
    draft.clearAttachments();
    lastUserRef.current = null;
    followLog();
    if (!ws) return;
    setLoadingChat(true);
    try {
      const snap = await getConversation(ws, chatId);
      if (!isLoadCurrent()) return;
      versionsRef.current.set(chatId, snap.version);
      applySnapshot(snap);
      rehydrateUploads(
        snap.messages.flatMap((m) => (m.role === "user" ? (m.attachments ?? []) : [])),
      );
    } catch (e) {
      if (!isLoadCurrent()) return;
      setError(
        e instanceof ConversationError && e.kind === "notFound"
          ? t("convNotFound")
          : t("convLoadFailed"),
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

  /** Server snapshot -> view messages: attachment refs and the billing
   *  request_id ride along so chips and receipts survive a reload. */
  function applySnapshot(snap: {
    messages: Array<{
      role: "user" | "assistant";
      content: string;
      reasoning?: string;
      model?: string;
      attachments?: ChatAttachmentRef[];
      request_id?: string;
    }>;
    model: string | null;
  }) {
    setMessages(
      snap.messages.map((m) => ({
        role: m.role,
        content: m.content,
        reasoning: m.reasoning ?? "",
        model: m.role === "assistant" ? m.model : undefined,
        attachments: m.role === "user" ? m.attachments : undefined,
        request_id: m.role === "assistant" ? m.request_id : undefined,
      })),
    );
    if (snap.model) setModel(snap.model);
  }

  /** Plug for the persistent attachment client (files lane, not committed
   *  yet): rehydrates composer/history upload state from the snapshot's
   *  user-turn attachment refs. Deliberately a no-op until that client lands;
   *  the call sites (openChat, fork) are the exact wiring point. */
  function rehydrateUploads(_refs: ChatAttachmentRef[]) {}

  /** Fork the conversation through the turn at `message_index` (the SERVER
   *  index: the user turn being forked through). The source conversation is
   *  never touched; the view switches to the returned full snapshot. An
   *  edited turn pre-fills the composer — the next send is an EXPLICIT paid
   *  generation, never auto-fired. Unsaved chats (no tracked version) cannot
   *  fork: the transcript's optimistic turns have no server index. */
  async function forkAt(messageIndex: number, content?: string, prefill?: string) {
    const ws = workspaceId;
    const chatId = activeChatIdRef.current;
    if (!ws || !chatId || streaming || busyRef.current) return;
    const version = versionsRef.current.get(chatId);
    if (version === undefined) {
      setError(t("forkUnsaved"));
      return;
    }
    try {
      const snap = await forkConversation(ws, chatId, {
        version,
        message_index: messageIndex,
        ...(content !== undefined ? { content } : {}),
      });
      loadSeqRef.current += 1; // stale openChat/fork responses never land here
      activeChatIdRef.current = snap.id;
      versionsRef.current.set(snap.id, snap.version);
      setActiveChatId(snap.id);
      if (userId) setDraftScope({ userId, workspaceId: ws, chatId: snap.id });
      setError(null);
      setConflict(false);
      setSaveNotice(null);
      setWalletGate(false);
      setReceiptLine(null);
      setLastUsage(null);
      applySnapshot(snap);
      rehydrateUploads(
        snap.messages.flatMap((m) => (m.role === "user" ? (m.attachments ?? []) : [])),
      );
      if (prefill !== undefined && prefill !== "" && userId) {
        // Prefill through the draft STORE, not setInput: the scope switch to
        // the fork hydrates from storage after this commit — writing there
        // first makes the hydration itself carry the prefill (no clobber).
        writeChatDraft({ userId, workspaceId, chatId: snap.id }, prefill);
      }
      lastUserRef.current = null;
      invalidateConversationList();
      followLog();
    } catch {
      setError(t("forkFailed"));
    }
  }

  /** Immutable snapshot of one finished turn, captured before any await so a
   *  concurrent send can never mutate what gets persisted. */
  interface TurnSnapshot {
    seq: number;
    idAtSend: string;
    chatId: string;
    baseMessages: ChatMessage[];
    attachments: ChatAttachment[];
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
    turn: TurnSnapshot,
    partial: { content: string; reasoning: string },
  ): Promise<void> {
    if (!userId || !workspaceId) return;
    const refs = turn.attachments.flatMap((attachment) =>
      attachment.serverRef ? [attachment.serverRef] : [],
    );
    const msgs = buildPersistMessages(turn.baseMessages, turn.userText, partial).map(
      (message, index) =>
        message.role === "user" && index === turn.baseMessages.length && refs.length > 0
          ? { ...message, attachments: refs }
          : message,
    );
    const knownVersion = versionsRef.current.get(turn.chatId);
    try {
      const snap = await saveConversation(workspaceId, turn.chatId, {
        version: knownVersion ?? 1,
        title: turn.isFirstTurn ? turn.userText.slice(0, 120) : undefined,
        model: turn.model,
        messages: msgs,
      });
      if (!viewCurrent(turn)) return;
      versionsRef.current.set(turn.chatId, snap.version);
      setSaveNotice(null);
      invalidateConversationList();
    } catch (e) {
      if (!viewCurrent(turn)) return; // old turn, new view: never touch it
      if (e instanceof ConversationError && e.kind === "conflict") {
        setConflict(true);
      } else {
        setSaveNotice(t("saveFailedNotice"));
      }
    }
  }

  /** Resolve the key for one send/connect. After every await the generation
   *  and identity are re-checked: an identity switch or generation bump while
   *  a key is being created must never repopulate state. */
  async function resolveKey(
    gen?: number,
    signal?: AbortSignal,
  ): Promise<{
    plaintext: string;
    purpose: ManagedKeyPurpose;
  } | null> {
    if (!userId || !workspaceId) {
      setKeyError(new ManagedKeyError("unauthorized", t("signInToChat")));
      return null;
    }
    const id = identityRef.current;
    const isCurrent = () =>
      identityRef.current === id && (gen === undefined || seqRef.current === gen);
    try {
      const key = await ensureKey(signal);
      if (!isCurrent()) return null;
      return { plaintext: key.plaintext, purpose: key.purpose };
    } catch (e) {
      if (!isCurrent()) return null;
      setKeyError(
        e instanceof ManagedKeyError ? e : new ManagedKeyError("invalid", t("keyCreateFailed")),
      );
      return null;
    }
  }

  async function send(
    textOverride?: string,
    isRetry = false,
    omitIds: ReadonlySet<string> = new Set(),
  ) {
    // Also block while a conversation snapshot is still loading: a send that
    // starts before openChat's response lands would be wiped by the snapshot
    // overwriting optimistic state when it resolves.
    if (busyRef.current || streaming || !model || conflict || loadingChat || !catalogReady) return;
    // Member chat gate: policy-off members and cap-exhausted members cannot
    // start a new PAID generation (the gateway would reject it anyway).
    if (memberBlocked || memberLimited) return;
    // Retry regenerates the LAST assistant reply from the existing history:
    // the user turn is reused as-is, never appended a second time.
    const retryTurn = isRetry ? findRetryTurn(messages) : null;
    if (isRetry && (!retryTurn || lastUserRef.current === null)) return;
    const text = (isRetry ? retryTurn?.userText : (textOverride ?? draft.input))?.trim() ?? "";
    // Fresh sends carry the pending chips; a retry re-uses the RETAINED full
    // content of the last user turn (below) so attachments survive a retry.
    // Attachment-only retry: only meaningful while the retained multimodal
    // content for that turn is still in this session's memory.
    const retryTurnIndex = isRetry
      ? retryTurn!.baseMessages.filter((m) => m.role === "user").length
      : 0;
    const retryUserMessage = isRetry
      ? messages.filter((message) => message.role === "user")[retryTurnIndex]
      : undefined;
    const turnAttachments = isRetry
      ? (retryUserMessage?.attachments ?? []).map(
          (serverRef) =>
            ({
              id: serverRef.id,
              kind: serverRef.kind,
              name: serverRef.name,
              bytes: serverRef.bytes,
              serverRef,
            }) as ChatAttachment,
        )
      : draft.attachmentsRef.current;
    const retryRetained =
      isRetry && activeChatIdRef.current
        ? multimodalRef.current.get(activeChatIdRef.current)?.get(retryTurnIndex)
        : undefined;
    if (turnAttachments.some((attachment) => !attachment.serverRef)) return;
    if (!text && turnAttachments.length === 0 && !retryRetained) return;
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
    // Exact-final render coalescing: deltas queue and flush at most once per
    // frame; end() flushes everything queued on done/abort/error so the
    // terminal transcript equals the sequential stream with nothing dropped.
    let coalescer: ReturnType<typeof createRenderCoalescer> | null = null;
    const turnIndex = baseMessages.filter((m) => m.role === "user").length;
    const turnRefs = isRetry
      ? (retryUserMessage?.attachments ?? [])
      : turnAttachments.flatMap((attachment) =>
          attachment.serverRef ? [attachment.serverRef] : [],
        );
    const outgoing: ConversationMessage[] = [
      ...baseMessages.map(({ role, content, attachments }) => ({
        role,
        content,
        ...(role === "user" && attachments ? { attachments } : {}),
      })),
      { role: "user", content: text, ...(turnRefs.length ? { attachments: turnRefs } : {}) },
    ];
    const preparedMessages = omitIds.size > 0 ? stripAttachments(outgoing, omitIds) : outgoing;
    let bodyJson = "";
    // Terminal save, AWAITED while busy: the next send cannot start until the
    // server version has been tracked, so a back-to-back send never saves on
    // a stale version and loses its turn to a 409.
    const saveTurn = (partial: { content: string; reasoning: string; model?: string }) => {
      if (!canPersist || !chatId || !ws) return Promise.resolve();
      return persistTurn(
        {
          seq,
          idAtSend,
          chatId,
          baseMessages,
          attachments: turnAttachments,
          userText: text,
          isFirstTurn,
          model,
        },
        partial,
      );
    };
    // 413 recovery inputs: the pre-send draft snapshot is captured BEFORE the
    // programmatic clear (never replaced by the empty post-clear values) and
    // the revision baseline is read AFTER that clear — the clear itself is
    // not a user mutation, so an untouched composer still restores wholesale.
    let preSendText = "";
    let snapshotAttachments: ChatAttachment[] = [];
    let revisionBaseline = 0;
    let rollback413: (() => void) | null = null;
    let dispatched = false;
    try {
      if (!ws) return;
      const prepared = await prepareChatSend({
        workspaceId: ws,
        model,
        messages: preparedMessages,
        effort: effortForSend as ReasoningEffort,
        signal: ac.signal,
      });
      if (!isCurrent() || ac.signal.aborted) return;
      if (!prepared.ok) {
        if (prepared.kind === "unavailable")
          setUnavailableSend({ files: prepared.files, textOverride, isRetry, omitIds });
        else setError(prepared.kind === "tooLarge" ? t("tooLarge") : prepared.error.message);
        return;
      }
      bodyJson = prepared.bodyJson;
      setUnavailableSend(null);
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
          if (isCurrent()) setSaveNotice(t("saveFailedNoKeep"));
        }
      }
      const key = await resolveKey(seq, ac.signal);
      if (!key || !isCurrent() || ac.signal.aborted) return;
      const keyPurpose = key.purpose;
      setError(null);
      // The request is now certain to go out: commit the draft reset, the
      // retention entry and the retry disclosure together. The snapshot is
      // taken before the clear; the baseline after it.
      if (!isRetry && textOverride === undefined) {
        preSendText = draft.input;
        snapshotAttachments = [...turnAttachments];
        const prevLastUser = lastUserRef.current;
        const prevLastTurnAttached = lastTurnAttached;
        draft.setInput("");
        drafts.clearCurrent(); // the stored draft dies with the send
        draft.applyAttachments([]);
        draft.clearAttachError();
        setLastTurnAttached(turnAttachments.length > 0);
        revisionBaseline = draft.revision();
        rollback413 = () => {
          setMessages(baseMessages);
          assistantPartialRef.current = { content: "", reasoning: "" };
          lastUserRef.current = prevLastUser;
          setLastTurnAttached(prevLastTurnAttached);
          if (chatId) multimodalRef.current.get(chatId)?.delete(turnIndex);
        };
      }
      if (chatId && !isRetry) {
        let turns = multimodalRef.current.get(chatId);
        if (!turns) {
          turns = new Map();
          multimodalRef.current.set(chatId, turns);
        }
        turns.set(turnIndex, buildUserContent(text, turnAttachments));
      }
      // A deliberate send (fresh or retry) always re-engages sticky-bottom
      // follow: the user must see their own message and the streaming reply,
      // even if they had scrolled up, and even if a late scroll event during
      // layout of the previous turn latched followLogRef off.
      followLog();
      // The view keeps each prior message's reasoning (the Reasoning section
      // stays visible across sends); only the paid request body above strips
      // it to role+content.
      setMessages([
        ...baseMessages,
        {
          role: "user",
          content: text,
          reasoning: "",
          attachments: isRetry
            ? retryUserMessage?.attachments
            : turnAttachments.flatMap((attachment) =>
                attachment.serverRef ? [attachment.serverRef] : [],
              ),
        },
        { role: "assistant", content: "", reasoning: "" },
      ]);
      lastUserRef.current = text;
      dispatched = true;
      const res = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key.plaintext}`,
        },
        body: bodyJson,
        signal: ac.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        if (!isCurrent()) return; // stale 413/4xx: discarded, nothing restored
        if (res.status === 413 && rollback413) {
          // Gateway body cap exceeded: NOT a completed turn. Roll back the
          // optimistic bubbles, SKIP the terminal save (the failed request
          // never enters history, so a resend cannot duplicate the user
          // message), and surface the persistent reconnect alert.
          rollback413();
          const revisionChanged = draft.revision() !== revisionBaseline;
          if (!revisionChanged) {
            // Unchanged revision: wholesale automatic restore of the snapshot
            // (attachments restore without re-reading files — session-only).
            draft.setInput(preSendText);
            draft.applyAttachments([...snapshotAttachments]);
          }
          setSend413({
            text: preSendText,
            attachments: snapshotAttachments,
            revisionChanged,
            keyPurpose,
          });
          setRestoreConfirm(false);
          return;
        }
        if (res.status === 401) {
          // Managed key revoked or session gone: offer explicit reconnect.
          setKeyError(new ManagedKeyError("unauthorized", t("keyReconnectFresh")));
        } else if (res.status === 402) {
          // Wallet exhausted: named error plus the top-up link (walletGate).
          setError(readableError(res.status, body));
          setWalletGate(true);
        } else if (res.status === 429) {
          // Typed Retry-After (header seconds -> number); the body error code
          // string is never parsed back into a number.
          const ra = Number(res.headers.get("retry-after"));
          setError(
            Number.isFinite(ra) && ra >= 0
              ? t("errRateLimited", { seconds: String(Math.ceil(ra)) })
              : t("errRateLimitedGeneric"),
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
      if (!reader) throw new Error(t("noStreaming"));
      // The gateway stamps every post-record response with the request row id:
      // this turn's billing receipt key (GET /workspaces/:id/chat-receipts/:id).
      const requestId = res.headers.get("x-hbr-request-id");
      const decoder = new TextDecoder();
      const parser = createSseParser();
      coalescer = createRenderCoalescer({
        flush: (batch) => {
          if (!isCurrent()) return;
          const m = parser.model && catalogModelIds.has(parser.model) ? parser.model : null;
          for (const delta of batch) appendToLast(delta, m);
        },
      });
      for (;;) {
        const { done, value } = await reader.read();
        if (!isCurrent()) return; // superseded: no delta may repopulate state
        if (done) break;
        for (const delta of parser.push(decoder.decode(value, { stream: true }))) {
          coalescer.push(delta);
        }
        if (parser.done) break;
      }
      coalescer.end(); // exact final flush (done path)
      // Mid-stream error event: keep the partial already rendered and surface
      // the server's message; the terminal save below still records the turn.
      if (parser.error) setError(parser.error);
      const usage = parser.usage; // last valid top-level usage (typed)
      if (requestId && ws) {
        const rid = requestId;
        assistantPartialRef.current = { ...assistantPartialRef.current, request_id: rid };
        // Actual-cost receipt: pending renders nothing (never "0 ₫");
        // settled/failed render the ACTUAL charged VND.
        void fetchChatReceipt(ws, rid)
          .then((receipt) => {
            if (!isCurrent()) return;
            setReceiptLine(chargedVndLabel(receipt));
          })
          .catch(() => {}); // receipt is cosmetic; the turn already persisted
      }
      if (usage) setLastUsage(usage);
      // Completed: persist the full turn (user + assistant) in one write.
      await saveTurn({ ...assistantPartialRef.current });
    } catch (e) {
      coalescer?.end(); // exact final flush (abort/error path)
      if (!isCurrent()) return;
      if (e instanceof DOMException && e.name === "AbortError" && !dispatched) return;
      if (e instanceof DOMException && e.name === "AbortError") {
        // Explicit stop: keep whatever streamed so far and persist it.
      } else {
        setError(e instanceof Error ? e.message : t("requestFailed"));
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

  function appendToLast(delta: StreamDelta, model: string | null) {
    const partial = assistantPartialRef.current;
    assistantPartialRef.current = {
      content: partial.content + delta.content,
      reasoning: partial.reasoning + delta.reasoning,
      model: partial.model ?? model ?? undefined,
    };
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== "assistant") return prev;
      return [...prev.slice(0, -1), appendDelta(last, delta, model)];
    });
  }

  const autoEligible = Boolean(userId && workspaceId);
  const canSend = Boolean(
    (draft.input.trim() || draft.attachments.length > 0) &&
    draft.attachments.every((attachment) => attachment.serverRef) &&
    model &&
    catalogReady &&
    !streaming &&
    !conflict &&
    !loadingChat &&
    autoEligible &&
    !memberBlocked &&
    !memberLimited,
  );
  const showRetry = !streaming && lastUserRef.current !== null;

  // Phone toolbar buttons must be 44px touch targets: the shared `size="sm"`
  // only gives 36px on coarse pointers, so the page overrides the height
  // (page-only — the shared button styles stay untouched) and `min-w-11`
  // guarantees 44px width for the icon-only phone layout.
  const toolbarTouch = "pointer-coarse:h-11 min-w-11";

  const historyList = (
    <ConversationList
      userId={userId ?? ""}
      workspaceId={workspaceId ?? ""}
      activeChatId={activeChatId}
      onOpen={(chatId) => {
        // Opening a conversation is explicit intent: expand the desktop list
        // for this view (session-only; the pref stays untouched).
        expandSidebarSession();
        void openChat(chatId);
      }}
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
    <div className="mx-auto max-w-3xl space-y-1">
      <Alert
        variant="destructive"
        onDismiss={() => setKeyError(null)}
        dismissLabel={t("dismissAlert")}
      >
        {keyError.message}
      </Alert>
      {keyError.kind === "forbidden" ? (
        <p className="text-xs text-muted-foreground">{t("keyForbiddenHelp")}</p>
      ) : keyError.kind === "unauthorized" ? (
        <div>
          <Button variant="outline" size="sm" onClick={reconnect}>
            {t("keyTooLargeAction")}
          </Button>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="-m-4 flex min-h-0 min-w-0 flex-1 overflow-hidden sm:-m-6">
      {/* Fills the bounded app-shell main (flex-1 of the Page wrapper), with
        the router Page wrapper's p-4 sm:p-6 cancelled by the negative margins,
        so the log (flex-1 min-h-0 overflow-y-auto) is the only scroller and
        the composer stays pinned; the page itself never scrolls. Replaces the
        old h-[calc(100dvh-3rem)] so the verification banner, when present,
        shrinks the pane instead of overflowing main into a second scroll. */}
      {/* Desktop: conversation history lives inside the chat pane. Collapse
        is a device UI pref (localStorage), identity-independent. */}
      <aside
        id="chat-history-aside"
        data-state={sidebarCollapsed ? "collapsed" : "expanded"}
        className={`hidden ${sidebarCollapsed ? "w-14" : "w-64"} shrink-0 flex-col border-r border-border px-2 py-2 transition-[width] duration-200 lg:flex`}
      >
        <div className={`flex items-center ${sidebarCollapsed ? "justify-center" : "justify-end"}`}>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleSidebar}
            aria-expanded={!sidebarCollapsed}
            aria-controls="chat-history-aside"
            aria-label={sidebarCollapsed ? t("expandSidebar") : t("collapseSidebar")}
            title={sidebarCollapsed ? t("expandSidebar") : t("collapseSidebar")}
          >
            {sidebarCollapsed ? (
              <PanelLeftOpen className="size-4" aria-hidden />
            ) : (
              <PanelLeftClose className="size-4" aria-hidden />
            )}
          </Button>
        </div>
        {sidebarCollapsed ? (
          <div className="flex flex-1 animate-in flex-col items-center pt-2 fade-in duration-150">
            <Button
              variant="ghost"
              size="icon"
              onClick={startNewChat}
              aria-label={t("newChat")}
              title={t("newChat")}
            >
              <Plus className="size-4" aria-hidden />
            </Button>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 animate-in flex-col fade-in duration-150">
            {historyList}
          </div>
        )}
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Compact top bar: history (phone), model picker + New chat.
          Icon-only controls below sm keep everything on one row at 375/390;
          labels come back at sm+. role=group exposes the controls for the E2E
          geometry probe without a roving-tabindex toolbar keyboard contract
          (native buttons are already tab-navigable). */}
        <h1 className="sr-only">{t("chat")}</h1>
        <div
          role="group"
          aria-label={t("chatControls")}
          className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2"
        >
          {/* Phone: history opens in a sheet owned by this page, not the app
            nav drawer. */}
          <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
            <SheetTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={`${toolbarTouch} lg:hidden`}
                aria-label={t("convHistory")}
                title={t("convHistory")}
              >
                <History className="size-4" aria-hidden />
                <span className="hidden sm:inline">{t("history")}</span>
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-80">
              <SheetTitle className="sr-only">{t("convHistory")}</SheetTitle>
              {historyList}
            </SheetContent>
          </Sheet>
          <ModelControls
            id="chat-model"
            models={models.map((m) => ({
              publicId: m.publicId,
              displayName: m.displayName,
              reasoning: m.reasoning,
            }))}
            loading={modelsLoading}
            error={modelsError}
            value={model}
            onModelChange={changeModel}
            effort={effort}
            onEffortChange={changeEffort}
          />
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">
            <Button
              variant="outline"
              size="sm"
              className={toolbarTouch}
              onClick={startNewChat}
              disabled={messages.length === 0 && !streaming && activeChatId === null}
              aria-label={t("newChat")}
              title={t("newChat")}
            >
              <Plus className="size-4" aria-hidden />
              <span className="hidden sm:inline">{t("newChat")}</span>
            </Button>
          </div>
        </div>

        {modelsError && (
          <ErrorState
            message={`${t("catalogUnavailable")}${modelsError ? ` — ${modelsError}` : ""}`}
          />
        )}

        {conflict && (
          <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2">
            <p className="text-sm font-medium">{t("conflictTitle")}</p>
            <p className="text-xs text-muted-foreground">{t("conflictBody")}</p>
            <Button variant="outline" size="sm" className="mt-1" onClick={reloadActive}>
              {t("reloadSaved")}
            </Button>
          </div>
        )}
        {unavailableSend && (
          <Alert
            variant="destructive"
            className="mx-auto max-w-3xl"
            title={t("attachmentUnavailableTitle")}
          >
            <p>{t("attachmentUnavailableBody")}</p>
            <ul className="list-disc pl-5">
              {unavailableSend.files.map((file) => (
                <li key={file.id}>{file.name}</li>
              ))}
            </ul>
            <div className="mt-2 flex gap-2">
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  const ids = new Set([
                    ...unavailableSend.omitIds,
                    ...unavailableSend.files.map((file) => file.id),
                  ]);
                  setUnavailableSend(null);
                  void send(unavailableSend.textOverride, unavailableSend.isRetry, ids);
                }}
              >
                {t("omitUnavailable")}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setUnavailableSend(null)}>
                {t("cancelOmit")}
              </Button>
            </div>
          </Alert>
        )}
        {saveNotice && (
          <p className="px-4 py-1 text-xs text-amber-600" role="status">
            {saveNotice}
          </p>
        )}
        {loadingChat && messages.length === 0 && (
          <p className="px-4 py-2 text-sm text-muted-foreground">{t("loadingConversation")}</p>
        )}

        {messages.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 py-16 text-center">
            <h2 className="text-2xl font-semibold tracking-tight">{t("whatBuild")}</h2>
            <div className="flex flex-wrap justify-center gap-2">
              {PROMPT_CHIPS.map((chip) => (
                <PromptChip
                  key={chip.en}
                  chip={chip}
                  onPick={(text) => {
                    draft.setInput(text);
                    draft.bump(); // chip pick replaces the draft
                    draft.focus();
                  }}
                />
              ))}
            </div>
            <p className="max-w-md text-sm text-muted-foreground">{t("reuseNotice")}</p>
            {!userId && <p className="text-sm text-muted-foreground">{t("signInStart")}</p>}
          </div>
        ) : (
          <Transcript
            ref={transcriptRef}
            messages={messages}
            streaming={streaming}
            {...(activeChatId
              ? {
                  // Fork = copy through the PRECEDING user turn (assistant
                  // turns fork at index-1); the original stays intact. Both
                  // actions pre-fill the composer — the next send is an
                  // EXPLICIT paid generation, never auto-fired.
                  onForkTurn: (index: number) => void forkAt(Math.max(0, index - 1)),
                  onRegenerateTurn: (index: number) =>
                    void forkAt(Math.max(0, index - 1), undefined, messages[index - 1]?.content),
                }
              : {})}
            {...(activeChatId
              ? {
                  onEditTurn: (index: number, content?: string) =>
                    void forkAt(index, content, content),
                }
              : {})}
            onPreviewAttachment={(a) => {
              // Plug until the persistent attachment client lands: expired
              // refs are labeled by the transcript; live previews need the
              // files-lane GET (bytes are never client-composable).
              void a;
            }}
          />
        )}

        <div className="mx-auto w-full max-w-3xl px-4 pb-safe">
          {error && (
            <Alert
              variant="destructive"
              className="mx-auto max-w-3xl"
              onDismiss={() => {
                setError(null);
                setWalletGate(false);
              }}
              dismissLabel={t("dismissAlert")}
            >
              {error}
              {walletGate && (
                <div className="mt-2">
                  <Link
                    to="/billing/credits"
                    className="inline-flex h-8 items-center rounded-md border border-border px-3 text-sm font-medium hover:bg-muted"
                  >
                    {t("topUp")}
                  </Link>
                </div>
              )}
            </Alert>
          )}
          {memberBlocked && (
            <Alert
              variant="destructive"
              className="mx-auto max-w-3xl"
              onDismiss={() =>
                void queryClient.invalidateQueries({
                  queryKey: ["member-chat-access", workspaceId],
                })
              }
              dismissLabel={t("dismissAlert")}
            >
              {t("memberChatBlocked")}
            </Alert>
          )}
          {memberLimited && (
            <p className="px-4 text-xs text-amber-600" role="status">
              {t("memberLimitReached", { time: formatDate(access.data!.resets_at) })}
            </p>
          )}
          {(receiptLine || lastUsage) && (
            <p className="px-4 py-1 text-xs text-muted-foreground" role="status">
              {[
                receiptLine ? t("chargedLast", { cost: receiptLine }) : null,
                lastUsage ? t("usageTokens", { tokens: String(lastUsage.total_tokens) }) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
          {send413 && (
            <Alert
              variant="destructive"
              title={t(send413.keyPurpose === "chat" ? "keyTooLargeChatTitle" : "keyTooLargeTitle")}
              className="mx-auto max-w-3xl"
              onDismiss={dismiss413}
              dismissLabel={t("dismissAlert")}
            >
              {t(send413.keyPurpose === "chat" ? "keyTooLargeChatBody" : "keyTooLargeBody")}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {send413.keyPurpose !== "chat" && (
                  <Button variant="outline" size="sm" onClick={reconnectKey}>
                    {t("keyTooLargeAction")}
                  </Button>
                )}
                {send413.revisionChanged &&
                  (restoreConfirm ? (
                    <>
                      <Button variant="destructive" size="sm" onClick={confirmRestore}>
                        {t("restoreConfirmYes")}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setRestoreConfirm(false)}>
                        {t("restoreConfirmNo")}
                      </Button>
                    </>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => setRestoreConfirm(true)}>
                      {t("restoreDraftAction")}
                    </Button>
                  ))}
              </div>
              {restoreConfirm && <p className="mt-1 text-xs">{t("restoreDraftConfirm")}</p>}
            </Alert>
          )}
          {keyErrorBlock}
          {showRetry && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1">
              <Button variant="outline" size="sm" onClick={() => void send(undefined, true)}>
                {t("retryLastReply")}
              </Button>
              <p className="min-w-0 text-xs text-muted-foreground">
                {t("retryRegenerates")}
                {lastTurnAttached && t("retryAttachments")}
              </p>
            </div>
          )}
          <Composer
            draft={draft}
            placeholder={
              model
                ? t("placeholderSend")
                : modelsError
                  ? t("placeholderModelsError")
                  : t("placeholderChooseModel")
            }
            streaming={streaming}
            canSend={canSend}
            onSend={() => void send()}
            onStop={stop}
            advanced={
              <>
                <p className="text-xs text-muted-foreground">{composerT("scopeBilling")}</p>
                <p className="text-xs text-muted-foreground">{composerT("attachHint")}</p>
                <p className="text-xs text-muted-foreground">{t("attachmentRetention")}</p>
              </>
            }
          />
        </div>
      </div>
    </div>
  );
}
