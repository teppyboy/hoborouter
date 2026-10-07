import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { History, Paperclip, Plus, Send, Square, X } from "lucide-react";
import { createSseParser, type StreamDelta } from "./sse";
import { ConversationList, conversationListKey } from "./conversation-list";
import { buildPersistMessages, findRetryTurn, isEmptyAssistant, type TurnMessage } from "./turn";
import {
  ConversationError,
  createConversation,
  getConversation,
  saveConversation,
} from "./conversations";
import { ChatMarkdown } from "../../components/chat-markdown";
import { ErrorState, CopyButton } from "../../components/page";
import { Button } from "../../components/ui/button";
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
import { ManagedKeyError, clearManagedChatKey, useManagedChatKey } from "./managed-key";
import {
  ATTACHMENT_HINT,
  ATTACHMENT_RETENTION_NOTICE,
  addAttachments,
  buildUserContent,
  removeAttachment,
  utf8ByteLength,
  withMultimodalContent,
  type ChatAttachment,
  type UserContent,
} from "./attachments";
import { useT, useLocaleEntry, translate, type LocaleEntry } from "../../lib/i18n/t";
import { useLocaleStore } from "../../lib/i18n/locale";

// Chat page copy: inline LocaleEntry set (see lib/i18n/common.ts). Model
// names, message content and API errors stay verbatim — only chrome, notices
// and controls are translated. Module-level helpers read the live locale via
// useLocaleStore.getState() (see translate() in lib/i18n/t.ts).
const chatCopy = {
  chip1: {
    en: "Help me write a debounce function in TypeScript.",
    vi: "Giúp tôi viết một hàm debounce bằng TypeScript.",
  },
  chip2: {
    en: "Explain how HTTP streaming works, end to end.",
    vi: "Giải thích cách HTTP streaming hoạt động từ đầu đến cuối.",
  },
  chip3: {
    en: "Debug why my React component renders twice.",
    vi: "Tìm lỗi vì sao component React của tôi render hai lần.",
  },
  errKeyReconnect: {
    en: "Your chat key is no longer valid. Try reconnecting.",
    vi: "Chat key của bạn không còn hợp lệ. Hãy kết nối lại.",
  },
  errWallet: {
    en: "Insufficient wallet balance for this request.",
    vi: "Số dư ví không đủ cho request này.",
  },
  errModelNotFound: {
    en: "Model not found. Pick another model.",
    vi: "Không tìm thấy mô hình. Hãy chọn mô hình khác.",
  },
  errRequestFailed: {
    en: "Request failed ({status}).",
    vi: "Request thất bại ({status}).",
  },
  convNotFound: {
    en: "Conversation not found (it may belong to another account).",
    vi: "Không tìm thấy hội thoại (có thể thuộc tài khoản khác).",
  },
  convLoadFailed: {
    en: "Could not load this conversation. Try again.",
    vi: "Không tải được hội thoại này. Thử lại.",
  },
  saveFailedNotice: {
    en: "This conversation could not be saved to your history.",
    vi: "Không lưu được hội thoại này vào lịch sử của bạn.",
  },
  saveFailedNoKeep: {
    en: "This conversation could not be saved. Messages will not be kept.",
    vi: "Không lưu được hội thoại này. Các tin nhắn sẽ không được giữ lại.",
  },
  signInToChat: {
    en: "Sign in and choose a workspace to start chatting.",
    vi: "Đăng nhập và chọn workspace để bắt đầu trò chuyện.",
  },
  keyCreateFailed: {
    en: "Could not create a chat key. Try again.",
    vi: "Không tạo được chat key. Thử lại.",
  },
  tooLarge: {
    en: "This message is too large to send — attachments plus history exceed the request limit. Remove some attachments and try again.",
    vi: "Tin nhắn quá lớn để gửi — tệp đính kèm cộng lịch sử vượt giới hạn request. Hãy bớt tệp đính kèm và thử lại.",
  },
  keyReconnectFresh: {
    en: "Your chat key is no longer valid. Reconnect to create a fresh one.",
    vi: "Chat key của bạn không còn hợp lệ. Kết nối lại để tạo key mới.",
  },
  noStreaming: {
    en: "Streaming is not supported in this browser.",
    vi: "Trình duyệt này không hỗ trợ streaming.",
  },
  requestFailed: { en: "Request failed.", vi: "Request thất bại." },
  chat: { en: "Chat", vi: "Trò chuyện" },
  chatControls: { en: "Chat controls", vi: "Điều khiển trò chuyện" },
  convHistory: { en: "Conversation history", vi: "Lịch sử hội thoại" },
  history: { en: "History", vi: "Lịch sử" },
  model: { en: "Model", vi: "Mô hình" },
  loadingModels: { en: "Loading models…", vi: "Đang tải mô hình…" },
  modelsUnavailable: { en: "Model list unavailable", vi: "Không tải được danh sách mô hình" },
  chooseModel: { en: "Choose a model", vi: "Chọn một mô hình" },
  newChat: { en: "New chat", vi: "Trò chuyện mới" },
  modelsPrefix: { en: "Models: {error}", vi: "Mô hình: {error}" },
  conflictTitle: {
    en: "This conversation changed on another device or tab.",
    vi: "Hội thoại này đã thay đổi trên thiết bị hoặc tab khác.",
  },
  conflictBody: {
    en: "Your newest messages below are still shown here but are NOT saved.",
    vi: "Các tin nhắn mới nhất bên dưới vẫn hiển thị tại đây nhưng CHƯA được lưu.",
  },
  reloadSaved: { en: "Reload saved version", vi: "Tải lại bản đã lưu" },
  loadingConversation: { en: "Loading conversation…", vi: "Đang tải hội thoại…" },
  whatBuild: { en: "What would you like to build?", vi: "Bạn muốn xây dựng gì hôm nay?" },
  reuseNotice: {
    en: 'Chat reuses a workspace key stored in this browser, named after this device (e.g. "Chat - iPhone"). A key is created only once, when you connect or send your first message. Use the paperclip to attach images or text files to a message. Usage is charged to your selected workspace.',
    vi: 'Chat dùng lại chat key của workspace được lưu trong trình duyệt này, đặt tên theo thiết bị (ví dụ "Chat - iPhone"). Key chỉ được tạo một lần, khi bạn kết nối hoặc gửi tin nhắn đầu tiên. Dùng chiếc kẹp giấy để đính kèm ảnh hoặc tệp văn bản vào tin nhắn. Mức sử dụng được tính vào workspace bạn đã chọn.',
  },
  signInStart: { en: "Sign in to start chatting.", vi: "Đăng nhập để bắt đầu trò chuyện." },
  conversation: { en: "Conversation", vi: "Hội thoại" },
  reasoning: { en: "Reasoning", vi: "Suy luận" },
  copyReply: { en: "Copy reply", vi: "Copy câu trả lời" },
  thinking: { en: "Thinking…", vi: "Đang suy nghĩ…" },
  retryLastReply: { en: "Retry last reply", vi: "Thử lại câu trả lời cuối" },
  retryRegenerates: {
    en: "Regenerates the last reply — usage will be charged again.",
    vi: "Tạo lại câu trả lời cuối — mức sử dụng sẽ được tính phí lại.",
  },
  retryAttachments: {
    en: " Retry re-sends this turn's attachments from this browser session; they are not saved to your history.",
    vi: " Thử lại sẽ gửi lại tệp đính kèm của lượt này từ phiên trình duyệt; chúng không được lưu vào lịch sử.",
  },
  readingFile: { en: "Reading file…", vi: "Đang đọc tệp…" },
  removeAttachment: { en: "Remove attachment {name}", vi: "Xoá tệp đính kèm {name}" },
  removeTitle: { en: "Remove {name}", vi: "Xoá {name}" },
  message: { en: "Message", vi: "Tin nhắn" },
  placeholderSend: {
    en: "Send a message… (Enter to send, Shift+Enter for a new line)",
    vi: "Nhập tin nhắn… (Enter để gửi, Shift+Enter để xuống dòng)",
  },
  placeholderModelsError: {
    en: "Model list unavailable — reload to pick a model",
    vi: "Không tải được danh sách mô hình — tải lại để chọn mô hình",
  },
  placeholderChooseModel: { en: "Choose a model first", vi: "Chọn mô hình trước" },
  attachFiles: { en: "Attach files", vi: "Đính kèm tệp" },
  attachFilesTitle: { en: "Attach files. {hint}", vi: "Đính kèm tệp. {hint}" },
  stopGenerating: { en: "Stop generating", vi: "Dừng tạo" },
  sendMessage: { en: "Send message", vi: "Gửi tin nhắn" },
} as const;

