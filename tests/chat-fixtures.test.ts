// Behavior tests for the shared chat SSE fixture builders: every fixture must
// be a body the real SSE parser (apps/web/src/pages/chat/sse.ts) consumes with
// the documented semantics — exact accumulation, reasoning separated, usage
// and error events not surfaced as deltas, no-space spelling normalized.
import { describe, expect, it } from "bun:test";
import { createSseParser } from "../apps/web/src/pages/chat/sse";
import {
  completeStream,
  DONE,
  errorEvent,
  fencedCode,
  longContentStream,
  reasoningDelta,
  streamBody,
  usageChunk,
} from "./helpers/chat-fixtures";

const accumulate = (body: string, splitAt?: number[]) => {
  const p = createSseParser();
  let content = "";
  let reasoning = "";
  const feeds = splitAt
    ? [0, ...splitAt, body.length]
    : [0, Math.floor(body.length / 3), body.length];
  for (let i = 0; i < feeds.length - 1; i++) {
    for (const e of p.push(body.slice(feeds[i], feeds[i + 1]))) {
      content += e.content;
      reasoning += e.reasoning;
    }
  }
  return { content, reasoning, model: p.model, done: p.done };
};

describe("chat SSE fixtures", () => {
  it("completeStream accumulates content exactly and terminates", () => {
    const body = completeStream("Xin chào", { model: "public-model-a" });
    expect(body.endsWith(DONE)).toBe(true);
    const r = accumulate(body, [5, 11, 17]);
    expect(r.content).toBe("Xin chào");
    expect(r.model).toBe("public-model-a");
    expect(r.done).toBe(true);
  });

  it("longContentStream keeps every paragraph verbatim across many deltas", () => {
    const paragraphs = Array.from({ length: 40 }, (_, i) => `Đoạn ${i} — text`);
    const r = accumulate(longContentStream(paragraphs));
    expect(r.content).toBe(paragraphs.map((p) => `${p}\n\n`).join(""));
  });

  it("fenced code survives verbatim inside a stream", () => {
    const code = fencedCode("ts", "const x: number = 1;");
    const r = accumulate(completeStream(`Look:\n${code}\ndone`));
    expect(r.content).toContain("```ts\nconst x: number = 1;\n```");
  });

  it("reasoning deltas stay separate from content", () => {
    const body = streamBody(["answer"], { reasoning: "thinking" });
    const r = accumulate(body);
    expect(r.reasoning).toBe("thinking");
    expect(r.content).toBe("answer");
  });

  it("usage chunk is valid but yields no delta", () => {
    const body = completeStream("hi", {
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    });
    expect(usageChunk({ prompt_tokens: 1, completion_tokens: 2 })).toContain('"usage"');
    const r = accumulate(body);
    expect(r.content).toBe("hi");
    expect(body).toContain('"prompt_tokens":12');
  });

  it("error event carries the upstream message and stops the stream", () => {
    const body = errorEvent("upstream exploded");
    const r = accumulate(body);
    expect(r.content).toBe("");
    expect(r.done).toBe(true);
    expect(body).toContain('"message":"upstream exploded"');
  });

  it("no-space data lines are normalized by the parser", () => {
    const body = streamBody(["a", "b"], { noSpace: true });
    expect(body).toContain("data:{");
    const r = accumulate(body);
    expect(r.content).toBe("ab");
  });

  it("raw reasoningDelta line is parser-compatible", () => {
    const r = accumulate(reasoningDelta("step 1"));
    expect(r.reasoning).toBe("step 1");
  });
});
