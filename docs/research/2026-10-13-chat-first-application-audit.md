# Chat-first application improvement audit

Status: research and design direction only; implementation not authorized by this document.

Baseline: `2976190ad08095a5910784254081c87cdc1f5701`.
Audit date: 2026-10-13. Repository stayed clean during the investigation.

## Brief

Improve the application across UX/UI, developer experience, performance, and frontend/backend integration. Chat is the priority. Owner selected **everyday assistant use plus developer controls through progressive disclosure**. Preserve the monochrome house identity, React 19/Vite SPA, existing TanStack/shadcn primitives, CPA-owned provider execution, public model privacy, integer VND, append-only financial history, and server authorization.

This audit is not an Open WebUI clone, a frontend framework migration, or a provider-router project.

## Method and evidence

Seven independently scoped native subagent lanes:

1. Chat design / interaction review (Assessment A).
2. Localhost rendered evidence and Impeccable detector (Assessment B).
3. React/JavaScript rendering, loading, and streaming performance.
4. Backend/frontend Chat contract integration.
5. TypeScript/DX, testing, CI, and module architecture.
6. Non-Chat application task journeys.
7. Primary-source design-pattern research.

Parent synthesis checked the reports against current source and six captured screenshots. Findings below distinguish inspected behavior, measured results, and proposals. Subagent prose is not sufficient evidence by itself.

Skills installed at user scope, not application dependencies: `vercel-react-best-practices`, `vercel-composition-patterns`, `typescript-advanced-types`, `better-auth-best-practices`, `better-auth-security-best-practices`. Existing Impeccable, codebase-design, brainstorming, and orchestration skills also informed the audit. Only applicable React SPA guidance is used; Next.js/SSR/SWR migration recommendations do not apply.

### Render evidence

Local fake CPA stack only: CPA8499, API3099, web5199, Chrome9399, PostgreSQL55434. Existing E2E subset passed **12/12**, covering fixture signup/workspace/model/funding, Chat send, reopen, and rename. Stack was stopped afterward.

Screenshots:

- `/tmp/hbr-e2e/shots/chat-desktop-welcome.png` — 1440×900.
- `/tmp/hbr-e2e/shots/chat-desktop-history.png` — 1440×900.
- `/tmp/hbr-e2e/shots/chat-desktop-conversation.png` — 1440×900.
- `/tmp/hbr-e2e/shots/chat-desktop-attachment-chip.png` — 1440×900.
- `/tmp/hbr-e2e/shots/chat-mobile-welcome.png` — 390×844 CSS pixels, DPR2.
- `/tmp/hbr-e2e/shots/chat-mobile-history-sheet.png` — same mobile viewport.

File timestamps confirm capture on 2026-10-13. Assessment B's claimed `2025-07-14` date is incorrect and is not used. Screenshots are temporary local artifacts; paths alone do not constitute durable visual baselines.

Impeccable detector: one run on Chat source and app shell, **0 findings**. This is a mechanical result, not proof of good UX. No injected visual overlay was created.

No captures of actual reasoning/code/long-answer streams were obtained: the fake fixture used for capture did not exercise those states. Mobile soft-keyboard behavior, manual screen readers, and real-provider/OAuth behavior remain unverified.

### Measured rendering baseline

Performance lane measured current production build:

- Main entry approximately 463.7 kB / 150.6 kB gzip.
- Chat chunk approximately 125.9 kB / 42.8 kB gzip.
- Existing markdown benchmark, Bun/jsdom: approximately 8–14 ms per 10 kB update; approximately 77–128 ms per 100 kB update; about 1.9 seconds total across 100 growing-message updates.

These measurements establish parser cost in that environment, not browser interaction latency. A browser performance baseline is required before claiming an improved frame budget or INP.

## Design assessment

Independent Assessment A scores, source-led rather than a user study:

| Heuristic           |  Score /4 | Main gap                                                      |
| ------------------- | --------: | ------------------------------------------------------------- |
| System status       |         3 | Saved/request status is not visible enough                    |
| Real-world language |         2 | Welcome leads with browser-key internals                      |
| User control        |         3 | No earlier-turn edit/fork actions                             |
| Consistency         |         3 | Mixed EN/VI chrome                                            |
| Error prevention    |         3 | Strong 413/409 and attachment guards                          |
| Recognition         |         2 | No history search or remembered settings                      |
| Efficiency          |         1 | No keyboard accelerators                                      |
| Minimalism          |         3 | Main task competes with two rails and technical welcome copy  |
| Error recovery      |         4 | Strong rollback/reconnect/conflict flows                      |
| Help                |         2 | Constraints explained at the wrong moments                    |
| **Total**           | **26/40** | Strong correctness foundations, substantial workflow friction |