/** Reactive translator for the chat page; component-scope only. */
const useChatT = () => useT(chatCopy);

// Turn message shape shared with the pure helpers in ./turn.
type ChatMessage = TurnMessage;

// Actionable starters: each is a real prompt a user can send or edit.
const PROMPT_CHIPS: LocaleEntry[] = [chatCopy.chip1, chatCopy.chip2, chatCopy.chip3];

// Gateway caps the request body in UTF-8 BYTES (1 MiB); keep the client-side
// pre-check well under that so attachment data URLs plus history never trip a
// raw 413. Byte-accurate: measured with TextEncoder, not UTF-16 .length.
const MAX_REQUEST_BODY_BYTES = 900_000;

function readableError(status: number, body: { error?: { message?: string } } | null): string {
  const msg = body?.error?.message;
  const locale = useLocaleStore.getState().locale;
  // 401 never reaches here (the managed-key reconnect path handles it); the
  // generic fallback still names the likely cause.
  if (status === 401) return msg ?? translate(chatCopy, "errKeyReconnect", locale);
  if (status === 402) return msg ?? translate(chatCopy, "errWallet", locale);
  if (status === 404) return msg ?? translate(chatCopy, "errModelNotFound", locale);
  return msg ?? translate(chatCopy, "errRequestFailed", locale, { status });
}

