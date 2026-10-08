# Chat attachments 10 MiB + response model + UI bundle

Status: DESIGN ONLY — no implementation until written user approval.
Base: `e61ec23cad96eb5b197fb38fb7ca0614cb96acb8` (branch `pi-subagents/chat-spec-efdd544-774a-s0-t0`). Revision 5.
Supersedes: `chat-10mib.md` draft (resolves its 5 findings), the independent spec review (`chat-spec-independent-review.md`, 5 findings), and the final spec review (`chat-spec-final.md`, 3 P1 findings: membership-only public-ID validation, reliable client key-purpose metadata, 413 send rollback). Revision 4 narrows the revision-3 413 rollback with a draft-revision guard (composer is editable while pending) — see Self-review (revision 4). Revision 5 resolves the GLM review's single P1: the programmatic pre-fetch clear does not increment the draft revision — see Self-review (revision 5).

## Goal

Raise the web chat attachment budget to an approved 10 MiB raw total per message, backed by a server-owned 16 MiB body allowance on the exact gateway path the web chat uses, persist the public assistant model per message, and ship the UI bundle (destructive animated alerts, collapsible desktop conversation list). Money invariants, scrubbing, and history semantics are unchanged.

## Approved decisions (binding — user-approved after review)

1. Server-owned chat-key provenance: `purpose` column, set only by a dedicated authenticated chat-key route. No name heuristic, no environment flag, no client header.
2. Ordinary `sk-hbr-` keys and `/v1/responses`: keep the 1 MiB cap. Chat-purpose keys on `/v1/chat/completions`: 16 MiB.
3. Attachments: 10 MiB raw TOTAL per message, max 4 files. Existing text contract kept: 64 KiB read cap, 16 KiB UTF-8-safe inline excerpt.
4. Billing hold math unchanged: `maxInputTokens = min(bodyBytes, context_window)` clamp kept; integer VND reservation from bounded tokens.
5. Assistant `model` stored as an optional field inside the existing JSONB `messages`; no new column, no migration for it. Server validates against published public IDs.
6. History limits kept: 512 KiB save body, 64 KiB per message content. Retry stays last-reply-only.
7. UI: destructive animated alerts with manual dismiss + reduced-motion support; collapsible desktop conversation list. No new dependencies.
8. Attachments remain session-only; never persisted to history.

---

## Part 1 — Gateway: chat-purpose 16 MiB exception

### 1a. Key provenance (Finding 1 correction)

Verified current state: `ApiKeyRecord` (`packages/keys/src/keys.ts:25-52`) carries only `api_key_id`, `workspace_id`, `status`. The managed chat key mints through the ordinary route `POST /api/v1/workspaces/:id/keys` (`apps/web/src/pages/chat/managed-key.ts` → `apps/api/src/routes/keys.ts:48-72`). Nothing else distinguishes it — so provenance must be server-owned state.

Design:

- Add a forward-only migration `packages/db/drizzle/0013_api_keys_purpose.sql`:
  `ALTER TABLE api_keys ADD COLUMN purpose text NOT NULL DEFAULT 'generic'` plus a check constraint `purpose IN ('generic','chat')`. Never edit applied migrations; register in `packages/db/drizzle/meta/_journal.json`.
- Extend `packages/db/src/schema.ts` `apiKeys` with `purpose: text("purpose", { enum: ["generic", "chat"] }).notNull().default("generic")`.
- `verifyApiKey` selects and returns `purpose` in `ApiKeyRecord` (additive field; all existing callers compile unchanged).
- Ordinary `POST /api/v1/workspaces/:id/keys` keeps inserting `purpose: 'generic'` (the default; explicit is better than implicit).
- New route `POST /api/v1/workspaces/:id/chat-key`: same session + `requireWsRole` owner/admin authorization as the existing keys route (members get 403 — never a weaker endpoint), generates one key with `purpose: 'chat'`, audits it, returns `{ id, name, key_prefix, status, plaintext, purpose: "chat" }` — the existing `/keys` create shape plus one explicit `purpose` field; plaintext shown exactly once, never logged or stored server-side.
- **Client-side purpose metadata (review v3 Finding 2):** `ManagedKey` (`apps/web/src/pages/chat/managed-key.ts:14-19`) and the persisted browser record gain an explicit `purpose: "generic" | "chat"` field. `parseManagedKey` requires `purpose` on `/chat-key` responses (missing/other ⇒ `invalid`, never trusted) and restores LEGACY persisted records lacking the field as `"generic"` (safe default: every pre-change stored key is generic). The metadata gates UX only — which reconnect flow a 413 offers (§1c). It is NEVER an authorization trust anchor: the gateway's cap decision reads server-side `api_keys.purpose` exclusively, the client never asserts a purpose to the server, and a metadata mismatch degrades safely to the generic 413 flow.
- `apps/web/src/pages/chat/managed-key.ts` switches its mint call from `/keys` to `/chat-key`. Existing persisted plaintext keys in localStorage remain `generic`-purpose and keep working at 1 MiB — no silent upgrade, no forced migration. The concrete oversized-send upgrade path is defined in §1c (413 reconnect); reuse of an already-stored key is otherwise unchanged behavior.