Screenshots corroborate a sparse conversation plane, dense global navigation beside a separate Chat history rail, developer-only prompt examples, lengthy infrastructure disclosure above a distant composer, and repeated billing copy. Mobile has suitable touch targets and no horizontal scroll in the captured state, but the technical paragraph dominates the welcome experience. This motivates composition and information-altitude changes, not decorative color or a wholesale rebrand.

## What must be preserved

- Attachment byte validation, serialized file picking, and draft-revision-aware 413 recovery.
- Identity/generation guards and abort on navigation/workspace change.
- Optimistic conversation versions and explicit conflicts; never overwrite a newer saved conversation.
- Terminal-only history saving, not per-token network writes.
- Catalog-authored effort options and public-model validation.
- Sanitized Markdown, denied remote images/raw inputs, and no model-supplied HTML handlers.
- Server-owned purpose of browser Chat keys and existing access controls.
- Billing behavior: retry is another paid request; ambiguous dispatched failures/abort retain the existing full-hold policy.

## Verified findings and proposed work

### A. Chat interface and task flow

1. **Welcome composition and progressive disclosure** — `chat/index.tsx:1370–1384`, `:1677`. Move browser-key/device explanation into reachable connection details; retain a short billing/attachment disclosure near the composer. Mix everyday and developer starter prompts. Keep current brand but make the composer the visual/task anchor.
2. **Remembered model/effort and text drafts** — initial React state and open/reset flow in `chat/index.tsx`. Persist only validated public IDs and allowed efforts. Draft storage must be user/workspace/conversation-scoped, text-only, bounded, and cleared on logout/send as appropriate. Storage lifetime is an owner decision; do not silently put prompt contents in long-lived localStorage.
3. **History retrieval** — `conversation-list.tsx:112–273`. No search exists. A loaded-title filter must say it searches loaded results only; a complete-history promise requires a bounded server query preserving cursor semantics. Group dates and reduce permanent rename/archive button noise.
4. **Message actions** — `chat/index.tsx:1403–1438`, `components/chat-markdown.tsx`. Whole-response copy exists; per-code copy does not. Add accessible, sanitized React-owned code actions. Earlier-turn edit/regenerate semantics require an owner decision; preserving the original with a fork is preferable to silently discarding later turns.
5. **Accessible streaming and localization** — `chat/index.tsx:1391–1393`, attachment retention text, reconnect UI, shell theme label. Suppress per-token announcements while retaining readable completed content and one transition announcement. Merely removing `aria-live` does not remove `role=log`'s implicit live behavior. Confirm with actual screen-reader testing. Translate chrome and ensure closed sheet headings do not precede the active page title.

### B. Streaming performance and maintainability

6. **Growing Markdown reparsed on every update** — `chat/index.tsx:1029–1090`, `components/chat-markdown.tsx:48–56`, `lib/chat-markdown.ts`. Coalesce rendering while accumulating exact content independently; flush synchronously on completion/stop/error. Preserve all generation/identity and persistence guards. rAF batching alone does not make an 88 ms parse cheap: use the measured baseline to decide whether streaming plain-text/stable-block rendering is needed for large replies.
7. **Shared catalog array instability** — `pages/models/data.ts:39–65`. Mapping creates a fresh array each render; memoize on query data only if it demonstrably stabilizes consumers.
8. **Chat route not preloaded** — `lib/prefetch.ts`. Use the existing lazy-route preload seam for Chat instead of introducing another loading framework.
9. **Chat page concentrates unrelated responsibilities** — approximately 1,683 lines. Extract coherent composer, transcript, and send lifecycle modules incrementally with small interfaces. Line count is evidence of review locality problems, not itself a reason for a rewrite. Preserve behavior before visual/feature changes; avoid a new context/state-machine framework unless necessary.

### C. Backend/frontend contract improvements

