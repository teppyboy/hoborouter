// Chat page SSR regression: empty state renders without suggestion chips and
// keeps the workspace usage notice, composer, and history affordance.
import { test, expect, afterAll } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// lib/auth runs createAuthClient (window.location.origin) at module load;
// stub a minimal window so the SSR render can import the page. The previous
// globalThis descriptors are restored in afterAll so this file never leaks a
// stub window/localStorage into later files sharing the bun worker.
const g = globalThis as { window?: unknown; localStorage?: unknown };
const previousWindow = Object.getOwnPropertyDescriptor(g, "window");
const previousLocalStorage = Object.getOwnPropertyDescriptor(g, "localStorage");
g.window ??= { location: { origin: "http://localhost" } };
// The chat page imports the persisted hbr-locale store at module load; stub
// localStorage so the persist middleware has storage in this SSR-only file.
g.localStorage ??= {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
const { ChatPage } = await import("../apps/web/src/pages/chat");

afterAll(() => {
  if (previousWindow) Object.defineProperty(g, "window", previousWindow);
  else delete g.window;
  if (previousLocalStorage) Object.defineProperty(g, "localStorage", previousLocalStorage);
  else delete g.localStorage;
});

function render(): string {
  const qc = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ChatPage />
    </QueryClientProvider>,
  );
}

test("ChatPage SSR renders a centered empty state without suggestion chips", () => {
  const html = render();
  expect(html).toContain("What would you like to build?");
  expect(html).not.toContain("Help me write a debounce function");
  expect(html).not.toContain("Explain how HTTP streaming works");
  expect(html).not.toContain("Debug why my React component renders twice");
  expect(html).toContain('aria-label="Model"');
  expect(html).toContain('aria-label="Message"');
});

test("ChatPage SSR carries the managed-key reuse notice", () => {
  const html = render();
  // Reuse-first contract: a browser-stored key is reused; a new one is minted
  // only once, never automatically on render.
  expect(html).toContain("stored in this browser");
  expect(html).toContain("Chat - iPhone");
  expect(html).toContain("created only once");
  // First-use discoverability: the empty state names the attachment affordance.
  expect(html).toContain("Use the paperclip to attach images or text files");
  // Charging is disclosed on the empty state, not just mid-conversation.
  expect(html).toContain("Usage is charged to your selected workspace.");
});

test("ChatPage SSR renders no manual key UI and no Connect button", () => {
  const html = render();
  // The manual pasted-key path was removed entirely (managed key only):
  // neither the Advanced section nor any key input may exist in the markup.
  expect(html).not.toContain("Advanced: use your own API key");
  expect(html).not.toContain('id="chat-api-key"');
  expect(html).not.toContain('aria-label="Connect chat key"');
});

test("ChatPage SSR exposes the file attachment control", () => {
  const html = render();
  expect(html).toContain('aria-label="Attach files"');
});

test("ChatPage SSR exposes the toolbar with accessible control labels", () => {
  const html = render();
  // Group semantics (no roving-tabindex toolbar contract) plus per-control
  // accessible names (icon-only on phones still carries aria-label + title;
  // Connect is absent without a session, so it is E2E-asserted, not
  // SSR-asserted).
  expect(html).toContain('role="group"');
  expect(html).toContain('aria-label="Chat controls"');
  expect(html).toContain('aria-label="Conversation history"');
  expect(html).toContain('title="Conversation history"');
  expect(html).toContain('aria-label="New chat"');
  expect(html).toContain('title="New chat"');
});

test("ChatPage SSR preserves E2E-facing labels and never leaks a key", () => {
  const html = render();
  expect(html).toContain('id="chat-model"');
  expect(html).toContain("New chat");
  expect(html).toContain('aria-label="Message"');
  expect(html).toContain('aria-label="Send message"');
  // "Stop generating" and the "Conversation" log only exist mid-stream /
  // mid-conversation, so they are not assertable in static empty-state markup.
  // No pasted/remembered key or fake messages may appear (only the sk-hbr-
  // placeholder hint is allowed).
  expect(html).not.toMatch(/sk-hbr-[A-Za-z0-9]{8,}/);
});

test("ChatPage SSR keeps conversation history in the chat pane: desktop sidebar + phone sheet trigger", () => {
  // The sidebar collapse pref is a device UI pref persisted in localStorage;
  // this SSR contract is about the DEFAULT (expanded) rendering.
  globalThis.localStorage?.removeItem?.("chat.sidebar.collapsed");
  const html = render();
  // Phone sheet trigger (History button) and the desktop list shell both
  // render; the list itself is empty server-side (no session), never fake.
  expect(html).toContain('aria-label="Conversation history"');
  expect(html).toContain("Conversation history");
  expect(html).toContain("No conversations yet.");
  // No fabricated history rows and no delete control anywhere (archive is
  // the only lifetime action for saved conversations).
  expect(html).not.toContain("Delete");
});
