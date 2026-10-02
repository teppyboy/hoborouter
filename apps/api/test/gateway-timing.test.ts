// Regression: gateway records latency_ms / ttft_ms on usage settlements.
// Streams: ttft = first real generated token event (not role-only/usage/ping);
// non-stream: ttft NULL (not applicable), latency measured. Monotonic clock:
// latency_ms >= ttft_ms always. No real upstream — isolated fake CPA.
import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { Elysia } from "elysia";
import { createTestDb } from "@hoborouter/db";
import { hashApiKey } from "@hoborouter/keys";
import { q, trackDrop, makeApp } from "./helpers";
import { gatewayRoutes } from "../src/routes/v1-gateway";

const PLAINTEXT = "sk-hbr-gw-timing-key";
const CPA_KEY = "test-cpa-secret";
const CHAT_PATH = "/v1/chat/completions";

const ENV_KEYS = ["HBR_GATEWAY_ENABLED", "CPA_BASE_URL", "CPA_ACCESS_KEY", "HBR_USD_VND_RATE"];
let savedEnv: Record<string, string | undefined> = {};

async function seedGateway(db: Awaited<ReturnType<typeof makeApp>>["db"]) {
  const now = Date.now();
  await q(db, 
    "INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws-gw-t','gw-t','active',?)",
now);
  await q(db, 
    "INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at) VALUES ('wal-gw-t','ws-gw-t','VND',1000000000,0,0,?)",
now);
  await q(db, 
    "INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at) VALUES ('key-gw-t','ws-gw-t',?,?,'gw-t','active',?)",
hashApiKey(PLAINTEXT), "sk-hbr-gw...", now);
  await q(db, 
    "INSERT INTO models (id, public_id, slug, display_name, provider, context_window, enabled, published, created_at, updated_at) VALUES ('mdl-t','anthropic/claude-mythos-5','claude-mythos-5','Mythos 5','anthropic',128000,true,true,?,?)",
now, now);
  await q(db, 
    "INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at) VALUES ('map-t','mdl-t','anthropic','claude-mythos-5-upstream',true,?,?)",
now, now);
  await q(db, 
    "INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at, retired_at) VALUES ('price-t','mdl-t',1000000,1000000,100000,100000,1000000,?,NULL)",
now - 1000);
}

let db: Awaited<ReturnType<typeof makeApp>>["db"];
let gw: (req: Request) => Promise<Response>;

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  trackDrop(t.drop);
  await seedGateway(db);
  gw = (req) => new Elysia().use(gatewayRoutes(db)).handle(req);
});

const gwr = (body: unknown) =>
  gw(
    new Request("http://localhost" + CHAT_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${PLAINTEXT}` },
      body: JSON.stringify(body),
    }),
  );

const USAGE = { prompt_tokens: 5, completion_tokens: 7 };

const sse = async function* () {
  const chunk = (extra: object) =>
    `data: ${JSON.stringify({
      id: "c1",
      object: "chat.completion.chunk",
      model: "claude-mythos-5-upstream",
      ...extra,
    })}\n\n`;
  // Meta first: role-only, ping comment, empty content — none is a first token.
  yield chunk({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
  yield ": ping\n\n";
  yield chunk({ choices: [{ index: 0, delta: { content: "" }, finish_reason: null }] });
  await Bun.sleep(2); // minimal fake gap so ttft < latency observably
  yield chunk({ choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] });
  await Bun.sleep(2);
  yield chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  yield chunk({ choices: [], usage: USAGE });
  yield "data: [DONE]\n\n";
};

let fakeServer: ReturnType<typeof Bun.serve> | null = null;
function startFakeCpa(handler: () => Response) {
  fakeServer = Bun.serve({ port: 0, fetch: () => handler() });
  process.env.CPA_BASE_URL = `http://127.0.0.1:${fakeServer.port}`;
}

const lastUsageLog = async () =>
  (await q(db, 
      "SELECT status, latency_ms, ttft_ms FROM usage_logs ORDER BY ctid DESC LIMIT 1",
    ))[0] as { status: string; latency_ms: number | null; ttft_ms: number | null };

const finitePositive = (n: number | null) => n !== null && Number.isFinite(n) && n >= 0;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.HBR_GATEWAY_ENABLED = "1";
  process.env.CPA_ACCESS_KEY = CPA_KEY;
  process.env.HBR_USD_VND_RATE = "26000";
  delete process.env.CPA_BASE_URL;
});

afterEach(async () => {
  fakeServer?.stop(true);
  fakeServer = null;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await q(db, "DELETE FROM settlements");
  await q(db, "UPDATE wallets SET balance = 1000000000, reserved = 0 WHERE id = 'wal-gw-t'");
});

afterAll(() => {
  fakeServer?.stop(true);
});