10. **Attachment history diverges after reload** — `chat/index.tsx:867–886`, `turn.ts:22–42`, `api/routes/chats.ts` text-only message contract. Session-only images are currently intentional and disclosed while attaching, but reopened history lacks durable information about what was omitted. At minimum persist safe attachment metadata/a retention marker, not binary content, so a reload notice is based on facts. Persistent attachments require separately approved storage/retention/access controls.
11. **Member first-send authorization mismatch** — `api/routes/keys.ts:149`, `chat/managed-key.ts:206`. Conversation APIs permit members, but browser key minting requires admin. Choose explicit role gating in the UI or an approved capped member Chat access policy; do not broaden spending permissions silently.
12. **Request correlation missing on some charged error paths** — `v1-gateway.ts:856–869`, `:920–932`. Preserve `x-hbr-request-id` after a request record exists, including full-hold failures. Show actionable support/retry guidance without exposing raw upstream errors.
13. **SSE no-space privacy gap** — `v1-gateway.ts:398–403`. Rewriter handles only `data: `; legal `data:{...}` can bypass model scrubbing. Accept both and test streamed public-ID substitution. The frontend parser already handles both (`chat/sse.ts:66–68`); the report's frontend gap is rejected.
14. **Rename sends the whole transcript** — `conversation-list.tsx:130–141`. Add a small versioned title-only mutation with the same authorization/audit/concurrency rules. Do not infer that stale snapshots can be overwritten.
15. **Typed stream/request outcome metadata** — `chat/sse.ts`, `conversations.ts`, gateway/request log routes. Capture valid token usage/request ID, distinguish 429 from 500, link 402 to top-up. Display server-settled VND cost only from a server-authoritative receipt; token counts alone are not a bill. Missing/ambiguous usage must remain labeled honestly.
16. **Wire contracts duplicated** — client/server Chat message and reasoning DTOs. Share a minimal dependency-safe contract and keep runtime validation. Type-only exports alone do not validate network payloads.

### D. Application UX and DX/integration

17. **Active navigation loses context on model drill-down** — `app-shell.tsx`. Match route segments, not raw arbitrary string prefixes. Localize theme labels and stop avatar hashing from running in render on every shell update.
18. **CI waits until release tags** — `.github/workflows/release.yml:3–7`. Introduce push/PR validation before release; isolate UI test browser globals and run a blocking UI-quality gate. Preserve full-history requirements and avoid fixed host-port collisions with service-container isolation. Do not blindly copy a retry-on-any-error policy.
19. **Test setup load order is an undocumented-at-callsite contract** — `tests/helpers/faithful-api-mock.ts`, `ssr-dom.ts`, `better-auth-client-isolation.ts`. Consolidate a small documented test bootstrap, reproducible teardown, and faithful mocks. Verify runtime behavior; do not rely on source-text assertions or sleeps masking cleanup bugs.
20. **Migration bookkeeping needs a cheap integrity gate** — validate migrator inputs/journal consistency as tooling configuration, plus a real populated upgrade test. This is not a substitute for fresh-database and upgrade behavior checks.

## Audit corrections and exclusions

- Frontend `data:` no-space parsing is already supported; only backend rewriter needs review/fix.
- `role=log` has implicit polite live semantics; deleting its explicit `aria-live` is not a sufficient accessibility fix.
- Attachment-loss detection after reload cannot be reliable without a persisted marker/metadata. Do not promise a conditional notice inferred from now-missing memory.
- Existing 512 KiB conversation save cap means rename traffic is bounded there, not by the gateway's 16 MiB multimodal cap.
- SessionStorage survives a page reload; it normally clears when the tab session ends. Defaulting to sessionStorage must not be described as reminting on every reload.
- CSS content-visibility reduces layout/paint, not React Markdown parsing. Avoid claiming it solves scripting cost or adopting a percentage target without a browser baseline.
- Static SameSite cookie analysis does not establish comprehensive custom-route CSRF protection. Cover origin/content-type policy, same-site scenarios, and proxy configuration when authorizing new mutations.
- A helper export test is not rendered UI interaction coverage; new message actions/drag/filter flows need actual behavior tests.
- Supplied PRODUCT/DESIGN records are stale in places (including live OAuth assumptions). Do not repair/rewrite them as an unasked side effect.
- No new raw reasoning-chain content, tool execution, MCP, voice, RAG, marketplace, or provider adapters are implied by Chat design research.

## Recommended phased roadmap (not an approved implementation plan)

### Phase 0 — safety and trustworthy baselines

Blocking push/PR checks; deterministic UI fixture/teardown; fake streams containing code/reasoning/long replies and failure types; record desktop/mobile/theme baselines and browser performance; gateway request correlation and no-space SSE scrub tests.

