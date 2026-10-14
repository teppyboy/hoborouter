// SSE parser (apps/web/src/pages/chat/sse.ts): additive typed top-level
// usage and mid-stream error events, without changing the existing
// content/reasoning/model/[DONE] protocol contract.
// - usage: only a complete, finite {prompt_tokens, completion_tokens,
//   total_tokens} object is trusted; the LAST valid one wins (final chunk).
// - error: first top-level error message is kept; already-streamed content
//   and the captured model are preserved; the parser never throws.
import { describe, test, expect } from "bun:test";
import { createSseParser } from "../apps/web/src/pages/chat/sse";

const data = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

describe("sse parser usage + stream error", () => {
  test("captures a valid top-level usage object; malformed usage ignored", () => {
    const p = createSseParser();
    p.push(data({ choices: [{ delta: { content: "hi" } }] }));
    expect(p.usage).toBeNull();
    p.push(data({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    expect(p.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    // Partial/malformed usage objects are never coerced into fake numbers.
    p.push(data({ usage: { prompt_tokens: "x", completion_tokens: 5 } }));
    expect(p.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  test("last valid usage wins (final usage chunk semantics)", () => {
    const p = createSseParser();
    p.push(data({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    p.push(data({ usage: { prompt_tokens: 9, completion_tokens: 8, total_tokens: 17 } }));
    expect(p.usage).toEqual({ prompt_tokens: 9, completion_tokens: 8, total_tokens: 17 });
  });

  test("mid-stream error event: message kept, streamed content/model preserved", () => {
    const p = createSseParser();
    p.push(data({ model: "public-model-a", choices: [{ delta: { content: "partial" } }] }));
    p.push(data({ error: { message: "upstream exploded" } }));
    expect(p.error).toBe("upstream exploded");
    expect(p.model).toBe("public-model-a");
    const deltas = p.push(data({ choices: [{ delta: { content: " more" } }] }));
    expect(deltas).toEqual([{ content: " more", reasoning: "" }]);
    expect(p.done).toBe(false); // an error event is not [DONE]
  });

  test("string error payload accepted; [DONE] still terminates", () => {
    const p = createSseParser();
    p.push(data({ error: "plain failure" }));
    expect(p.error).toBe("plain failure");
    p.push(data({ choices: [{ delta: { content: "x" } }] }));
    p.push("data: [DONE]\n\n");
    expect(p.done).toBe(true);
  });

  test("regression: content/reasoning deltas and model capture unchanged", () => {
    const p = createSseParser();
    const out = p.push(
      'data: {"model":"m1","choices":[{"delta":{"content":"a"}}]}\n' +
        'data: {"choices":[{"delta":{"reasoning_content":"r"}}]}\n\n',
    );
    expect(out).toEqual([
      { content: "a", reasoning: "" },
      { content: "", reasoning: "r" },
    ]);
    expect(p.model).toBe("m1");
    expect(p.error).toBeNull();
    expect(p.usage).toBeNull();
  });
});