describe("gateway timing fields", () => {
  test("stream: ttft positive finite, latency >= ttft, persisted in usage_logs", async () => {
    startFakeCpa(
      () => new Response(sse() as unknown as ReadableStream, { headers: { "content-type": "text/event-stream" } }),
    );
    const res = await gwr({
      model: "anthropic/claude-mythos-5",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    expect(res.status).toBe(200);
    await res.text();
    const log = await lastUsageLog();
    expect(log.status).toBe("ok");
    expect(finitePositive(log.ttft_ms)).toBe(true);
    expect(finitePositive(log.latency_ms)).toBe(true);
    expect(log.latency_ms! >= log.ttft_ms!).toBe(true);
  });

  test("all-in-one chunk stream: ttft captured before settlement", async () => {
    // One event carries content + finish_reason + usage; TTFT callback must
    // fire during pass-through, before settleStreamEnd at stream close.
    startFakeCpa(
      () =>
        new Response(
          `data: ${JSON.stringify({
            id: "c3",
            object: "chat.completion.chunk",
            model: "claude-mythos-5-upstream",
            choices: [{ index: 0, delta: { content: "hello" }, finish_reason: "stop" }],
            usage: USAGE,
          })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const res = await gwr({
      model: "anthropic/claude-mythos-5",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    expect(res.status).toBe(200);
    await res.text();
    const log = await lastUsageLog();
    expect(log.status).toBe("ok");
    expect(finitePositive(log.ttft_ms)).toBe(true);
    expect(log.latency_ms! >= log.ttft_ms!).toBe(true);
  });

  test("tool_calls metadata without arguments is NOT first token (ttft NULL)", async () => {
    startFakeCpa(
      () =>
        new Response(
          `data: ${JSON.stringify({
            id: "c4",
            object: "chat.completion.chunk",
            model: "claude-mythos-5-upstream",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "f" } }],
                },
                finish_reason: null,
              },
            ],
          })}\n\n` +
            `data: ${JSON.stringify({
              id: "c4",
              object: "chat.completion.chunk",
              model: "claude-mythos-5-upstream",
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            })}\n\n` +
            `data: ${JSON.stringify({
              id: "c4",
              object: "chat.completion.chunk",
              model: "claude-mythos-5-upstream",
              choices: [],
              usage: USAGE,
            })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const res = await gwr({
      model: "anthropic/claude-mythos-5",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    expect(res.status).toBe(200);
    await res.text();
    const log = await lastUsageLog();
    expect(log.status).toBe("ok");
    expect(log.ttft_ms).toBeNull();
    expect(finitePositive(log.latency_ms)).toBe(true);
  });

  test("tool_calls streaming arguments IS first token", async () => {
    startFakeCpa(
      () =>
        new Response(
          `data: ${JSON.stringify({
            id: "c5",
            object: "chat.completion.chunk",
            model: "claude-mythos-5-upstream",
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] },
                finish_reason: null,
              },
            ],
          })}\n\n` +
            `data: ${JSON.stringify({
              id: "c5",
              object: "chat.completion.chunk",
              model: "claude-mythos-5-upstream",
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            })}\n\n` +
            `data: ${JSON.stringify({
              id: "c5",
              object: "chat.completion.chunk",
              model: "claude-mythos-5-upstream",
              choices: [],
              usage: USAGE,
            })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const res = await gwr({
      model: "anthropic/claude-mythos-5",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    expect(res.status).toBe(200);
    await res.text();
    const log = await lastUsageLog();
    expect(log.status).toBe("ok");
    expect(finitePositive(log.ttft_ms)).toBe(true);
    expect(log.latency_ms! >= log.ttft_ms!).toBe(true);
  });

  test("responses stream: text delta is first token, persisted", async () => {
    startFakeCpa(
      () =>
        new Response(
          `data: ${JSON.stringify({ type: "response.created", response: { id: "r1" } })}\n\n` +
            `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hi" })}\n\n` +
            `data: ${JSON.stringify({
              type: "response.completed",
              response: {
                id: "r1",
                status: "completed",
                usage: { input_tokens: 5, output_tokens: 7 },
              },
            })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const res = await gw(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${PLAINTEXT}` },
        body: JSON.stringify({ model: "anthropic/claude-mythos-5", input: "hi", stream: true }),
      }),
    );
    expect(res.status).toBe(200);
    await res.text();
    const log = await lastUsageLog();
    expect(log.status).toBe("ok");
    expect(finitePositive(log.ttft_ms)).toBe(true);
    expect(finitePositive(log.latency_ms)).toBe(true);
    expect(log.latency_ms! >= log.ttft_ms!).toBe(true);
  });

  test("non-stream: ttft NULL (not applicable), latency positive finite", async () => {
    startFakeCpa(
      () =>
        new Response(
          JSON.stringify({
            id: "c2",
            object: "chat.completion",
            model: "claude-mythos-5-upstream",
            choices: [
              { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
            ],
            usage: USAGE,
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const res = await gwr({ model: "anthropic/claude-mythos-5", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    const log = await lastUsageLog();
    expect(log.status).toBe("ok");
    expect(log.ttft_ms).toBeNull();
    expect(finitePositive(log.latency_ms)).toBe(true);
  });
});
