# Persistent Chat Attachment Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist private attachment references with chat turns and safely rehydrate them before explicit sends without changing saved history on omission.

**Architecture:** Keep the existing upload/read API and 16 MiB gateway path. Implement pure send preparation in a new chat module, then connect upload refs, persisted user-turn refs, rehydrated multimodal bodies, and explicit send-local omit UI to `ChatPage`; storage hardening is a separate plan. All preparation and limits run before conversation creation, key mint, draft clear, optimistic state, or dispatch.

**Tech Stack:** TypeScript, React, Bun tests, existing Elysia/Drizzle API, existing shared DTOs and attachment helpers.

**Spec:** `docs/superpowers/specs/2026-10-14-persistent-chat-attachment-lifecycle.md`

## Global Constraints

- At most four new attachments and 10 MiB raw bytes per new turn.
- The complete UTF-8 JSON gateway body is at most 16 MiB.
- Persist only canonical `ChatAttachmentRef[]`; never persist file bytes, data URLs, base64, or paths.
- 404/410 refs block generation until explicit outgoing-only omission; saved snapshots remain unchanged.
- Other rehydration failures block and preserve draft/history; they cannot be waived as unavailable files.
- Do not alter gateway billing, integer VND, reservation/settlement, request IDs, or member authorization.
- No binary browser storage, new dependencies, provider calls, or production config access.

## Review Focus

- Omission accidentally reaches a save/fork payload — assert original server snapshot/version are unchanged after omit-and-send.
- A late fetch dispatches after workspace/chat switch or abort — assert no later gateway request or state write.
- Retrying the last turn duplicates its user message — assert one persisted user turn and rehydrated refs.
- A body-size rejection clears the draft or mints a key — assert these side effects do not occur.
- A transient fetch failure is offered as an omit case — assert retry/cancel only for non-404/410 failures.

---

### Task 1: Pure send-preparation seam

**Files:**

- Create: `apps/web/src/pages/chat/prepare-send.ts`
- Test: `tests/chat-prepare-send.test.ts`
- Reuse: `apps/web/src/pages/chat/persistent-attachments.ts`, `attachments.ts`, `turn.ts`, and the existing `buildChatRequestBody` request shape.

**Interfaces:**

- Produces `prepareChatSend(input: { workspaceId: string; model: string; messages: ConversationMessage[]; effort: ReasoningEffort; signal?: AbortSignal; fetch?: typeof fetch }): Promise<PreparedChatSend>` in `prepare-send.ts`.
- `PreparedChatSend` is either `{ ok: true; bodyJson: string; messages: ConversationMessage[] }`, `{ ok: false; kind: "unavailable"; files: UnavailableAttachment[]; outgoingMessages: ConversationMessage[] }`, or `{ ok: false; kind: "tooLarge" | "failed"; error: Error }`.
- `outgoingMessages` is a fresh copy, never an alias to supplied snapshots. On unavailable results it retains all refs until caller explicitly confirms omit. Import `ConversationMessage` from `@hoborouter/shared` and `ReasoningEffort` from `./reasoning`.

- [ ] **Step 1: Write failing pure tests** for all refs rehydrated before a successful body; raw budget rejection before fetch; 404/410 yields unavailable without partial body; 500/network yields blocking failure; exact UTF-8 JSON size checked at 16 MiB; input snapshot remains byte-identical.
- [ ] **Step 2: Run** `bun test tests/chat-prepare-send.test.ts`; expected: failures because `prepareChatSend` is not implemented.
- [ ] **Step 3: Implement** the typed result seam. Sum canonical refs first; call `rehydrateMultimodalContents`; assemble request messages with `withMultimodalContent`; build exact request JSON; reject over 16 MiB before returning success. Thread AbortSignal.
- [ ] **Step 4: Run** `bun test tests/chat-prepare-send.test.ts`; expected: all tests pass, including unchanged-input assertions.
- [ ] **Step 5: Commit** only the new module and test: `feat(web): prepare chat sends with persisted attachments`.

### Task 2: Persisted upload references in ChatPage

**Files:**

