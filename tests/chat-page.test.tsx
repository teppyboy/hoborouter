// Chat page SSR regression: the empty state must render server-side (no
// window, no fetch) and explain how to get a key and a model.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatPage } from "../apps/web/src/pages/chat";

function render(): string {
  return renderToStaticMarkup(<ChatPage />);
}

test("ChatPage SSR renders the empty state with key + model guidance", () => {
  const html = render();
  expect(html).toContain("Chat");
  expect(html).toContain("API key");
  expect(html).toContain("Start a conversation");
  // Empty state points at the API keys page; no pasted/remembered key or fake
  // messages may appear (only the sk-hbr- placeholder hint is allowed).
  expect(html).toContain("/keys");
  expect(html).not.toMatch(/sk-hbr-[A-Za-z0-9]{8,}/);
});
