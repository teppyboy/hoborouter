# Streaming Responses + Release CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `stream: true` requests through Hoborouter reach clients (pi-coding-agent, OpenAI SDKs, curl) token by token, not as one block at the end; and the `v0.1.0` release workflow goes green so the image publishes.

**Architecture:** The gateway already builds a pull-based SSE passthrough stream. The global response wrapper in `apps/api/src/app.ts` (`boundaryResponse`) then does `await body.arrayBuffer()` on every successful response, which waits for the whole stream before sending anything. Fix: pass streaming bodies through untouched, keep buffering only for small JSON error bodies. Add anti-buffering headers for proxies, then prove streaming with a test that measures time-to-first-byte against a slow fake upstream.

**Tech Stack:** Bun 1.4 `Bun.serve`, Elysia `2.0.0-exp.64`, Web Streams, `bun:test`, GitHub Actions, PostgreSQL 17.

**Spec:** User request 2026-10-03: "I can't see it stream response to my pi-coding-agent, it only respond the full text, but I want streaming." Plus the failed release run `37054262196` (156 test failures in CI).

## Global Constraints

- No new dependencies. Never touch the owner's uncommitted `bun.lock` or the `CPA_BASE_URL` line in `deploy/docker-compose.yml`.
- Money invariants unchanged: settlement stays durable before the stream closes, client abort still gives `full_hold`, upstream is still aborted on client cancel.
- Upstream model IDs must never reach the client in streamed chunks (`sseModelRewriteStream` stays).
- Non-streaming responses and every JSON error body keep their current behaviour and headers (`x-hbr-request-id`, stripped tracing headers, normalized error shape).
- Tests: behavior tests only, run against Postgres via `createTestDb()`; `PORT=3998 bun test --parallel=4` must stay green.

## Review Focus

