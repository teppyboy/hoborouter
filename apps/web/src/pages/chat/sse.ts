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

export interface SseParser {
  /** Feed one decoded chunk; returns the deltas found in it. */
  push(chunk: string): StreamDelta[];
  /** True once the `data: [DONE]` sentinel has been seen. */
  readonly done: boolean;
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

export function createSseParser(): SseParser {
  let buffer = "";
  let done = false;
  return {
    get done() {
      return done;
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
        const delta = extractDelta(obj);
        if (delta.content || delta.reasoning) events.push(delta);
      }
      return events;
    },
  };
}
