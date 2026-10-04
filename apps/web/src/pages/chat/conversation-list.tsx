// Conversation history list for the chat page. Desktop: a sidebar rendered
// inside the chat pane; phone: a Sheet owned here (not the global app nav
// drawer). Data is private per user+workspace — the server only ever returns
// this identity's active conversations (archived rows are retained
// server-side but never listed, and there is deliberately no delete control:
// archive is the only lifetime action). Cursor pagination is honest: a
// "Load more" button appears only when the server returned a cursor — no
// fabricated counts. No API key is ever rendered here: rows carry title,
// timestamp and id only.
import * as React from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, Pencil } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { formatDate } from "../../lib/format";
import {
  archiveConversation,
  ConversationError,
  getConversation,
  listConversations,
  saveConversation,
  type ConversationSummary,
} from "./conversations";

// Single spelling of the history-list query key, shared with the chat page
// so a successful create/save there can invalidate the exact same key.
export const conversationListKey = (userId: string, workspaceId: string) => [
  "chat-conversations",
  "list",
  userId,
  workspaceId,
];

function actionErrorMessage(e: unknown): string {
  if (e instanceof ConversationError) {
    if (e.kind === "conflict")
      return "This conversation changed elsewhere. Reload the list and try again.";
    if (e.kind === "unauthorized" || e.kind === "forbidden")
      return "Your session expired. Sign in again.";
    if (e.kind === "notFound") return "This conversation no longer exists for you.";
  }
  return "The action failed. Try again.";
}

export function ConversationList({
  userId,
  workspaceId,
  activeChatId,
  onOpen,
  onClose,
  onRenamed,
  onArchive,
}: {
  userId: string;
  workspaceId: string;
  activeChatId: string | null;
  onOpen: (chatId: string) => void;
  /** Called after a row action so a phone Sheet can close itself. */
  onClose?: () => void;
  /** Rename bumped the server version: the chat page updates the active
   *  conversation's tracked version so its next turn save never 409s. */
  onRenamed?: (info: { chatId: string; version: number }) => void;
  /** Archive succeeded: the chat page blanks the view if this was the
   *  active conversation (archived history must not stay on screen). */
  onArchive?: (chatId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [renaming, setRenaming] = React.useState<ConversationSummary | null>(null);
  const [renameTitle, setRenameTitle] = React.useState("");

  const list = useInfiniteQuery({
    queryKey: conversationListKey(userId, workspaceId),
    queryFn: ({ pageParam }) => listConversations(workspaceId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    // Only fetch for a fully-resolved identity; avoids 401/403 noise during
    // logout/login or workspace switches.
    enabled: userId !== "" && workspaceId !== "",
    retry: false,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: conversationListKey(userId, workspaceId) });

  // Rename is a read-modify-write through the same optimistic-version PUT the
  // chat page saves with: a concurrent change surfaces as an explicit 409,
  // never a silent overwrite.
  const rename = useMutation({
    mutationFn: async ({ chatId, title }: { chatId: string; title: string }) => {
      const snap = await getConversation(workspaceId, chatId);
      return saveConversation(workspaceId, chatId, {
        version: snap.version,
        title,
        model: snap.model,
        messages: snap.messages,
      });
    },
    onSuccess: (snap, { chatId }) => {
      setRenaming(null);
      onRenamed?.({ chatId, version: snap.version });
      void invalidate();
    },
    onError: (e) => setActionError(actionErrorMessage(e)),
  });

  // Soft archive only — the server retains the row; there is no delete
  // endpoint and no delete control here on purpose.
  const archive = useMutation({
    mutationFn: (chatId: string) => archiveConversation(workspaceId, chatId),
    onSuccess: (_data, chatId) => {
      onArchive?.(chatId);
      void invalidate();
    },
    onError: (e) => setActionError(actionErrorMessage(e)),
  });

  function startRename(c: ConversationSummary) {
    setRenaming(c);
    setRenameTitle(c.title);
    setActionError(null);
  }

  function submitRename() {
    if (!renaming) return;
    const title = renameTitle.trim();
    if (!title) return;
    rename.mutate({ chatId: renaming.id, title: title.slice(0, 120) });
  }

  const items = list.data?.pages.flatMap((p) => p.data) ?? [];
  const resolved = userId !== "" && workspaceId !== "";
  const idle = !list.isLoading && !list.isError;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <h2 className="sr-only">Conversation history</h2>
      {list.isError ? (
        <p className="px-2 py-4 text-sm text-muted-foreground">
          Could not load your conversations.{" "}
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={() => void list.refetch()}
          >
            Retry
          </Button>
        </p>
      ) : list.isLoading ? (
        <p className="px-2 py-4 text-sm text-muted-foreground">Loading conversations…</p>
      ) : !resolved || items.length === 0 ? (
        <p className="px-2 py-4 text-sm text-muted-foreground">No conversations yet.</p>
      ) : (
        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto" aria-label="Conversations">
          {items.map((c) => (
            <li key={c.id} className="group relative">
              <button
                type="button"
                aria-current={c.id === activeChatId ? "true" : undefined}
                onClick={() => {
                  onOpen(c.id);
                  onClose?.();
                }}
                className="w-full rounded-md px-2 py-2 pr-14 text-left hover:bg-accent focus-visible:bg-accent"
              >
                <span className="block truncate text-sm font-medium">{c.title}</span>
                <span className="block text-xs text-muted-foreground">
                  {formatDate(c.updated_at)}
                </span>
              </button>
              <div className="absolute top-1/2 right-1 flex -translate-y-1/2 gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={`Rename conversation: ${c.title}`}
                  onClick={() => startRename(c)}
                >
                  <Pencil className="size-3.5" aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={`Archive conversation: ${c.title}`}
                  disabled={archive.isPending}
                  onClick={() => {
                    setActionError(null);
                    archive.mutate(c.id);
                  }}
                >
                  <Archive className="size-3.5" aria-hidden />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Honest pagination: only when the server returned a real cursor. */}
      {idle && list.hasNextPage && (
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {list.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      )}
      {actionError && <p className="px-2 py-2 text-xs text-destructive">{actionError}</p>}

      {/* Rename: explicit dialog, literal title only (never AI-generated). */}
      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename conversation</DialogTitle>
            <DialogDescription>
              A short label for your history. At most 120 characters.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="conversation-rename-title">Title</Label>
            <Input
              id="conversation-rename-title"
              value={renameTitle}
              maxLength={120}
              onChange={(e) => setRenameTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitRename();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!renameTitle.trim() || rename.isPending}
              onClick={submitRename}
            >
              {rename.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
