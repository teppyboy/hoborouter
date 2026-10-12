// Reasoning-split usage correctness (parity plan Task 2):
// - Anthropic output_tokens_details.thinking_tokens survives non-stream and
//   cumulative-stream usage extraction (billed as reasoning, subset of output).
// - Responses status "incomplete" with valid usage is a normal billed outcome
//   (stream event and non-stream body); missing usage still fails to full hold.
// - Full-hold behavior for missing/invalid splits is preserved.
import { describe, expect, test } from "bun:test";
import { createUsageTap, resolveBillableUsage } from "../packages/usage/src/usage";

const tapResult = (
  protocol: "chat" | "responses" | "messages",
  stream: boolean,
  chunks: string[],
) => {
  const tap = createUsageTap({ protocol, stream });
  for (const c of chunks) tap.push(new TextEncoder().encode(c));
  return tap.end();
};

const rates = {
  input: 1000000n,
  output: 2000000n,
  cachedInput: 500000n,
  // Distinct reasoning price HIGHER than output: exposes any 0-split bug.
  reasoning: 3000000n,
};

describe("messages thinking_tokens split", () => {
  test("non-stream usage with output_tokens_details.thinking_tokens is extracted", () => {
    const body = JSON.stringify({
      type: "message",
      usage: {
        input_tokens: 100,
        output_tokens: 150,
        output_tokens_details: { thinking_tokens: 40 },
      },
    });
    const r = tapResult("messages", false, [body]);
    expect(r).toEqual({
      complete: true,
      usage: {
        inputTokens: 100n,
        outputTokens: 150n,
        cachedInputTokens: 0n,
        reasoningTokens: 40n,
      },
    });
  });

  test("non-stream without the details object keeps reasoningTokens at 0n", () => {
    const body = JSON.stringify({
      type: "message",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const r = tapResult("messages", false, [body]);
    expect(r.complete && r.usage.reasoningTokens).toBe(0n);
  });

  test("thinking_tokens above output_tokens is invalid usage (full hold)", () => {
    const body = JSON.stringify({
      type: "message",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        output_tokens_details: { thinking_tokens: 6 },
      },
    });
    const r = tapResult("messages", false, [body]);
    expect(r).toEqual({ complete: false, reason: "invalid_usage" });
    expect(resolveBillableUsage(r, rates).billable).toBe(false);
  });

  test("stream: cumulative message_delta carries thinking_tokens", () => {
    const ev = (name: string, data: object) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    const sse =
      ev("message_start", {
        type: "message_start",
        message: { usage: { input_tokens: 100, output_tokens: 1 } },
      }) +
      ev("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: {
          output_tokens: 150,
          output_tokens_details: { thinking_tokens: 40 },
        },
      }) +
      ev("message_stop", { type: "message_stop" });
    const r = tapResult("messages", true, [sse]);
    expect(r).toEqual({
      complete: true,
      usage: {
        inputTokens: 100n,
        outputTokens: 150n,
        cachedInputTokens: 0n,
        reasoningTokens: 40n,
      },
    });
  });

  test("stream without thinking_tokens stays 0n, not an assumption", () => {
    const ev = (name: string, data: object) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    const sse =
      ev("message_start", {
        type: "message_start",
        message: { usage: { input_tokens: 100, output_tokens: 1 } },
      }) +
      ev("message_delta", {
        type: "message_delta",
        delta: {},
        usage: { output_tokens: 150 },
      }) +
      ev("message_stop", { type: "message_stop" });
    const r = tapResult("messages", true, [sse]);
    expect(r.complete && r.usage.reasoningTokens).toBe(0n);
  });

  test("extracted thinking split bills the reasoning rate on the split only", () => {
    const billable = resolveBillableUsage(
      {
        complete: true,
        usage: {
          inputTokens: 100n,
          outputTokens: 150n,
          cachedInputTokens: 0n,
          reasoningTokens: 40n,
        },
      },
      rates,
    );
    expect(billable.billable).toBe(true);
    if (billable.billable) {
      expect(billable.usage.reasoningTokens).toBe(40n);
      expect(billable.usage.outputTokens).toBe(150n); // no double-count
      expect(billable.assumed).toBeUndefined();
    }
  });
});

describe("Responses incomplete is a billed outcome", () => {
  const incompleteBody = JSON.stringify({
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    usage: { input_tokens: 20, output_tokens: 30 },
  });

  test("non-stream status incomplete with usage completes", () => {
    const r = tapResult("responses", false, [incompleteBody]);
    expect(r).toEqual({
      complete: true,
      usage: {
        inputTokens: 20n,
        outputTokens: 30n,
        cachedInputTokens: null,
        reasoningTokens: null,
      },
    });
  });

  test("stream response.incomplete event with usage completes", () => {
    const sse =
      `data: ${JSON.stringify({
        type: "response.incomplete",
        response: {
          status: "incomplete",
          usage: { input_tokens: 20, output_tokens: 30 },
        },
      })}\n\n` + `data: {"type":"response.incomplete","sequence_number":12}\n\n`;
    const r = tapResult("responses", true, [sse]);
    expect(r).toEqual({
      complete: true,
      usage: {
        inputTokens: 20n,
        outputTokens: 30n,
        cachedInputTokens: null,
        reasoningTokens: null,
      },
    });
  });

  test("incomplete without usage stays missing_usage (full hold)", () => {
    const r = tapResult("responses", false, [
      JSON.stringify({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }),
    ]);
    expect(r).toEqual({ complete: false, reason: "missing_usage" });
  });

  test("incomplete with invalid usage stays invalid_usage (full hold)", () => {
    const r = tapResult("responses", false, [
      JSON.stringify({
        status: "incomplete",
        usage: {
          input_tokens: 20,
          output_tokens: 30,
          output_tokens_details: { reasoning_tokens: 31 },
        },
      }),
    ]);
    expect(r).toEqual({ complete: false, reason: "invalid_usage" });
  });

  test("stream response.failed still fails", () => {
    const sse = `data: ${JSON.stringify({ type: "response.failed", response: {} })}\n\n`;
    const r = tapResult("responses", true, [sse]);
    expect(r).toEqual({ complete: false, reason: "error_event" });
  });

  test("non-stream completed still completes (regression)", () => {
    const r = tapResult("responses", false, [
      JSON.stringify({
        status: "completed",
        usage: { input_tokens: 5, output_tokens: 6 },
      }),
    ]);
    expect(r.complete).toBe(true);
  });
});
