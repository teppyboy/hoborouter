import * as React from "react";
import { Paperclip, Send, Square, X } from "lucide-react";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { ATTACH_ERROR_COPY, useChatT } from "./copy";
import {
  ATTACHMENT_RETENTION_NOTICE,
  addAttachments,
  removeAttachment,
  AttachError,
  type ChatAttachment,
} from "./attachments";

/** Draft state owned by the composer: text, per-message attachments and the
 *  user-mutation revision counter. The send lifecycle (use-chat-send) reads
 *  and resets it through this interface; view resets clear attachments via
 *  clearAttachments. */
export interface ComposerDraft {
  input: string;
  attachments: ChatAttachment[];
  attachmentsRef: React.RefObject<ChatAttachment[]>;
  attachError: AttachError | string | null;
  readingFiles: boolean;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  setInput(text: string): void;
  applyAttachments(next: ChatAttachment[]): void;
  /** View reset: clears pending attachments AND the attach error. */
  clearAttachments(): void;
  /** Send-side: dismiss the attach error without touching the chips. */
  clearAttachError(): void;
  /** User draft mutation (typing, chip pick, attach/remove). */
  bump(): void;
  /** Current revision for the 413 unchanged-draft baseline compare. */
  revision(): number;
  focus(): void;
  handleFiles(files: FileList | null): void;
}

export function useComposerDraft(deps: {
  identityRef: React.RefObject<string>;
  seqRef: React.RefObject<number>;
}): ComposerDraft {
  const { identityRef, seqRef } = deps;
  const [input, setInput] = React.useState("");
  // Draft revision counter: increments on USER draft mutations only — typing,
  // paste (both via onChange), prompt-chip pick, attachment pick/remove. The
  // send flow's own programmatic pre-fetch clear must NOT bump it: the 413
  // rollback reads its baseline AFTER that clear, so an untouched composer
  // presents "unchanged" and the wholesale restore path stays reachable.
  const draftRevisionRef = React.useRef(0);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  // Per-message attachments (images as multimodal parts, text/code inlined).
  // Held in memory only; cleared when the message is sent or the view resets.
  const [attachments, setAttachments] = React.useState<ChatAttachment[]>([]);
  const attachmentsRef = React.useRef<ChatAttachment[]>([]);
  const [attachError, setAttachError] = React.useState<AttachError | string | null>(null);
  // Serialized attachment reads: two overlapping file picks must both validate
  // against the LIVE list, never a stale snapshot (count/total budget).
  const attachQueueRef = React.useRef<Promise<void>>(Promise.resolve());
  // Files queued for reading but not yet attached: a visible status so the
  // paperclip button never feels dead while large reads are in flight.
  const [readingFiles, setReadingFiles] = React.useState(false);

  // State + ref move together: the async file-read handler and the send
  // lifecycle must both see the live list without depending on render timing.
  function applyAttachments(next: ChatAttachment[]) {
    attachmentsRef.current = next;
    setAttachments(next);
  }

  /** Serialized, view-pinned attachment ingestion: overlapping picks queue
   *  behind each other so every batch validates against the LIVE list (count
   *  + total budget), and a read finishing after newChat/openChat/send (any
   *  generation bump) or an identity switch is discarded — it can never
   *  repopulate another conversation's or the sent composer's chip list. */
  function handleFiles(fileList: FileList | null) {
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;
    setReadingFiles(true);
    const run = attachQueueRef.current
      .then(() => doAttachFiles(files))
      .finally(() => {
        // Clear the reading status only when no later pick is still queued.
        if (attachQueueRef.current === run) setReadingFiles(false);
      });
    attachQueueRef.current = run;
  }

  async function doAttachFiles(files: File[]) {
    const idAtPick = identityRef.current;
    const genAtPick = seqRef.current;
    const res = await addAttachments(attachmentsRef.current, files);
    if (identityRef.current !== idAtPick || seqRef.current !== genAtPick) return;
    if (res.error) {
      setAttachError(res.error);
      return;
    }
    setAttachError(null);
    draftRevisionRef.current += 1; // user-initiated pick: counts as a draft mutation
    applyAttachments([...attachmentsRef.current, ...res.added]);
  }

  return {
    input,
    attachments,
    attachmentsRef,
    attachError,
    readingFiles,
    textareaRef,
    setInput,
    applyAttachments,
    clearAttachments: () => {
      applyAttachments([]);
      setAttachError(null);
    },
    clearAttachError: () => setAttachError(null),
    bump: () => {
      draftRevisionRef.current += 1;
    },
    revision: () => draftRevisionRef.current,
    focus: () => textareaRef.current?.focus(),
    handleFiles,
    // Hidden input lives inside <Composer>; expose nothing for it.
  };
}

/** The message composer card: attachment chips, textarea, attach/send (or
 *  stop) controls. Rendering only — state lives in useComposerDraft, the
 *  send lifecycle in use-chat-send. */
