import * as React from "react";
import { Paperclip, Send, Settings2, Square, X } from "lucide-react";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { ATTACH_ERROR_COPY } from "./copy";
import { useComposerT } from "./composer-copy";
import {
  ATTACHMENT_RETENTION_NOTICE,
  ATTACHMENT_LIMITS,
  validateFile,
  removeAttachment,
  AttachError,
  type ChatAttachment,
} from "./attachments";
import { AttachmentUploadError, createPersistedAttachment } from "./attachment-client";
import { useChatT } from "./copy";

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
  workspaceId: string | null;
}): ComposerDraft {
  const { identityRef, seqRef, workspaceId } = deps;
  const t = useChatT();
  const [input, setInput] = React.useState("");
  // Draft revision counter: increments on USER draft mutations only — typing,
  // paste (both via onChange), prompt-chip pick, attachment pick/remove. The
  // send flow's own programmatic pre-fetch clear must NOT bump it: the 413
  // rollback reads its baseline AFTER that clear, so an untouched composer
  // presents "unchanged" and the wholesale restore path stays reachable.
  const draftRevisionRef = React.useRef(0);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  // Per-message attachments (images as multimodal parts, text/code inlined).
  // Local previews are paired with server refs for conversation persistence.
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
    try {
      if (attachmentsRef.current.length + files.length > ATTACHMENT_LIMITS.maxCount) {
        throw new AttachError("tooMany", "You can attach at most 4 files per message.");
      }
      if (
        attachmentsRef.current.reduce((sum, a) => sum + a.bytes, 0) +
          files.reduce((sum, file) => sum + file.size, 0) >
        ATTACHMENT_LIMITS.maxTotalBytes
      ) {
        throw new AttachError("totalTooLarge", "Attachments exceed the 10 MB total limit.");
      }
      for (const file of files) validateFile(file);
      if (!workspaceId) throw new AttachmentUploadError("unauthorized", "Sign in to upload files.");
      const added = await Promise.all(
        files.map((file) => createPersistedAttachment(workspaceId, file)),
      );
      if (identityRef.current !== idAtPick || seqRef.current !== genAtPick) return;
      setAttachError(null);
      draftRevisionRef.current += 1;
      applyAttachments([...attachmentsRef.current, ...added]);
    } catch (e) {
      if (identityRef.current !== idAtPick || seqRef.current !== genAtPick) return;
      if (e instanceof AttachError) setAttachError(e);
      else if (e instanceof AttachmentUploadError) {
        const key = (
          {
            unauthorized: "attachmentUploadUnauthorized",
            forbidden: "attachmentUploadForbidden",
            tooLarge: "attachmentUploadTooLarge",
            unsupported: "attachmentUploadUnsupported",
            quota: "attachmentUploadQuota",
            network: "attachmentUploadNetwork",
            invalid: "attachmentUploadInvalid",
          } as const
        )[e.kind];
        setAttachError(t(key));
      } else setAttachError(e instanceof Error ? e.message : t("attachReadFailed"));
    }
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

/** Send-trigger keys: Enter (without Shift) or Cmd/Ctrl+Enter. IME
 *  composition is handled by the caller; Shift+Enter keeps the newline. */
export function isSendKeydown(e: {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}): boolean {
  if (e.key !== "Enter") return false;
  if (e.metaKey || e.ctrlKey) return true;
  return !e.shiftKey;
}

/** The message composer card: attachment chips, textarea, attach/send (or
 *  stop) controls, and the always-available Advanced disclosure (scope,
 *  billing and attachment copy — rendered outside the welcome wall).
 *  Rendering only — state lives in useComposerDraft, the send lifecycle in
 *  use-chat-send. */
export function Composer(props: {
  draft: ComposerDraft;
  placeholder: string;
  streaming: boolean;
  canSend: boolean;
  onSend(): void;
  onStop(): void;
  /** Disclosure content override; the default carries scope/billing and
   *  attachment copy. The disclosure renders regardless of this prop. */
  advanced?: React.ReactNode;
  /** Controlled attachment chips (persistent-upload integration): when set,
   *  rendered instead of the in-memory draft chips. Removal then goes
   *  through onRemoveAttachment. */
  attachments?: ChatAttachment[];
  /** Controlled-chip removal; only consulted while `attachments` is set. */
  onRemoveAttachment?(id: string): void;
  /** Fired whenever the in-memory draft attachment list changes
   *  (pick/remove/clear) so the page can mirror it (e.g. future upload
   *  persistence). */
  onAttachmentsChange?(next: ChatAttachment[]): void;
}): React.ReactElement {
  const { draft, placeholder, streaming, canSend, onSend, onStop } = props;
  const t = useComposerT();
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const advancedRef = React.useRef<HTMLDivElement | null>(null);
  // Chips shown are the controlled list when provided, else the draft's.
  const chips = props.attachments ?? draft.attachments;
  const onAttachmentsChangeRef = React.useRef(props.onAttachmentsChange);
  onAttachmentsChangeRef.current = props.onAttachmentsChange;
  React.useEffect(() => {
    onAttachmentsChangeRef.current?.(draft.attachments);
  }, [draft.attachments]);
  // Advanced disclosure focus: opening moves focus to the first control
  // inside; closing (Escape below) returns it to the toggle.
  const advancedToggleRef = React.useRef<HTMLButtonElement | null>(null);
  React.useEffect(() => {
    if (!advancedOpen) return;
    advancedRef.current
      ?.querySelector<HTMLElement>("button, [href], input, select, textarea")
      ?.focus();
  }, [advancedOpen]);
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
        {(chips.length > 0 || draft.attachError || draft.readingFiles) && (
          <div className="space-y-1 px-1 pb-1">
            {draft.readingFiles && (
              <p className="text-xs text-muted-foreground" role="status">
                {t("readingFile")}
              </p>
            )}
            {chips.length > 0 && (
              <ul className="flex flex-wrap gap-1.5">
                {chips.map((a) => (
                  <li
                    key={a.id}
                    className="flex max-w-full items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs"
                  >
                    <span className="min-w-0 truncate">{a.name}</span>
                    <button
                      type="button"
                      onClick={() => {
                        if (props.attachments) {
                          props.onRemoveAttachment?.(a.id);
                          return;
                        }
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
            if (isSendKeydown(e)) {
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
          <Button
            ref={advancedToggleRef}
            size="icon"
            variant="ghost"
            aria-expanded={advancedOpen}
            aria-controls="composer-advanced"
            onClick={() => setAdvancedOpen((v) => !v)}
            onKeyDown={(e) => {
              // Escape inside the open disclosure returns focus here.
              if (advancedOpen && e.key === "Escape") {
                e.preventDefault();
                setAdvancedOpen(false);
              }
            }}
            aria-label={t("advanced")}
            title={t("advancedHint")}
          >
            <Settings2 className="size-4" aria-hidden />
          </Button>
          {streaming ? (
            <Button size="icon" variant="outline" onClick={onStop} aria-label={t("stopGenerating")}>
              <Square className="size-4" aria-hidden />
            </Button>
          ) : (
            <Button size="icon" onClick={onSend} disabled={!canSend} aria-label={t("sendMessage")}>
              <Send className="size-4" aria-hidden />
            </Button>
          )}
        </div>
        <div
          id="composer-advanced"
          ref={advancedRef}
          hidden={!advancedOpen}
          className="space-y-1 px-1 pb-1"
          onKeyDown={(e) => {
            if (advancedOpen && e.key === "Escape") {
              e.preventDefault();
              setAdvancedOpen(false);
              advancedToggleRef.current?.focus();
            }
          }}
        >
          {props.advanced ?? (
            <>
              <p className="text-xs text-muted-foreground">{t("scopeBilling")}</p>
              <p className="text-xs text-muted-foreground">{t("attachHint")}</p>
              <p className="text-xs text-muted-foreground">{ATTACHMENT_RETENTION_NOTICE}</p>
            </>
          )}
        </div>
      </div>
    </>
  );
}
