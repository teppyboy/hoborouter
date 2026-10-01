import { describe, expect, test } from "bun:test";
import { createUsageTap, injectChatUsageOption, type UsageResult } from "../src/usage";

// Fixtures copied from .pi/cpa-usage-capture.md (z-ai/glm-5.3-flash, CPA v8.0.4).
// No headers/keys/tokens included.

const chatSseUsageLine =
  'data: {"id":"chatcmpl-5efe3159-cc1d-4035-a226-43265fb56e28","object":"chat.completion.chunk","created":1790752137,"model":"z-ai/glm-5.3-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}';
const chatSseDone = "data: [DONE]";
const chatSseUsageChunk =
  'data: {"id":"chatcmpl-5efe3159-cc1d-4035-a226-43265fb56e28","object":"chat.completion.chunk","created":1790752137,"model":"z-ai/glm-5.3-flash","choices":[],"usage":{"prompt_tokens":18,"completion_tokens":8,"total_tokens":26}}';

const chatSseFixture = [
  'data: {"id":"chatcmpl-5efe3159","object":"chat.completion.chunk","created":1790752137,"model":"z-ai/glm-5.3-flash","choices":[{"index":0,"delta":{"content":"hi"}}]}',
  "",
  chatSseUsageLine,
  "",
  chatSseUsageChunk,
  "",
  chatSseDone,
  "",
  "",
].join("\n");

const responsesSseFixture = [
  "event: response.created",
  'data: {"type":"response.created","sequence_number":0,"response":{"id":"chatcmpl-d36a6e4f","object":"response","status":"in_progress"}}',
  "",
  "event: response.output_text.delta",
  'data: {"type":"response.output_text.delta","sequence_number":5,"delta":"ok"}',
  "",
  "event: response.completed",
  'data: {"type":"response.completed","sequence_number":9,"response":{"id":"chatcmpl-d36a6e4f-16af-4533-92c1-57d745f6f5e8","object":"response","created_at":1790752139,"status":"completed","background":false,"error":null,"max_output_tokens":16,"model":"z-ai/glm-5.3-flash","output":[{"id":"msg_0","type":"message","status":"completed","content":[{"type":"output_text","annotations":[],"logprobs":[],"text":"ok"}],"role":"assistant"}],"usage":{"input_tokens":18,"input_tokens_details":{"cached_tokens":0},"output_tokens":3,"total_tokens":21,"output_tokens_details":{"reasoning_tokens":0}}}}',
  "",
].join("\n");

const chatJsonFixture = JSON.stringify({
  id: "chatcmpl-16e34933-65c0-4048-9048-c8c4fa749ae7",
  object: "chat.completion",
  created: 1790752136,
  model: "z-ai/glm-5.3-flash",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 18, completion_tokens: 3, total_tokens: 21 },
});

const responsesJsonFixture = JSON.stringify({
  id: "chatcmpl-d36a6e4f",
  object: "response",
  status: "completed",
  model: "z-ai/glm-5.3-flash",
  usage: {
    input_tokens: 18,
    output_tokens: 3,
    total_tokens: 21,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
});

const completeChat = {
  complete: true as const,
  usage: {
    inputTokens: 18n,
    outputTokens: 8n,
    cachedInputTokens: null,
    reasoningTokens: null,
  },
};

const completeResponses = {
  complete: true as const,
  usage: {
    inputTokens: 18n,
    outputTokens: 3n,
    cachedInputTokens: 0n,
    reasoningTokens: 0n,
  },
};

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s);

function runStream(
  options: Parameters<typeof createUsageTap>[0],
  input: string | Uint8Array,
  chunks?: number[],
): UsageResult {
  const tap = createUsageTap(options);
  const data = typeof input === "string" ? bytes(input) : input;
  if (chunks) {
    let offset = 0;
    for (const size of chunks) {
      tap.push(data.subarray(offset, offset + size));
      offset += size;
    }
    if (offset < data.length) tap.push(data.subarray(offset));
  } else {
    tap.push(data);
  }
  return tap.end();
}

