# Chat Attachment Storage Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the existing private attachment filesystem/API against lock leaks, symlink reads, unsafe temp writes, quota/file inconsistency, and cleanup starvation.

**Architecture:** Keep existing attachment routes, DB metadata, filesystem layout, owner checks, TTL, and quota. Apply a semantic port against the integrated store API, not a cherry-pick of `3212ce0`; split store/route corrections from GC selection/retry changes and use regression tests against the existing code.

**Tech Stack:** TypeScript, Bun tests, Node filesystem primitives, Elysia, Drizzle, PostgreSQL.

**Spec:** `docs/superpowers/specs/2026-10-14-persistent-chat-attachment-lifecycle.md`

## Global Constraints

- Preserve existing route DTOs, owner/workspace authorization, 30-day expiry, 24-hour orphan policy, and 500 MiB user quota.
- Never read or follow attachment symlink targets; temp creation is exclusive and mode `0600`.
- Quota rejection must not return success, leave committed metadata, or leave permanent unreferenced bytes.
- Failed unlink remains discoverable for retry; referenced attachments never count as orphans.
- Unsafe cookie-authenticated upload/delete requires a present trusted Origin.
- No real config/secrets, new dependency, production DB, push, tag, or release.

## Review Focus

- Lock tail rejects and leaves an unhandled detached promise — test rejection followed by reuse and map drain.
- Filesystem rename/DB commit failure leaves a row or bytes behind — inject failures and assert both sides cleaned.
- Existing symlink UUID path reads outside attachment directory — assert 410 and target contents never returned.
- Referenced rows fill an orphan batch and starve real orphans — assert candidate filtering happens before limit.
- Unlink failure permanently hides a row from future cleanup — assert later sweep retries.

---

### Task 1: Safe per-user lock and atomic filesystem persistence

**Files:**
- Modify: `apps/api/src/chat-attachment-store.ts`
- Modify: `apps/api/test/chat-attachments-api.test.ts` (or existing direct store tests if separated)

**Interfaces:** preserve existing `withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T>` and `persistAttachmentFile(dir, id, bytes, commit)` interface; do not transplant the incompatible transactional signature from `3212ce0`.

- [ ] **Step 1: Write failing direct-store tests** in `apps/api/test/chat-attachments-api.test.ts` for lock serialization, map drain after success/rejection, reuse after rejection, temp mode `0600` plus exclusive-create collision, and temp/final cleanup on commit/rename failures. Add a route test that a planted symlink returns 410 and never exposes target bytes.
- [ ] **Step 2: Run** `PORT=3998 bun test apps/api/test/chat-attachments-api.test.ts`; expected: new tests fail on current lock/write/read behavior.
- [ ] **Step 3: Implement** settled swallowed lock tails with identity-checked cleanup and no detached rejection; create temp bytes with `{ mode: 0o600, flag: "wx" }`. In the upload route, run row insert + rename inside the existing Drizzle transaction callback; on callback/commit failure, rollback the row and remove temp/final path. Reject symlink targets before reads.
- [ ] **Step 4: Run** the same tests; expected: no lock entries after settled success/failure and no row/file artifacts after injected errors.
- [ ] **Step 5: Commit** store/routes/tests with explicit paths: `fix(api): harden private attachment writes and reads`.

### Task 2: Quota transaction and Origin boundary

**Files:**
- Modify: `apps/api/src/routes/attachments.ts`
- Modify: `apps/api/src/chat-attachment-store.ts` only if required by the existing commit callback seam.
- Test: `apps/api/test/chat-attachments-api.test.ts`

**Interfaces:** keep same upload route and DTO. Quota rejection remains existing `413 QUOTA_EXCEEDED` response. Trusted-origin parsing uses existing env/base URL contract.

- [ ] **Step 1: Write failing API tests**: quota exceeded creates neither metadata row nor final/temp file; malformed/untrusted/missing Origin on unsafe cookie upload/delete returns 403; trusted configured Origin succeeds.
- [ ] **Step 2: Run** `PORT=3998 bun test apps/api/test/chat-attachments-api.test.ts`; expected: failures on quota false-success or absent-Origin acceptance.
- [ ] **Step 3: Implement** quota overflow as a typed thrown error before file persistence is finalized; use the Task 1 atomic commit seam so quota failure leaves neither row nor bytes. Reject absent Origin for unsafe session-cookie routes while continuing to allow a valid trusted origin.
- [ ] **Step 4: Run** the focused API tests; expected: quota leaves no durable row/file, Origin tests pass, existing auth/MIME/ownership behaviors stay green.
- [ ] **Step 5: Commit** only route/tests changes: `fix(api): enforce attachment quota and origin checks`.

### Task 3: GC retry and starvation-free orphan selection

**Files:**
- Modify: `apps/api/src/attachment-gc.ts`
- Test: `apps/api/test/chat-attachments-api.test.ts`

**Interfaces:** preserve `runAttachmentGc(db, env?, nowMs?, limit?)`; continue returning `{ expired, orphaned }` as today.

- [ ] **Step 1: Write failing tests** where unlink failure is retried by the next sweep, and where the first `limit` old rows are referenced but a later orphan is still selected and reaped.
- [ ] **Step 2: Run** the focused API tests; expected: current code demonstrates retry/starvation defects.
- [ ] **Step 3: Implement** cleanup in unlink-before-tombstone order for DELETE, expiry, and orphan rows: ENOENT counts as already unlinked; any other unlink failure leaves the row untombstoned so a later user retry/GC sweep retries it. After unlink succeeds, tombstone metadata. Select orphan rows with a correlated NOT EXISTS reference filter before `.limit(limit)` so referenced rows cannot starve true orphans. Keep bounded DB work and never hard-delete metadata.
- [ ] **Step 4: Run** the focused API tests; expected: failed unlink is retried and actual orphans do not starve behind referenced rows.
- [ ] **Step 5: Commit** GC/tests: `fix(api): retry attachment cleanup without orphan starvation`.

### Task 4: Storage hardening verification

**Files:** no product changes unless a failing regression identifies a defect.

- [ ] **Step 1: Run** `PORT=3998 bun test apps/api/test/chat-attachments-api.test.ts` with isolated test Postgres available; expected: all attachment route, failure-injection, and GC regressions pass.
- [ ] **Step 2: Run** `node_modules/.bin/tsc -p apps/api/tsconfig.json --noEmit`; expected exit 0.
- [ ] **Step 3: Run** `git diff --check`; expected no output and exit 0.
- [ ] **Step 4: If test Postgres is unavailable**, record exact Docker/connection error and leave DB acceptance unclaimed; never substitute production DB.

---