export function Composer(props: {
  draft: ComposerDraft;
  placeholder: string;
  streaming: boolean;
  canSend: boolean;
  onSend(): void;
  onStop(): void;
}): React.ReactElement {
  const { draft, placeholder, streaming, canSend, onSend, onStop } = props;
  const t = useChatT();
  // The hidden file input is rendered (and reset) entirely inside <Composer>.
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  return (
    <>
      {/* File drag-and-drop on the whole composer. Dragover is only
          cancelled for a Files payload so dragging text between editor
          spots keeps the native drop-to-insert behaviour. */}
      <div
        className="relative rounded-2xl border border-border bg-card p-2 shadow-sm"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDrop={(e) => {
          if (e.dataTransfer.files.length > 0) {
            e.preventDefault();
            draft.handleFiles(e.dataTransfer.files);
          }
        }}
      >
        {(draft.attachments.length > 0 || draft.attachError || draft.readingFiles) && (
          <div className="space-y-1 px-1 pb-1">
            {draft.readingFiles && (
              <p className="text-xs text-muted-foreground" role="status">
                {t("readingFile")}
              </p>
            )}
            {draft.attachments.length > 0 && (
              <ul className="flex flex-wrap gap-1.5">
                {draft.attachments.map((a) => (
                  <li
                    key={a.id}
                    className="flex max-w-full items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs"
                  >
                    <span className="min-w-0 truncate">{a.name}</span>
                    <button
                      type="button"
                      onClick={() => {
                        draft.bump(); // user-initiated remove
                        draft.applyAttachments(
                          removeAttachment(draft.attachmentsRef.current, a.id),
                        );
                        draft.clearAttachError();
                      }}
                      aria-label={t("removeAttachment", { name: a.name })}
                      title={t("removeTitle", { name: a.name })}
                      className="shrink-0 rounded-sm text-muted-foreground hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <X className="size-3.5" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {draft.attachError && (
              <Alert
                variant="destructive"
                autoDismissMs={6000}
                onDismiss={draft.clearAttachError}
                dismissLabel={t("dismissAlert")}
              >
                {draft.attachError instanceof AttachError
                  ? t(
                      ATTACH_ERROR_COPY[draft.attachError.code],
                      draft.attachError.name2 ? { name: draft.attachError.name2 } : undefined,
                    )
                  : draft.attachError}
              </Alert>
            )}
            <p className="text-xs text-muted-foreground">{t("attachHint")}</p>
            <p className="text-xs text-muted-foreground">{ATTACHMENT_RETENTION_NOTICE}</p>
          </div>
        )}
        <Textarea
          aria-label={t("message")}
          ref={draft.textareaRef}
          rows={1}
          placeholder={placeholder}
          value={draft.input}
          onChange={(e) => {
            draft.setInput(e.target.value);
            draft.bump(); // typing/paste: a USER draft mutation
          }}
          onKeyDown={(e) => {
            // IME composition: Enter confirms the candidate, not the message.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          onPaste={(e) => {
            // Clipboard files (e.g. a screenshot) attach like a pick;
            // text-only pastes keep the native insert-into-draft path.
            if (e.clipboardData.files.length > 0) {
              e.preventDefault();
              draft.handleFiles(e.clipboardData.files);
            }
          }}
          className="max-h-48 min-h-10 resize-none border-0 bg-transparent px-2 py-1 shadow-none field-sizing-content focus-visible:ring-0"
        />
        <div className="flex items-center justify-end gap-1">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp,image/gif,text/*,.md,.markdown,.csv,.json,.yaml,.yml,.toml,.log,.ts,.tsx,.js,.jsx,.mjs,.cjs,.css,.html,.py,.go,.rs,.java,.c,.h,.cpp,.sh,.sql"
            className="hidden"
            aria-hidden
            tabIndex={-1}
            onChange={(e) => {
              draft.handleFiles(e.target.files);
              // Allow re-picking the same file after a removal.
              e.target.value = "";
            }}
          />
          <Button
            size="icon"
            variant="ghost"
            onClick={() => fileInputRef.current?.click()}
            disabled={streaming}
            aria-label={t("attachFiles")}
            title={t("attachFilesTitle", { hint: t("attachHint") })}
          >
            <Paperclip className="size-4" aria-hidden />
          </Button>
          {streaming ? (
            <Button size="icon" variant="outline" onClick={onStop} aria-label={t("stopGenerating")}>
              <Square className="size-4" aria-hidden />
            </Button>
          ) : (
            <Button
              size="icon"
              onClick={onSend}
              disabled={!canSend}
              aria-label={t("sendMessage")}
            >
              <Send className="size-4" aria-hidden />
            </Button>
          )}
        </div>
      </div>
      <p className="py-2 text-center text-xs text-muted-foreground">
        Usage is charged to your selected workspace.
      </p>
    </>
  );
}
