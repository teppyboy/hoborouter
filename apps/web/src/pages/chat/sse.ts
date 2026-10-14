// SSE parser for the /v1/chat/completions stream. Pure and framework-free so
// tests can drive it byte-by-byte. Handles reads split mid-line, multiple
// events per chunk, OpenAI's `data: [DONE]` sentinel, and ignores malformed
// lines. ponytail: each `data:` line is one event (the SSE spec allows
// multi-line data payloads; OpenAI-compatible upstreams never send them).
export interface StreamDelta {
  /** Text to append to the assistant message. Empty when none. */
  content: string;
  /** Reasoning delta shown separately from content. Empty when none. */
  reasoning: string;
}

/** Top-level per-request usage on the final usage chunk (typed, additive). */
export interface StreamUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface SseParser {
  /** Feed one decoded chunk; returns the deltas found in it. */
  push(chunk: string): StreamDelta[];
  /** True once the `data: [DONE]` sentinel has been seen. */
  readonly done: boolean;
  /** First non-empty top-level string `model` seen on any data payload —
   *  the gateway delivers the PUBLIC model ID here. Null until captured. */
  readonly model: string | null;
  /** Last valid top-level `usage` object seen (the OpenAI-compatible final
   *  usage chunk). Malformed/partial usage objects are ignored, not trusted. */
  readonly usage: StreamUsage | null;
  /** Message of the first top-level `error` event payload (OpenAI-compatible
   *  mid-stream error). Content/model already streamed stay preserved — the
   *  caller decides how to surface it; the parser never throws. */
  readonly error: string | null;
}

function extractDelta(obj: unknown): StreamDelta {
  const empty: StreamDelta = { content: "", reasoning: "" };
  if (typeof obj !== "object" || obj === null) return empty;
  const choices = (obj as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return empty;
  const choice = choices[0] as { delta?: unknown } | null;
  const delta = choice?.delta;
  if (typeof delta !== "object" || delta === null) return empty;
  const d = delta as Record<string, unknown>;
  return {
    content: typeof d.content === "string" ? d.content : "",
    // The gateway passes through reasoning_content and the bare `reasoning`
    // spelling; treat them as the same concept.
    reasoning:
      typeof d.reasoning_content === "string"
        ? d.reasoning_content
        : typeof d.reasoning === "string"
          ? d.reasoning
          : "",
  };
}

function extractUsage(obj: unknown): StreamUsage | null {
  if (typeof obj !== "object" || obj === null) return null;
  const u = (obj as { usage?: unknown }).usage;
  if (typeof u !== "object" || u === null) return null;
  const o = u as Record<string, unknown>;
  // All three counts must be present, finite numbers — a partial usage
  // object is never coerced into fake zeros.
  const values = [o.prompt_tokens, o.completion_tokens, o.total_tokens];
  if (!values.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  return {
    prompt_tokens: o.prompt_tokens as number,
    completion_tokens: o.completion_tokens as number,
    total_tokens: o.total_tokens as number,
  };
}

function extractErrorMessage(obj: unknown): string | null {
  if (typeof obj !== "object" || obj === null) return null;
  const err = (obj as { error?: unknown }).error;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string" && msg !== "") return msg;
  }
  return null;
}

export function createSseParser(): SseParser {
  let buffer = "";
  let done = false;
  let model: string | null = null;
  let usage: StreamUsage | null = null;
  let error: string | null = null;
  return {
    get done() {
      return done;
    },
    get model() {
      return model;
    },
    get usage() {
      return usage;
    },
    get error() {
      return error;
    },
    push(chunk: string): StreamDelta[] {
      buffer += chunk;
      const events: StreamDelta[] = [];
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (done) continue;
        // Only `data:` lines carry events; field lines, comments and garbage
        // are ignored.
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === "[DONE]") {
          done = true;
          continue;
        }
        let obj: unknown;
        try {
          obj = JSON.parse(payload);
        } catch {
          continue; // malformed data line ignored
        }
        // Mid-stream error event: remember the first message; deltas already
        // delivered stay in the caller's transcript (never discarded).
        if (error === null) error = extractErrorMessage(obj);
        // Record the first non-empty top-level model (public ID from the
        // gateway); later chunks never override it.
        if (model === null) {
          const m = (obj as { model?: unknown } | null)?.model;
          if (typeof m === "string" && m !== "") model = m;
        }
        // Usage arrives on the final chunk (last valid object wins).
        const u = extractUsage(obj);
        if (u) usage = u;
        const delta = extractDelta(obj);
        if (delta.content || delta.reasoning) events.push(delta);
      }
      return events;
    },
  };
}
