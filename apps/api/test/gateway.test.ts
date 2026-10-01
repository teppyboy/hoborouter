// Paid gateway routes: /v1/chat/completions + /v1/responses against a local
// Bun.serve fake CPA. No real network, no real provider calls. Core behaviors
// only (disabled gate, auth, reservation, settlement, streaming, errors).
import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { createDb, migrate } from "@hoborouter/db";
import { hashApiKey } from "@hoborouter/keys";
import { gatewayRoutes } from "../src/routes/v1-gateway";

const PLAINTEXT = "sk-hbr-gw-test-key";
const CPA_KEY = "test-cpa-secret";
const CHAT_PATH = "/v1/chat/completions";
const RESPONSES_PATH = "/v1/responses";

const ENV_KEYS = [
  "HBR_GATEWAY_ENABLED",
  "CPA_BASE_URL",
  "CPA_ACCESS_KEY",
  "HBR_USD_VND_RATE",
  "HBR_DEFAULT_MAX_OUTPUT_TOKENS",
];
let savedEnv: Record<string, string | undefined> = {};

function seedGateway(db: Database) {
  const now = Date.now();
  db.prepare(
    "INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws-gw','gw','active',?)",
  ).run(now);
  db.prepare(
    "INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at) VALUES ('wal-gw','ws-gw','VND',1000000000,0,0,?)",
  ).run(now);
  db.prepare(
    "INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at) VALUES ('key-gw','ws-gw',?,?,'gw','active',?)",
  ).run(hashApiKey(PLAINTEXT), "sk-hbr-gw...", now);
  db.prepare(
    "INSERT INTO models (id, public_id, slug, display_name, provider, context_window, enabled, published, created_at, updated_at) VALUES ('mdl-a','openai/gw-test','gw-test','GW Test','openai',128000,1,1,?,?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at) VALUES ('map-a','mdl-a','openai','gpt-4o-upstream',1,?,?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at, retired_at) VALUES ('price-a','mdl-a',1000000,2000000,500000,3000000,1200000,?,NULL)",
  ).run(now - 1000);
}

let db: Database;
let gw: (req: Request) => Promise<Response>;

beforeAll(() => {
  db = createDb(":memory:");
  migrate(db);
  seedGateway(db);
  gw = (req) => new Elysia().use(gatewayRoutes(db)).handle(req);
});

const gwr = (path: string, body: unknown, key = PLAINTEXT) =>
  gw(
    new Request("http://localhost" + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );

type Captured = { path: string; headers: Headers; body: string };
let captured: Captured[] = [];
let upstreamAborted = false;
let fakeServer: ReturnType<typeof Bun.serve> | null = null;

function startFakeCpa(handler: (c: Captured) => Response | Promise<Response>) {
  captured = [];
  upstreamAborted = false;
  fakeServer = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const c = { path: new URL(req.url).pathname, headers: req.headers, body: await req.text() };
      captured.push(c);
      return await handler(c);
    },
  });
  process.env.CPA_BASE_URL = `http://127.0.0.1:${fakeServer.port}`;
  return fakeServer;
}

const chatUsage = () => ({
  prompt_tokens: 1000,
  completion_tokens: 100,
  prompt_tokens_details: { cached_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 0 },
});
const chatJson = (usage = chatUsage()) =>
  new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      model: "openai/gw-test",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage,
    }),
    { headers: { "content-type": "application/json", "x-cpa-trace-id": "trace-json-1" } },
  );

