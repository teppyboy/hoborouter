# tests/

Behavior tests for the monorepo (unit, integration, UI render). Run from repo
root; see `AGENTS.md` for the full command reference.

## Setup and commands

```sh
bun install            # workspaces incl. tests/
bun run db:test:up     # test Postgres (hbr-test-pg, 127.0.0.1:55432)
PORT=3998 bun run test # all tests; PORT avoids a dev backend on :3000
bun run test:gate      # CI gate: everything except tests/ci-cosmetic-ui.txt
bun run test:ui        # only the cosmetic UI/copy tests in that list
```

Tests pick their Postgres from `HBR_TEST_DATABASE_URL` (default
`postgres://postgres:postgres@127.0.0.1:55432/postgres`) and create isolated,
migrated, self-dropping databases via `packages/db/src/testing.ts`
(`createTestDb`). CI uses an ephemeral service container, so there is no
port collision with the dev/test Postgres.

## Test helpers (tests/helpers/)

Load-order-sensitive. If a UI test renders app components, prefer the
one-call bootstrap:

```ts
import { bootstrapUiTest } from "./helpers/bootstrap";
const restore = bootstrapUiTest(); // before importing app modules
afterAll(restore);
```

- `bootstrap.ts` — composes the three helpers below in the correct order
  (Better Auth stubs → faithful document → api mock registration) and returns
  the teardown for `afterAll`. No global assertion weakening; each test file
  still owns its remaining cleanup.
- `better-auth-client-isolation.ts` — seeds listener-free stubs for the three
  Better Auth `Symbol.for` window managers BEFORE app modules load, so delayed
  nanostores unmount cleanup (1000 ms) never touches a deleted
  `globalThis.window` between test files. Call at module load, before imports
  of app code. Stubs are process-lifetime by design.
- `ssr-dom.ts` — `installSsrDom()` installs a faithful jsdom document when
  none exists (Radix captures `document` at first module load) and returns a
  restore function for `afterAll`. No-op (and restores nothing) if a document
  is already present.
- `faithful-api-mock.ts` — registers ONE process-global `mock.module` for
  `apps/web/src/lib/api` whose exports are the genuine module; each test file
  then intercepts requests through its own `globalThis.fetch` harness. First
  registration in the process wins; later calls are no-ops.
- `chat-fixtures.ts` — pure builders for OpenAI-compatible
  `/v1/chat/completions` SSE bodies: `completeStream`, `longContentStream`,
  `fencedCode`, `reasoningDelta`, `usageChunk`, `errorEvent`, `DONE`, plus
  `streamBody` (model/reasoning/usage/no-space options). No server, no
  dependencies: callers deliver the bytes however they like, including
  byte-level splits. Consumed by the fake CPA (`tests/fake-cpa.ts`) and
  parser/stream tests; behavior covered in `tests/chat-fixtures.test.ts`.

## Rules that keep this suite reliable

- Behavior, not implementation: never assert on source file contents or CSS
  text (AGENTS.md).
- No global assertion weakening, no shared mutable state between files, no
  sleeps masking cleanup bugs; every file restores what it changes
  (`afterAll`) — DOM, env, servers.
- Cosmetic UI/copy checks belong in `tests/ci-cosmetic-ui.txt` (one path per
  line, `#` comments) so the fast gate and the UI job stay disjoint.
- New behavior change ⇒ new or updated test in the same PR.

## CI

`.github/workflows/ci.yml` (push/PR, all blocking): `check` job (vp check +
direct `tsc` for api and web + real web build), `test` job (gate on an
ephemeral Postgres service container, retrying only on the exact transient
`PostgresError: Connection closed` marker), `ui` job (blocking cosmetic gate).
Full-history checkout is required (`git show` in tests, build metadata).
`.github/workflows/release.yml` remains the tag-triggered release gate.
