import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  History,
  Paperclip,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Send,
  Square,
  X,
} from "lucide-react";
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
import { Alert } from "../../components/ui/alert";
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
import {
  ManagedKeyError,
  clearManagedChatKey,
  useManagedChatKey,
  type ManagedKeyPurpose,
} from "./managed-key";
import {
  ATTACHMENT_RETENTION_NOTICE,
  addAttachments,
  buildUserContent,
  removeAttachment,
  utf8ByteLength,
  withMultimodalContent,
  AttachError,
  type AttachErrorCode,
  type ChatAttachment,
  type UserContent,
} from "./attachments";
import { useT, translate } from "../../lib/i18n/t";
import { useLocaleStore } from "../../lib/i18n/locale";
import { useCapabilityLabel } from "../../lib/capabilities";
import {
  buildChatRequestBody,
  EFFORT_LABELS,
  EFFORT_UNSET,
  supportedEffortOptions,
  type ReasoningEffort,
} from "./reasoning";
// Chat page copy: inline LocaleEntry set (see lib/i18n/common.ts). Model
// names, message content and API errors stay verbatim — only chrome, notices
// and controls are translated. Module-level helpers read the live locale via
// useLocaleStore.getState() (see translate() in lib/i18n/t.ts).
const chatCopy = {
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
    en: "This message is too large to send — attachments plus history exceed the 16 MB request limit. Remove some attachments and try again.",
    vi: "Tin nhắn quá lớn để gửi — tệp đính kèm cộng lịch sử vượt giới hạn 16 MB. Hãy bớt tệp đính kèm và thử lại.",
  },
  attachHint: {
    en: "PNG, JPEG, WebP or GIF images and text/code files up to 64 KB; up to 4 files, 10 MB total per message.",
    vi: "Ảnh PNG, JPEG, WebP hoặc GIF và tệp văn bản/mã nguồn tối đa 64 KB; tối đa 4 tệp, tổng 10 MB mỗi tin nhắn.",
  },
  attachUnsupported: {
    en: "“${name}” is not a supported file type. Supported: PNG, JPEG, WebP, GIF images and plain text/code files.",
    vi: "“${name}” không phải loại tệp được hỗ trợ. Chỉ nhận ảnh PNG, JPEG, WebP, GIF và tệp văn bản/mã nguồn.",
  },
  attachImageTooLarge: {
    en: "“${name}” is too large (max 10 MB per image).",
    vi: "“${name}” quá lớn (tối đa 10 MB mỗi ảnh).",
  },
  attachTextTooLarge: {
    en: "“${name}” is too large (max 64 KB as text).",
    vi: "“${name}” quá lớn (tối đa 64 KB dưới dạng văn bản).",
  },
  attachTooMany: {
    en: "You can attach at most 4 files per message.",
    vi: "Bạn chỉ có thể đính kèm tối đa 4 tệp mỗi tin nhắn.",
  },
  attachTotalTooLarge: {
    en: "Attachments exceed the 10 MB total limit. Remove something and try again.",
    vi: "Tệp đính kèm vượt giới hạn tổng 10 MB. Hãy bớt tệp rồi thử lại.",
  },
  attachReadFailed: {
    en: "Could not read that file.",
    vi: "Không đọc được tệp đó.",
  },
  dismissAlert: { en: "Dismiss", vi: "Đóng thông báo" },
  keyTooLargeTitle: {
    en: "This chat key has a 1 MB request limit.",
    vi: "Chat key này có giới hạn request 1 MB.",
  },
  keyTooLargeBody: {
    en: "Attachments this large need a new chat key. Reconnect to create one — your message stays here, nothing is deleted.",
    vi: "Tệp đính kèm cỡ này cần chat key mới. Kết nối lại để tạo key — tin nhắn của bạn vẫn còn nguyên, không có gì bị xóa.",
  },
  keyTooLargeAction: { en: "Reconnect", vi: "Kết nối lại" },
  keyTooLargeChatTitle: {
    en: "This conversation is over the 16 MB request limit.",
    vi: "Hội thoại này vượt quá giới hạn request 16 MB.",
  },
  keyTooLargeChatBody: {
    en: "Reduce attachments or message history in this conversation, then send again — no new key is needed.",
    vi: "Hãy giảm tệp đính kèm hoặc lịch sử tin nhắn trong hội thoại này rồi gửi lại — không cần key mới.",
  },
  catalogUnavailable: {
    en: "The model catalog could not be loaded, so sending is disabled. Try reloading the page.",
    vi: "Không tải được danh mục mô hình nên không thể gửi tin. Hãy thử tải lại trang.",
  },
  restoreDraftAction: {
    en: "Restore original draft",
    vi: "Khôi phục bản nháp ban đầu",
  },
  restoreDraftConfirm: {
    en: "Restoring replaces what you have typed since. Restore the original draft and attachments?",
    vi: "Khôi phục sẽ thay những gì bạn vừa gỡ/thêm. Khôi phục bản nháp và tệp đính kèm ban đầu?",
  },
  restoreConfirmYes: { en: "Restore", vi: "Khôi phục" },
  restoreConfirmNo: { en: "Keep my edits", vi: "Giữ bản đang soạn" },
  collapseSidebar: {
    en: "Collapse conversation list",
    vi: "Thu gọn danh sách hội thoại",
  },
  expandSidebar: {
    en: "Expand conversation list",
    vi: "Mở rộng danh sách hội thoại",
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
  effort: { en: "Thinking effort", vi: "Mức suy luận" },
  effortDefault: { en: "Default", vi: "Mặc định" },
  newChat: { en: "New chat", vi: "Trò chuyện mới" },
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
  jumpToLatest: { en: "Jump to latest", vi: "Nhảy tới tin nhắn mới nhất" },
  editMessage: { en: "Edit", vi: "Chỉnh sửa" },
  cancelEdit: { en: "Cancel edit", vi: "Hủy chỉnh sửa" },
  confirmEdit: { en: "Confirm and regenerate", vi: "Xác nhận và tạo lại" },
  editWarning: { en: "This will remove the old reply and all later turns. Regenerating sends a new request and usage will be charged again.", vi: "Thao tác này sẽ xóa câu trả lời cũ và các lượt sau. Tạo lại sẽ gửi yêu cầu mới và tính phí sử dụng lần nữa." },
  editAttachmentRequired: { en: "This message had attachments. Reattach the files needed before regenerating.", vi: "Tin nhắn này có tệp đính kèm. Hãy đính kèm lại các tệp cần thiết trước khi tạo lại." },
  editAttachmentUnknown: { en: "Attachment history is unknown. Reattach any files needed; old file content is unavailable.", vi: "Không rõ lịch sử tệp đính kèm. Hãy đính kèm lại các tệp cần thiết; nội dung tệp cũ không có sẵn." },
  editSaveFailed: { en: "Could not save the trimmed conversation. Regeneration was not sent.", vi: "Không thể lưu hội thoại đã rút gọn. Yêu cầu tạo lại chưa được gửi." },
} as const;

