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
  listConversations,
  renameConversation,
  type ConversationSummary,
} from "./conversations";
import { useT, translate } from "../../lib/i18n/t";
import { useLocaleStore } from "../../lib/i18n/locale";

// Conversation-list copy: inline LocaleEntry set (see lib/i18n/common.ts).
const listCopy = {
  convHistory: { en: "Conversation history", vi: "Lịch sử hội thoại" },
  loadFailed: { en: "Could not load your conversations.", vi: "Không tải được hội thoại của bạn." },
  retry: { en: "Retry", vi: "Thử lại" },
  loading: { en: "Loading conversations…", vi: "Đang tải hội thoại…" },
  none: { en: "No conversations yet.", vi: "Chưa có hội thoại nào." },
  conversations: { en: "Conversations", vi: "Hội thoại" },
  renameAria: { en: "Rename conversation: {title}", vi: "Đổi tên hội thoại: {title}" },
  archiveAria: { en: "Archive conversation: {title}", vi: "Lưu trữ hội thoại: {title}" },
  loadMore: { en: "Load more", vi: "Tải thêm" },
  conflict: {
    en: "This conversation changed elsewhere. Reload the list and try again.",
    vi: "Hội thoại này đã thay đổi ở nơi khác. Hãy tải lại danh sách và thử lại.",
  },
  sessionExpired: {
    en: "Your session expired. Sign in again.",
    vi: "Phiên của bạn đã hết hạn. Đăng nhập lại.",
  },
  gone: {
    en: "This conversation no longer exists for you.",
    vi: "Hội thoại này không còn tồn tại với bạn.",
  },
  actionFailed: { en: "The action failed. Try again.", vi: "Thao tác thất bại. Thử lại." },
  searchLabel: { en: "Search history", vi: "Tìm trong lịch sử" },
  searchPlaceholder: { en: "Search titles…", vi: "Tìm theo tiêu đề…" },
  noMatches: {
    en: "No conversations match your search.",
    vi: "Không có hội thoại nào khớp tìm kiếm.",
  },
  today: { en: "Today", vi: "Hôm nay" },
  yesterday: { en: "Yesterday", vi: "Hôm qua" },
  renameTitle: { en: "Rename conversation", vi: "Đổi tên hội thoại" },
  renameDesc: {
    en: "A short label for your history. At most 120 characters.",
    vi: "Nhãn ngắn cho lịch sử của bạn. Tối đa 120 ký tự.",
  },
  titleLabel: { en: "Title", vi: "Tiêu đề" },
  cancel: { en: "Cancel", vi: "Huỷ" },
  saving: { en: "Saving…", vi: "Đang lưu…" },
  save: { en: "Save", vi: "Lưu" },
} as const;

function listActionErrorMessage(e: unknown): string {
  const locale = useLocaleStore.getState().locale;
  if (e instanceof ConversationError) {
    if (e.kind === "conflict") return translate(listCopy, "conflict", locale);
    if (e.kind === "unauthorized" || e.kind === "forbidden")
      return translate(listCopy, "sessionExpired", locale);
    if (e.kind === "notFound") return translate(listCopy, "gone", locale);
  }
  return translate(listCopy, "actionFailed", locale);
}

