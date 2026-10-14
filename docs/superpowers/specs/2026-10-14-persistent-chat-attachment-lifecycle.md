# Persistent Chat Attachment Lifecycle

Status: DESIGN — awaiting user review and approval before implementation planning.
Branch context: `feat/chat-quality-integration`, current base `0b4d569459ee10d28e386269e3a631dd8439b088`.
Supersedes the session-only attachment retention statements in `2026-10-08-chat-attachments-ux-design.md` where they conflict. This spec does not authorize release, push, or production use.

## Goal

Make private Chat attachments survive reloads and conversation forks without silently omitting unavailable files, changing saved history, or bypassing the existing gateway billing/reservation path. Keep the existing browser Chat send request format and existing session-authenticated filesystem-backed attachments API.

## Approved product constraints carried forward

- Attachments are private to the uploading user and workspace, stored as metadata plus filesystem bytes; browser storage holds no binary data.
- A user turn stores canonical `ChatAttachmentRef[]`; assistant turns never contain attachment refs.
- New uploads remain bounded by existing client/server limits: at most four attachments and 10 MiB raw bytes for a new turn; total request body remains bounded by the existing 16 MiB chat-key gateway limit.
- Existing conversation snapshots and source forks are immutable except through their existing version-checked save/fork operations. A failed, cancelled, or omitted-file attempt must not rewrite source history.
- All generation remains an explicit user action, uses the existing managed key and gateway billing/settlement path, and keeps integer VND behavior unchanged.
- Member chat authorization, session-only member key handling, request IDs, and receipt visibility remain unchanged.

## Architecture and data flow

### 1. Upload on selection

1. Validate the entire selected batch (count, per-file type/size, aggregate raw bytes) before reading any file.
2. For each accepted file, create the current in-memory `ChatAttachment` preview and upload raw bytes to the existing session-authenticated workspace attachment endpoint.
3. Keep the server-returned `ChatAttachmentRef` as the canonical reference. A failed upload adds no attachment to the composer; the UI shows the existing typed/localized error and offers explicit retry.
4. Removing a composer attachment removes it from the pending turn only. It does not delete a previously uploaded file or alter conversation history.

### 2. Persist refs with the owning user message

- The send snapshot contains the selected prompt, local attachment previews, and canonical refs.
- On successful turn persistence, write the refs on that user message in the same version-checked conversation snapshot as its text. Never persist data URLs, text bytes, base64, or client-provided paths.
- Reloaded history renders chips from refs without fetching bytes.
- Fork copies refs for retained user turns and for the forked user turn, preserving the source conversation byte-for-byte and its version.
- Legacy user messages without refs remain valid.

### 3. Prepare a generation without mutating history

Introduce a small, pure send-preparation seam used by fresh send, retry, edit-fork send, and regenerate paths:

1. Build a private outgoing snapshot from the chosen conversation messages plus the current turn. Do not mutate React state, saved conversation messages, or fork source data during preparation.
2. Sum canonical ref byte sizes across the full outgoing conversation. Reject before any fetch if raw bytes exceed 10 MiB.
3. Fetch each distinct referenced file through the existing authenticated attachment GET endpoint. Rebuild image data URLs and bounded text excerpts using existing `buildUserContent` behavior.
4. Estimate encoded attachment contribution and measure the final UTF-8 JSON request body. Reject before conversation creation, key mint, draft clearing, or gateway dispatch if it exceeds 16 MiB.
5. Only after preparation succeeds may the existing send path create/adopt a conversation, resolve a key, clear the draft, optimistically render, and dispatch to `/v1/chat/completions`.

The preparation seam returns either a complete request history/body or a typed blocking result. It never returns a partial history.

### 4. Unavailable refs and explicit, send-local omission

- A 404/410 for any owned historical ref, or an over-budget historical snapshot, blocks generation. No text-only fallback, partial attachment subset, key mint, new conversation, draft clear, or gateway dispatch occurs.
- Show the affected filenames and an explicit `Omit unavailable files for this send` confirmation.
- Confirmation creates an outgoing-only copy with those refs omitted and retries preparation. It does not call conversation save, fork, delete attachment bytes, update the source snapshot, or persist the omission.
- If remaining refs still cannot be fetched or exceed a limit, keep generation blocked and show the next actionable error; never silently discard another file.
- A future explicit user edit/fork can change persisted refs through normal existing versioned APIs. The omission confirmation itself cannot.

### 5. Failure and concurrency behavior