/** Structured rejection code -> localized copy key (see AttachError in
 *  attachments.ts; the page localizes via chatCopy). */
const ATTACH_ERROR_COPY: Record<AttachErrorCode, keyof typeof chatCopy> = {
  unsupported: "attachUnsupported",
  imageTooLarge: "attachImageTooLarge",
  textTooLarge: "attachTextTooLarge",
  tooMany: "attachTooMany",
  totalTooLarge: "attachTotalTooLarge",
};

/** Reactive translator for the chat page; component-scope only. */
const useChatT = () => useT(chatCopy);

// Turn message shape shared with the pure helpers in ./turn.
type ChatMessage = TurnMessage;

// Gateway caps the request body in UTF-8 BYTES — 1 MiB for generic keys,
// 16 MiB for chat-purpose keys (approved attachment budget). Keep the
// client-side pre-check at the same 16 MiB ceiling: byte-accurate, measured
// with TextEncoder, not UTF-16 .length. The guard runs BEFORE any side
// effect (key mint, conversation create, draft reset).
const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

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

function appendDelta(msg: ChatMessage, delta: StreamDelta, model: string | null): ChatMessage {
  return {
    ...msg,
    content: msg.content + delta.content,
    reasoning: msg.reasoning + delta.reasoning,
    model: msg.model ?? model ?? undefined,
  };
}