### 1b. Cap resolution (after auth lookup, before ANY side effect — includes `last_used_at`)

Verified current state: auth lookup runs at `apps/api/src/routes/v1-gateway.ts:336`, but the handler then WRITES `api_keys.last_used_at` (lines 339-341) BEFORE the declared `content-length` precheck (lines 344-347) and the streamed accumulation cap (lines 348-364). That write is a DB side effect performed for requests the size gate is about to reject — the preflight must be side-effect-free.

Design (ordering is normative):

1. Auth lookup only (`verifyApiKey`) — needed to resolve the limit. No writes.
2. Resolve the limit: `const bodyLimit = path === "/v1/chat/completions" && key.purpose === "chat" ? CHAT_MAX_BODY_BYTES : MAX_BODY_BYTES;` where `MAX_BODY_BYTES` stays `1024*1024` and `CHAT_MAX_BODY_BYTES = 16 * 1024 * 1024` (10 MiB raw × 4/3 base64 + prompt/history/JSON headroom).
3. Declared `content-length` gate against `bodyLimit` → 413 `payload_too_large` with the resolved limit named. Mid-read overflow keeps calling `bodyReader.cancel()` (line 358 behavior preserved).
4. Streamed accumulation gate against `bodyLimit` → 413, cancel.
5. Only AFTER both gates pass: the existing `last_used_at` update, then everything downstream unchanged.

Consequently, an oversized request (either gate) performs NO DB write, no rate-limit counting, no reservation, and no wallet work of any kind. The in-handler comment "Disabled gate before any DB write" must be corrected — the true invariant becomes "no DB write before the body gates".

- `/v1/responses` and every generic key keep 1 MiB. No env override for the 16 MiB value in this scope (constant in code; an env knob would be speculative).

### 1c. Generic-key 413 reconnect (explicit, manual, browser-only)

Verified current state: managed keys mint through `POST /api/v1/workspaces/:id/keys` (`managed-key.ts:202-210`); the chat page offers reconnect only for 401 (`index.tsx:723-725`); a 413 from the gateway lands in `setError` via `readableError` with no recovery action. An old generic-purpose key therefore hits an unrecoverable 413 on any ≥1 MiB send. Additionally, the send flow clears the draft and attachments before the fetch (`index.tsx:683-686`) and on failure persists the user turn (`:723-733`) — so today a 413 would both lose the draft and persist a failed turn (review v3 Finding 3).

Design (failure semantics, not implementation):

- Trigger: a 413 `payload_too_large` from `/v1/chat/completions` while the active managed key is generic-purpose per CLIENT metadata (§1a). The server's own `purpose` remains the authority for the cap; the client metadata only selects this recovery path. If a chat-metadata key ever receives a 413, the same alert shows with a corrected explanation — the reconnect action is harmless in either case.
- Presentation: a PERSISTENT destructive Alert (never auto-dismissed — see §4a) explaining the request exceeded the 1 MiB limit for this key and offering one explicit **Reconnect** action.
- Reconnect action: clears ONLY the browser-side managed-key state — the per-identity in-memory cache and the namespaced localStorage/sessionStorage entries via the existing `clearManagedChatKey(identity)` semantics. It makes NO API call and never revokes, disables, or deletes the old server-side key.
- Next explicit send after reconnect: mints a fresh key through `/chat-key` (`purpose: 'chat'`, 16 MiB) and reuses it as usual. The failed message is NOT retried automatically — the user re-sends manually.
- Until reconnect, the generic key continues to work for all <1 MiB messages; there is no proactive forced upgrade, no background key swap, and no automatic retry loop.
- Failure of the reconnect mint follows the existing `ManagedKeyError` taxonomy (unauthorized/forbidden/network/invalid) with the existing copy; nothing is cached on failure.

#### 413 send rollback (draft, attachments, history)

- **Capture + draft revision:** when a send is committed, the pre-send draft text and the full attachment list are snapshotted (preserved as the recovery snapshot — never replaced by the empty post-clear values) and the per-composer **draft revision** counter is read as the comparison baseline. The counter increments ONLY on USER draft mutations — typing, paste, user-initiated clear, attachment pick, attachment remove (revision 4 correction: the composer stays editable while the request is pending, so identity/conversation/generation guards alone cannot detect later edits). **The send flow's own programmatic pre-fetch clear (`setInput("")`/`applyAttachments([])`, `index.tsx:683-686`) is NOT a user mutation and must NOT increment the revision** (revision 5 correction): the comparison baseline (revision value) is read AFTER that programmatic clear, so a send with no user edits afterwards presents an unchanged revision and the wholesale restore path remains reachable. User-initiated clears DO increment. The snapshot + revision baseline are held only for the in-flight send generation. Equivalently, the implementation may compare the captured text+attachment state against the live composer; the revision counter is the specified mechanism because it is O(1) and cannot miss an edit-then-undo round trip.
- **On 413 (generic-purpose key):** the failure is NOT treated as a completed turn:
  - The terminal `saveTurn` is SKIPPED — no user-turn history persist, no assistant placeholder, no version bump. The failed request never enters `chat_conversations.messages`, so the next resend cannot duplicate the user message (review v3 Finding 3).
  - The on-screen optimistic user message and empty assistant bubble are rolled back.
  - **Draft/attachment restore is revision-gated (final narrow correction):**
    - **Unchanged revision** (no user typing/pick/remove since the programmatic clear): WHOLESALE AUTOMATIC restore of the snapshot — draft text and attachment list return exactly, attachments without re-reading files (session-only objects are still in memory).
    - **Changed revision** (any USER typing, attachment pick, or remove after the programmatic clear): the newer draft is NEVER overwritten automatically. The current composer content and attachments are kept untouched; the pre-send snapshot is held as a RECOVERABLE snapshot and the persistent reconnect alert gains an explicit **Restore original draft** action. Restoration happens ONLY after the user activates that action AND confirms the overwrite (confirmation is required because it replaces their newer edits); declining keeps the newer draft. No other path overwrites the composer from the snapshot.
  - In BOTH paths: no automatic resend, no key revocation, no history duplication — the user re-sends manually after (optionally) reconnecting.
