// Pure SSE parser tests for the chat page: chunk splits, multiple events per
// chunk, [DONE] sentinel, reasoning deltas, malformed lines.
import { test, expect } from "bun:test";
import { createSseParser } from "../apps/web/src/pages/chat/sse";

const dataLine = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const chunk = (content: string) => dataLine({ choices: [{ delta: { content } }] });

test("reassembles a data line split across reads", () => {
  const p = createSseParser();
  const full = chunk("Hello");
  const mid = Math.floor(full.length / 2);
  expect(p.push(full.slice(0, mid))).toHaveLength(0); // partial line buffered
  expect(p.push(full.slice(mid))).toEqual([{ content: "Hello", reasoning: "" }]);
  expect(p.done).toBe(false);
});

test("handles a chunk boundary mid-JSON and mid-line", () => {
  const p = createSseParser();
  const full = `data: {"choices":[{"delta":{"content":"Hi"}}]}\ndata: [DONE]\n`;
  // Cut inside the JSON payload and inside the second "data: " prefix.
  expect(p.push(full.slice(0, 12))).toHaveLength(0);
  expect(p.push(full.slice(12, 52))).toEqual([{ content: "Hi", reasoning: "" }]);
  expect(p.push(full.slice(52))).toHaveLength(0);
  expect(p.done).toBe(true);
});

test("multiple events in a single chunk", () => {
  const p = createSseParser();
  const events = p.push(chunk("a") + chunk("b") + chunk("c"));
  expect(events.map((e) => e.content)).toEqual(["a", "b", "c"]);
});

test("[DONE] sets done and stops parsing further lines", () => {
  const p = createSseParser();
  p.push(chunk("x"));
  expect(p.push("data: [DONE]\n" + chunk("after-done"))).toHaveLength(0);
  expect(p.done).toBe(true);
});

test("reasoning_content deltas are surfaced separately from content", () => {
  const p = createSseParser();
  const events = p.push(
    dataLine({ choices: [{ delta: { reasoning_content: "thinking" } }] }) +
      dataLine({ choices: [{ delta: { content: "answer" } }] }),
  );
  expect(events).toEqual([
    { content: "", reasoning: "thinking" },
    { content: "answer", reasoning: "" },
  ]);
});

test("bare `reasoning` field is treated as reasoning_content", () => {
  const p = createSseParser();
  expect(p.push(dataLine({ choices: [{ delta: { reasoning: "why" } }] }))).toEqual([
    { content: "", reasoning: "why" },
  ]);
});

test("malformed data lines and non-data lines are ignored", () => {
  const p = createSseParser();
  const events = p.push(
    "data: {not json}\n" +
      "data: \n" +
      ": keep-alive comment\n" +
      "event: ping\n" +
      "garbage line\n" +
      dataLine({ choices: [{ delta: { role: "assistant" } }] }) + // role-only: no text
      chunk("ok"),
  );
  expect(events).toEqual([{ content: "ok", reasoning: "" }]);
  expect(p.done).toBe(false);
});

test("no trailing partial line is dropped; it flushes on the next push", () => {
  const p = createSseParser();
  expect(p.push(chunk("first"))).toEqual([{ content: "first", reasoning: "" }]);
  expect(p.push('data: {"choices":[{"delta":{"content":"se')).toHaveLength(0);
  expect(p.push('cond"}}]}\n\n')).toEqual([{ content: "second", reasoning: "" }]);
});