export function ChatPage() {
  const t = useChatT();
  const locale = useLocaleStore((s) => s.locale);
  const capabilityLabelFor = useCapabilityLabel();
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
  const [input, setInput] = React.useState("");
  const [editing, setEditing] = React.useState<number | null>(null);
  const [editText, setEditText] = React.useState("");
  const [editConfirm, setEditConfirm] = React.useState(false);
  // Draft revision counter: increments on USER draft mutations only — typing,
  // paste (both via onChange), prompt-chip pick, attachment pick/remove. The
  // send flow's own programmatic pre-fetch clear must NOT bump it: the 413
  // rollback reads its baseline AFTER that clear, so an untouched composer
  // presents "unchanged" and the wholesale restore path stays reachable.
  const draftRevisionRef = React.useRef(0);
  const bumpDraftRevision = () => {
    draftRevisionRef.current += 1;
  };
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  // Per-message attachments (images as multimodal parts, text/code inlined).
  // Held in memory only; cleared when the message is sent or the view resets.
  const [attachments, setAttachments] = React.useState<ChatAttachment[]>([]);
  const attachmentsRef = React.useRef<ChatAttachment[]>([]);
  const [attachError, setAttachError] = React.useState<AttachError | string | null>(null);
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
  const [keyError, setKeyError] = React.useState<ManagedKeyError | null>(null);
  // Saved conversation identity. null = a new, unsaved chat: it is blank until
  // the first send, which creates the server conversation exactly once. The
  // ref mirrors the state so the send lifecycle can read the id after awaits.
  const [activeChatId, setActiveChatId] = React.useState<string | null>(null);
  const activeChatIdRef = React.useRef<string | null>(null);
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
  }>({ content: "", reasoning: "" });
  const abortRef = React.useRef<AbortController | null>(null);
  // Sticky-bottom follow for the conversation log: ref to the scroll element
  // plus whether the user is near the bottom. While streaming, the log only
  // auto-scrolls when the user hasn't scrolled up to read history.
  const logRef = React.useRef<HTMLDivElement | null>(null);
  const followLogRef = React.useRef(true);
  // Render mirror of "user is away from the bottom" (the onScroll latch): a
  // ref alone cannot drive the Jump-to-latest button, and the boolean only
  // changes at the 80px threshold, so React bails out of the extra renders.
  const [logAway, setLogAway] = React.useState(false);
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
    setEditing(null);
    setEditConfirm(false);
    setActiveChatId(null);
    setConflict(false);
    setSaveNotice(null);
    setLoadingChat(false);
    setHistoryOpen(false);
    setError(null);
    setKeyError(null);
    setAttachError(null);
    setSend413(null); // identity switch: the snapshot never crosses identities
    setRestoreConfirm(false);
    setLastTurnAttached(false);
    applyAttachments([]);
    multimodalRef.current.clear();
    lastUserRef.current = null;
    followLogRef.current = true;
    setLogAway(false);
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
    bumpDraftRevision(); // user-initiated pick: counts as a draft mutation
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
    setEditing(null);
    setEditConfirm(false);
    setError(null);
    setKeyError(null);
    setConflict(false);
    setSaveNotice(null);
    setLoadingChat(false);
    setAttachError(null);
    setSend413(null);
    setRestoreConfirm(false);
    setLastTurnAttached(false);
    applyAttachments([]);
    lastUserRef.current = null;
    // A fresh view always starts pinned to its latest message (same contract
    // as a deliberate send): reading position from a previous view must not
    // leak into the new one.
    followLogRef.current = true;
    setLogAway(false);
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
    setInput(send413.text);
    applyAttachments([...send413.attachments]);
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
    setMessages([]);
    setEditing(null);
    setEditConfirm(false);
    setError(null);
    setConflict(false);
    setSaveNotice(null);
    setAttachError(null);
    setSend413(null);
    setRestoreConfirm(false);
    setLastTurnAttached(false);
    applyAttachments([]);
    lastUserRef.current = null;
    followLogRef.current = true;
    setLogAway(false);
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
          model: m.role === "assistant" ? m.model : undefined,
          hadAttachments: m.role === "user" ? m.hadAttachments : undefined,
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
    hadAttachments: boolean;
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
    const msgs = buildPersistMessages(turn.baseMessages, turn.userText, partial, turn.hadAttachments);
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

  async function send(textOverride?: string, isRetry = false, sendBase?: ChatMessage[], sendAttachments?: ChatAttachment[]) {
    // Also block while a conversation snapshot is still loading: a send that
    // starts before openChat's response lands would be wiped by the snapshot
    // overwriting optimistic state when it resolves.
    if (busyRef.current || streaming || !model || conflict || loadingChat || !catalogReady) return;
    // Retry regenerates the LAST assistant reply from the existing history:
    // the user turn is reused as-is, never appended a second time.
    const retryTurn = isRetry ? findRetryTurn(messages) : null;
    if (isRetry && (!retryTurn || lastUserRef.current === null)) return;
    const text = (isRetry ? retryTurn?.userText : (textOverride ?? input))?.trim() ?? "";
    // Fresh sends carry the pending chips; a retry re-uses the RETAINED full
    // content of the last user turn (below) so attachments survive a retry.
    const turnAttachments = isRetry ? [] : (sendAttachments ?? attachmentsRef.current);
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
      isRetry ? retryTurn!.baseMessages : (sendBase ?? messages).filter((m) => !isEmptyAssistant(m))
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
    // Reasoning carrier (see ./reasoning): only when the selected model
    // explicitly advertises the "reasoning" capability — an effort picked
    // for a different model is dropped, never leaked into another model's
    // request.
    const bodyJson = JSON.stringify(
      buildChatRequestBody({ model, messages: history, effort: effortForSend }),
    );
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
    const saveTurn = (partial: { content: string; reasoning: string; model?: string }) => {
      if (!canPersist || !chatId || !ws) return Promise.resolve();
      return persistTurn(
        { seq, idAtSend, chatId, baseMessages, userText: text, isFirstTurn, model, hadAttachments: turnAttachments.length > 0 || Boolean(isRetry && retryTurn && messages.findLast((m) => m.role === "user")?.hadAttachments) },
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
      const keyPurpose = key.purpose;
      setError(null);
      // The request is now certain to go out: commit the draft reset, the
      // retention entry and the retry disclosure together. The snapshot is
      // taken before the clear; the baseline after it.
      if (textOverride !== undefined && !isRetry) {
        setInput("");
        applyAttachments([]);
        setAttachError(null);
      }
      if (!isRetry && textOverride === undefined) {
        preSendText = input;
        snapshotAttachments = [...turnAttachments];
        const prevLastUser = lastUserRef.current;
        const prevLastTurnAttached = lastTurnAttached;
        setInput("");
        applyAttachments([]);
        setAttachError(null);
        setLastTurnAttached(turnAttachments.length > 0);
        revisionBaseline = draftRevisionRef.current;
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
        turns.set(turnIndex, turnContent);
      }
      // A deliberate send (fresh or retry) always re-engages sticky-bottom
      // follow: the user must see their own message and the streaming reply,
      // even if they had scrolled up, and even if a late scroll event during
      // layout of the previous turn latched followLogRef off.
      followLogRef.current = true;
      setLogAway(false);
      // The view keeps each prior message's reasoning (the Reasoning section
      // stays visible across sends); only the paid request body above strips
      // it to role+content.
      setMessages([
        ...baseMessages,
        { role: "user", content: text, reasoning: "", ...(turnAttachments.length > 0 ? { hadAttachments: true } : {}) },
        { role: "assistant", content: "", reasoning: "" },
      ]);
      lastUserRef.current = text;
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
          const revisionChanged = draftRevisionRef.current !== revisionBaseline;
          if (!revisionChanged) {
            // Unchanged revision: wholesale automatic restore of the snapshot
            // (attachments restore without re-reading files — session-only).
            setInput(preSendText);
            applyAttachments([...snapshotAttachments]);
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
          const streamModel =
            parser.model && catalogModelIds.has(parser.model) ? parser.model : null;
          appendToLast(delta, streamModel);
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

  async function confirmEditAndRegenerate() {
    if (editing === null || busyRef.current || streaming || !model || !catalogReady) return;
    busyRef.current = true;
    const text = editText.trim();
    const selected = messages[editing];
    if (!selected || selected.role !== "user" || (!text && attachmentsRef.current.length === 0)) {
      busyRef.current = false;
      return;
    }
    if (selected.hadAttachments === true && attachmentsRef.current.length === 0) {
      busyRef.current = false;
      return;
    }
    const base = messages.slice(0, editing).filter((m) => !isEmptyAssistant(m));
    const trimmed: ChatMessage[] = [
      ...base,
      { role: "user", content: text, reasoning: "", ...(attachmentsRef.current.length ? { hadAttachments: true } : {}) },
    ];
    const chatId = activeChatIdRef.current;
    if (!chatId || !workspaceId || !userId) {
      busyRef.current = false;
      return;
    }
    try {
      const snap = await saveConversation(workspaceId, chatId, {
        version: versionsRef.current.get(chatId) ?? 1,
        model,
        messages: trimmed,
      });
      if (activeChatIdRef.current !== chatId) return;
      versionsRef.current.set(chatId, snap.version);
      setMessages(trimmed);
      setConflict(false);
      setSaveNotice(null);
      invalidateConversationList();
      multimodalRef.current.delete(chatId);
      lastUserRef.current = null;
      setLastTurnAttached(false);
      setSend413(null);
      setEditing(null);
      setEditConfirm(false);
      busyRef.current = false;
      await send(text, false, base, [...attachmentsRef.current]);
    } catch (e) {
      busyRef.current = false;
      if (e instanceof ConversationError && e.kind === "conflict") setConflict(true);
      else setSaveNotice(t("editSaveFailed"));
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

  /** One user-triggered jump to the newest message. Smooth ONCE (user
   *  intent), never per stream chunk; prefers-reduced-motion gets an instant
   *  pin. followLogRef stays false until the scroll actually arrives near the
   *  bottom (the onScroll latch re-engages it) — setting it here would let
   *  the layout-effect pin override the smooth animation with an instant
   *  jump on the next render. */
  function jumpToLatest() {
    const el = logRef.current;
    if (!el) return;
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      el.scrollTop = el.scrollHeight;
    } else {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }

  const autoEligible = Boolean(userId && workspaceId);
  const canSend = Boolean(
    (input.trim() || attachments.length > 0) &&
    model &&
    catalogReady &&
    !streaming &&
    !conflict &&
    !loadingChat &&
    autoEligible,
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
          className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2 lg:hidden"
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
            <p className="max-w-md text-sm text-muted-foreground">{t("reuseNotice")}</p>
            {!userId && <p className="text-sm text-muted-foreground">{t("signInStart")}</p>}
          </div>
        ) : (
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div
              className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]"
              role="log"
              aria-live="polite"
              aria-label={t("conversation")}
              onScroll={() => {
                const el = logRef.current;
                if (!el) return;
                const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
                followLogRef.current = fromBottom < 80;
                setLogAway(fromBottom >= 80);
              }}
              ref={logRef}
            >
              <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-4">
                {messages.map((m, i) =>
                  m.role === "user" ? (
                    <div key={i} className="flex justify-end gap-2">
                      <div className="max-w-[85%]">
                        <div className="wrap-anywhere whitespace-pre-wrap rounded-2xl bg-muted px-4 py-2 text-sm">
                          {m.content}
                        </div>
                        {!streaming && <Button variant="ghost" size="sm" onClick={() => { setEditing(i); setEditText(m.content); setEditConfirm(false); applyAttachments([]); }} aria-label={t("editMessage")}>{t("editMessage")}</Button>}
                      </div>
                    </div>
                  ) : (
                    <div key={i} className="w-full space-y-1 text-sm leading-relaxed">
                      {m.reasoning && (
                        <details className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                          <summary className="cursor-pointer select-none font-medium">
                            {t("reasoning")}
                          </summary>
                          <div className="mt-1 wrap-anywhere whitespace-pre-wrap">
                            {m.reasoning}
                          </div>
                        </details>
                      )}
                      {m.content ? (
                        <>
                          <ChatMarkdown
                            content={m.content}
                            streaming={streaming && i === messages.length - 1}
                          />
                          {/* Muted ACTUAL-USED model label: the public ID from
                          the SSE stream / saved history, not the picker's
                          selection guess (the gateway rewrites to public IDs). */}
                          {m.role === "assistant" && m.model && (
                            <p className="text-xs text-muted-foreground">{m.model}</p>
                          )}
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
            {/* Jump to latest: shown whenever the user is reading older
              messages (static history included, not just mid-stream). One
              user-triggered scroll; the onScroll latch re-engages follow only
              when the target arrives. */}
            {logAway && (
              <Button
                variant="secondary"
                size="sm"
                onClick={jumpToLatest}
                aria-label={t("jumpToLatest")}
                title={t("jumpToLatest")}
                className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 shadow-md animate-in fade-in slide-in-from-bottom-2 duration-150"
              >
                <ArrowDown className="size-4" aria-hidden />
                {t("jumpToLatest")}
              </Button>
            )}
          </div>
        )}

        <div className="mx-auto w-full max-w-3xl px-4 pb-safe">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Select value={model} onValueChange={setModel} disabled={models.length === 0}>
              <SelectTrigger
                id="chat-model"
                aria-label={t("model")}
                className="pointer-coarse:h-11 h-9 min-w-0 max-w-56 flex-1 gap-1 border-0 bg-muted/50 shadow-none"
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
                >
                  {models.find((m) => m.publicId === model)?.displayName ?? (model || undefined)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem
                    key={m.publicId}
                    value={m.publicId}
                    textValue={m.displayName ?? m.publicId}
                  >
                    {m.displayName ?? m.publicId}
                    {m.capabilities.length > 0 && (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        {m.capabilities.map((c) => capabilityLabelFor(c)).join(", ")}
                      </span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {showEffort && (
              <Select value={effort} onValueChange={setEffort}>
                <SelectTrigger id="chat-effort" aria-label={t("effort")} className="pointer-coarse:h-11 h-9 w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={EFFORT_UNSET}>{t("effortDefault")}</SelectItem>
                  {effortOptions.map((e: ReasoningEffort) => (
                    <SelectItem key={e} value={e}>
                      {EFFORT_LABELS[e][locale]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          {error && (
            <Alert
              variant="destructive"
              className="mx-auto max-w-3xl"
              onDismiss={() => setError(null)}
              dismissLabel={t("dismissAlert")}
            >
              {error}
            </Alert>
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
          {/* File drag-and-drop on the whole composer. Dragover is only
              cancelled for a Files payload so dragging text between editor
              spots keeps the native drop-to-insert behaviour. */}
          <div
            className="relative rounded-2xl border border-border bg-card p-2 shadow-sm"
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("Files")) e.preventDefault();
            }}
            onDrop={(e) => {
              if (e.dataTransfer.files.length > 0) {
                e.preventDefault();
                handleFiles(e.dataTransfer.files);
              }
            }}
          >
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
                            bumpDraftRevision(); // user-initiated remove
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
                  <Alert
                    variant="destructive"
                    autoDismissMs={6000}
                    onDismiss={() => setAttachError(null)}
                    dismissLabel={t("dismissAlert")}
                  >
                    {attachError instanceof AttachError
                      ? t(
                          ATTACH_ERROR_COPY[attachError.code],
                          attachError.name2 ? { name: attachError.name2 } : undefined,
                        )
                      : attachError}
                  </Alert>
                )}
                <p className="text-xs text-muted-foreground">{t("attachHint")}</p>
                <p className="text-xs text-muted-foreground">{ATTACHMENT_RETENTION_NOTICE}</p>
              </div>
            )}
            {editing !== null && (
              <div className="mb-2 space-y-2" role="group" aria-label={t("editMessage")}>
                <p className="text-sm text-muted-foreground">{t("editWarning")}</p>
                {messages[editing]?.hadAttachments === true ? (
                  <p role="alert" className="text-sm text-destructive">{t("editAttachmentRequired")}</p>
                ) : messages[editing]?.hadAttachments === undefined ? (
                  <p role="status" className="text-sm text-amber-600">{t("editAttachmentUnknown")}</p>
                ) : null}
                <Textarea aria-label={t("editMessage")} value={editText} onChange={(e) => setEditText(e.target.value)} />
                {!editConfirm ? (
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => { setEditing(null); setEditConfirm(false); applyAttachments([]); }}>{t("cancelEdit")}</Button>
                    <Button size="sm" onClick={() => setEditConfirm(true)}>{t("confirmEdit")}</Button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <Button variant="destructive" size="sm" disabled={(messages[editing]?.hadAttachments === true && attachments.length === 0) || (!editText.trim() && attachments.length === 0)} onClick={() => void confirmEditAndRegenerate()}>{t("confirmEdit")}</Button>
                    <Button variant="outline" size="sm" onClick={() => setEditConfirm(false)}>{t("cancelEdit")}</Button>
                  </div>
                )}
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
              onChange={(e) => {
                setInput(e.target.value);
                bumpDraftRevision(); // typing/paste: a USER draft mutation
              }}
              onKeyDown={(e) => {
                // IME composition: Enter confirms the candidate, not the message.
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              onPaste={(e) => {
                // Clipboard files (e.g. a screenshot) attach like a pick;
                // text-only pastes keep the native insert-into-draft path.
                if (e.clipboardData.files.length > 0) {
                  e.preventDefault();
                  handleFiles(e.clipboardData.files);
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
                title={t("attachFilesTitle", { hint: t("attachHint") })}
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