- **Restore guards — all must hold for either path, else discard the 413 entirely (snapshot dropped, no restore, no recoverable copy, no persist):** (a) same session identity (userId + workspaceId unchanged — no logout/switch), (b) same conversation context (the active conversation at failure is the one the send targeted — no conversation switch or New chat), (c) same send generation (`isCurrent()`/generation counter — no newer send started). A stale 413 never restores, never rolls back newer state, and never erases a draft the user has since edited.
- **Empty new conversation:** the server conversation row may already exist (created before the fetch, storage-only, never billed). On a guarded 413 first-turn failure the client KEEPS its adoption of that row — a zero-message conversation is indistinguishable from a fresh New chat, so the restored draft re-sends into the same conversation. Nothing is deleted server-side (no destructive cleanup, no auto-archival). If the 413 arrives stale (guards fail) after a conversation switch, the empty row simply remains as an ordinary empty conversation the user can delete through the existing UI; no automatic removal.
- Other HTTP failures (non-413) keep the existing behavior: persist the user turn so the history matches what is on screen.

Tests (delayed 413 / identity switch / draft revision races):

- 413 while guards current AND revision unchanged → wholesale restore: draft restored byte-identical, attachment list restored, NO user turn persisted (version unchanged, messages empty), persistent reconnect alert shown, no automatic re-send.
- **Unchanged baseline after the programmatic clear**: a send whose composer the user never touches produces an unchanged revision at 413 (the send flow's own `setInput("")`/`applyAttachments([])` does not count as a mutation) — the wholesale restore path fires; only USER-initiated clears/edits/picks/removes mark the revision changed.
- **Text edit after the programmatic clear** (user types while pending) → revision changed: newer draft kept untouched, snapshot held as recoverable; explicit restore action appears; confirming replaces the composer, declining keeps the newer draft; NO user turn persisted either way; no resend, no revoke.
- **Attachment remove/add by the user after the programmatic clear** → same revision-gated behavior: list untouched automatically, snapshot recoverable, restore only with confirmation; removed attachment returns only via confirmed restore.
- 413 arriving AFTER the user switched to another conversation → guards fail: snapshot discarded, no restore into the new conversation, failed turn not persisted, no state corruption; old conversation untouched server-side.
- 413 arriving AFTER workspace/identity switch (logout/sign-in as another user) → guards fail: no restore, no cross-identity state writes, recoverable snapshot dropped; managed-key cache already cleared by the identity change.
- 413 arriving AFTER a newer send started (stale generation) → discarded silently; the newer stream continues undisturbed; no snapshot retained.
- Resend after reconnect → mints chat-purpose key, single user turn persisted (no duplication of the rolled-back turn), regardless of which restore path was taken.

### 1d. Billing units (Finding 3 correction)

Verified current state: `maxInput = Math.min(Math.ceil(Buffer.byteLength(raw)), contextWindow)` (`v1-gateway.ts:414-415`); `estimateCapVnd` (`packages/wallet/src/billing.ts:53-88`) converts integer token bounds to VND and throws `WalletError("overflow")` when the cap exceeds `maxStoredMoney`. The clamp means a 13 MiB body does NOT reserve 13M tokens unless the model context window allows it.

Design: keep the math; name the units explicitly in code comments and tests:

- `bodyBytes` = UTF-8 bytes of the inbound JSON body (used for the 1/16 MiB gate and auto-routing cost hints).
- `maxInputTokens` = `min(bodyBytes, context_window)` — a conservative 1 token/byte bound, clamped.
- `maxOutputTokens` = requested or default, bounded by `context_window`.
- `capVnd` = integer VND reservation computed from those bounded tokens via `estimateCapVnd`.

Overflow is a function of the model's context window and price, not body size alone. The regression test must construct a fixture (small `context_window` and high per-token price) where the effective bounded token count makes `capVnd > maxStoredMoney`, then assert: no dispatch, no ledger entry, no partial charge, and the reservation path returns cleanly. Do not label an arbitrary large body as guaranteed overflow.

### 1e. Everything downstream unchanged

- Scrubbing: `scrubJsonStrings` still runs on the parsed body and per `data:` chunk for streams; large bodies do not bypass it.
- Auto-routing (`hoborouter/auto`), model allowlists, funding selection, subscription/allowance limiters, settle-once `done` flag, client-abort `full_hold` settlement: unchanged.
- 413 on an oversize body must not consume a rate-limit slot (it occurs before limiter touch — pin with a test).

---

## Part 2 — Attachments and body budget (Finding 2 correction)

Verified current state: `ATTACHMENT_LIMITS` (`apps/web/src/pages/chat/attachments.ts:39-48`) is `maxCount: 4, maxImageBytes: 384KiB, maxTextBytes: 64KiB, maxTotalBytes: 384KiB, maxTextInlineBytes: 16KiB`. The total check in `addAttachments` (lines ~158-178) runs on `file.size` BEFORE any `arrayBuffer()`/`text()` read. The client pre-send guard is `MAX_REQUEST_BODY_BYTES = 900_000` (`index.tsx:183`), measured as `utf8ByteLength(JSON.stringify(...))` before key mint, conversation create, or draft reset (`index.tsx:642-650`).

Design:

- `maxTotalBytes: 10 * 1024 * 1024` — raw sum of attachment bytes per message. This is the binding limit; a single 10 MiB image or four files totaling 10 MiB are both acceptable, and the "4 × 10 MiB" memory example from the old draft is unreachable.
- `maxImageBytes: 10 * 1024 * 1024` — per-file ceiling only; total validation remains binding.
- `maxCount: 4` unchanged. `maxTextBytes: 64KiB`, `maxTextInlineBytes: 16KiB` unchanged — text beyond the inline cap is billed as tokens with no UX value; oversize text files keep rejecting with the existing message shape.
- `MAX_REQUEST_BODY_BYTES` (`index.tsx:183`) becomes `16 * 1024 * 1024` — the same number as the gateway's chat-purpose cap. The guard keeps running before any side effect (key mint, conversation create, fetch). History shares the 16 MiB JSON budget: a 10 MiB attachment plus a large history can still be rejected client-side with the existing `tooLarge` message; the copy is updated to say so (see Copy).
- Attachment budget errors are raised before any file read; the pre-send guard measures exact UTF-8 bytes, not UTF-16 chars.

Memory reality (corrected claim): a 10 MiB raw image becomes a ~13.4 MiB base64 payload inside a ~14 MiB UTF-16 JS string (≈28 MiB RSS for that string), plus temporary conversion overhead in `bytesToDataUrl`. Attachments stay session-only (`ATTACHMENT_RETENTION_NOTICE`), are cleared after send, and are never persisted. No object-URL refactor in this scope (current data-URL path is correct and tested); noted as a profiling follow-up only.

Read preflight order (corrected per review; pinned by tests): **ALL validation before ANY read** — (1) count check, (2) total-bytes check on `File.size`, (3) every selected file's type and per-file size check, then (4) reads. Verified current behavior violates this: `addAttachments` validates sequentially inside `createAttachment`, so an earlier file is read (`arrayBuffer()`/`text()`) before a later file's type/size rejection is discovered. The revised contract validates the whole batch's type+size first; only then are accepted files read. All-or-nothing batch semantics unchanged. A file that busts the budget is never read, and no file is read at all if any file in the batch is invalid.

---

## Part 3 — Persisted assistant model (Finding 4 correction)

Verified current state: `chat_conversations.messages` is a JSONB array (`packages/db/src/schema.ts:1014-1049`); message-shape validation is app-side. `validateMessages` (`apps/api/src/routes/chats.ts:56-99`) accepts only `role`, `content` (≤64 KiB), optional `reasoning` — any other field (including `model`) is silently dropped today (only role/content/reasoning are copied into the stored message; unknown fields never persist). `sse.ts` `extractDelta` reads only `choices[0].delta` and drops the top-level `model`. The gateway rewrites upstream IDs to public ones before SSE delivery (`sseModelRewriteStream`, `v1-gateway.ts:278-320`), so the top-level `model` on delivered chunks is already the public ID.

Design:

- Message JSON gains an optional assistant-only field `model?: string`. No DB column, no migration (Finding 4 accepted).
- Capture: `apps/web/src/pages/chat/sse.ts` — the parser records the first non-empty top-level string `model` from parsed `data:` payloads and exposes it (e.g. `parser.model`), pure and framework-free as today. `turn.ts` assistant partials carry `model?: string`; `index.tsx` threads it into the persisted message and renders it as a muted label under the assistant bubble (public ID only). `conversations.ts` `ChatMessage` gains `model?: string`.
- Server validation with historical-model retention (review Finding 2): `validateMessages` accepts `model` only on `assistant` messages and runs under the conversation row lock. Verified current state: the PUT handler validates the FULL replacement snapshot (`chats.ts:57-99`) BEFORE its `SELECT … FOR UPDATE` transaction (`chats.ts:287-296`), so a model that was valid when saved but has since been unpublished would reject every later full-snapshot save. Corrected semantics:
  - Under the existing row lock (same transaction as the version check and update), read the stored snapshot's assistant `model` values.
  - **Retained** values: a `model` string already present on an assistant message in the stored snapshot passes validation unchanged, even if that model is now unpublished or disabled — history is never invalidated by catalog churn.
  - **Newly introduced** values: a `model` string not present in the stored snapshot must be a member of the **enabled AND published** `models.public_id` set (one catalog lookup per request). Validation is MEMBERSHIP-ONLY in that set — review v3 Finding 1: a legitimate published `public_id` that happens to equal some `models.id` or `slug` is ACCEPTED; strings are never blacklisted by equality with internal IDs (verified: `public_id` is independently stored, `schema.ts:602-627`, and resolution is membership by `public_id`, `catalog.ts:130-155`). Upstream/private/internal-only IDs fail membership because they are not any enabled+published `public_id` — no separate blacklist is needed or used.
  - **Always rejected** (400, no partial write): non-string values and `model` on user messages; plus any string outside the enabled+published `public_id` membership set (which covers every upstream/private/internal-only ID). The browser is untrusted; a forged upstream ID can never be persisted or rendered because it cannot be a member of the public set.
  - Save failure is all-or-nothing: an invalid newly introduced model rejects the entire save with 400; no messages, title, or version bump is written.
- Limits kept: 64 KiB per message content, 512 KiB save body, 500 messages. A save exceeding them fails explicitly (existing 413/400 mapping to `ConversationError`); add a save-failure test for histories over the limit.
- Attachments are never in persisted JSON — persisted content stays plain text (existing behavior; the multimodal content map is session-only).
- Removed/empty assistant history semantics (explicit): an empty assistant partial (failed/aborted turn) is never persisted (`buildPersistMessages` drops it) and is excluded from retry base history (`findRetryTurn` filters `isEmptyAssistant`). A cleared/removed message is gone from the next save snapshot; the save is a full-snapshot replace with optimistic `version` concurrency, so no stale merges. `model` follows its message: a dropped assistant message drops its model too.

### API contract (chats PUT)

Request message objects: `{ role: "user"|"assistant", content: string (≤64KiB), reasoning?: string, model?: string (assistant only, published public ID) }`. Response snapshots return exactly what was stored, so a reloaded conversation renders the stored public model. No other fields accepted.

---

## Part 4 — UI bundle (Finding 5 correction)

### 4a. Destructive animated Alert

- New `apps/web/src/components/ui/alert.tsx`, hand-rolled in the existing ui-component style. No new dependency; the repo already imports `tw-animate-css` (`apps/web/src/index.css:2`) and already scopes custom keyframes under `@media (prefers-reduced-motion: no-preference)` (lines 112-154) — reuse that pattern.
- Variants default/destructive. All attachment and send errors (`attachError`/`setError`, `index.tsx:1070-1074`) render as destructive Alert with `role="alert"` (replacing `role="status"` for errors) and a manual dismiss button.
- Dismissal policy (review Finding 5 — scoped, not blanket): **auto-dismiss (~6 s, cleared on unmount and on manual dismiss) applies ONLY to transient attachment notices** — attachment validation errors (type, per-file size, count, total) that the user immediately fixes and retries. **Persistent (manual dismissal only, or until explicit recovery) :** wallet errors (402), model-not-found (404), generic request/upstream failures, gateway 413, history save failures, version conflict (409), and managed-key errors including the §1c reconnect alert. Verified current mapping: `readableError` routes 402/404/other into `setError` (`index.tsx:185-190`, `:723-727`) — none of those may auto-dismiss, because the user must read the cause and decide (e.g. wait, switch model, reconnect).
- Tests assert observable behavior only: alert visibility, `role="alert"`, message text, manual dismissal, auto-dismiss timer firing, timer cleanup on unmount. No CSS-source or class-string assertions (repo testing rule).

### 4b. Collapsible desktop conversation list

- `index.tsx:852` desktop `<aside>` gains a `collapsed` state persisted in `localStorage` (`chat.sidebar.collapsed`). Collapsed: narrow rail with the toggle and "new chat"; expanded: current 16rem list. Mobile Sheet untouched.
- Toggle carries `aria-expanded`/`aria-controls`; the aside carries `data-state="expanded"|"collapsed"`.
- Tests: toggle flips `data-state` and `aria-expanded`, state persists across remount, list content is reachable when expanded, focus stays usable. No CSS-text assertions.

### 4c. Retry scope

Retry stays last-reply-only (approved minimal scope). `findRetryTurn` semantics unchanged; copy stays. No retry-anywhere.

### 4d. CopyButton

Unchanged — it already copies persisted content for every rendered assistant message (`index.tsx:1005`).

---

## New user-facing copy (bilingual, existing `{en, vi}` dictionary pattern in `index.tsx`)

| Key                                        | en                                                                                                                                    | vi                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `attachTotalTooLarge`                      | `Attachments exceed the 10 MB total limit. Remove something and try again.`                                                           | `Tệp đính kèm vượt giới hạn 10 MB. Hãy bớt rồi thử lại.`                                                              |
| `attachImageTooLarge`                      | `"${name}" is too large (max 10 MB per image).`                                                                                       | `"${name}" quá lớn (tối đa 10 MB mỗi ảnh).`                                                                           |
| `tooLarge` (update)                        | `This message is too large to send — attachments plus history exceed the 16 MB request limit. Remove some attachments and try again.` | `Tin nhắn quá lớn để gửi — tệp đính kèm cộng lịch sử vượt giới hạn 16 MB. Hãy bớt tệp đính kèm và thử lại.`           |
| `dismissAlert`                             | `Dismiss`                                                                                                                             | `Đóng thông báo`                                                                                                      |
| `keyTooLargeTitle`                         | `This chat key has a 1 MB request limit.`                                                                                             | `Chat key này có giới hạn request 1 MB.`                                                                              |
| `keyTooLargeBody`                          | `Attachments this large need a new chat key. Reconnect to create one — your message stays here, nothing is deleted.`                  | `Tệp đính kèm cỡ này cần chat key mới. Kết nối lại để tạo key — tin nhắn của bạn vẫn còn nguyên, không có gì bị xóa.` |
| `keyTooLargeAction`                        | `Reconnect`                                                                                                                           | `Kết nối lại`                                                                                                         |
| `restoreDraftAction`                       | `Restore original draft`                                                                                                              | `Khôi phục bản nháp ban đầu`                                                                                          |
| `restoreDraftConfirm`                      | `Restoring replaces what you have typed since. Restore the original draft and attachments?`                                           | `Khôi phục sẽ thay những gì bạn vừa gỡ/thêm. Khôi phục bản nháp và tệp đính kèm ban đầu?`                             |
| `collapseSidebar` / `expandSidebar`        | `Collapse conversation list` / `Expand conversation list`                                                                             | `Thu gọn danh sách hội thoại` / `Mở rộng danh sách hội thoại`                                                         |
| `attachHint` (update of `ATTACHMENT_HINT`) | `PNG, JPEG, WebP or GIF images and text/code files up to 64 KB; up to 4 files, 10 MB total per message.`                              | `Ảnh PNG, JPEG, WebP hoặc GIF và tệp văn bản/mã nguồn tối đa 64 KB; tối đa 4 tệp, tổng 10 MB mỗi tin nhắn.`           |

Existing copy kept: `unsupportedMessage`, `tooLargeTextMessage` (64 KiB text), `ATTACHMENT_RETENTION_NOTICE`, `keyReconnectFresh`.

---

## Compatibility, reuse, migrations, contracts

- **Migrations**: exactly one — `0013_api_keys_purpose.sql`, additive, default `'generic'`, forward-only, registered in `_journal.json`. No data backfill needed (every existing key is generic by definition). Message `model` needs none.
- **Key reuse**: stored browser chat keys minted before this change are generic-purpose and keep working at 1 MiB indefinitely — no forced upgrade. Legacy persisted records without `purpose` metadata restore as `generic`; `/chat-key` mints carry explicit `purpose: "chat"`. Oversized sends on a generic key surface the persistent reconnect alert + rollback (§1c); reconnect clears only browser cache and the next explicit send mints a chat-purpose key via `/chat-key`. The old server-side key is never auto-revoked. `clearManagedChatKey` and identity-scoped storage behavior unchanged. Client purpose metadata is UX state only; server `api_keys.purpose` is the sole authorization/cap authority.
- **Side-effect-free preflight**: oversized gateway requests (declared or streamed gate) cause no DB write — `last_used_at` updates only after both gates pass (§1b); no rate-limit slot, reservation, or ledger activity for rejected bodies.
- **Historical models**: catalog churn never invalidates saved history — models already present in a stored snapshot are retained through unpublished/disabled transitions; only newly introduced values are gated on enabled+published (§3).
- **API contracts**: `verifyApiKey` returns one added field; `/v1/*` error codes unchanged (`payload_too_large` 413, `invalid_api_key` 401). Chats PUT validation strictly widens (accepts one previously-dropped field on assistant messages, validated). `/chat-key` response mirrors the existing `/keys` create response shape.
- **Negative behavior**: wrong-purpose or oversized requests get 413; unauthenticated large bodies get 401 with no `read()`; forged/non-public `model` gets 400; oversize text file and count/total busts reject before any file read; a doomed pre-send body blocks with the updated `tooLarge` alert and issues no fetch.
- **Races**: parallel sends stay serialized by `busyRef`; concurrent saves stay guarded by optimistic `version` (409 → reload, never overwrite); retry-while-streaming is impossible under last-reply-only + busy guard; oversize request + rate-limit failure still uncopies the tentative limiter slot (`uncountSubscriptionRateLimit` paths at `v1-gateway.ts:540-545`).

## Memory

- Server: worst case one 16 MiB buffered body per in-flight chat request plus the existing one-shot `scrubJsonStrings` copy on the parsed body (per request, not per chunk); streaming path scrubs per `data:` line as today. Acceptable at single-instance scale; profiling follow-up only, no code now.
- Client: bounded by 10 MiB raw total / 4 files; encoded strings ≈ 28 MiB RSS worst case for one image; cleared after send; never persisted.

## Testing (behavioral; source files referenced by name, no source-text assertions)

Gateway (`tests/`, uses the fake CPA, never a real provider):

1. Invalid auth + 2 MiB streamed body → 401, and the stream is never read (`read()` not called).
2. Valid generic key + 2 MiB body → 413 `payload_too_large`; **no `last_used_at` write occurs**; no rate-limit slot consumed; no reservation created.
3. Valid generic key + 2 MiB body with a lying/large declared Content-Length → 413 from the declared gate with the same no-side-effect assertions.
4. Chat-purpose key + `/v1/chat/completions` at 16 MiB−ε → proceeds to dispatch; at 16 MiB+ε → 413 with `bodyReader.cancel()` called (spy on cancel) and no `last_used_at` write.
5. Chat-purpose key + `/v1/responses` → 413 at >1 MiB (purpose does not leak across paths).
6. Valid request under the resolved cap → `last_used_at` update happens exactly once, after the gates (ordering assertion).
7. Missing/dishonest `Content-Length` still hits the streamed cap with cancel.
8. Scrub still applied to a large base64 body and to stream chunks on the 16 MiB path.
9. Overflow fixture: model with small `context_window` + high price such that bounded `capVnd > maxStoredMoney` → 400/`overflow` path, no dispatch, no ledger entry; reservation release on post-reservation failure; existing concurrent double-spend tests stay green.

Web attachments/units:

1. 10 MiB total accepted; 10 MiB + 1 byte rejected before any `arrayBuffer()`/`text()`; four files aggregating 10 MiB accepted; five files or aggregate over 10 MiB rejected with `attachTotalTooLarge`.
2. **Whole-batch preflight**: a batch whose SECOND file is invalid (bad type or oversize) rejects before the FIRST file is read — no read call for any file in the batch (read spy).
3. Text contract unchanged: >64 KiB text file rejects; accepted text inlines truncated to 16 KiB UTF-8-safe.
4. Pre-send guard: attachment + history over 16 MiB blocks before key mint, conversation create, or fetch; error copy matches `tooLarge`.

Model persistence:

1. SSE parser returns the public `model` from chunks; persisted assistant JSON contains it; reloaded snapshot renders it; a forged upstream/private/unknown or user-message `model` is rejected 400 and never rendered; no upstream ID appears in DOM or response body.
2. **Membership-only validation**: a newly introduced `public_id` that EQUALS some `models.id` or `slug` but is itself enabled+published is ACCEPTED (fixture model where `public_id === id`); a string matching only an internal ID/slug (not any published `public_id`) is rejected 400 — no equality blacklist on either side.
3. **Historical retention**: save a snapshot with public model M; M becomes unpublished in the catalog; the next full-snapshot save retaining M succeeds (M kept, rendered unchanged on reload).
4. **Mixed snapshot**: one retained-but-unpublished model + one newly introduced published model → save succeeds; newly introduced **unpublished** model → 400, nothing written (version unchanged, messages unchanged).
5. **Purpose metadata**: legacy persisted `ManagedKey` records without `purpose` restore as `"generic"`; a `/chat-key` response without `purpose: "chat"` is treated as `invalid` (never trusted); metadata mismatch (client says chat, server says generic) degrades to the generic 413 flow — never an authorization bypass.
6. Save over 512 KiB / 64 KiB per message fails explicitly (`ConversationError`), nothing partially persisted.

UI:

1. Alert: destructive variant renders `role="alert"` with the attachment error; manual dismiss works; auto-dismiss timer fires; timer cleared on unmount.
2. **Dismissal scope**: attachment validation errors auto-dismiss after the timer; wallet (402), model-not-found (404), generic request failure, 413, save failure, 409 conflict, and reconnect alerts do NOT auto-dismiss — still visible after the timer, dismissed only manually or via explicit recovery.
3. **413 reconnect flow**: generic-purpose key + 413 → persistent reconnect alert with `Reconnect` action; action clears only browser-managed-key state (no API call — assert no fetch); no automatic re-send of the failed request; next explicit send mints via `/chat-key`; old key not revoked (no DELETE/revoke call).
4. **413 rollback (revision-gated)**: unchanged revision (no user mutation; the programmatic pre-fetch clear does not count) → wholesale restore, NO user turn persisted (version/messages unchanged), empty first-turn conversation adopted as a fresh chat; changed revision (user text edit / attachment pick / remove after the clear) → newer draft kept, recoverable snapshot + explicit confirmed restore only; stale 413 after conversation switch / identity/workspace switch / newer send → snapshot discarded silently, no restore, no erase; resend after reconnect persists exactly one user turn (no duplication).
5. Sidebar: `data-state`, `aria-expanded`, persistence across remount, keyboard focus behavior.

## Examples

- Single 9 MiB PNG: accepted (≤10 MiB total) → data URL ≈ 12 MiB → JSON body with modest history < 16 MiB → chat-purpose key dispatch OK. Same message with a generic key: 413.
- Four 2.5 MiB files (10 MiB total): accepted. Adding any fifth file or a 0.5 MiB file to the four: rejected before reads.
- 9 MiB PNG + 400 KiB of prior history text: JSON ≈ 12.6 MiB < 16 MiB → OK. With 4 MiB history: > 16 MiB → blocked client-side by the pre-send guard, `tooLarge` alert, no fetch.
- Vision hold: body 13 MiB, model context 128K → `maxInputTokens = 131072` (clamped), `capVnd` from that bound and the model's price — money-safe, possibly large hold, unchanged math.

## Self-review

- Implementation order (for the later plan, not this spec): migration + purpose + `/chat-key` route → gateway side-effect-free preflight + resolved cap + tests → web key route switch + purpose metadata + 413 reconnect flow with rollback + tests → whole-batch attachment preflight + limits + pre-send guard + tests → SSE model capture + historical-retention membership-only validation + tests → Alert with scoped dismissal + tests → sidebar collapse + tests.

## Self-review (revision 3)

- Revision 2 findings all retained (gateway side-effect-free preflight, historical retention, manual reconnect, whole-batch preflight, scoped dismissal).
- Revision 3 — all 3 final-review P1s addressed at spec level, no implementation:
  1. **Membership-only model validation** (§3): new values validated solely by enabled+published `public_id` membership; removed the `id`/`slug` equality blacklist so a legitimate published `public_id === models.id` is accepted; upstream/private IDs still fail via membership. Test: model persistence test 2 (both directions).
  2. **Reliable local key purpose** (§1a, §1c): `ManagedKey` + persisted records carry explicit `purpose`; legacy records restore as `generic`; `/chat-key` response requires `purpose: "chat"`; metadata is UX-scope only, never authorization trust; mismatch degrades to the generic flow. Tests: model/purpose metadata test 4.
  3. **413 send rollback** (§1c): snapshot before the pre-fetch clear; guarded restore of draft + attachments; skip terminal save so the failed turn is never persisted and resend cannot duplicate the user message; empty first-turn conversation adopted as a fresh chat (no destructive cleanup); stale 413s discarded under identity/conversation/generation guards. Tests: UI test 4 + dedicated delayed-413/identity-switch tests in §1c.

## Self-review (revision 4) — delta comment

- Narrow correction only; nothing else from revisions 1-3 changed.
- Gap found: revision 3's identity/conversation/generation guards are insufficient because the composer stays editable while the request is pending — a 413 arriving after the user typed or changed attachments would have wholesale-restored over their later edits.
- Correction (§1c + UI test 4): a per-composer **draft revision** counter increments on every draft mutation (typing, paste, clear, attachment pick, remove); the pre-send snapshot carries the revision at capture. Unchanged revision ⇒ wholesale automatic restore (previous behavior, now proven safe). Changed revision ⇒ the newer draft is never touched automatically; the snapshot is held as a recoverable copy with an explicit **Restore original draft** action that requires confirmation before overwriting. Equivalent snapshot-compare spelling is noted as an alternative, but the counter is the specified mechanism (O(1), immune to edit-then-undo).
- New copy: `restoreDraftAction`, `restoreDraftConfirm` (bilingual, existing dictionary pattern).
- New race tests in §1c: text edit after clear; attachment remove/add after clear; conversation and workspace/identity switch discard the recoverable snapshot. No automatic resend, no key revoke, no history duplication in any path.
- No additional infrastructure: the revision counter is one integer in existing composer state; the recoverable snapshot is the same captured object held instead of dropped; no new storage, dependency, endpoint, or migration.

## Self-review (revision 5) — delta comment

- Single narrow fix for the GLM review P1 (spec-level ordering ambiguity); nothing else from revisions 1-4 changed.
- Gap found: §1c previously said the revision counter increments on "EVERY draft mutation — typing, paste, clear, …" while the snapshot was captured BEFORE the send flow's own pre-fetch clear. Read literally, the programmatic `setInput("")`/`applyAttachments([])` would bump the live revision after capture, making every send present as "changed revision" and the unchanged-revision wholesale restore path unreachable.
- Correction (§1c + §1c tests): the counter increments on USER mutations only (typing, paste, user-initiated clear, pick, remove); the programmatic pre-fetch clear does not increment; the comparison baseline (revision value) is captured AFTER the programmatic clear while the pre-send snapshot (original draft text + attachments) is preserved for recovery — the recovery snapshot is never replaced with empty post-clear values. Wording "EVERY mutation" replaced everywhere with user-mutation semantics; the changed-revision branches now say "USER typing/pick/remove".
- New test: unchanged baseline after the programmatic clear — a send with zero user edits fires the wholesale restore path at 413; only user-initiated clears/edits/picks/removes mark it changed.
- No additional infrastructure: no new state, dependency, endpoint, or migration; same one-integer counter, same captured object, capture point redefined.
- No TBDs, no invented fields, no speculative infrastructure (still exactly one migration — `0013_api_keys_purpose.sql`; NO migration for the response model; one route, one component; client purpose metadata is one added field on an existing record shape, no new storage). Every number traces to an approved decision, existing code, or a review correction. Written user approval is REQUIRED before any plan or implementation work begins.

## Residual risks

- 16 MiB buffered bodies × concurrency is a memory spike at scale; acceptable now, revisit with instance growth.
- Large images produce large VND holds (money-safe, UX-surprising); an instance-configurable per-message cap below 10 MiB is a possible future knob, deliberately not included.
- Stored pre-change chat keys stay generic (1 MiB) forever unless the user explicitly reconnects after a 413; small messages never require action and the old key is never revoked server-side.
