// SSE model capture: the parser records the FIRST non-empty top-level string
// `model` from data payloads (the gateway delivers the public ID there) and
// exposes it; later chunks never override it, and non-string/empty values are
// ignored. Pure parser, no DOM, no network.
import { test, expect } from "bun:test";
import { createSseParser } from "../apps/web/src/pages/chat/sse";

const dataLine = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

test("captures the top-level model from a data payload", () => {
  const p = createSseParser();
  expect(p.model).toBeNull();
  p.push(dataLine({ model: "test/model", choices: [{ delta: { content: "Hi" } }] }));
  expect(p.model).toBe("test/model");
});

test("first non-empty model wins; later chunks never override", () => {
  const p = createSseParser();
  p.push(dataLine({ model: "test/model", choices: [{ delta: { content: "a" } }] }));
  p.push(dataLine({ model: "other/model", choices: [{ delta: { content: "b" } }] }));
  expect(p.model).toBe("test/model");
});

test("empty and non-string model values are ignored until a real one arrives", () => {
  const p = createSseParser();
  p.push(dataLine({ model: "", choices: [{ delta: { content: "a" } }] }));
  expect(p.model).toBeNull();
  p.push(dataLine({ model: 42, choices: [{ delta: { content: "b" } }] }));
  expect(p.model).toBeNull();
  p.push(dataLine({ model: null, choices: [{ delta: { content: "c" } }] }));
  expect(p.model).toBeNull();
  p.push(dataLine({ model: "test/model", choices: [{ delta: { content: "d" } }] }));
  expect(p.model).toBe("test/model");
});

test("model is captured across chunk splits and from non-delta payloads", () => {
  const p = createSseParser();
  // Split the first data line mid-JSON.
  const full = dataLine({ model: "test/model", choices: [{ delta: { content: "Hi" } }] });
  expect(p.push(full.slice(0, 20))).toHaveLength(0);
  p.push(full.slice(20));
  expect(p.model).toBe("test/model");
  // A usage-only final chunk (no choices delta) still cannot override.
  p.push(dataLine({ model: "upstream/private", choices: [] }));
  expect(p.model).toBe("test/model");
});

test("no model anywhere leaves model null; malformed lines are ignored", () => {
  const p = createSseParser();
  p.push(dataLine({ choices: [{ delta: { content: "Hi" } }] }) + "data: not-json\n\n");
  expect(p.model).toBeNull();
});
