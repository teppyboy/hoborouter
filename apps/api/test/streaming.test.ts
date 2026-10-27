// Streaming regressions: SSE must reach the client incrementally through the
// full app boundary (app.handle), not be buffered until the upstream finishes.
// Money behaviour is unchanged: settlement stays durable before stream close,
// client cancel settles full_hold exactly once, upstream gets aborted.
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { createTestDb } from "@hoborouter/db";
import { hashApiKey } from "@hoborouter/keys";
import { q, trackDrop } from "./helpers";
import { buildApp } from "../src/app";

const PLAINTEXT = "sk-hbr-stream-test-key";
const CPA_KEY = "test-cpa-secret";
const CHAT_PATH = "/v1/chat/completions";
const RESPONSES_PATH = "/v1/responses";
const UPSTREAM_MODEL = "gpt-4o-upstream";
const PUBLIC_MODEL = "openai/stream-test";

const ENV_KEYS = ["HBR_GATEWAY_ENABLED", "CPA_BASE_URL", "CPA_ACCESS_KEY", "HBR_USD_VND_RATE"];
let savedEnv: Record<string, string | undefined> = {};

const enc = new TextEncoder();
const dec = new TextDecoder();

const withTimeout = <T>(p: Promise<T>, ms: number, msg: string): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

const chatChunkLine = (content: string) =>
  `data: ${JSON.stringify({
    id: "chatcmpl-s",
    object: "chat.completion.chunk",
    created: 1,
    model: UPSTREAM_MODEL,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`;

const chatStopLine = () =>
  `data: ${JSON.stringify({
    id: "chatcmpl-s",
    object: "chat.completion.chunk",
    created: 1,
    model: UPSTREAM_MODEL,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  })}\n\n`;

const chatUsageLine = () =>
  `data: ${JSON.stringify({
    id: "chatcmpl-s",
    object: "chat.completion.chunk",
    created: 1,
    model: UPSTREAM_MODEL,
    choices: [],
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 100,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    },
  })}\n\n`;

const responsesEvent = (obj: Record<string, unknown>) =>
  `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;

let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let app: Awaited<ReturnType<typeof buildApp>>;
let handler: (req: Request) => Response | Promise<Response> = () =>
  new Response(null, { status: 500 });
let fakeServer: ReturnType<typeof Bun.serve> | null = null;

const post = (path: string, body: unknown, signal?: AbortSignal) =>
  app.handle(
    new Request("http://localhost" + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${PLAINTEXT}`,
      },
      body: JSON.stringify(body),
      signal,
    }),
  );

const lastCharge = async () =>
  (await q(db, "SELECT status FROM billing_reservations ORDER BY ctid DESC LIMIT 1"))[0] as {
    status: string;
  };

const lastRequestStatus = async () =>
  (await q(db, "SELECT status FROM requests ORDER BY created_at DESC, id DESC LIMIT 1"))[0] as {
    status: string;
  };

async function waitFor(fn: () => Promise<boolean>, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not met within timeout");
}

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  trackDrop(t.drop);
  const now = Date.now();
  await q(
    db,
    "INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws-s','s','active',?)",
    now,
  );
  await q(
    db,
    "INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at) VALUES ('wal-s','ws-s','VND',1000000000,0,0,?)",
    now,
  );
  await q(
    db,
    "INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at) VALUES ('key-s','ws-s',?,?,'s','active',?)",
    hashApiKey(PLAINTEXT),
    "sk-hbr-s...",
    now,
  );
  await q(
    db,
    "INSERT INTO models (id, public_id, slug, display_name, provider, context_window, enabled, published, created_at, updated_at) VALUES ('mdl-s',?,?,'Stream Test','openai',128000,true,true,?,?)",
    PUBLIC_MODEL,
    "stream-test",
    now,
    now,
  );
  await q(
    db,
    "INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at) VALUES ('map-s','mdl-s','openai', ?,true,?,?)",
    UPSTREAM_MODEL,
    now,
    now,
  );
  await q(
    db,
    "INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at, retired_at) VALUES ('price-s','mdl-s',1000000,2000000,500000,3000000,1200000,?,NULL)",
    now - 1000,
  );
  app = await buildApp({ db });
  fakeServer = Bun.serve({ port: 0, fetch: (req) => handler(req) });
  process.env.CPA_BASE_URL = `http://127.0.0.1:${fakeServer.port}`;
});

afterAll(() => {
  fakeServer?.stop(true);
});

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.HBR_GATEWAY_ENABLED = "1";
  process.env.CPA_ACCESS_KEY = CPA_KEY;
  process.env.HBR_USD_VND_RATE = "26000";
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await q(db, "UPDATE wallets SET balance = 1000000000, reserved = 0 WHERE id = 'wal-s'");
  await q(db, "DELETE FROM settlements");
});

