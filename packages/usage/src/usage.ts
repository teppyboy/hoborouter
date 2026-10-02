import type { UsageTokens } from "../../wallet/src/money";

/** Split token counts may be unknown (null) when the provider omits details. */
export type UsageSplit = {
  inputTokens: bigint;
  outputTokens: bigint;
  cachedInputTokens: bigint | null;
  reasoningTokens: bigint | null;
};

export type UsageResult =
  | { complete: true; usage: UsageSplit }
  | { complete: false; reason: string };

export type SplitRates = {
  input: bigint;
  output: bigint;
  cachedInput: bigint;
  reasoning: bigint;
};

export type BillableUsage =
  | { billable: true; usage: UsageTokens; assumed?: string[] }
  | { billable: false; reason: string };

const defaultMaxLineBytes = 1024 * 1024;
const defaultMaxBodyBytes = 8 * 1024 * 1024;

const cleanChatFinishes = new Set(["stop", "length", "tool_calls", "content_filter"]);

/**
 * For chat stream:true requests set stream_options.include_usage=true when
 * absent. Never mutates the input; non-stream bodies returned unchanged.
 */
export function injectChatUsageOption(
  body: Record<string, unknown> | unknown,
): Record<string, unknown> | unknown {
  if (
    typeof body !== "object" ||
    body === null ||
    (body as Record<string, unknown>).stream !== true
  ) {
    return body;
  }
  const streamOptions = (body as Record<string, unknown>).stream_options;
  if (
    typeof streamOptions === "object" &&
    streamOptions !== null &&
    (streamOptions as Record<string, unknown>).include_usage === true
  ) {
    return body;
  }
  const merged =
    typeof streamOptions === "object" && streamOptions !== null
      ? { ...(streamOptions as Record<string, unknown>), include_usage: true }
      : { include_usage: true };
  return { ...(body as Record<string, unknown>), stream_options: merged };
}

function isSafeNonNegative(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

type UsageExtraction =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "ok"; usage: UsageSplit };

/** Validate token counts; missing split fields stay null (unknown), not zero. */
function parseUsage(
  input: unknown,
  output: unknown,
  cached: unknown,
  reasoning: unknown,
): UsageExtraction {
  if (input === undefined || output === undefined) return { kind: "missing" };
  if (!isSafeNonNegative(input) || !isSafeNonNegative(output)) return { kind: "invalid" };
  let cachedSplit: bigint | null = null;
  if (cached !== undefined && cached !== null) {
    if (!isSafeNonNegative(cached) || cached > input) return { kind: "invalid" };
    cachedSplit = BigInt(cached);
  }
  let reasoningSplit: bigint | null = null;
  if (reasoning !== undefined && reasoning !== null) {
    if (!isSafeNonNegative(reasoning) || reasoning > output) return { kind: "invalid" };
    reasoningSplit = BigInt(reasoning);
  }
  return {
    kind: "ok",
    usage: {
      inputTokens: BigInt(input),
      outputTokens: BigInt(output),
      cachedInputTokens: cachedSplit,
      reasoningTokens: reasoningSplit,
    },
  };
}

type ChatUsageShape = {
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown };
    completion_tokens_details?: { reasoning_tokens?: unknown };
  };
};

type ResponsesUsageShape = {
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    input_tokens_details?: { cached_tokens?: unknown };
    output_tokens_details?: { reasoning_tokens?: unknown };
  };
};

function chatUsageOf(obj: ChatUsageShape): UsageExtraction {
  const u = obj.usage;
  if (u === undefined) return { kind: "missing" };
  return parseUsage(
    u.prompt_tokens,
    u.completion_tokens,
    u.prompt_tokens_details?.cached_tokens,
    u.completion_tokens_details?.reasoning_tokens,
  );
}