/** Push input split into two chunks at every byte offset; all results must match `expected`. */
function expectSameEveryOffset(
  options: Parameters<typeof createUsageTap>[0],
  input: string,
  expected: UsageResult,
) {
  const data = bytes(input);
  for (let i = 0; i <= data.length; i++) {
    const tap = createUsageTap(options);
    tap.push(data.subarray(0, i));
    tap.push(data.subarray(i));
    const result = tap.end();
    expect(result).toEqual(expected);
  }
}

describe("injectChatUsageOption", () => {
  test("stream:true without stream_options adds include_usage", () => {
    const body = { model: "m", stream: true, messages: [] };
    const out = injectChatUsageOption(body) as typeof body & {
      stream_options: { include_usage: boolean };
    };
    expect(out.stream_options.include_usage).toBe(true);
  });

  test("stream:true with existing stream_options merges without mutating input", () => {
    const body = { stream: true, stream_options: { include_usage: false as boolean | undefined } };
    (body.stream_options as { include_usage?: boolean }).include_usage = undefined;
    const out = injectChatUsageOption(body) as typeof body;
    expect(out.stream_options.include_usage).toBe(true);
    expect(body.stream_options.include_usage).toBeUndefined();
  });

  test("include_usage already true is left alone", () => {
    const body = { stream: true, stream_options: { include_usage: true } };
    expect(injectChatUsageOption(body)).toBe(body);
  });

  test("non-stream body unchanged", () => {
    const body = { model: "m", stream: false };
    expect(injectChatUsageOption(body)).toBe(body);
  });
});

