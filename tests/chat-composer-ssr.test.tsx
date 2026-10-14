// Composer module contracts on the mounted page level: the send-key rule
// (Enter sends, Shift+Enter newline, Cmd/Ctrl+Enter sends) and the SSR
// welcome-independent Advanced disclosure carrying scope/billing/attachment
// copy, plus controlled attachment chips rendering. jsdom is not needed —
// the key rule is a pure helper and the disclosure is assertable via SSR
// markup (native hidden region renders its content).
import { test, expect, afterAll } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComposerDraft } from "../apps/web/src/pages/chat/composer";

// The composer imports the persisted hbr-locale store at module load; stub a
// minimal window/localStorage so the import works without a browser, then
// restore so later test files in this worker are unaffected.
const g = globalThis as {
  window?: unknown;
  localStorage?: unknown;
  sessionStorage?: unknown;
};
const previousWindow = Object.getOwnPropertyDescriptor(g, "window");
const previousLocalStorage = Object.getOwnPropertyDescriptor(g, "localStorage");
const previousSessionStorage = Object.getOwnPropertyDescriptor(g, "sessionStorage");
g.window ??= { location: { origin: "http://localhost" } };
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.sessionStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { isSendKeydown, Composer } = await import(
  "../apps/web/src/pages/chat/composer"
);

afterAll(() => {
  for (const [key, prev] of [
    ["window", previousWindow],
    ["localStorage", previousLocalStorage],
    ["sessionStorage", previousSessionStorage],
  ] as const) {
    if (prev) Object.defineProperty(g, key, prev);
    else delete g[key];
  }
});

function key(input: {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}): { key: string; shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } {
  return input;
}

test("send keys: Enter sends, Shift+Enter newlines, Cmd/Ctrl+Enter sends", () => {
  expect(isSendKeydown(key({ key: "Enter" }))).toBe(true);
  expect(isSendKeydown(key({ key: "Enter", shiftKey: true }))).toBe(false);
  expect(isSendKeydown(key({ key: "Enter", metaKey: true, shiftKey: true }))).toBe(true);
  expect(isSendKeydown(key({ key: "Enter", ctrlKey: true }))).toBe(true);
  expect(isSendKeydown(key({ key: "a", metaKey: true }))).toBe(false);
});

function fakeDraft(): ComposerDraft {
  return {
    input: "",
    attachments: [],
    attachmentsRef: { current: [] },
    attachError: null,
    readingFiles: false,
    textareaRef: { current: null },
    setInput: () => {},
    applyAttachments: () => {},
    clearAttachments: () => {},
    clearAttachError: () => {},
    bump: () => {},
    revision: () => 0,
    focus: () => {},
    handleFiles: () => {},
  };
}

function renderComposer(extra?: {
  attachments?: { id: string; kind: "text"; name: string; bytes: number }[];
}) {
  return renderToStaticMarkup(
    <Composer
      draft={fakeDraft()}
      placeholder="Send a message…"
      streaming={false}
      canSend={true}
      onSend={() => {}}
      onStop={() => {}}
      {...extra}
    />,
  );
}

test("SSR composer carries the Advanced disclosure with scope/billing/attachment copy", () => {
  const html = renderComposer();
  // Advanced toggle + collapsed-but-present disclosure region (renders
  // outside the welcome wall: it exists whether or not the wall shows).
  expect(html).toContain('aria-label="Advanced"');
  expect(html).toContain('id="composer-advanced"');
  expect(html).toContain("Usage is charged to your selected workspace.");
  expect(html).toContain("PNG, JPEG, WebP or GIF images");
});

test("SSR composer renders controlled attachment chips when provided", () => {
  const html = renderComposer({
    attachments: [{ id: "a1", kind: "text", name: "notes.md", bytes: 12 }],
  });
  expect(html).toContain("notes.md");
});