- Network/auth/server errors fetching bytes block this generation and preserve draft/history. Provide explicit retry or cancel; do not treat non-404/410 failures as unavailable-file confirmation.
- Abort, workspace/user switch, conversation switch, newer send, or component unmount invalidates the preparation generation. Late fetch results cannot update the new view, mutate storage, or dispatch a request.
- Once gateway dispatch begins, preserve existing stop/error/full-hold, request ID, receipt, and idempotent settlement behavior. No automatic retry after dispatch.
- Existing 413 rollback remains intact: no failed turn save or duplicate on resend; do not change draft revision rules in this work.

## Private file API hardening (separate coherent backend commit)

The integrated attachment store has six concrete findings from `3212ce0` that require semantic port rather than cherry-picking its incompatible transaction helper:

1. Drain per-user lock tails by identity; do not leave map entries permanently or create detached rejecting `finally` promises.
2. Create temporary files exclusively with mode `0600`; reject symlink targets on reads.
3. Quota overflow must throw before reporting successful persistence or leaving unreferenced bytes.
4. Ensure metadata and files cannot diverge after DB/rename failures, using the current DB transaction capabilities and explicit cleanup.
5. Failed unlink must remain retryable by a later GC sweep; tombstone only after the cleanup strategy preserves retryability.
6. Select orphan candidates after excluding referenced IDs, so a full batch of referenced rows cannot starve actual orphans.
7. Cookie-authenticated unsafe attachment methods require a present trusted Origin; absent Origin is rejected. (This is listed as an additional security correction; test both missing and trusted origins.)

Storage hardening is independent of the ChatPage send seam and can be committed/tested separately. Do not change data retention duration, ownership rules, or attachment API shape.

## UI behavior

- Pending composer chips show upload state and canonical server-backed state; failed uploads are not sendable.
- Reloaded conversation shows refs/chips even before bytes are fetched.
- Blocking dialog lists unavailable files and provides explicit omit/cancel controls. Focus remains accessible; error/status copy uses existing EN/VI chat copy conventions.
- Omission is described as applying only to the next generation; history remains intact.
- Mobile and keyboard users can reach upload, retry, omit, cancel, send, and history controls without pointer-only interactions.

## Tests and acceptance evidence

### Client/unit and mounted UI tests

1. Whole-batch invalid selection performs zero reads and zero uploads; upload failure adds no composer item.
2. Successful upload stores only the returned canonical ref in a user message; serialized conversation never contains base64/data URL or file bytes.
3. Reloaded history renders refs without fetching; explicit retry/send rehydrates all refs before gateway dispatch.
4. Any unavailable ref prevents gateway dispatch, key mint, conversation creation, draft clearing, and history save.
5. Explicit omission retries with the outgoing copy only; assert original saved/source messages and version are unchanged and no omission is persisted.
6. Abort or identity/conversation switch during rehydration prevents late dispatch and state writes.
7. Raw/encoded/request body limits reject before any side effect; exact UTF-8 body measurement is covered.
8. Fork preserves the source snapshot and refs; the forked generation rehydrates its refs.
9. Retry of the last user turn rehydrates its refs; no duplicate user turn is persisted.

### API tests

- Existing upload/download ownership, MIME, quota, expiry, tombstone, and GC tests remain green.
- Add regression tests for lock-map cleanup after fulfillment/rejection, restrictive exclusive temp creation, symlink read refusal, quota rollback/no dangling file or row, rename/DB failure cleanup, unlink retry across sweeps, orphan selection starvation, and missing/untrusted/trusted Origin behavior.
- Database-backed tests run only when the isolated test Postgres is healthy; no production database/provider calls.

### Verification

- Focused Chat attachment/client/UI tests; focused API attachment tests.
- Direct API, tests, and web TypeScript checks; `git diff --check`.
- Full suite/E2E once after integration, on isolated test infrastructure. No repeated test-flake matrix.
- No push/tag/release without explicit owner instruction.

## Self-review

- The outgoing-only omission object is distinct from the source snapshot; acceptance item 5 verifies no accidental persistence.
- All rehydration and byte gates precede side effects, preventing accidental paid text-only dispatch and preserving drafts on a blocked send.
- Non-unavailability fetch errors cannot be waived with the omit control.
- Storage hardening remains a separate commit, reducing overlap with the page lifecycle changes.
- Existing route, ownership, quota, TTL, financial, and gateway contracts remain authoritative; no new storage or billing subsystem is introduced.
