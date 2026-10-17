import { useT, translate, type LocaleEntry } from "../../lib/i18n/t";
import { useLocaleStore } from "../../lib/i18n/locale";
import type { AttachErrorCode } from "./attachments";

// Chat page copy: inline LocaleEntry set (see lib/i18n/common.ts). Model
// names, message content and API errors stay verbatim — only chrome, notices
// and controls are translated. Module-level helpers read the live locale via
// useLocaleStore.getState() (see translate() in lib/i18n/t.ts).
export const chatCopy = {
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
  editTurn: { en: "Edit message", vi: "Sửa tin nhắn" },
  saveEdit: { en: "Save", vi: "Lưu" },
  cancelEdit: { en: "Cancel", vi: "Huỷ" },
  editTurnHint: {
    en: "Editing forks the conversation here — the next send starts a new PAID generation; the original stays unchanged.",
    vi: "Sửa sẽ tách hội thoại từ đây — lần gửi tiếp theo bắt đầu một lượt tạo mới CÓ TÍNH PHÍ; bản gốc không đổi.",
  },
  forkTurn: { en: "Fork from here", vi: "Tách từ đây" },
  forkTurnHint: {
    en: "Creates a copy of the conversation up to this message — the next send starts a new PAID generation; the original stays unchanged.",
    vi: "Tạo bản sao hội thoại tới tin nhắn này — lần gửi tiếp theo bắt đầu một lượt tạo mới CÓ TÍNH PHÍ; bản gốc không đổi.",
  },
  regenerateTurn: { en: "Regenerate reply", vi: "Tạo lại câu trả lời" },
  regenerateTurnHint: {
    en: "Regenerates this reply — a new PAID generation; the original stays unchanged.",
    vi: "Tạo lại câu trả lời này — một lượt tạo mới CÓ TÍNH PHÍ; bản gốc không đổi.",
  },
  attachmentsLabel: { en: "Attachments", vi: "Tệp đính kèm" },
  attachmentExpired: { en: "Expired", vi: "Đã hết hạn" },
  previewAttachment: {
    en: "Preview {name}",
    vi: "Xem trước {name}",
  },
  replyComplete: { en: "Reply complete.", vi: "Đã trả lời xong." },
  errRateLimited: {
    en: "Too many requests — try again in {seconds}s.",
    vi: "Quá nhiều yêu cầu — thử lại sau {seconds} giây.",
  },
  errRateLimitedGeneric: {
    en: "Too many requests — try again shortly.",
    vi: "Quá nhiều yêu cầu — thử lại sau ít phút.",
  },
  topUp: { en: "Top up wallet", vi: "Nạp tiền ví" },
  keyForbiddenHelp: {
    en: "Members without owner or admin role cannot create a chat key in this workspace. Ask a workspace admin for help.",
    vi: "Thành viên (không phải chủ sở hữu hoặc quản trị viên) không thể tạo chat key trong workspace này. Hãy nhờ quản trị viên workspace hỗ trợ.",
  },
  attachmentRetention: {
    en: "Attachments are saved with your message. Their files may expire after the retention period.",
    vi: "Tệp đính kèm được lưu cùng tin nhắn. Tệp có thể hết hạn sau thời gian lưu trữ.",
  },
  attachmentUnavailableTitle: {
    en: "Some attached files are unavailable.",
    vi: "Một số tệp đính kèm không còn khả dụng.",
  },
  attachmentUnavailableBody: {
    en: "Nothing was sent. Omit these files for this send only? Your saved conversation will remain unchanged.",
    vi: "Chưa gửi nội dung nào. Bỏ các tệp này chỉ trong lần gửi này? Hội thoại đã lưu sẽ không thay đổi.",
  },
  omitUnavailable: {
    en: "Omit unavailable files for this send",
    vi: "Bỏ tệp không khả dụng trong lần gửi này",
  },
  cancelOmit: { en: "Cancel", vi: "Huỷ" },

  attachmentUploadUnauthorized: { en: "Sign in again to upload this file.", vi: "Đăng nhập lại để tải tệp này lên." },
  attachmentUploadForbidden: { en: "You cannot upload files to this workspace.", vi: "Bạn không thể tải tệp lên workspace này." },
  attachmentUploadTooLarge: { en: "This file is too large to upload.", vi: "Tệp này quá lớn để tải lên." },
  attachmentUploadUnsupported: { en: "This file type cannot be uploaded.", vi: "Không thể tải lên loại tệp này." },
  attachmentUploadQuota: { en: "Workspace attachment storage is full.", vi: "Dung lượng lưu tệp đính kèm của workspace đã đầy." },
  attachmentUploadNetwork: { en: "Could not upload the file. Check your connection and retry.", vi: "Không tải được tệp lên. Kiểm tra kết nối rồi thử lại." },
  attachmentUploadInvalid: { en: "Upload failed. Try selecting the file again.", vi: "Tải tệp lên thất bại. Hãy chọn lại tệp." },
  memberChatBlocked: {
    en: "Chat is not enabled for this workspace. Ask a workspace admin to enable member chat.",
    vi: "Chat chưa được bật cho workspace này. Hãy nhờ quản trị viên workspace bật chat cho thành viên.",
  },
  memberLimitReached: {
    en: "You have used today's member chat limit. It resets {time}.",
    vi: "Bạn đã dùng hết hạn mức chat hôm nay. Hạn mức sẽ đặt lại lúc {time}.",
  },
  forkFailed: {
    en: "Could not fork the conversation.",
    vi: "Không thể tách hội thoại.",
  },
  forkUnsaved: {
    en: "Save the conversation before forking or editing a turn.",
    vi: "Hãy lưu hội thoại trước khi tách hoặc sửa một lượt.",
  },
  chargedLast: { en: "Last reply cost: {cost}", vi: "Câu trả lời cuối tiêu tốn: {cost}" },
  usageTokens: { en: "{tokens} tokens", vi: "{tokens} token" },
} as const;

/** Structured rejection code -> localized copy key (see AttachError in
 *  attachments.ts; the page localizes via chatCopy). */
export const ATTACH_ERROR_COPY: Record<AttachErrorCode, keyof typeof chatCopy> = {
  unsupported: "attachUnsupported",
  imageTooLarge: "attachImageTooLarge",
  textTooLarge: "attachTextTooLarge",
  tooMany: "attachTooMany",
  totalTooLarge: "attachTotalTooLarge",
};

/** Reactive translator for the chat page; component-scope only. */
export const useChatT = () => useT(chatCopy);

// Actionable starters: each is a real prompt a user can send or edit.
export const PROMPT_CHIPS: LocaleEntry[] = [chatCopy.chip1, chatCopy.chip2, chatCopy.chip3];

export function readableError(
  status: number,
  body: { error?: { message?: string } } | null,
): string {
  const msg = body?.error?.message;
  const locale = useLocaleStore.getState().locale;
  // 401 never reaches here (the managed-key reconnect path handles it); the
  // generic fallback still names the likely cause.
  if (status === 401) return msg ?? translate(chatCopy, "errKeyReconnect", locale);
  if (status === 402) return msg ?? translate(chatCopy, "errWallet", locale);
  if (status === 404) return msg ?? translate(chatCopy, "errModelNotFound", locale);
  return msg ?? translate(chatCopy, "errRequestFailed", locale, { status });
}