### Phase 1 — coherent Chat modules and responsive rendering

Shared wire contracts and runtime parsing; extract composer/send/transcript seams while keeping behavior; coalesce rendering; stable catalog data; route preload; terminal flush and exact persistence tests. No broad rewrite.

### Phase 2 — everyday assistant workspace

Compact composer-centered layout; remembered model/effort; scoped recoverable text draft; history search; keyboard shortcuts; translated notices; actionable 402/429 errors; accessible status/live regions; versioned title-only rename.

### Phase 3 — developer details and per-message controls

Advanced settings drawer/popover with catalog-backed capabilities and thinking effort; per-code copy; request ID and valid tokens; server-settled cost receipt if approved; edit/rerun with chosen preserve/fork semantics; safe contextual help and no hidden billing changes.

### Phase 4 — attachment/access policy and surrounding application polish

Implement selected member-access and attachment-retention policy, including auth/storage tests. Improve shell active-state/wayfinding, model discovery, key policy form feedback, analytics/error consistency, and test/documentation DX only where audits establish specific benefit.

### Phase 5 — bounded integration and release acceptance

One integration owner merges dependency-ordered commits. Independent security/billing review. One batched desktop/mobile/light/dark visual review with at most one correction confirmation pass; screen-reader spot-check. Full tests, direct typechecks, check, production build and isolated E2E after all implementation. Publish only when explicitly requested.

## Parallel execution shape

- Baseline/test tooling lane: CI, test fixtures/helpers, performance scenario.
- Backend contracts lane: request headers/SSE, title/search/receipt contracts, shared server validation.
- Chat lifecycle lane: composer/send/transcript modules, cancellation, recovery, render coalescing.
- Message rendering lane: code copy, safe Markdown rendering, accessibility.
- History/settings lane: retrieval, preference/draft persistence, identity-scoped storage.
- App shell/general UX lane: nav/labels/avatar and approved non-Chat refinements.
- Integration owner: contracts, schemas, root manifest/lockfile and final gates.

These are ownership groups, not permission for concurrent edits to `chat/index.tsx`. First extract agreed seams serially or allocate isolated worktrees; then implement independent components in parallel. Runtime reports and SHAs must travel between dependency waves. No writer depends on an API contract that has not landed or been explicitly frozen.

## Acceptance outcomes

- Exact generated/received/persisted content across done, stop, error, workspace switch and 413/409 recovery.
- No automatic duplicate paid request; retry cost disclosed; correlation available on charged failures.
- Model and effort preference restores only valid catalog values; drafts never cross identity/workspace/conversation.
- Accessible primary workflow by keyboard; screen-reader status updates at meaningful transitions, not every token.
- History search scope honest; renamed content never overwrites concurrent messages.
- No secret/private upstream IDs in client state, receipts, errors or developer inspection.
- Streaming/long-history browser traces improve against recorded baseline; parser call-count tests alone are insufficient.
- Mobile portrait/landscape, soft keyboard, long text/code/tables and attachment/reasoning states tested explicitly.
- UI checks block broken changes before a release tag; migration/config errors are diagnosed at the owning gate.

## Primary-source pattern references

- LibreChat message actions: https://www.librechat.ai/docs/features/message_actions
- LibreChat conversation forks: https://www.librechat.ai/docs/features/fork
- Open WebUI documented features: https://docs.openwebui.com/features/
- Open WebUI message queue: https://docs.openwebui.com/features/chat-conversations/chat-features/message-queue.md
- Vercel AI SDK metadata patterns: https://ai-sdk.dev/docs/ai-sdk-ui/message-metadata

Patterns only; no source/assets copied and no SDK adoption implied. Message queueing, folders/tags, and true branching trees are candidates for later scope, not free additions.

## Open owner decisions

1. Keep the global app shell with a refined compact Chat workspace, or provide a focused Chat mode with global navigation initially collapsed?
2. Earlier-message editing: preserve the original by forking, or explicitly replace later turns after confirmation?
3. Attachment policy: session-only with durable metadata/warning, or persistent private attachments with an approved storage/retention design?
4. Shared-workspace member Chat access and prompt-draft storage lifetime require a policy decision before implementation.

The next deliverable is an approved design brief, followed by bounded subsystem specifications and a concrete implementation plan with exact endpoints, types, owners and dependency waves.
