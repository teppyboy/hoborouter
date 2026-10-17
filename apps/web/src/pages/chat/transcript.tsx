import * as React from "react";
import { ArrowDown, FileText, ImageIcon, Pencil, RefreshCw, GitFork } from "lucide-react";
import { ChatMarkdown } from "../../components/chat-markdown";
import { CopyButton } from "../../components/page";
import { Button } from "../../components/ui/button";
import { useChatT } from "./copy";
import { utf8ByteLength } from "./attachments";
import { createRenderCoalescer, type ChatAttachmentRef, type TurnMessage } from "./turn";

// Turn message shape shared with the pure helpers in ./turn.
type ChatMessage = TurnMessage;

// Beyond this many UTF-8 bytes of assistant content while streaming, the live
// tail renders as exact plain text (safe React text nodes, no markdown parse)
// — the parse cost per coalesced flush would otherwise dominate long replies.
// At the terminal point the normal markdown render returns.
const PLAINTEXT_STREAM_BYTES = 64 * 1024;

export interface TranscriptHandle {
  /** Re-engage sticky-bottom follow (deliberate send, new chat, opened
   *  conversation, identity switch). No-op while the log is unmounted
   *  (empty view) — a fresh mount always starts pinned to the bottom. */
  follow(): void;
}

/** Turn-action callbacks, all PARENT-OWNED: the transcript only reports
 *  which completed turn was acted on (fork source index; edit with the new
 *  content). The presenter never mutates a message, never calls the fork
 *  endpoint, never starts a generation — fork/edit/regenerate each become an
 *  explicit, separately-charged send initiated by the page. */
