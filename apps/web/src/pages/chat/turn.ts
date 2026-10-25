// Pure turn-transaction helpers for the chat page send lifecycle, extracted
// so the persistence payload and the retry derivation are unit-testable
// without a DOM. Contract: a terminal save persists an immutable snapshot
// (history before the turn + the one user turn + the streamed assistant
// partial), and retry regenerates the last assistant reply by reusing the
// EXISTING user turn — never appending it a second time.
export interface TurnMessage {
  role: "user" | "assistant";
  content: string;
  reasoning: string;
  /** Assistant only: the public model ID actually used (SSE top-level
   *  `model`). Optional so user messages and legacy history compile. */
  model?: string;
  /** User only: files were attached in the original session. */
  hadAttachments?: boolean;
}

export const isEmptyAssistant = (m: { role: string; content: string; reasoning: string }) =>
  m.role === "assistant" && m.content === "" && m.reasoning === "";

/** Full transcript for one terminal save. The assistant partial is dropped
 *  when empty so a failed/aborted turn never persists a blank reply. */
export function buildPersistMessages(
  baseMessages: TurnMessage[],
  userText: string,
  partial: { content: string; reasoning: string; model?: string },
  hadAttachments = false,
): Array<{
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  model?: string;
  hadAttachments?: boolean;
}> {
  const msgs: Array<{
    role: "user" | "assistant";
    content: string;
    reasoning?: string;
    model?: string;
    hadAttachments?: boolean;
  }> = [
    ...baseMessages,
    { role: "user", content: userText, reasoning: "", ...(hadAttachments ? { hadAttachments: true } : {}) },
  ];
  if (partial.content !== "" || partial.reasoning !== "") {
    msgs.push({
      role: "assistant",
      content: partial.content,
      reasoning: partial.reasoning,
      model: partial.model,
    });
  }
  return msgs;
}

/** Derive the retry turn: the history BEFORE the last user turn, plus that
 *  user turn's text. Returns null when there is no user turn to regenerate
 *  from. Empty assistant placeholders (failed/aborted attempts) are excluded
 *  from the base history — the saved transcript replaces them wholesale. */
export function findRetryTurn(messages: TurnMessage[]): {
  baseMessages: TurnMessage[];
  userText: string;
} | null {
  let lastUser: number | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") {
      lastUser = i;
      break;
    }
  }
  const user = lastUser === null ? undefined : messages[lastUser];
  if (lastUser === null || !user) return null;
  return {
    baseMessages: messages.slice(0, lastUser).filter((m) => !isEmptyAssistant(m)),
    userText: user.content,
  };
}
