// Builders for OpenAI-compatible /v1/chat/completions SSE bodies, shared by
// the fake CPA (tests/fake-cpa.ts owner) and parser/stream behavior tests.
// Pure string builders: no fetch, no server, no dependencies — callers choose
// how and when the bytes are delivered, including byte-level splits.

const dataLine = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;

/** Same payload without the space after `data:` — some upstreams emit this
 *  spelling and the gateway must normalize both. */
const dataLineNoSpace = (obj: unknown): string => `data:${JSON.stringify(obj)}\n\n`;

/** Final OpenAI usage chunk: empty choices, usage object only. Emitted when
 *  the upstream was asked for stream_options.include_usage. */
export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

/** One content delta. `model` is the PUBLIC model id the gateway repeats. */
export function contentDelta(text: string, model?: string): string {
  const delta: Record<string, unknown> = {
    choices: [{ delta: { content: text } }],
  };
  if (model !== undefined) delta.model = model;
  return dataLine(delta);
}

/** One reasoning delta. Uses `reasoning_content`; the gateway also accepts
 *  the bare `reasoning` spelling and treats them as the same concept. */
export function reasoningDelta(text: string): string {
  return dataLine({ choices: [{ delta: { reasoning_content: text } }] });
}

/** Final usage chunk (no deltas). The SSE parser ignores it; usage handling
 *  lives in the caller's response layer. */
export function usageChunk(usage: ChatUsage): string {
  return dataLine({ choices: [], usage });
}

/** OpenAI-style mid-stream error event, terminated by [DONE]. */
export function errorEvent(message: string): string {
  return dataLine({ error: { message, type: "upstream_error", code: null } }) + "data: [DONE]\n\n";
}

export const DONE = "data: [DONE]\n\n";

export interface StreamOptions {
  /** Public model id emitted once on the first chunk. */
  model?: string;
  /** Reasoning emitted as leading deltas before any content. */
  reasoning?: string;
  /** Usage chunk appended before [DONE]. */
  usage?: ChatUsage;
  /** Emit every event without the space after `data:`. */
  noSpace?: boolean;
}

/** Content stream split across the given deltas, optionally with reasoning
 *  and usage, always terminated by [DONE]. */
export function streamBody(deltas: string[], opts: StreamOptions = {}): string {
  const line = opts.noSpace ? dataLineNoSpace : dataLine;
  const parts: string[] = [];
  if (opts.reasoning) {
    parts.push(line({ choices: [{ delta: { reasoning_content: opts.reasoning } }] }));
  }
  for (const [i, text] of deltas.entries()) {
    // model is top-level on the payload (where the SSE parser reads it),
    // emitted once on the first content chunk like real upstreams.
    const payload: Record<string, unknown> = {
      choices: [{ delta: { content: text } }],
    };
    if (i === 0 && opts.model !== undefined) payload.model = opts.model;
    parts.push(line(payload));
  }
  if (opts.usage) parts.push(line({ choices: [], usage: opts.usage }));
  parts.push(DONE);
  return parts.join("");
}

/** Single-delta complete reply. */
export function completeStream(content: string, opts: StreamOptions = {}) {
  return streamBody([content], opts);
}

/** A long reply as many multi-sentence deltas, for streaming/perf fixtures. */
export function longContentStream(paragraphs: string[], opts: StreamOptions = {}) {
  return streamBody(
    paragraphs.map((p) => `${p}\n\n`),
    opts,
  );
}

/** Fenced code block content exactly as it should appear in the assistant
 *  message (callers embed it in a delta themselves or via streamBody). */
export function fencedCode(lang: string, code: string): string {
  return `\`\`\`${lang}\n${code}\n\`\`\``;
}
