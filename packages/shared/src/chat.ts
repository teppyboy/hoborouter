// Shared Chat DTOs — dependency-free, type-only. Runtime validation stays
// API-side (Zod); these are the frozen wire shapes frontend/backend lanes
// both compile against. No file bytes, paths, or provider secrets here.
import type { EpochMs } from "./index";

/** Attachment kinds accepted by POST /workspaces/:id/attachments. */
export const CHAT_ATTACHMENT_KINDS = ["image", "text"] as const;
export type ChatAttachmentKind = (typeof CHAT_ATTACHMENT_KINDS)[number];

/** Hard caps enforced server-side (migration 0024 contract). */
export const CHAT_ATTACHMENT_MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MiB
export const CHAT_ATTACHMENT_MAX_TEXT_BYTES = 64 * 1024; // 64 KiB UTF-8
export const CHAT_ATTACHMENT_QUOTA_BYTES = 500 * 1024 * 1024; // 500 MiB live per user
export const CHAT_ATTACHMENT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days from upload
export const CHAT_ATTACHMENT_ORPHAN_TTL_MS = 24 * 60 * 60 * 1000; // unreferenced uploads

/**
 * Public attachment reference. Appears inside user messages only; history
 * snapshots retain expired/deleted refs (metadata) and are never pruned.
 */
export interface ChatAttachmentRef {
  id: string;
  name: string;
  kind: ChatAttachmentKind;
  bytes: number;
  mime: string;
  /** Epoch ms after which the bytes are gone; metadata stays in history. */
  expires_at: EpochMs;
}

/** Chat response DTO for GET/DELETE .../attachments/:attachmentId and 201 bodies. */
export interface ChatAttachmentDto extends ChatAttachmentRef {
  workspace_id: string;
  created_at: EpochMs;
  deleted_at: EpochMs | null;
}

/**
 * Conversation message shape (jsonb in chat_conversations.messages).
 * Backward compatible: reasoning/model/attachments/request_id are additive
 * and optional. `attachments` is user-only; `request_id` is assistant-only.
 */
export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  model?: string;
  attachments?: ChatAttachmentRef[];
  request_id?: string;
}

/** Fork request/response contract (POST /chats/:chatId/fork). */
export interface ChatForkRequest {
  version: number;
  message_index: number;
  content?: string;
}
export interface ChatForkResponse {
  id: string;
  version: number;
}

/** Title rename contract (PUT /chats/:chatId/title). */
export interface ChatTitleUpdateRequest {
  version: number;
  title: string;
}
export interface ChatTitleUpdateResponse {
  id: string;
  version: number;
}

/** Per-request billing receipt for chat generations. */
export type ChatReceiptStatus = "pending" | "settled" | "failed";
export interface ChatReceipt {
  request_id: string;
  status: ChatReceiptStatus;
  /** NULL while pending; actual VND even for failed (full-hold) requests. */
  charged_vnd: number | null;
  public_model: string | null;
  created_at: EpochMs;
}