const chatSse = () => {
  const chunk = (extra: object) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-2",
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-4o-upstream",
      ...extra,
    })}\n\n`;
  return (
    chunk({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] }) +
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
    chunk({ choices: [], usage: chatUsage() }) +
    "data: [DONE]\n\n"
  );
};

const lastCharge = () =>
  db
    .prepare(
      "SELECT br.cap_vnd, br.status, le.amount FROM billing_reservations br LEFT JOIN ledger_entries le ON le.billing_reservation_id = br.id ORDER BY br.rowid DESC LIMIT 1",
    )
    .get() as { cap_vnd: number; status: string; amount: number | null };

const requestCount = () => (db.prepare("SELECT COUNT(*) c FROM requests").get() as { c: number }).c;

const walletBalance = () =>
  db.prepare("SELECT balance, reserved FROM wallets WHERE id = 'wal-gw'").get() as {
    balance: number;
    reserved: number;
  };

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.HBR_GATEWAY_ENABLED = "1";
  process.env.CPA_ACCESS_KEY = CPA_KEY;
  process.env.HBR_USD_VND_RATE = "26000";
  delete process.env.CPA_BASE_URL;
  delete process.env.HBR_DEFAULT_MAX_OUTPUT_TOKENS;
});

afterEach(() => {
  fakeServer?.stop(true);
  fakeServer = null;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  db.prepare("UPDATE wallets SET balance = 1000000000, reserved = 0 WHERE id = 'wal-gw'").run();
  db.prepare("DELETE FROM settlements").run();
});

afterAll(() => {
  fakeServer?.stop(true);
});

describe("gateway core", () => {
  test("disabled -> 503 gateway_disabled, no DB writes, no fetch", async () => {
    process.env.HBR_GATEWAY_ENABLED = "0";
    startFakeCpa(() => chatJson());
    const before = requestCount();
    const res = await gwr(CHAT_PATH, { model: "openai/gw-test", messages: [] });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("gateway_disabled");
    expect(captured.length).toBe(0);
    expect(requestCount()).toBe(before);
  });

  test("invalid key -> 401 OpenAI-style", async () => {
    const res = await gwr(CHAT_PATH, { model: "openai/gw-test", messages: [] }, "sk-hbr-nope");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { type: string; code: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("invalid_api_key");
  });

  test("insufficient balance -> 402, no fetch, no request rows", async () => {
    startFakeCpa(() => chatJson());
    db.prepare("UPDATE wallets SET balance = 1 WHERE id = 'wal-gw'").run();
    const before = requestCount();
    const res = await gwr(CHAT_PATH, { model: "openai/gw-test", messages: ["x".repeat(50)] });
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "insufficient_balance",
    );
    expect(captured.length).toBe(0);
    expect(requestCount()).toBe(before);
  });

  test("non-stream chat: exact settled charge, one upstream call, model replaced", async () => {
    startFakeCpa(() => chatJson());
    const res = await gwr(CHAT_PATH, {
      model: "openai/gw-test",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-hbr-request-id")).toBeTruthy();
    expect(((await res.json()) as { model: string }).model).toBe("openai/gw-test");
    expect(captured.length).toBe(1);
    expect(captured[0]!.path).toBe(CHAT_PATH);
    expect(captured[0]!.headers.get("authorization")).toBe(`Bearer ${CPA_KEY}`);
    expect(captured[0]!.headers.get("cookie")).toBeNull();
    expect(captured[0]!.headers.get("x-request-id")).toBeNull();
    expect(JSON.parse(captured[0]!.body).model).toBe("gpt-4o-upstream");
    // 1000 input * 1_000_000 + 100 output * 2_000_000 -> 1200 micro USD
    // -> ceil(1200 * 26000 * 1200000 / 1e12) = 38 VND.
    expect(lastCharge().status).toBe("settled");
    expect(lastCharge().amount).toBe(38);
    expect(walletBalance().balance).toBe(1000000000 - 38);
    expect(walletBalance().reserved).toBe(0);
  });

  test("non-stream responses: exact settled charge with splits", async () => {
    startFakeCpa(
      () =>
        new Response(
          JSON.stringify({
            id: "resp-1",
            object: "response",
            status: "completed",
            output: [],
            usage: {
              input_tokens: 500,
              output_tokens: 200,
              input_tokens_details: { cached_tokens: 100 },
              output_tokens_details: { reasoning_tokens: 50 },
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const res = await gwr(RESPONSES_PATH, { model: "openai/gw-test", input: "hi" });
    expect(res.status).toBe(200);
    // (500-100)*1e6 + 100*5e5 + (200-50)*2e6 + 50*3e6 -> 900 micro USD
    // -> ceil(900 * 26000 * 1200000 / 1e12) = 29 VND.
    expect(lastCharge().status).toBe("settled");
    expect(lastCharge().amount).toBe(29);
  });

  test("stream: SSE passthrough byte-identical + settled, usage option injected", async () => {
    const sse = chatSse();
    startFakeCpa(() => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
    const res = await gwr(CHAT_PATH, {
      model: "openai/gw-test",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(sse);
    expect(JSON.parse(captured[0]!.body).stream_options.include_usage).toBe(true);
    expect(lastCharge().status).toBe("settled");
    expect(lastCharge().amount).toBe(38);
  });

  test("client abort mid-stream -> full hold + upstream aborted", async () => {
    startFakeCpa(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"x":1}\n\n'));
            },
            cancel() {
              upstreamAborted = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const res = await gwr(CHAT_PATH, {
      model: "openai/gw-test",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 100));
    expect(upstreamAborted).toBe(true);
    const last = db
      .prepare("SELECT status FROM requests ORDER BY created_at DESC, id DESC LIMIT 1")
      .get() as { status: string };
    expect(last.status).toBe("client_abort");
    expect(lastCharge().status).toBe("settled_full_hold");
  });

  test("upstream 500 -> status passthrough + full hold", async () => {
    startFakeCpa(() => new Response("boom", { status: 500 }));
    const res = await gwr(CHAT_PATH, { model: "openai/gw-test", messages: [] });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("boom");
    const last = db
      .prepare("SELECT status FROM requests ORDER BY created_at DESC, id DESC LIMIT 1")
      .get() as { status: string };
    expect(last.status).toBe("upstream_error");
    expect(lastCharge().status).toBe("settled_full_hold");
  });

  test("upstream body read failure after headers -> 502 + full hold", async () => {
    let server: ReturnType<typeof Bun.serve> | null = null;
    startFakeCpa(() => {
      // Send headers, then kill the connection mid-body.
      setTimeout(() => server?.stop(true), 20);
      return new Response(new ReadableStream({ start() {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    server = fakeServer;
    const res = await gwr(CHAT_PATH, { model: "openai/gw-test", messages: [] });
    expect(res.status).toBe(502);
    expect(lastCharge().status).toBe("settled_full_hold");
    fakeServer = null;
  });

  test("fetch throw after dispatching -> 502 + full hold", async () => {
    process.env.CPA_BASE_URL = "http://127.0.0.1:1"; // nothing listens
    const res = await gwr(CHAT_PATH, { model: "openai/gw-test", messages: [] });
    expect(res.status).toBe(502);
    expect(lastCharge().status).toBe("settled_full_hold");
  });
});
