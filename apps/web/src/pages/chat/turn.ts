import type { StreamDelta } from "./sse";

// Pure turn-transaction helpers for the chat page send lifecycle, extracted
// so the persistence payload and the retry derivation are unit-testable
// without a DOM. Contract: a terminal save persists an immutable snapshot
// (history before the turn + the one user turn + the streamed assistant
// partial), and retry regenerates the last assistant reply by reusing the
// EXISTING user turn — never appending it a second time.
/** Public attachment reference — mirrors ChatAttachmentRef in
 *  packages/shared/src/chat.ts (frozen wire DTO; the web app keeps local type
 *  mirrors, see conversations.ts). Metadata only: bytes are never in the DTO. */
export interface ChatAttachmentRef {
  id: string;
  name: string;
  kind: "image" | "text";
  bytes: number;
  mime: string;
  /** Epoch ms after which the bytes are gone; metadata stays in history. */
  expires_at: number;
}

export interface TurnMessage {
  role: "user" | "assistant";
  content: string;
  reasoning: string;
  /** Assistant only: the public model ID actually used (SSE top-level
   *  `model`). Optional so user messages and legacy history compile. */
  model?: string;
  /** User-only attachment refs (additive DTO field); assistant-only below. */
  attachments?: ChatAttachmentRef[];
  /** Assistant only: the gateway request ID (from the fetch parent's
   *  x-hbr-request-id response header), linking the turn to its billing
   *  receipt via GET /workspaces/:id/chat-receipts/:requestId. */
  request_id?: string;
}

export const isEmptyAssistant = (m: { role: string; content: string; reasoning: string }) =>
  m.role === "assistant" && m.content === "" && m.reasoning === "";

/** Full transcript for one terminal save. The assistant partial is dropped
 *  when empty so a failed/aborted turn never persists a blank reply. */
export function buildPersistMessages(
  baseMessages: TurnMessage[],
  userText: string,
  partial: { content: string; reasoning: string; model?: string; request_id?: string },
): Array<{
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  model?: string;
  request_id?: string;
}> {
  const msgs: Array<{
    role: "user" | "assistant";
    content: string;
    reasoning?: string;
    model?: string;
    request_id?: string;
  }> = [...baseMessages, { role: "user", content: userText, reasoning: "" }];
  if (partial.content !== "" || partial.reasoning !== "") {
    msgs.push({
      role: "assistant",
      content: partial.content,
      reasoning: partial.reasoning,
      model: partial.model,
      request_id: partial.request_id,
    });
  }
  return msgs;
}

/** Render coalescing for the send loop: buffers stream deltas and applies
 *  them at most once per scheduled tick (one flush per frame by default), so
 *  1000 chunks cannot cause 1000 renders. Pure queue — accumulation stays in
 *  the caller's state. `end()` is the exact-final contract: on done/abort/
 *  error everything queued flushes synchronously and the pending tick is
 *  cancelled, so the terminal state equals the sequential stream with
 *  nothing dropped or duplicated. */
export interface RenderCoalescerOptions {
  /** Applies one ordered batch of queued deltas. */
  flush(batch: StreamDelta[]): void;
  /** Schedules a flush; must eventually run the callback. Returns its own
   *  cancel. Injectable so tests drive flush timing without rAF. */
  schedule?(cb: () => void): () => void;
}

const defaultSchedule = (cb: () => void): (() => void) => {
  const id = requestAnimationFrame(cb);
  return () => cancelAnimationFrame(id);
};

export function createRenderCoalescer(options: RenderCoalescerOptions) {
  const schedule = options.schedule ?? defaultSchedule;
  let queued: StreamDelta[] = [];
  let scheduled = false;
  let cancel: (() => void) | null = null;
  const flushNow = () => {
    scheduled = false;
    cancel = null;
    if (queued.length === 0) return;
    const batch = queued;
    queued = [];
    options.flush(batch);
  };
  return {
    push(delta: StreamDelta) {
      queued.push(delta);
      if (scheduled) return;
      scheduled = true;
      cancel = schedule(flushNow);
    },
    /** Terminal: exact final flush on done/abort/error. */
    end() {
      cancel?.();
      flushNow();
    },
    get pending() {
      return scheduled || queued.length > 0;
    },
  };
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
