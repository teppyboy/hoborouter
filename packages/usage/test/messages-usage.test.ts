// Anthropic Messages protocol usage tap: non-stream JSON usage (input +
// cache_creation + cache_read, output) and SSE stream usage from
// message_start / message_delta with message_stop completion (no [DONE]).
import { describe, expect, test } from "bun:test";
import { createUsageTap } from "../src/usage";

const enc = (s: string) => new TextEncoder().encode(s);

const messageJson = (usage: object | undefined) =>
  JSON.stringify({
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    stop_reason: "end_turn",
    ...(usage === undefined ? {} : { usage }),
  });

const sse = (...events: [string, object][]) =>
  events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");

const feed = (chunks: Uint8Array[], stream: boolean, protocol: "messages") => {
  const tap = createUsageTap({ protocol, stream });
  for (const c of chunks) tap.push(c);
  return tap.end();
};

describe("messages non-stream usage", () => {
  test("input + cache_creation + cache_read + output mapped to split", () => {
    const r = feed(
      [
        enc(
          messageJson({
            input_tokens: 1000,
            output_tokens: 100,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 50,
          }),
        ),
      ],
      false,
      "messages",
    );
    expect(r).toEqual({
      complete: true,
      usage: {
        inputTokens: 1200n,
        outputTokens: 100n,
        cachedInputTokens: 50n,
        reasoningTokens: 0n,
      },
    });
  });

  test("cache fields absent -> zero splits, no assumption", () => {
    const r = feed([enc(messageJson({ input_tokens: 10, output_tokens: 5 }))], false, "messages");
    expect(r).toEqual({
      complete: true,
      usage: { inputTokens: 10n, outputTokens: 5n, cachedInputTokens: 0n, reasoningTokens: 0n },
    });
  });

  test("missing usage -> missing_usage", () => {
    expect(feed([enc(messageJson(undefined))], false, "messages")).toEqual({
      complete: false,
      reason: "missing_usage",
    });
  });

  test("missing input_tokens -> missing_usage", () => {
    expect(feed([enc(messageJson({ output_tokens: 5 }))], false, "messages")).toEqual({
      complete: false,
      reason: "missing_usage",
    });
  });

  test("invalid usage -> invalid_usage", () => {
    expect(
      feed([enc(messageJson({ input_tokens: -1, output_tokens: 5 }))], false, "messages"),
    ).toEqual({
      complete: false,
      reason: "invalid_usage",
    });
  });
});

describe("messages stream usage", () => {
  const fullStream = () =>
    sse(
      [
        "message_start",
        {
          type: "message_start",
          message: {
            type: "message",
            usage: {
              input_tokens: 1000,
              output_tokens: 1,
              cache_creation_input_tokens: 200,
              cache_read_input_tokens: 50,
            },
          },
        },
      ] as [string, object],
      [
        "content_block_delta",
        { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
      ] as [string, object],
      [
        "message_delta",
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 100 },
        },
      ] as [string, object],
      ["message_stop", { type: "message_stop" }] as [string, object],
    );

  test("message_start input + message_delta output -> complete split", () => {
    const r = feed([enc(fullStream())], true, "messages");
    expect(r).toEqual({
      complete: true,
      usage: {
        inputTokens: 1200n,
        outputTokens: 100n,
        cachedInputTokens: 50n,
        reasoningTokens: 0n,
      },
    });
  });

  test("usage split across chunk boundaries still parses", () => {
    const s = fullStream();
    const mid = Math.floor(s.length / 2);
    const r = feed([enc(s.slice(0, mid)), enc(s.slice(mid))], true, "messages");
    expect(r.complete).toBe(true);
  });

  test("missing message_stop -> missing_stop", () => {
    const r = feed(
      [
        enc(
          sse(
            [
              "message_start",
              { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
            ],
            ["message_delta", { type: "message_delta", usage: { output_tokens: 5 } }],
          ),
        ),
      ],
      true,
      "messages",
    );
    expect(r).toEqual({ complete: false, reason: "missing_stop" });
  });

  test("no usage events -> missing_usage", () => {
    const r = feed(
      [
        enc(
          sse(
            ["message_start", { type: "message_start", message: { usage: {} } }],
            ["message_stop", { type: "message_stop" }],
          ),
        ),
      ],
      true,
      "messages",
    );
    expect(r).toEqual({ complete: false, reason: "missing_usage" });
  });

  test("error event -> error_event", () => {
    const r = feed(
      [
        enc(
          sse(
            [
              "message_start",
              { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
            ],
            [
              "error",
              { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
            ],
          ),
        ),
      ],
      true,
      "messages",
    );
    expect(r).toEqual({ complete: false, reason: "error_event" });
  });

  test("invalid usage in message_delta -> invalid_usage", () => {
    const r = feed(
      [
        enc(
          sse(
            [
              "message_start",
              { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
            ],
            ["message_delta", { type: "message_delta", usage: { output_tokens: "many" } }],
            ["message_stop", { type: "message_stop" }],
          ),
        ),
      ],
      true,
      "messages",
    );
    expect(r).toEqual({ complete: false, reason: "invalid_usage" });
  });

  test("abort -> reported reason", () => {
    const tap = createUsageTap({ protocol: "messages", stream: true });
    tap.push(enc("event: message_start\ndata: {}\n\n"));
    expect(tap.abort("client_abort")).toEqual({ complete: false, reason: "client_abort" });
  });
});