function appendDelta(msg: ChatMessage, delta: StreamDelta): ChatMessage {
  return {
    ...msg,
    content: msg.content + delta.content,
    reasoning: msg.reasoning + delta.reasoning,
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
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  // Per-message attachments (images as multimodal parts, text/code inlined).
  // Held in memory only; cleared when the message is sent or the view resets.
  const [attachments, setAttachments] = React.useState<ChatAttachment[]>([]);
  const attachmentsRef = React.useRef<ChatAttachment[]>([]);
  const [attachError, setAttachError] = React.useState<string | null>(null);
  // Session-only multimodal retention: conversation id -> user-turn index ->
  // the full request content captured when that turn was sent. Lets follow-ups
  // AND retries keep carrying this session's attachments (which persistence
  // drops, history being string-only). Cleared on identity change; bounded by
  // the session's own turn count.
  const multimodalRef = React.useRef<Map<string, Map<number, UserContent>>>(new Map());
  // Whether the most recently SENT turn carried attachments (drives the
  // truthful retry disclosure).
  const [lastTurnAttached, setLastTurnAttached] = React.useState(false);
  // Serialized attachment reads: two overlapping file picks must both validate
  // against the LIVE list, never a stale snapshot (count/total budget).
  const attachQueueRef = React.useRef<Promise<void>>(Promise.resolve());
  // Files queued for reading but not yet attached: a visible status so the
  // paperclip button never feels dead while large reads are in flight.
  const [readingFiles, setReadingFiles] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  // State + ref move together: the async file-read handler and the send
  // lifecycle must both see the live list without depending on render timing.
  function applyAttachments(next: ChatAttachment[]) {
    attachmentsRef.current = next;
    setAttachments(next);
  }
  const [streaming, setStreaming] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [keyError, setKeyError] = React.useState<ManagedKeyError | null>(null);
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
    setAttachError(null);
    setLastTurnAttached(false);
    applyAttachments([]);
    multimodalRef.current.clear();
    lastUserRef.current = null;
  }, [userId, workspaceId]);

  // Model changes are a per-message choice, not a conversation boundary:
  // switching models keeps the existing context (like ChatGPT). The model is
  // persisted with every save; an explicit "New chat" is how context resets.

  /** Serialized, view-pinned attachment ingestion: overlapping picks queue
   *  behind each other so every batch validates against the LIVE list (count
   *  + total budget), and a read finishing after newChat/openChat/send (any
   *  generation bump) or an identity switch is discarded — it can never
   *  repopulate another conversation's or the sent composer's chip list. */
  function handleFiles(fileList: FileList | null) {
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;
    setReadingFiles(true);
    const run = attachQueueRef.current
      .then(
        () => doAttachFiles(files),
        () => doAttachFiles(files),
      )
      .finally(() => {
        // Clear the reading status only when no later pick is still queued.
        if (attachQueueRef.current === run) setReadingFiles(false);
      });
    attachQueueRef.current = run;
  }

  async function doAttachFiles(files: File[]) {
    const idAtPick = identityRef.current;
    const genAtPick = seqRef.current;
    const res = await addAttachments(attachmentsRef.current, files);
    if (identityRef.current !== idAtPick || seqRef.current !== genAtPick) return;
    if (res.error) {
      setAttachError(res.error);
      return;
    }
    setAttachError(null);
    applyAttachments([...attachmentsRef.current, ...res.added]);
  }

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
    setAttachError(null);
    setLastTurnAttached(false);
    applyAttachments([]);
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
    setAttachError(null);
    setLastTurnAttached(false);
    applyAttachments([]);
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
    turn: TurnSnapshot,
    partial: { content: string; reasoning: string },
  ): Promise<void> {
    if (!userId || !workspaceId) return;
    const msgs = buildPersistMessages(turn.baseMessages, turn.userText, partial);
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
  async function resolveKey(gen?: number, signal?: AbortSignal): Promise<string | null> {
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
      return key.plaintext;
    } catch (e) {
      if (!isCurrent()) return null;
      setKeyError(
        e instanceof ManagedKeyError ? e : new ManagedKeyError("invalid", t("keyCreateFailed")),
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
    // Fresh sends carry the pending chips; a retry re-uses the RETAINED full
    // content of the last user turn (below) so attachments survive a retry.
    const turnAttachments = isRetry ? [] : attachmentsRef.current;
    // Attachment-only retry: only meaningful while the retained multimodal
    // content for that turn is still in this session's memory.
    const retryTurnIndex = isRetry
      ? retryTurn!.baseMessages.filter((m) => m.role === "user").length
      : 0;
    const retryRetained =
      isRetry && activeChatIdRef.current
        ? multimodalRef.current.get(activeChatIdRef.current)?.get(retryTurnIndex)
        : undefined;
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
    // Session-only multimodal retention: an attachment-bearing turn keeps its
    // full request content in memory (conversation id + user-turn index) so
    // follow-ups AND retries still carry the attachments until reload.
    // Persistence stays string-only — no DB, no history schema change.
    const storedTurns = chatId ? multimodalRef.current.get(chatId) : undefined;
    const history: Array<{
      role: "user" | "assistant";
      content: string | UserContent;
    }> = [
      ...withMultimodalContent(
        baseMessages.map(({ role, content }) => ({ role, content })),
        storedTurns,
      ),
    ];
    const turnIndex = baseMessages.filter((m) => m.role === "user").length;
    const turnContent: UserContent = isRetry
      ? (storedTurns?.get(turnIndex) ?? text)
      : buildUserContent(text, turnAttachments);
    history.push({ role: "user", content: turnContent });
    // Gateway caps the body in UTF-8 BYTES (1 MiB), not UTF-16 chars: measure
    // the exact payload BEFORE any side effect (conversation create, key
    // mint, draft reset) so a rejection leaves the draft fully untouched.
    const bodyJson = JSON.stringify({ model, messages: history, stream: true });
    if (utf8ByteLength(bodyJson) > MAX_REQUEST_BODY_BYTES) {
      setError(t("tooLarge"));
      busyRef.current = false;
      setStreaming(false);
      abortRef.current = null;
      return;
    }
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
          if (isCurrent()) setSaveNotice(t("saveFailedNoKeep"));
        }
      }
      const key = await resolveKey(seq, ac.signal);
      if (!key || !isCurrent()) return;
      setError(null);
      // The request is now certain to go out: commit the draft reset, the
      // retention entry and the retry disclosure together.
      if (!isRetry && textOverride === undefined) {
        setInput("");
        applyAttachments([]);
        setAttachError(null);
        setLastTurnAttached(turnAttachments.length > 0);
      }
      if (chatId && !isRetry) {
        let turns = multimodalRef.current.get(chatId);
        if (!turns) {
          turns = new Map();
          multimodalRef.current.set(chatId, turns);
        }
        turns.set(turnIndex, turnContent);
      }
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
        body: bodyJson,
        signal: ac.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        if (!isCurrent()) return;
        if (res.status === 401) {
          // Managed key revoked or session gone: offer explicit reconnect.
          setKeyError(new ManagedKeyError("unauthorized", t("keyReconnectFresh")));
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
    (input.trim() || attachments.length > 0) && model && !streaming && !conflict && autoEligible,
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
          Members without owner or admin role cannot create a chat key in this workspace. Ask a
          workspace admin for help.
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
          <Select value={model} onValueChange={setModel} disabled={models.length === 0}>
            <SelectTrigger
              id="chat-model"
              aria-label={t("model")}
              className="h-9 min-w-0 max-w-56 flex-1 gap-1 border-0 bg-muted/50 shadow-none"
            >
              <SelectValue
                className="min-w-0 truncate"
                placeholder={
                  modelsLoading
                    ? t("loadingModels")
                    : modelsError
                      ? t("modelsUnavailable")
                      : t("chooseModel")
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
            <Button
              variant="outline"
              size="sm"
              className={toolbarTouch}
              onClick={newChat}
              disabled={messages.length === 0 && !streaming && activeChatId === null}
              aria-label={t("newChat")}
              title={t("newChat")}
            >
              <Plus className="size-4" aria-hidden />
              <span className="hidden sm:inline">{t("newChat")}</span>
            </Button>
          </div>
        </div>

        {modelsError && <ErrorState message={t("modelsPrefix", { error: modelsError })} />}

        {conflict && (
          <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2">
            <p className="text-sm font-medium">{t("conflictTitle")}</p>
            <p className="text-xs text-muted-foreground">{t("conflictBody")}</p>
            <Button variant="outline" size="sm" className="mt-1" onClick={reloadActive}>
              {t("reloadSaved")}
            </Button>
          </div>
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
                    setInput(text);
                    textareaRef.current?.focus();
                  }}
                />
              ))}
            </div>
            <p className="max-w-md text-sm text-muted-foreground">{t("reuseNotice")}</p>
            {!userId && <p className="text-sm text-muted-foreground">{t("signInStart")}</p>}
          </div>
        ) : (
          <div
            className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]"
            role="log"
            aria-live="polite"
            aria-label={t("conversation")}
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
                          {t("reasoning")}
                        </summary>
                        <div className="mt-1 wrap-anywhere whitespace-pre-wrap">{m.reasoning}</div>
                      </details>
                    )}
                    {m.content ? (
                      <>
                        <ChatMarkdown
                          content={m.content}
                          streaming={streaming && i === messages.length - 1}
                        />
                        <div className="flex justify-end">
                          <CopyButton value={m.content} label={t("copyReply")} />
                        </div>
                      </>
                    ) : (
                      !m.reasoning &&
                      streaming &&
                      i === messages.length - 1 && (
                        <div className="animate-pulse motion-reduce:animate-none text-muted-foreground">
                          {t("thinking")}
                        </div>
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
                {t("retryLastReply")}
              </Button>
              <p className="min-w-0 text-xs text-muted-foreground">
                {t("retryRegenerates")}
                {lastTurnAttached && t("retryAttachments")}
              </p>
            </div>
          )}
          <div className="relative rounded-2xl border border-border bg-card p-2 shadow-sm">
            {(attachments.length > 0 || attachError || readingFiles) && (
              <div className="space-y-1 px-1 pb-1">
                {readingFiles && (
                  <p className="text-xs text-muted-foreground" role="status">
                    {t("readingFile")}
                  </p>
                )}
                {attachments.length > 0 && (
                  <ul className="flex flex-wrap gap-1.5">
                    {attachments.map((a) => (
                      <li
                        key={a.id}
                        className="flex max-w-full items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs"
                      >
                        <span className="min-w-0 truncate">{a.name}</span>
                        <button
                          type="button"
                          onClick={() => {
                            applyAttachments(removeAttachment(attachmentsRef.current, a.id));
                            setAttachError(null);
                          }}
                          aria-label={t("removeAttachment", { name: a.name })}
                          title={t("removeTitle", { name: a.name })}
                          className="shrink-0 rounded-sm text-muted-foreground hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <X className="size-3.5" aria-hidden />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {attachError && (
                  <p className="text-xs text-destructive" role="status">
                    {attachError}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">{ATTACHMENT_HINT}</p>
                <p className="text-xs text-muted-foreground">{ATTACHMENT_RETENTION_NOTICE}</p>
              </div>
            )}
            <Textarea
              aria-label={t("message")}
              ref={textareaRef}
              rows={1}
              placeholder={
                model
                  ? t("placeholderSend")
                  : modelsError
                    ? t("placeholderModelsError")
                    : t("placeholderChooseModel")
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
            <div className="flex items-center justify-end gap-1">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/png,image/jpeg,image/webp,image/gif,text/*,.md,.markdown,.csv,.json,.yaml,.yml,.toml,.log,.ts,.tsx,.js,.jsx,.mjs,.cjs,.css,.html,.py,.go,.rs,.java,.c,.h,.cpp,.sh,.sql"
                className="hidden"
                aria-hidden
                tabIndex={-1}
                onChange={(e) => {
                  handleFiles(e.target.files);
                  // Allow re-picking the same file after a removal.
                  e.target.value = "";
                }}
              />
              <Button
                size="icon"
                variant="ghost"
                onClick={() => fileInputRef.current?.click()}
                disabled={streaming}
                aria-label={t("attachFiles")}
                title={t("attachFilesTitle", { hint: ATTACHMENT_HINT })}
              >
                <Paperclip className="size-4" aria-hidden />
              </Button>
              {streaming ? (
                <Button
                  size="icon"
                  variant="outline"
                  onClick={stop}
                  aria-label={t("stopGenerating")}
                >
                  <Square className="size-4" aria-hidden />
                </Button>
              ) : (
                <Button
                  size="icon"
                  onClick={() => void send()}
                  disabled={!canSend}
                  aria-label={t("sendMessage")}
                >
                  <Send className="size-4" aria-hidden />
                </Button>
              )}
            </div>
          </div>
          <p className="py-2 text-center text-xs text-muted-foreground">
            Usage is charged to your selected workspace.
          </p>
        </div>
      </div>
    </div>
  );
}