describe("chat SSE tap", () => {
  test("complete: usage + [DONE] + clean finish", () => {
    expect(runStream({ protocol: "chat", stream: true }, chatSseFixture)).toEqual(completeChat);
  });

  test("complete at every byte offset (rechunked)", () => {
    expectSameEveryOffset({ protocol: "chat", stream: true }, chatSseFixture, completeChat);
  });

  test("CRLF line endings", () => {
    expect(
      runStream({ protocol: "chat", stream: true }, chatSseFixture.replace(/\n/g, "\r\n")),
    ).toEqual(completeChat);
  });

  test("multi-line data event joined with \n as one event", () => {
    // SSE joins data: lines of one event with \n; split at a whitespace-safe token boundary.
    const usage1 = 'data: {"usage":{"prompt_tokens":18,';
    const usage2 = 'data: "completion_tokens":8}}';
    const input = `${chatSseUsageLine}\n\n${usage1}\n${usage2}\n\n${chatSseDone}\n\n`;
    expect(runStream({ protocol: "chat", stream: true }, input)).toEqual(completeChat);
  });

  test("comments and event: fields ignored", () => {
    const input = `: ping\n\nevent: message\n${chatSseUsageLine}\n\n${chatSseUsageChunk}\n\n${chatSseDone}\n\n`;
    expect(runStream({ protocol: "chat", stream: true }, input)).toEqual(completeChat);
  });

  test("missing [DONE] => incomplete", () => {
    const input = chatSseFixture.replace(`${chatSseDone}\n`, "");
    expect(runStream({ protocol: "chat", stream: true }, input).complete).toBe(false);
  });

  test("missing finish_reason => incomplete", () => {
    const input = chatSseFixture.replace(chatSseUsageLine, chatSseUsageChunk);
    expect(runStream({ protocol: "chat", stream: true }, input).complete).toBe(false);
  });

  test("missing usage => incomplete", () => {
    const input = chatSseFixture.replace(chatSseUsageChunk, chatSseUsageLine);
    expect(runStream({ protocol: "chat", stream: true }, input).complete).toBe(false);
  });

  test("error event => incomplete", () => {
    const input = `data: {"error":{"message":"boom"}}\n\n${chatSseDone}\n\n`;
    const result = runStream({ protocol: "chat", stream: true }, input);
    expect(result).toEqual({ complete: false, reason: "error_event" });
  });

  test("length finish_reason is clean terminal", () => {
    const input = chatSseFixture.replace('"finish_reason":"stop"', '"finish_reason":"length"');
    expect(runStream({ protocol: "chat", stream: true }, input)).toEqual(completeChat);
  });

  test("unknown finish_reason => incomplete", () => {
    const input = chatSseFixture.replace('"finish_reason":"stop"', '"finish_reason":"weird"');
    expect(runStream({ protocol: "chat", stream: true }, input).complete).toBe(false);
  });

  test("truncated mid-event => incomplete", () => {
    const result = runStream({ protocol: "chat", stream: true }, 'data: {"usage":{"prompt_tok');
    expect(result.complete).toBe(false);
  });

  test("empty body => incomplete", () => {
    expect(runStream({ protocol: "chat", stream: true }, "").complete).toBe(false);
  });

  test("long stream of normal events under maxLineBytes completes", () => {
    // ~5 KB of normal delta events, maxLineBytes 1024: total size exceeds the
    // bound but no single line/event does.
    const deltas: string[] = [];
    for (let i = 0; i < 20; i++) {
      deltas.push(`data: {"choices":[{"delta":{"content":"${"x".repeat(200)}"}}]}`);
    }
    const input = deltas
      .flatMap((d) => [d, ""])
      .concat([chatSseUsageLine, "", chatSseUsageChunk, "", chatSseDone, ""])
      .join("\n");
    expect(runStream({ protocol: "chat", stream: true, maxLineBytes: 1024 }, input)).toEqual(
      completeChat,
    );
  });

  test("single unterminated line over maxLineBytes => oversize_line", () => {
    const tap = createUsageTap({ protocol: "chat", stream: true, maxLineBytes: 16 });
    tap.push(bytes(`data: {"a":"${"y".repeat(64)}`));
    expect(tap.end()).toEqual({ complete: false, reason: "oversize_line" });
  });

  test("oversize line => incomplete", () => {
    const tap = createUsageTap({ protocol: "chat", stream: true, maxLineBytes: 16 });
    tap.push(bytes(`data: ${"x".repeat(64)}\n\n`));
    expect(tap.end()).toEqual({ complete: false, reason: "oversize_line" });
  });

  test("malformed UTF-8 => incomplete", () => {
    const tap = createUsageTap({ protocol: "chat", stream: true });
    tap.push(new Uint8Array([0xff, 0xfe]));
    expect(tap.end()).toEqual({ complete: false, reason: "malformed_utf8" });
  });

  test("multibyte char split across chunks", () => {
    const content = "こんにちは";
    const line = `data: {"choices":[{"delta":{"content":"${content}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`;
    const input = `${line}\n\n${chatSseDone}\n\n`;
    const data = bytes(input);
    // The multibyte chars are near the start; split at every offset anyway.
    for (let i = 1; i < 24; i++) {
      const tap = createUsageTap({ protocol: "chat", stream: true });
      tap.push(data.subarray(0, i));
      tap.push(data.subarray(i));
      const result = tap.end();
      expect(result).toEqual({
        complete: true,
        usage: {
          inputTokens: 1n,
          outputTokens: 1n,
          cachedInputTokens: null,
          reasoningTokens: null,
        },
      });
    }
  });

  test("abort returns incomplete with reason", () => {
    const tap = createUsageTap({ protocol: "chat", stream: true });
    tap.push(bytes(chatSseFixture));
    expect(tap.abort("client_cancelled")).toEqual({ complete: false, reason: "client_cancelled" });
  });
});

describe("chat JSON tap", () => {
  test("complete", () => {
    expect(runStream({ protocol: "chat", stream: false }, chatJsonFixture)).toEqual({
      complete: true,
      usage: { inputTokens: 18n, outputTokens: 3n, cachedInputTokens: null, reasoningTokens: null },
    });
  });

  test("oversize body => incomplete", () => {
    const tap = createUsageTap({ protocol: "chat", stream: false, maxBodyBytes: 8 });
    tap.push(bytes(chatJsonFixture));
    expect(tap.end()).toEqual({ complete: false, reason: "oversize_body" });
  });

  test("malformed JSON => incomplete", () => {
    expect(runStream({ protocol: "chat", stream: false }, "{nope").complete).toBe(false);
  });

  test("missing usage => incomplete", () => {
    expect(runStream({ protocol: "chat", stream: false }, "{}").complete).toBe(false);
  });

  test("malformed UTF-8 => incomplete", () => {
    const tap = createUsageTap({ protocol: "chat", stream: false });
    tap.push(new Uint8Array([0xff]));
    expect(tap.end()).toEqual({ complete: false, reason: "malformed_utf8" });
  });
});

