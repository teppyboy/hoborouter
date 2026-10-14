import type { ConversationMessage } from "@hoborouter/shared";
import {
  AttachmentBudgetExceededError,
  UnavailableAttachmentsError,
  messageRefBytes,
  rehydrateMultimodalContents,
} from "./persistent-attachments";
import { withMultimodalContent } from "./attachments";
import { buildChatRequestBody, type ReasoningEffort } from "./reasoning";

export const MAX_CHAT_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

export type PreparedChatSend =
  | { ok: true; bodyJson: string; conversationMessages: ConversationMessage[] }
  | { ok: false; kind: "unavailable"; files: UnavailableAttachmentsError["unavailable"]; outgoingMessages: ConversationMessage[] }
  | { ok: false; kind: "tooLarge" | "failed"; error: Error };

function copyMessages(messages: ConversationMessage[]): ConversationMessage[] {
  return messages.map((message) => ({
    ...message,
    ...(message.attachments
      ? { attachments: message.attachments.map((attachment) => ({ ...attachment })) }
      : {}),
  }));
}

export async function prepareChatSend(input: {
  workspaceId: string;
  model: string;
  messages: ConversationMessage[];
  effort: ReasoningEffort;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}): Promise<PreparedChatSend> {
  const outgoingMessages = copyMessages(input.messages);
  if (messageRefBytes(outgoingMessages) > 10 * 1024 * 1024) {
    return { ok: false, kind: "tooLarge", error: new AttachmentBudgetExceededError() };
  }
  try {
    const contents = await rehydrateMultimodalContents(input.workspaceId, outgoingMessages, {
      fetch: input.fetch,
      signal: input.signal,
    });
    const history = withMultimodalContent(
      outgoingMessages.map(({ role, content }) => ({ role, content })),
      contents,
    );
    const bodyJson = JSON.stringify(
      buildChatRequestBody({ model: input.model, messages: history, effort: input.effort }),
    );
    if (new TextEncoder().encode(bodyJson).byteLength > MAX_CHAT_REQUEST_BODY_BYTES) {
      return { ok: false, kind: "tooLarge", error: new Error("Chat request body exceeds 16 MiB.") };
    }
    return { ok: true, bodyJson, conversationMessages: copyMessages(outgoingMessages) };
  } catch (error) {
    if (error instanceof UnavailableAttachmentsError) {
      return {
        ok: false,
        kind: "unavailable",
        files: error.unavailable,
        outgoingMessages,
      };
    }
    if (error instanceof AttachmentBudgetExceededError) {
      return { ok: false, kind: "tooLarge", error };
    }
    return {
      ok: false,
      kind: "failed",
      error: error instanceof Error ? error : new Error("Could not prepare chat request."),
    };
  }
}