function responsesUsageOf(obj: ResponsesUsageShape): UsageExtraction {
  const u = obj.usage;
  if (u === undefined) return { kind: "missing" };
  return parseUsage(
    u.input_tokens,
    u.output_tokens,
    u.input_tokens_details?.cached_tokens,
    u.output_tokens_details?.reasoning_tokens,
  );
}

/**
 * Observe-only usage tap. The caller forwards response bytes to push() and
 * reads the outcome via end() (or abort() on cancellation). Pass-through is
 * the caller's job; memory is O(line) for streams, O(body) bounded by
 * maxBodyBytes for non-stream JSON.
 */
export function createUsageTap(options: {
  protocol: "chat" | "responses";
  stream: boolean;
  maxLineBytes?: number;
  maxBodyBytes?: number;
}): {
  push(chunk: Uint8Array): void;
  end(): UsageResult;
  abort(reason: string): UsageResult;
} {
  const maxLineBytes = options.maxLineBytes ?? defaultMaxLineBytes;
  const maxBodyBytes = options.maxBodyBytes ?? defaultMaxBodyBytes;
  const decoder = new TextDecoder("utf-8", { fatal: true });

  let result: UsageResult | null = null;
  let lineBuf = ""; // ponytail: bound checked in decoded chars (chars <= UTF-8 bytes); trips late on non-ASCII lines only
  let eventLines: string[] = [];
  let eventChars = 0;
  let bodyBytes: Uint8Array[] = [];
  let bodyLength = 0;
  let sawDone = false;
  let sawCleanFinish = false;
  let sawUsage: UsageSplit | null = null;
  let sawInvalidUsage = false;

  const fail = (reason: string): UsageResult => {
    if (result === null) result = { complete: false, reason };
    return result;
  };

  const finish = (): UsageResult => {
    if (result !== null) return result;
    if (options.stream) {
      if (sawInvalidUsage) return fail("invalid_usage");
      if (sawUsage === null) return fail("missing_usage");
      if (options.protocol === "chat") {
        if (!sawCleanFinish) return fail("missing_finish");
        if (!sawDone) return fail("missing_done");
      }
      return (result = { complete: true, usage: sawUsage });
    }
    // Non-stream JSON.
    const total = Buffer.concat(bodyBytes);
    let text: string;
    try {
      text = decoder.decode(total);
    } catch {
      return fail("malformed_utf8");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fail("malformed_json");
    }
    if (typeof parsed !== "object" || parsed === null) return fail("malformed_json");
    const obj = parsed as Record<string, unknown>;
    if (options.protocol === "chat") {
      const extracted = chatUsageOf(obj as ChatUsageShape);
      if (extracted.kind !== "ok")
        return fail(extracted.kind === "invalid" ? "invalid_usage" : "missing_usage");
      return (result = { complete: true, usage: extracted.usage });
    }
    if (obj.status !== "completed") return fail("not_completed");
    const extracted = responsesUsageOf(obj as ResponsesUsageShape);
    if (extracted.kind !== "ok")
      return fail(extracted.kind === "invalid" ? "invalid_usage" : "missing_usage");
    return (result = { complete: true, usage: extracted.usage });
  };

  const handleEventData = (data: string): void => {
    if (options.protocol === "chat" && data === "[DONE]") {
      sawDone = true;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      fail("malformed_json");
      return;
    }
    if (typeof parsed !== "object" || parsed === null) {
      fail("malformed_json");
      return;
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.error !== undefined && obj.error !== null) {
      fail("error_event");
      return;
    }
    if (options.protocol === "chat") {
      if (Array.isArray(obj.choices)) {
        for (const choice of obj.choices) {
          if (
            typeof choice === "object" &&
            choice !== null &&
            (choice as Record<string, unknown>).finish_reason != null
          ) {
            const fr = (choice as Record<string, unknown>).finish_reason;
            if (typeof fr === "string" && cleanChatFinishes.has(fr)) sawCleanFinish = true;
            else fail("unclean_finish");
          }
        }
      }
      const extracted = chatUsageOf(obj as ChatUsageShape);
      if (extracted.kind === "invalid") sawInvalidUsage = true;
      if (extracted.kind === "ok") sawUsage = extracted.usage;
      return;
    }
    // Responses SSE: completion only on the response.completed event.
    const type = typeof obj.type === "string" ? obj.type : "";
    if (type === "response.failed" || type === "response.incomplete" || type === "error") {
      fail("error_event");
      return;
    }
    if (type === "response.completed") {
      const response = obj.response;
      if (typeof response !== "object" || response === null) {
        fail("malformed_json");
        return;
      }
      const extracted = responsesUsageOf(response as ResponsesUsageShape);
      if (extracted.kind === "invalid") sawInvalidUsage = true;
      if (extracted.kind === "ok") sawUsage = extracted.usage;
    }
  };

  const handleLine = (line: string): void => {
    if (line.length === 0) {
      if (eventLines.length > 0) {
        handleEventData(eventLines.join("\n"));
        eventLines = [];
        eventChars = 0;
      }
      return;
    }
    if (line.startsWith(":")) return; // SSE comment
    if (line.startsWith("data:")) {
      const value = line.startsWith("data: ") ? line.slice(6) : line.slice(5);
      eventChars += value.length;
      if (eventChars > maxLineBytes) {
        fail("oversize_line");
        return;
      }
      eventLines.push(value);
      return;
    }
    // event:, id:, retry: fields — only event matters implicitly via data type.
  };

  return {
    push(chunk: Uint8Array): void {
      if (result !== null) return;
      if (options.stream) {
        let text: string;
        try {
          text = decoder.decode(chunk, { stream: true });
        } catch {
          fail("malformed_utf8");
          return;
        }
        lineBuf += text;
        for (;;) {
          const nl = lineBuf.search(/\r\n|\r|\n/);
          if (nl === -1) break;
          const line = lineBuf.slice(0, nl);
          lineBuf = lineBuf.slice(nl + (lineBuf[nl] === "\r" && lineBuf[nl + 1] === "\n" ? 2 : 1));
          handleLine(line);
          if (result !== null) return;
        }
        if (lineBuf.length > maxLineBytes) fail("oversize_line");
        return;
      }
      bodyBytes.push(chunk);
      bodyLength += chunk.length;
      if (bodyLength > maxBodyBytes) fail("oversize_body");
    },
    end(): UsageResult {
      if (result !== null) return result;
      if (options.stream) {
        if (lineBuf.length > 0) {
          handleLine(lineBuf);
          lineBuf = "";
        }
        // Flush a final event without trailing blank line.
        if (result === null && eventLines.length > 0) {
          handleEventData(eventLines.join("\n"));
          eventLines = [];
        }
      }
      return finish();
    },
    abort(reason: string): UsageResult {
      return fail(reason);
    },
  };
}

/**
 * Resolve a tap result into a full UsageTokens for calculateCharge. A missing
 * split (provider omitted the details object) never fails a complete response:
 * choose the value that yields the HIGHER charge (never undercharge). Cached
 * input is a subset of input; reasoning a subset of output. Assumptions are
 * returned so they can be recorded.
 */
export function resolveBillableUsage(result: UsageResult, price: SplitRates): BillableUsage {
  if (!result.complete) return { billable: false, reason: result.reason };
  const { usage } = result;
  const assumed: string[] = [];
  let cachedInputTokens = usage.cachedInputTokens;
  if (cachedInputTokens === null) {
    cachedInputTokens = price.cachedInput > price.input ? usage.inputTokens : 0n;
    assumed.push("cached_input");
  }
  let reasoningTokens = usage.reasoningTokens;
  if (reasoningTokens === null) {
    reasoningTokens = price.reasoning > price.output ? usage.outputTokens : 0n;
    assumed.push("reasoning");
  }
  const resolved = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens,
    reasoningTokens,
  };
  return assumed.length === 0 ? { billable: true, usage: resolved } : { billable: true, usage: resolved, assumed };
}
