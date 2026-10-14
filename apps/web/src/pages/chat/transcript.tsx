import * as React from "react";
import { ArrowDown } from "lucide-react";
import { ChatMarkdown } from "../../components/chat-markdown";
import { CopyButton } from "../../components/page";
import { Button } from "../../components/ui/button";
import { useChatT } from "./copy";
import type { TurnMessage } from "./turn";

// Turn message shape shared with the pure helpers in ./turn.
type ChatMessage = TurnMessage;

export interface TranscriptHandle {
  /** Re-engage sticky-bottom follow (deliberate send, new chat, opened
   *  conversation, identity switch). No-op while the log is unmounted
   *  (empty view) — a fresh mount always starts pinned to the bottom. */
  follow(): void;
}

/** The scrollable conversation log: message bubbles, reasoning sections,
 *  streaming indicator and the Jump-to-latest control. Owns the sticky-bottom
 *  follow latch; callers re-engage it via the handle. */
export const Transcript = React.forwardRef<
  TranscriptHandle,
  { messages: ChatMessage[]; streaming: boolean }
>(function Transcript({ messages, streaming }, ref) {
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
   *  intent), never per stream chunk; prefers-reduced-motion gets an instant
   *  pin. followLogRef stays false until the scroll actually arrives near the
   *  bottom (the onScroll latch re-engages it) — setting it here would let
   *  the layout-effect pin override the smooth animation with an instant
   *  jump on the next render. */
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
        aria-live="polite"
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
          {messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] wrap-anywhere whitespace-pre-wrap rounded-2xl bg-muted px-4 py-2 text-sm">
                  {m.content}
                </div>
              </div>
            ) : (
              <div key={i} className="w-full space-y-1 text-sm leading-relaxed">
                {m.reasoning && (
                  <details className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                    <summary className="cursor-pointer select-none font-medium">
                      {t("reasoning")}
                    </summary>
                    <div className="mt-1 wrap-anywhere whitespace-pre-wrap">{m.reasoning}</div>
                  </details>
                )}
                {m.content ? (
                  <>
                    <ChatMarkdown
                      content={m.content}
                      streaming={streaming && i === messages.length - 1}
                    />
                    {/* Muted ACTUAL-USED model label: the public ID from
                          the SSE stream / saved history, not the picker's
                          selection guess (the gateway rewrites to public IDs). */}
                    {m.role === "assistant" && m.model && (
                      <p className="text-xs text-muted-foreground">{m.model}</p>
                    )}
                    <div className="flex justify-end">
                      <CopyButton value={m.content} label={t("copyReply")} />
                    </div>
                  </>
                ) : (
                  !m.reasoning &&
                  streaming &&
                  i === messages.length - 1 && (
                    <div className="animate-pulse motion-reduce:animate-none text-muted-foreground">
                      {t("thinking")}
                    </div>
                  )
                )}
              </div>
            ),
          )}
        </div>
      </div>
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