1. **Slow upstream:** first SSE chunk must reach the client while later chunks are still pending (pi-coding-agent's case). Test: first chunk received before upstream releases the second.
2. **Client disconnect mid-stream:** upstream fetch aborted and request settled `full_hold` exactly once, with the new passthrough path.
3. **Reverse proxies (nginx, Caddy, Cloudflare):** SSE responses carry `cache-control: no-cache` and `x-accel-buffering: no` so a proxy in front of the VPS does not re-buffer.
4. **Long generations:** `Bun.serve` default `idleTimeout` (10 s) closes a connection that sends nothing for 10 s, which can kill slow reasoning streams before their first token. Set an explicit idle timeout and test that the gateway's own SSE responses are not cut by it.
5. **Error during stream:** a stream that errors mid-way still sends the bytes already produced, then terminates; the boundary must not convert it to a JSON 500.

---

### Task 1: Make the response boundary stream-safe

**Files:**
- Modify: `apps/api/src/app.ts` (`boundaryResponse`, lines ~229–253)
- Test: `apps/api/test/streaming.test.ts` (new)

**Interfaces:**
- Produces: `boundaryResponse` passes `source.body` through as a stream when `json === false`; only `json === true` builds a buffered body.

- [ ] **Step 1: Write the failing test** `streaming.test.ts > "first SSE chunk arrives before upstream finishes"`: fake CPA returns a `ReadableStream` that enqueues chunk 1 (`data: {"choices":[{"delta":{"content":"A"}}]}`), then waits on a promise the test controls. The test calls `app.handle(...)` for `/v1/chat/completions` with `stream: true`, reads the first chunk from `res.body.getReader()` with a 2 s timeout, asserts it contains `"A"`, then releases chunk 2 + `data: [DONE]` and asserts the rest arrives and the request is settled.
- [ ] **Step 2: Run** `PORT=3998 bun test apps/api/test/streaming.test.ts`. Expected: FAIL (timeout on first chunk) on the current code.
- [ ] **Step 3: Implement.** In `boundaryResponse`, when `json` is false and `body instanceof Response`, return `new Response(body.body, { status, headers })` instead of `await body.arrayBuffer()`. Keep `noBody` handling and header copying unchanged.
- [ ] **Step 4: Run** the new test plus `gateway.test.ts`, `gateway-timing.test.ts`, `security.test.ts`, `app.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(api): stream responses through the boundary instead of buffering`.

### Task 2: Anti-buffering headers and idle timeout

**Files:**
- Modify: `apps/api/src/routes/v1-gateway.ts` (stream `Response` headers, lines ~617–625)
- Modify: `apps/api/src/index.ts` (`Bun.serve` options)
- Test: `apps/api/test/streaming.test.ts`

**Interfaces:**
- Produces: streamed gateway responses carry `content-type: text/event-stream`, `cache-control: no-cache`, `x-accel-buffering: no`, `x-hbr-request-id`.
- Produces: `Bun.serve({ idleTimeout: Number(process.env.HBR_IDLE_TIMEOUT_S) || 255 })`. 255 s is Bun's maximum.

- [ ] **Step 1: Write failing test** `"stream response has anti-buffering headers"`: assert the three headers on a streamed response, and that non-stream responses are unchanged.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** headers; `idleTimeout` in `index.ts`. Document `HBR_IDLE_TIMEOUT_S` in `docs/development.md` env list.
- [ ] **Step 4: Run** streaming + gateway tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): SSE anti-buffering headers and long idle timeout`.

### Task 3: Streaming regression coverage

**Files:**
- Modify: `apps/api/test/streaming.test.ts`
- Modify: `tests/fake-cpa.ts` (optional `HBR_FAKE_CPA_CHUNK_DELAY_MS` env: delay between SSE chunks, default 0)

- [ ] **Step 1: Tests:**
  - `"client cancel mid-stream after first chunk: upstream aborted, full_hold once"`, using the controllable slow upstream from Task 1.
  - `"upstream error mid-stream: already-sent bytes delivered, stream terminates, no JSON 500 body"`.
  - `"Responses API stream also streams incrementally"` (same first-chunk-before-finish check on `/v1/responses`).
  - `"streamed chunks never contain the upstream model id"`.
- [ ] **Step 2: Run** the file. Expected: PASS after Tasks 1–2.
- [ ] **Step 3: Commit** `test(api): streaming regressions (ttfb, cancel, mid-stream error, responses)`.

### Task 4: End-to-end streaming check through the real server

**Files:**
- Modify: `tests/e2e/ui.ts` (one new step) or new `tests/e2e/stream-check.ts` called from the existing E2E step list
- Uses: `tests/fake-cpa.ts` with `HBR_FAKE_CPA_CHUNK_DELAY_MS=300`

- [ ] **Step 1:** Add E2E step `"gateway streams incrementally over HTTP"`. Through the real API port (3099), with a real API key created earlier in the run, POST `stream: true` with `fetch`. Record the arrival time of every chunk. Assert ≥ 2 chunks, and the first content chunk arrives at least 200 ms before the last.
- [ ] **Step 2: Run** `E2E_CPA_PORT=8499 bun run e2e`. Expected: 40/40 pass.
- [ ] **Step 3: Commit** `test(e2e): verify gateway streams over real HTTP`.

### Task 5: Make the release workflow green

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `tests/sqlite-to-pg.test.ts`
- Test: rerun the workflow on tag `v0.1.0` (delete and recreate the tag only after it passes locally under the same steps)

Root causes from run `37054262196`:
1. 152 of 156 failures: `ENOENT ... apps/web/dist`. `buildApp` mounts `staticSpa(webDist)`, which `realpathSync`s the dist folder, and CI never builds the web app before testing.
2. `tests/sqlite-to-pg.test.ts` runs `git show 3af6325:...`. `actions/checkout@v4` makes a depth-1 clone, so the commit doesn't exist.

- [ ] **Step 1:** In `release.yml` test job, add `run: cd apps/web && bun run build` before tests. Set `fetch-depth: 0` on checkout. Use one Postgres service with `--max-connections` raised. `HBR_TEST_DATABASE_URL` must point at the `postgres` admin database (createTestDb creates its own databases).
- [ ] **Step 2:** `staticSpa` must not crash when dist is missing. If `webDist` does not exist, skip the SPA mount and log once. Add a test: `buildApp` with `HBR_WEB_DIST` pointing to a missing folder still serves `/healthz` 200 and `/v1/models` 401. Owned: `apps/api/src/app.ts` (two lines) and `apps/api/test/app.test.ts`.
- [ ] **Step 3:** Run the workflow's exact steps locally (fresh `git clone --depth 1` into a temp dir, then the same commands) to prove it passes. With `fetch-depth: 0` the sqlite test finds `3af6325`.
- [ ] **Step 4: Commit** `ci(release): build web before tests, full history, tolerate missing dist`.
- [ ] **Step 5:** Push `main`. Move tag `v0.1.0` to the new commit (`git tag -f v0.1.0 && git push -f origin v0.1.0`; the image was never published, so nothing depends on the old tag). Watch the run until it is green and the package `ghcr.io/teppyboy/hoborouter` lists `v0.1.0` and `latest`.

### Task 6: Verify with the real client

- [ ] **Step 1:** With the owner's running dev stack (`bun run dev` + real CPA), run one streaming request with `curl -N` against `http://localhost:3000/v1/chat/completions` and record chunk arrival times. Do not print the API key.
- [ ] **Step 2:** Owner confirms streaming in pi-coding-agent. Note for owner: pi-coding-agent's provider config must be the OpenAI-compatible provider with base URL `http://localhost:3000/v1`. If a reverse proxy sits in front on the VPS, it receives `x-accel-buffering: no` from us.

## Execution order

Tasks 1 → 2 → 3 run in one agent (same files). Task 5 runs in parallel in a second agent (disjoint files except `app.ts`; Task 5 Step 2 is coordinated by giving that two-line change to the Task 1–3 agent). Task 4 runs after 1–3. Then a read-only review of the stream path, then the full gate, then commit and push, then the tag move and release watch.