export interface TurnActionCallbacks {
  onForkTurn?: (index: number) => void;
  onEditTurn?: (index: number, content?: string) => void;
  onRegenerateTurn?: (index: number) => void;
  /** Session attachment preview: the page reads bytes from its own session
   *  retention (or the files API it already owns) — the transcript never
   *  fetches files and never builds an arbitrary file URL itself. */
  onPreviewAttachment?: (ref: ChatAttachmentRef) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${Math.round(bytes / 1024)} KB`;
}

/** One attachment reference chip: name, size, kind icon. Expired refs (past
 *  their TTL — bytes are gone server-side) render as a muted non-interactive
 *  chip with an explicit notice; live refs open the parent-owned preview. */
const AttachmentChip = React.memo(function AttachmentChip({
  ref: a,
  onPreview,
}: {
  ref: ChatAttachmentRef;
  onPreview?: (ref: ChatAttachmentRef) => void;
}) {
  const t = useChatT();
  const expired = a.expires_at <= Date.now();
  const Icon = a.kind === "image" ? ImageIcon : FileText;
  if (expired) {
    return (
      <span
        className="inline-flex max-w-52 items-center gap-1 rounded-full border border-dashed border-border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground"
        title={t("attachmentExpired")}
      >
        <Icon className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{a.name}</span>
        <span className="shrink-0">{formatBytes(a.bytes)}</span>
        <span className="shrink-0 font-medium">{t("attachmentExpired")}</span>
      </span>
    );
  }
  const preview = () => onPreview?.(a);
  return onPreview ? (
    <button
      type="button"
      onClick={preview}
      title={t("previewAttachment", { name: a.name })}
      className="inline-flex max-w-52 items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs hover:bg-muted"
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{a.name}</span>
      <span className="shrink-0 text-muted-foreground">{formatBytes(a.bytes)}</span>
    </button>
  ) : (
    <span className="inline-flex max-w-52 items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs">
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{a.name}</span>
      <span className="shrink-0 text-muted-foreground">{formatBytes(a.bytes)}</span>
    </span>
  );
});

/** One completed user turn: bubble, attachment ref chips, and the edit action.
 *  Memoized so streaming renders only touch the in-flight node. */
const UserTurn = React.memo(function UserTurn({
  m,
  index,
  completed,
  onEdit,
  onPreview,
}: {
  m: ChatMessage;
  index: number;
  completed: boolean;
  onEdit?: (index: number, content?: string) => void;
  onPreview?: (ref: ChatAttachmentRef) => void;
}) {
  const t = useChatT();
  const [editing, setEditing] = React.useState(false);
  const [edited, setEdited] = React.useState("");
  const startEdit = () => {
    setEdited(m.content);
    setEditing(true);
  };
  const saveEdit = () => {
    setEditing(false);
    // Fire-and-forget reporting: the parent forks the conversation and starts
    // the paid generation; the ORIGINAL message object stays untouched here.
    onEdit?.(index, edited.trim() || undefined);
  };
  return (
    <div className="flex justify-end">
      <div className="flex max-w-[85%] flex-col items-end gap-1">
        {editing ? (
          <div className="w-full min-w-64 space-y-1 rounded-2xl border border-border bg-background px-3 py-2">
            <textarea
              className="min-h-16 w-full resize-y bg-transparent text-sm outline-none"
              value={edited}
              onChange={(e) => setEdited(e.target.value)}
              aria-label={t("editTurn")}
              rows={3}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditing(false)}
                aria-label={t("cancelEdit")}
              >
                {t("cancelEdit")}
              </Button>
              <Button size="sm" onClick={saveEdit} aria-label={t("editTurnHint")}>
                {t("saveEdit")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="wrap-anywhere whitespace-pre-wrap rounded-2xl bg-muted px-4 py-2 text-sm">
              {m.content}
            </div>
            {m.attachments && m.attachments.length > 0 && (
              <div
                className="flex flex-wrap justify-end gap-1"
                role="list"
                aria-label={t("attachmentsLabel")}
              >
                {m.attachments.map((a) => (
                  <AttachmentChip key={a.id} ref={a} onPreview={onPreview} />
                ))}
              </div>
            )}
            {completed && onEdit && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground"
                onClick={startEdit}
                aria-label={t("editTurnHint")}
                title={t("editTurnHint")}
              >
                <Pencil className="size-3" aria-hidden />
                {t("editTurn")}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
});

/** One assistant turn: reasoning, content (live tail may degrade to exact
 *  plain text), ACTUAL-USED model label, copy, and the paid regenerate/fork
 *  actions. Memoized; only the in-flight node re-renders during streaming. */
const AssistantTurn = React.memo(function AssistantTurn({
  m,
  index,
  streamingNode,
  completed,
  onRegenerate,
  onFork,
}: {
  m: ChatMessage;
  index: number;
  streamingNode: boolean;
  completed: boolean;
  onRegenerate?: (index: number) => void;
  onFork?: (index: number) => void;
}) {
  const t = useChatT();
  const plainTextStream =
    streamingNode && m.content.length > 0 && utf8ByteLength(m.content) > PLAINTEXT_STREAM_BYTES;
  return (
    <div className="w-full space-y-1 text-sm leading-relaxed">
      {m.reasoning && (
        <details className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none font-medium">{t("reasoning")}</summary>
          <div className="mt-1 wrap-anywhere whitespace-pre-wrap">{m.reasoning}</div>
        </details>
      )}
      {m.content ? (
        <>
          {plainTextStream ? (
            // Exact bytes as safe React text: no markdown parsing on the hot
            // path of a very long stream. Terminal render restores markdown.
            <div className="wrap-anywhere whitespace-pre-wrap">{m.content}</div>
          ) : (
            <ChatMarkdown content={m.content} streaming={streamingNode} />
          )}
          {/* Muted ACTUAL-USED model label: the public ID from
            the SSE stream / saved history, not the picker's
            selection guess (the gateway rewrites to public IDs). */}
          {m.model && <p className="text-xs text-muted-foreground">{m.model}</p>}
          <div className="flex justify-end">
            <CopyButton value={m.content} label={t("copyReply")} />
          </div>
        </>
      ) : (
        !m.reasoning &&
        streamingNode && (
          <div className="animate-pulse motion-reduce:animate-none text-muted-foreground">
            {t("thinking")}
          </div>
        )
      )}
      {completed && (onRegenerate || onFork) && m.content && (
        <div className="flex justify-end gap-1">
          {onRegenerate && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={() => onRegenerate(index)}
              aria-label={t("regenerateTurnHint")}
              title={t("regenerateTurnHint")}
            >
              <RefreshCw className="size-3" aria-hidden />
              {t("regenerateTurn")}
            </Button>
          )}
          {onFork && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={() => onFork(index)}
              aria-label={t("forkTurnHint")}
              title={t("forkTurnHint")}
            >
              <GitFork className="size-3" aria-hidden />
              {t("forkTurn")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
});

/** The scrollable conversation log: message bubbles, reasoning sections,
 *  streaming indicator and the Jump-to-latest control. Owns the sticky-bottom
 *  follow latch; callers re-engage it via the handle. Accessibility: the log
 *  itself goes live-OFF while streaming (no per-token announcements), with
 *  aria-busy set; ONE polite status announces each completion. */
export const Transcript = React.forwardRef<
  TranscriptHandle,
  { messages: ChatMessage[]; streaming: boolean } & TurnActionCallbacks
>(function Transcript(
  { messages, streaming, onForkTurn, onEditTurn, onRegenerateTurn, onPreviewAttachment },
  ref,
) {
  const t = useChatT();
  // Sticky-bottom follow for the conversation log: ref to the scroll element
  // plus whether the user is near the bottom. While streaming, the log only
  // auto-scrolls when the user hasn't scrolled up to read history.
  const logRef = React.useRef<HTMLDivElement | null>(null);
  const followLogRef = React.useRef(true);
  // Render mirror of "user is away from the bottom" (the onScroll latch): a
  // ref alone cannot drive the Jump-to-latest button, and the boolean only
  // changes at the 80px threshold, so React bails out of the extra renders.
  const [logAway, setLogAway] = React.useState(false);
  // One completion announcement per finished stream (set only on the
  // streaming→idle edge) — never per token, never during streaming.
  const [announcement, setAnnouncement] = React.useState("");
  const prevStreamingRef = React.useRef(false);
  React.useEffect(() => {
    if (prevStreamingRef.current && !streaming) setAnnouncement(t("replyComplete"));
    prevStreamingRef.current = streaming;
  }, [streaming, t]);

  // Stable callback identities for the memoized turn nodes: completed turns
  // re-render only when their own message object changes, not on every
  // streaming flush. Latest props are read through a ref.
  const callbacksRef = React.useRef<TurnActionCallbacks>({});
  callbacksRef.current = { onForkTurn, onEditTurn, onRegenerateTurn, onPreviewAttachment };
  const callbacks = React.useMemo(
    () => ({
      onForkTurn: (index: number) => callbacksRef.current.onForkTurn?.(index),
      onEditTurn: (index: number, content?: string) =>
        callbacksRef.current.onEditTurn?.(index, content),
      onRegenerateTurn: (index: number) => callbacksRef.current.onRegenerateTurn?.(index),
      onPreviewAttachment: (a: ChatAttachmentRef) => callbacksRef.current.onPreviewAttachment?.(a),
    }),
    [],
  );
  // Actions exist only when the parent actually wired them: the stable
  // wrappers above are always defined, so the nodes must receive undefined
  // for an unwired callback (no ghost buttons, no dead preview chips).
  const wired = {
    onForkTurn: onForkTurn ? callbacks.onForkTurn : undefined,
    onEditTurn: onEditTurn ? callbacks.onEditTurn : undefined,
    onRegenerateTurn: onRegenerateTurn ? callbacks.onRegenerateTurn : undefined,
    onPreviewAttachment: onPreviewAttachment ? callbacks.onPreviewAttachment : undefined,
  };

  React.useImperativeHandle(
    ref,
    () => ({
      follow: () => {
        followLogRef.current = true;
        setLogAway(false);
      },
    }),
    [],
  );

  // New content arrived (stream delta or sent message): pin the log to the
  // bottom only while the user is still following. useLayoutEffect, not a
  // passive effect: a passive pin runs after the browser's rendering steps,
  // leaving a frame where the log sits unscrolled with the distance already
  // grown past the 80px threshold — the onScroll handler then latches
  // followLogRef off (and scroll anchoring can fight the late pin), so the
  // log never followed the new message or the stream and stayed at scrollTop
  // 0. Pinning synchronously before paint removes that window.
  React.useLayoutEffect(() => {
    const el = logRef.current;
    if (el && followLogRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  /** One user-triggered jump to the newest message. Smooth ONCE (user
   * intent), never per stream chunk; prefers-reduced-motion gets an instant
   * pin. followLogRef stays false until the scroll actually arrives near the
   * bottom (the onScroll latch re-engages it) — setting it here would let
   * the layout-effect pin override the smooth animation with an instant
   * jump on the next render. */
  function jumpToLatest() {
    const el = logRef.current;
    if (!el) return;
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      el.scrollTop = el.scrollHeight;
    } else {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]"
        role="log"
        // Live OFF while streaming: per-token announcements are noise. The
        // single completion announcement comes from the status node below.
        aria-live={streaming ? "off" : "polite"}
        aria-busy={streaming || undefined}
        aria-label={t("conversation")}
        onScroll={() => {
          const el = logRef.current;
          if (!el) return;
          const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
          followLogRef.current = fromBottom < 80;
          setLogAway(fromBottom >= 80);
        }}
        ref={logRef}
      >
        <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-4">
          {messages.map((m, i) => {
            const last = i === messages.length - 1;
            return m.role === "user" ? (
              <UserTurn
                key={i}
                m={m}
                index={i}
                completed={!streaming || !last}
                onEdit={wired.onEditTurn}
                onPreview={wired.onPreviewAttachment}
              />
            ) : (
              <AssistantTurn
                key={i}
                m={m}
                index={i}
                streamingNode={streaming && last}
                completed={!streaming || !last}
                onRegenerate={wired.onRegenerateTurn}
                onFork={wired.onForkTurn}
              />
            );
          })}
        </div>
      </div>
      {/* One completion status (polite): announced once when a stream ends. */}
      <p role="status" className="sr-only">
        {announcement}
      </p>
      {/* Jump to latest: shown whenever the user is reading older
            messages (static history included, not just mid-stream). One
            user-triggered scroll; the onScroll latch re-engages follow only
            when the target arrives. */}
      {logAway && (
        <Button
          variant="secondary"
          size="sm"
          onClick={jumpToLatest}
          aria-label={t("jumpToLatest")}
          title={t("jumpToLatest")}
          className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 shadow-md animate-in fade-in slide-in-from-bottom-2 duration-150"
        >
          <ArrowDown className="size-4" aria-hidden />
          {t("jumpToLatest")}
        </Button>
      )}
    </div>
  );
});

// Re-exported so the page's send loop can coalesce without importing ./turn
// directly; the queue itself stays in ./turn (pure, tested there).
export { createRenderCoalescer };