describe("gateway streaming through the app boundary", () => {
  test("first SSE chunk arrives before upstream finishes (chat)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    handler = () =>
      new Response(
        new ReadableStream({
          async start(c) {
            c.enqueue(enc.encode(chatChunkLine("A")));
            await gate;
            c.enqueue(enc.encode(chatStopLine() + chatUsageLine() + "data: [DONE]\n\n"));
            c.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    const res = await post(CHAT_PATH, {
      model: PUBLIC_MODEL,
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    // With the buffering bug this read blocks until the gate opens (test timeout).
    const first = await withTimeout(
      reader.read(),
      2000,
      "first chunk blocked until upstream finished",
    );
    expect(dec.decode(first.value!)).toContain('"content":"A"');
    release();
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += dec.decode(value, { stream: true });
    }
    expect(rest).toContain("[DONE]");
    await waitFor(async () => (await lastCharge()).status === "settled");
  });

  test("stream response has anti-buffering headers", async () => {
    handler = () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(chatChunkLine("A")));
            c.enqueue(enc.encode(chatStopLine() + chatUsageLine() + "data: [DONE]\n\n"));
            c.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    const res = await post(CHAT_PATH, {
      model: PUBLIC_MODEL,
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(res.headers.get("x-hbr-request-id")).toBeTruthy();
    await res.text();
  });

  test("non-stream response headers unchanged", async () => {
    handler = () =>
      new Response(
        JSON.stringify({
          id: "c1",
          object: "chat.completion",
          model: PUBLIC_MODEL,
          choices: [
            { index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            prompt_tokens_details: { cached_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 0 },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    const res = await post(CHAT_PATH, {
      model: PUBLIC_MODEL,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("x-accel-buffering")).toBeNull();
    expect(res.headers.get("x-hbr-request-id")).toBeTruthy();
    await res.text();
  });

  test("client cancel mid-stream after first chunk: upstream aborted, full_hold once", async () => {
    let upstreamCancelled = 0;
    handler = () =>
      new Response(
        new ReadableStream({
          async start(c) {
            c.enqueue(enc.encode(chatChunkLine("A")));
            await new Promise(() => {}); // never finishes on its own
            c.close();
          },
          cancel() {
            upstreamCancelled++;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    const res = await post(CHAT_PATH, {
      model: PUBLIC_MODEL,
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    const reader = res.body!.getReader();
    const first = await withTimeout(reader.read(), 2000, "first chunk blocked");
    expect(dec.decode(first.value!)).toContain('"content":"A"');
    await reader.cancel();
    await waitFor(async () => (await lastCharge()).status === "settled_full_hold");
    expect(upstreamCancelled).toBe(1);
    expect((await lastRequestStatus()).status).toBe("client_abort");
  });

  test("upstream error mid-stream: sent bytes delivered, stream terminates, no JSON 500 body", async () => {
    // Simulate a mid-stream upstream failure with a dedicated one-shot server
    // that force-stops (abrupt socket close) after the first chunk. Erroring the
    // response stream (c.error) would surface as an unhandled error in the test
    // process; force-stop terminates the connection with no error raised.
    const prevBase = process.env.CPA_BASE_URL;
    const oneShot = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(enc.encode(chatChunkLine("A")));
              // Keep the connection open until the client confirms it has
              // received the response head and this first chunk.
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    process.env.CPA_BASE_URL = `http://127.0.0.1:${oneShot.port}`;
    try {
      const res = await post(CHAT_PATH, {
        model: PUBLIC_MODEL,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = res.body!.getReader();
      const first = await reader.read();
      expect(dec.decode(first.value!)).toContain('"content":"A"');
      oneShot.stop(true);
      await expect(reader.read()).rejects.toThrow();
      await waitFor(async () => (await lastCharge()).status === "settled_full_hold");
      expect((await lastRequestStatus()).status).toBe("upstream_error");
    } finally {
      oneShot.stop(true);
      if (prevBase === undefined) delete process.env.CPA_BASE_URL;
      else process.env.CPA_BASE_URL = prevBase;
    }
  });

  test("Responses API stream also streams incrementally", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    handler = () =>
      new Response(
        new ReadableStream({
          async start(c) {
            c.enqueue(
              enc.encode(
                responsesEvent({
                  type: "response.created",
                  response: { id: "r1", status: "in_progress" },
                }),
              ),
            );
            await gate;
            c.enqueue(
              enc.encode(
                responsesEvent({ type: "response.output_text.delta", delta: "Hello" }) +
                  responsesEvent({
                    type: "response.completed",
                    response: {
                      id: "r1",
                      status: "completed",
                      usage: {
                        input_tokens: 1000,
                        output_tokens: 100,
                        input_tokens_details: { cached_tokens: 0 },
                        output_tokens_details: { reasoning_tokens: 0 },
                      },
                    },
                  }),
              ),
            );
            c.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    const res = await post(RESPONSES_PATH, { model: PUBLIC_MODEL, input: "hi", stream: true });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await withTimeout(
      reader.read(),
      2000,
      "first chunk blocked until upstream finished",
    );
    expect(dec.decode(first.value!)).toContain("response.created");
    release();
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += dec.decode(value, { stream: true });
    }
    expect(rest).toContain("response.output_text.delta");
    await waitFor(async () => (await lastCharge()).status === "settled");
  });

  test("streamed chunks never contain the upstream model id", async () => {
    handler = () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(chatChunkLine("A")));
            c.enqueue(enc.encode(chatStopLine() + chatUsageLine() + "data: [DONE]\n\n"));
            c.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    const res = await post(CHAT_PATH, {
      model: PUBLIC_MODEL,
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    const text = await res.text();
    expect(text).not.toContain(UPSTREAM_MODEL);
    expect(text).toContain(PUBLIC_MODEL);
  });
});
