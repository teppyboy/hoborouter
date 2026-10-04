// Unit tests for the chat page's pure turn-transaction helpers: the terminal
// save payload (immutable snapshot of history + user turn + assistant partial)
// and the retry derivation (reuse the existing user turn — never duplicate it).
import { describe, expect, test } from "bun:test";
import {
  buildPersistMessages,
  findRetryTurn,
  isEmptyAssistant,
} from "../apps/web/src/pages/chat/turn";

const msg = (role: "user" | "assistant", content: string, reasoning = "") => ({
  role,
  content,
  reasoning,
});

describe("buildPersistMessages", () => {
  test("completed turn: base + user + assistant partial in one write", () => {
    const msgs = buildPersistMessages(
      [msg("user", "hi"), msg("assistant", "hello")],
      "next question",
      { content: "answer", reasoning: "thinking" },
    );
    expect(msgs).toEqual([
      msg("user", "hi"),
      msg("assistant", "hello"),
      msg("user", "next question"),
      msg("assistant", "answer", "thinking"),
    ]);
  });

  test("failed turn with empty partial: no blank assistant row is persisted", () => {
    const msgs = buildPersistMessages([], "hi", { content: "", reasoning: "" });
    expect(msgs).toEqual([msg("user", "hi")]);
  });

  test("stopped turn: reasoning-only partial is kept", () => {
    const msgs = buildPersistMessages([], "prompt", { content: "", reasoning: "half-thought" });
    expect(msgs).toEqual([msg("user", "prompt"), msg("assistant", "", "half-thought")]);
  });
});

describe("findRetryTurn", () => {
  test("reuses the existing user turn: base excludes it, userText is its content", () => {
    const turn = findRetryTurn([
      msg("user", "first"),
      msg("assistant", "first reply"),
      msg("user", "second"),
    ]);
    expect(turn).toEqual({
      baseMessages: [msg("user", "first"), msg("assistant", "first reply")],
      userText: "second",
    });
  });

  test("retry after a failed turn: empty assistant placeholders excluded from base", () => {
    const turn = findRetryTurn([msg("user", "only question"), msg("assistant", "", "")]);
    expect(isEmptyAssistant(msg("assistant", "", ""))).toBe(true);
    expect(turn).toEqual({ baseMessages: [], userText: "only question" });
  });

  test("retry after a stopped partial: the partial assistant is not re-sent", () => {
    const turn = findRetryTurn([msg("user", "q"), msg("assistant", "partial", "some reasoning")]);
    expect(turn).toEqual({ baseMessages: [], userText: "q" });
  });

  test("multi-turn retry picks the LAST user turn only", () => {
    const turn = findRetryTurn([
      msg("user", "a"),
      msg("assistant", "A"),
      msg("user", "b"),
      msg("assistant", "B"),
      msg("user", "c"),
    ]);
    expect(turn?.userText).toBe("c");
    expect(turn?.baseMessages).toHaveLength(4);
    expect(turn?.baseMessages.some((m) => m.content === "c")).toBe(false);
  });

  test("no user turn: null (nothing to regenerate)", () => {
    expect(findRetryTurn([])).toBeNull();
    expect(findRetryTurn([msg("assistant", "orphan reply")])).toBeNull();
  });
});