describe("responses SSE tap", () => {
  test("complete on response.completed with usage", () => {
    expect(runStream({ protocol: "responses", stream: true }, responsesSseFixture)).toEqual(
      completeResponses,
    );
  });

  test("complete at every byte offset (rechunked)", () => {
    expectSameEveryOffset(
      { protocol: "responses", stream: true },
      responsesSseFixture,
      completeResponses,
    );
  });

  test("response.failed => incomplete", () => {
    const input =
      'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"bad"}}}\n\n';
    expect(runStream({ protocol: "responses", stream: true }, input)).toEqual({
      complete: false,
      reason: "error_event",
    });
  });

  test("response.incomplete => incomplete", () => {
    const input = 'event: response.incomplete\ndata: {"type":"response.incomplete"}\n\n';
    expect(runStream({ protocol: "responses", stream: true }, input)).toEqual({
      complete: false,
      reason: "error_event",
    });
  });

  test("error event => incomplete", () => {
    const input = 'event: error\ndata: {"type":"error","code":"x"}\n\n';
    expect(runStream({ protocol: "responses", stream: true }, input)).toEqual({
      complete: false,
      reason: "error_event",
    });
  });

  test("truncated before response.completed => incomplete", () => {
    const input = responsesSseFixture.split("event: response.completed")[0] ?? "";
    expect(runStream({ protocol: "responses", stream: true }, input).complete).toBe(false);
  });
});

describe("responses JSON tap", () => {
  test("complete", () => {
    expect(runStream({ protocol: "responses", stream: false }, responsesJsonFixture)).toEqual(
      completeResponses,
    );
  });

  test("status not completed => incomplete", () => {
    const body = JSON.parse(responsesJsonFixture);
    body.status = "in_progress";
    expect(runStream({ protocol: "responses", stream: false }, JSON.stringify(body)).complete).toBe(
      false,
    );
  });
});

describe("usage validation", () => {
  test("negative prompt_tokens => invalid_usage", () => {
    const body = JSON.parse(chatJsonFixture);
    body.usage.prompt_tokens = -1;
    expect(runStream({ protocol: "chat", stream: false }, JSON.stringify(body))).toEqual({
      complete: false,
      reason: "invalid_usage",
    });
  });

  test("non-integer tokens => invalid_usage", () => {
    const body = JSON.parse(chatJsonFixture);
    body.usage.completion_tokens = 1.5;
    expect(runStream({ protocol: "chat", stream: false }, JSON.stringify(body)).complete).toBe(
      false,
    );
  });

  test("unsafe number => invalid_usage", () => {
    const body = JSON.parse(chatJsonFixture);
    body.usage.prompt_tokens = 2 ** 53;
    expect(runStream({ protocol: "chat", stream: false }, JSON.stringify(body)).complete).toBe(
      false,
    );
  });

  test("cached > input => invalid_usage", () => {
    const body = JSON.parse(responsesJsonFixture);
    body.usage.input_tokens_details.cached_tokens = 99;
    expect(runStream({ protocol: "responses", stream: false }, JSON.stringify(body))).toEqual({
      complete: false,
      reason: "invalid_usage",
    });
  });

  test("reasoning > output => invalid_usage", () => {
    const body = JSON.parse(responsesJsonFixture);
    body.usage.output_tokens_details.reasoning_tokens = 99;
    expect(runStream({ protocol: "responses", stream: false }, JSON.stringify(body)).complete).toBe(
      false,
    );
  });
});
