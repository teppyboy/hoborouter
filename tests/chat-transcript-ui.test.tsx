// Transcript experience (apps/web/src/pages/chat/transcript.tsx): SSR-contract
// render tests of the extracted conversation log. Covers the new behavior:
// - Turn actions (edit / fork / regenerate) render ONLY on completed turns,
//   each carrying its explicit PAID-generation hint — the presenter itself
//   never generates.
// - Attachment ref chips render with name/size; expired refs show the expired
//   notice and never become interactive preview buttons.
// - Accessibility: live region OFF + aria-busy while streaming (no per-token
//   announcements); ONE polite completion status node.
// - Long live streams (>64 KiB) degrade to exact plain text (markdown engine
//   skipped on the hot path); terminal render restores markdown.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

// ChatMarkdown (marked + DOMPurify) needs a DOM; same setup as
// tests/chat-markdown-engine.test.tsx, restored afterwards.
const GLOBAL_KEYS = ["window", "document", "Node", "Element", "DOMParser"] as const;
const originals: Partial<Record<(typeof GLOBAL_KEYS)[number], PropertyDescriptor | undefined>> = {};
let jsdomWindow: { close: () => void } | null = null;

beforeAll(() => {
  const win = new JSDOM("", { url: "http://localhost:5173" }).window as unknown as {
    document: object;
    Node: object;
    Element: object;
    DOMParser: unknown;
    close: () => void;
  };
  for (const k of GLOBAL_KEYS) originals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  const values: Record<string, unknown> = {
    window: win,
    document: win.document,
    Node: win.Node,
    Element: win.Element,
    DOMParser: win.DOMParser,
  };
  for (const [k, v] of Object.entries(values)) (globalThis as Record<string, unknown>)[k] = v;
  jsdomWindow = win;
});

afterAll(() => {
  for (const k of GLOBAL_KEYS) {
    const d = originals[k];
    if (d) Object.defineProperty(globalThis, k, d);
  }
  jsdomWindow?.close();
});

const { Transcript } = await import("../apps/web/src/pages/chat/transcript");
import type { TurnMessage } from "../apps/web/src/pages/chat/turn";

const user = (content: string, attachments?: TurnMessage["attachments"]): TurnMessage => ({
  role: "user",
  content,
  reasoning: "",
  ...(attachments ? { attachments } : {}),
});

const assistant = (content: string, model = "public-model-a"): TurnMessage => ({
  role: "assistant",
  content,
  reasoning: "",
  model,
});

const base = (over: Partial<Parameters<typeof Transcript>[0]> = {}) => ({
  messages: [user("hello"), assistant("hi there")] as TurnMessage[],
  streaming: false,
  onForkTurn: () => {},
  onEditTurn: () => {},
  onRegenerateTurn: () => {},
  onPreviewAttachment: () => {},
  ...over,
});

test("completed turns expose edit/fork/regenerate with explicit PAID hints", () => {
  const html = renderToStaticMarkup(<Transcript {...base()} />);
  expect(html).toContain("Edit message");
  expect(html).toContain("Fork from here");
  expect(html).toContain("Regenerate reply");
  // Paid generation is explicit on every turn action, never hidden.
  expect(html).toContain("PAID generation");
});

test("streaming tail hides turn actions; earlier completed turns keep them", () => {
  const html = renderToStaticMarkup(
    <Transcript
      {...base({
        messages: [user("hello"), assistant("hi"), user("again"), assistant("")] as TurnMessage[],
        streaming: true,
      })}
    />,
  );
  // Only the in-flight tail lacks actions: exactly one completed assistant
  // turn carries the regenerate label, and the empty tail shows the thinking
  // indicator with no action row.
  expect(html).toContain("Thinking…");
  expect((html.match(/Regenerate reply/g) ?? []).length).toBe(1);
});

test("a11y: live OFF + aria-busy while streaming, polite + one status when idle", () => {
  const idle = renderToStaticMarkup(<Transcript {...base()} />);
  expect(idle).toContain('aria-live="polite"');
  expect(idle).not.toContain("aria-busy");
  const busy = renderToStaticMarkup(<Transcript {...base({ streaming: true })} />);
  expect(busy).toContain('aria-live="off"');
  expect(busy).toContain("aria-busy");
  // Exactly one polite completion-status node exists.
  expect(idle.split('role="status"').length - 1).toBe(1);
});

test("attachment chips: live refs preview via callback, expired refs never interactive", () => {
  const now = Date.now();
  const msgs = [
    user("with files", [
      { id: "a1", name: "photo.png", kind: "image", bytes: 2048, mime: "image/png", expires_at: now + 60_000 },
      { id: "a2", name: "notes.txt", kind: "text", bytes: 12, mime: "text/plain", expires_at: now - 1 },
    ]),
  ] as TurnMessage[];
  const withPreview = renderToStaticMarkup(
    <Transcript {...base({ messages: msgs, onForkTurn: undefined, onEditTurn: undefined, onRegenerateTurn: undefined })} />,
  );
  expect(withPreview).toContain("photo.png");
  expect(withPreview).toContain("2 KB");
  expect(withPreview).toContain("Expired");
  expect(withPreview).toContain("<button");
  // Without a preview callback nothing is interactive — no transcript-owned
  // file fetching, no arbitrary file URL.
  const noPreview = renderToStaticMarkup(
    <Transcript
      {...base({
        messages: msgs,
        onForkTurn: undefined,
        onEditTurn: undefined,
        onRegenerateTurn: undefined,
        onPreviewAttachment: undefined,
      })}
    />,
  );
  expect(noPreview).toContain("Expired");
  expect(noPreview).not.toContain("<button");
});

test("live stream beyond 64 KiB renders exact plain text; terminal restores markdown", () => {
  const big = "# Heading\n\n" + "x".repeat(70 * 1024);
  const live = renderToStaticMarkup(
    <Transcript {...base({ messages: [user("q"), assistant(big)] as TurnMessage[], streaming: true })} />,
  );
  // Exact text preserved (no markdown engine rewrite), no parsed heading tag.
  expect(live).toContain("# Heading");
  expect(live).not.toContain("<h1");
  const done = renderToStaticMarkup(
    <Transcript {...base({ messages: [user("q"), assistant("# Heading")] as TurnMessage[] })} />,
  );
  expect(done).toContain("<h1");
});
