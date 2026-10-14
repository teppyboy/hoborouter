// Conversation history list render contract: rows carry only title +
// timestamp (never messages, never any API key), the active conversation is
// marked, the only lifetime control is archive (no delete), rename/archive
// are explicit per-row actions, and "Load more" exists exactly when the
// server returned a real cursor — honest pagination, no fabricated counts.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConversationPage } from "../apps/web/src/pages/chat/conversations";

// listKey in conversation-list.tsx — the live query appends the debounced
// search term q; seeded data must use the q="" variant the list starts on.
const listKey = (userId: string, workspaceId: string) => [
  "chat-conversations",
  "list",
  userId,
  workspaceId,
  "",
];

function summary(id: string, title: string, updated_at: number) {
  return { id, title, model: null, version: 1, created_at: updated_at, updated_at };
}

function renderList(opts: {
  page?: ConversationPage;
  activeChatId?: string | null;
  resolvedIdentity?: boolean;
}): string {
  const qc = new QueryClient();
  if (opts.page) qc.setQueryData(listKey("u1", "ws1"), { pages: [opts.page], pageParams: [null] });
  const { ConversationList } = require("../apps/web/src/pages/chat/conversation-list") as {
    ConversationList: (props: Record<string, unknown>) => React.ReactElement;
  };
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ConversationList
        userId={opts.resolvedIdentity === false ? "" : "u1"}
        workspaceId={opts.resolvedIdentity === false ? "" : "ws1"}
        activeChatId={opts.activeChatId ?? null}
        onOpen={() => {}}
      />
    </QueryClientProvider>,
  );
}

test("renders saved conversations with title and updated timestamp, marks the active one", () => {
  const html = renderList({
    page: {
      data: [
        summary("chat-a", "Debounce function", 1700000000000),
        summary("chat-b", "Streaming question", 1700003600000),
      ],
      nextCursor: "1700000000000.chat-z",
    },
    activeChatId: "chat-b",
  });
  expect(html).toContain("Debounce function");
  expect(html).toContain("Streaming question");
  expect(html).not.toContain("Invalid Date");
  expect(html).toContain('aria-current="true"');
  // Rows never render message content or any key material.
  expect(html).not.toMatch(/sk-hbr-[A-Za-z0-9]{8,}/);
});

test("archive is the only lifetime control: rename + archive labels, no delete anywhere", () => {
  const html = renderList({
    page: { data: [summary("chat-a", "Debounce function", 1700000000000)], nextCursor: null },
  });
  expect(html).toContain('aria-label="Rename conversation: Debounce function"');
  expect(html).toContain('aria-label="Archive conversation: Debounce function"');
  expect(html).not.toContain("Delete");
});

test("Load more appears only when the server returned a cursor (honest pagination)", () => {
  const withCursor = renderList({
    page: { data: [summary("chat-a", "T1", 1700000000000)], nextCursor: "1.chat-x" },
  });
  expect(withCursor).toContain("Load more");
  const lastPage = renderList({
    page: { data: [summary("chat-a", "T1", 1700000000000)], nextCursor: null },
  });
  expect(lastPage).not.toContain("Load more");
});

test("unresolved identity renders an honest empty state (no fake rows)", () => {
  // With a resolved identity the list query is pending during SSR ("Loading
  // conversations…") — never fabricated rows.
  expect(renderList({ resolvedIdentity: false })).toContain("No conversations yet.");
});