- Modify: `apps/web/src/pages/chat/index.tsx`
- Modify: `apps/web/src/pages/chat/composer.tsx` only if current file-pick callback requires a prop/interface adjustment.
- Modify: `apps/web/src/pages/chat/copy.ts`
- Test: `tests/chat-page-attachments.test.tsx`

**Interfaces:**

- Composer attachment values remain `ChatAttachment`; persistent picks require `serverRef` before send.
- A user `ChatMessage.attachments` stores only `serverRef` values.

- [ ] **Step 1: Write failing mounted tests**: file selection uploads raw bytes; failed upload adds no sendable chip; successful user turn is saved with canonical refs and no data URL/text bytes.
- [ ] **Step 2: Run** `bun test tests/chat-page-attachments.test.tsx`; expected: failures because ChatPage still uses local-only `addAttachments` and saves no refs.
- [ ] **Step 3: Implement** whole-batch validation before reads/uploads; use `createPersistedAttachment(workspaceId, file)`; translate `AttachmentUploadError.kind` through EN/VI chat copy; ensure only uploaded attachments can send. Add server refs to optimistic and persisted user turn.
- [ ] **Step 4: Run** `bun test tests/chat-page-attachments.test.tsx`; expected: upload/persistence behaviors pass and legacy no-ref histories still render.
- [ ] **Step 5: Commit** explicit changed Chat source/tests: `feat(web): persist uploaded chat attachment refs`.

### Task 3: Send/retry/fork rehydration and explicit omission

**Files:**

- Modify: `apps/web/src/pages/chat/index.tsx`
- Modify: `apps/web/src/pages/chat/copy.ts`
- Modify: `apps/web/src/pages/chat/transcript.tsx` only if attachment-reference UI needs a callback.
- Test: `tests/chat-page-attachments.test.tsx`, `tests/chat-page-wave3-wiring.test.tsx`, and conversation API tests only if fork ref behavior is missing.

**Interfaces:**

- Consume Task 1 `prepareChatSend`.
- Blocking UI state is typed: unavailable filenames+refs; other errors remain retry/cancel errors.
- Omit confirmation stores only an outgoing copy for that explicit send; no source snapshot mutation.

- [ ] **Step 1: Write failing mounted tests** for reload chip display without fetch; send/retry/fork rehydration before gateway dispatch; missing ref blocks key mint, conversation creation, draft clear, history save and gateway POST; explicit omit sends remaining content but source snapshot/version stay unchanged; abort/chat switch prevents late dispatch.
- [ ] **Step 2: Run** the named UI tests; expected: failures because `rehydrateUploads` is a no-op and dispatch precedes attachment restoration.
- [ ] **Step 3: Implement** preparation before every side effect and for fresh send/retry/forked send. Add accessible localized confirmation for unavailable refs. After confirmation use `stripAttachments` on a cloned outgoing message list and re-run preparation; never call save/fork with omitted snapshots. Keep current draft and refs on all blocked failures.
- [ ] **Step 4: Run** `bun test tests/chat-page-attachments.test.tsx tests/chat-page-wave3-wiring.test.tsx tests/chat-history-client.test.ts`; expected: all listed behavior passes, including single-user-turn retry persistence and no source mutation.
- [ ] **Step 5: Commit** only lifecycle UI/copy/tests: `feat(web): rehydrate chat attachments before generation`.

### Task 4: Integrated Chat attachment verification

**Files:** no product changes unless a failing acceptance test identifies a defect.

- [ ] **Step 1: Run** `bun test tests/chat-attachment-client.test.ts tests/chat-persistent-attachments.test.ts tests/chat-prepare-send.test.ts tests/chat-page-attachments.test.tsx tests/chat-page-413-recovery.test.tsx tests/chat-history-client.test.ts`.
- [ ] **Step 2: Run** `node_modules/.bin/tsc -p tests/tsconfig.json --noEmit` and `(cd apps/web && ../../node_modules/.bin/tsc -b)`; expected exit 0.
- [ ] **Step 3: Run** `git diff --check`; expected no output and exit 0.
- [ ] **Step 4: Record** DB-dependent attachment API verification as blocked if isolated test Postgres is unavailable; do not substitute production DB.

---
