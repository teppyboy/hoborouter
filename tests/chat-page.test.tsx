// Chat page SSR regression: the redesigned empty state must render
// server-side (no window beyond the module-load stub, no fetch) and carry the
// ChatGPT-style welcome contract: centered headline, the three real prompt
// chips, the managed-key ("Browser Chat") auto credentials notice, and the
// collapsed Advanced manual-key section (native <details>, so its summary is
// assertable without grepping CSS).
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// lib/auth runs createAuthClient (window.location.origin) at module load;
// stub a minimal window so the SSR render can import the page.
(globalThis as { window?: unknown }).window ??= { location: { origin: "http://localhost" } };
const { ChatPage } = await import("../apps/web/src/pages/chat");

function render(): string {
  const qc = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ChatPage />
    </QueryClientProvider>,
  );
}

test("ChatPage SSR renders the centered welcome with headline and prompt chips", () => {
  const html = render();
  expect(html).toContain("What would you like to build?");
  for (const chip of [
    "Help me write a debounce function in TypeScript.",
    "Explain how HTTP streaming works, end to end.",
    "Debug why my React component renders twice.",
  ]) {
    expect(html).toContain(chip);
  }
});

test("ChatPage SSR carries the managed-key auto credentials notice", () => {
  const html = render();
  expect(html).toContain("Browser Chat");
  expect(html).toContain("created automatically");
  // Charging is disclosed on the empty state, not just mid-conversation.
  expect(html).toContain("Usage is charged to your selected workspace.");
});

test("ChatPage SSR keeps manual key as a collapsed Advanced section", () => {
  const html = render();
  // Native <details> renders its content in SSR markup even when collapsed;
  // assert the summary exists rather than grepping for hidden-ness CSS.
  expect(html).toContain("<details");
  expect(html).toContain("Advanced: use your own API key");
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