// Single spelling of the history-list query key, shared with the chat page
// so a successful create/save there can invalidate the exact same key.
export const conversationListKey = (userId: string, workspaceId: string) => [
  "chat-conversations",
  "list",
  userId,
  workspaceId,
];

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
  const t = useT(listCopy);
  const queryClient = useQueryClient();
  const locale = useLocaleStore((s) => s.locale);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [renaming, setRenaming] = React.useState<ConversationSummary | null>(null);
  const [renameTitle, setRenameTitle] = React.useState("");
  // Search text and the debounced value actually sent to the server (120ms).
  const [search, setSearch] = React.useState("");
  const [q, setQ] = React.useState("");
  React.useEffect(() => {
    const id = setTimeout(() => setQ(search.trim()), 120);
    return () => clearTimeout(id);
  }, [search]);

  const list = useInfiniteQuery({
    // q is part of the key: a new search starts a fresh first page (the old
    // cursor never leaks across queries), and the parent page's prefix
    // invalidation via conversationListKey still matches every variant.
    queryKey: [...conversationListKey(userId, workspaceId), q],
    queryFn: ({ pageParam, signal }) =>
      listConversations(workspaceId, pageParam, { q: q || undefined, signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    // Only fetch for a fully-resolved identity; avoids 401/403 noise during
    // logout/login or workspace switches.
    enabled: userId !== "" && workspaceId !== "",
    retry: false,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: conversationListKey(userId, workspaceId) });

  // Rename is a title-only PUT guarded by the tracked version: the transcript
  // is never downloaded or re-sent, and a concurrent change surfaces as an
  // explicit 409 instead of a silent overwrite.
  const rename = useMutation({
    mutationFn: ({ chatId, version, title }: { chatId: string; version: number; title: string }) =>
      renameConversation(workspaceId, chatId, { version, title }),
    onSuccess: ({ id, version }) => {
      setRenaming(null);
      onRenamed?.({ chatId: id, version });
      void invalidate();
    },
    onError: (e) => setActionError(listActionErrorMessage(e)),
  });

  // Soft archive only — the server retains the row; there is no delete
  // endpoint and no delete control here on purpose.
  const archive = useMutation({
    mutationFn: (chatId: string) => archiveConversation(workspaceId, chatId),
    onSuccess: (_data, chatId) => {
      onArchive?.(chatId);
      void invalidate();
    },
    onError: (e) => setActionError(listActionErrorMessage(e)),
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
    rename.mutate({ chatId: renaming.id, version: renaming.version, title: title.slice(0, 120) });
  }

  const items = list.data?.pages.flatMap((p) => p.data) ?? [];
  const resolved = userId !== "" && workspaceId !== "";
  const idle = !list.isLoading && !list.isError;

  // Day buckets for readable history grouping (local calendar days).
  const dayFormatter = new Intl.DateTimeFormat(locale === "vi" ? "vi-VN" : "en-US", {
    dateStyle: "medium",
  });
  const groups: { label: string; items: ConversationSummary[] }[] = [];
  let currentDay = "";
  for (const c of items) {
    const d = new Date(c.updated_at);
    const now = new Date();
    const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
    const label =
      dayDiff <= 0 ? t("today") : dayDiff === 1 ? t("yesterday") : dayFormatter.format(d);
    if (label !== currentDay) {
      groups.push({ label, items: [] });
      currentDay = label;
    }
    groups[groups.length - 1]?.items.push(c);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <h2 className="sr-only">{t("convHistory")}</h2>
      {/* Server-side title search: typing is debounced 120ms; the query key
          includes q so a new search always resets to the first page. */}
      <div className="px-2 pb-2">
        <Label className="sr-only" htmlFor="conversation-search">
          {t("searchLabel")}
        </Label>
        <Input
          id="conversation-search"
          type="search"
          value={search}
          placeholder={t("searchPlaceholder")}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {list.isError ? (
        <p className="px-2 py-4 text-sm text-muted-foreground">
          {t("loadFailed")}{" "}
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={() => void list.refetch()}
          >
            {t("retry")}
          </Button>
        </p>
      ) : list.isLoading ? (
        <p className="px-2 py-4 text-sm text-muted-foreground">{t("loading")}</p>
      ) : (!resolved || items.length === 0) && q === "" ? (
        <p className="px-2 py-4 text-sm text-muted-foreground">{t("none")}</p>
      ) : items.length === 0 ? (
        // A resolved identity with an active search that found nothing is a
        // distinct state from "no conversations yet" — never conflated.
        <p className="px-2 py-4 text-sm text-muted-foreground">{t("noMatches")}</p>
      ) : (
        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto" aria-label={t("conversations")}>
          {groups.map((g) => (
            <li key={g.label} className="group relative">
              <div aria-hidden className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                {g.label}
              </div>
              <ul>
                {g.items.map((c) => (
                  <li key={c.id} className="relative">
                    <button
                      type="button"
                      aria-current={c.id === activeChatId ? "true" : undefined}
                      onClick={() => {
                        onOpen(c.id);
                        onClose?.();
                      }}
                      className="w-full rounded-md px-2 py-2 pr-20 text-left hover:bg-accent focus-visible:bg-accent"
                    >
                      <span className="block truncate text-sm font-medium">{c.title}</span>
                      <span className="block text-xs text-muted-foreground">
                        {formatDate(c.updated_at)}
                      </span>
                    </button>
                    {/* 44px touch targets: usable on phones without a row
                        menu dependency; sibling of the row button so one
                        click never fires two actions. */}
                    <div className="absolute top-1/2 right-1 flex -translate-y-1/2 gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-11"
                        aria-label={t("renameAria", { title: c.title })}
                        onClick={() => startRename(c)}
                      >
                        <Pencil className="size-4" aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-11"
                        aria-label={t("archiveAria", { title: c.title })}
                        disabled={archive.isPending}
                        onClick={() => {
                          setActionError(null);
                          archive.mutate(c.id);
                        }}
                      >
                        <Archive className="size-4" aria-hidden />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
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
          {list.isFetchingNextPage ? t("loading") : t("loadMore")}
        </Button>
      )}
      {actionError && <p className="px-2 py-2 text-xs text-destructive">{actionError}</p>}

      {/* Rename: explicit dialog, literal title only (never AI-generated). */}
      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("renameTitle")}</DialogTitle>
            <DialogDescription>{t("renameDesc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="conversation-rename-title">{t("titleLabel")}</Label>
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
              {t("cancel")}
            </Button>
            <Button
              size="sm"
              disabled={!renameTitle.trim() || rename.isPending}
              onClick={submitRename}
            >
              {rename.isPending ? t("saving") : t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
