// Reproduces the owner's case: CPA (GLM) omits prompt_tokens_details /
// completion_tokens_details on successful replies. Price: input 1000000,
// output 1000000, cached_input 100000, reasoning 100000 (usd micro per 1M),
// markup 1x, fx 26000. Expected: 13 in + 264 out settle as 'usage' —
// 277 micro USD -> ceil(277 * 26000 * 1000000 / 1e12) = 8 VND, status ok,
// public_model set, no full hold.
import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { Elysia } from "elysia";
import { createTestDb } from "@hoborouter/db";
import { hashApiKey } from "@hoborouter/keys";
import { q, trackDrop, makeApp } from "./helpers";
import { gatewayRoutes } from "../src/routes/v1-gateway";

const PLAINTEXT = "sk-hbr-gw-split-key";
const CPA_KEY = "test-cpa-secret";
const CHAT_PATH = "/v1/chat/completions";

const ENV_KEYS = ["HBR_GATEWAY_ENABLED", "CPA_BASE_URL", "CPA_ACCESS_KEY", "HBR_USD_VND_RATE"];
let savedEnv: Record<string, string | undefined> = {};

async function seedGateway(db: Awaited<ReturnType<typeof makeApp>>["db"]) {
  const now = Date.now();
  await q(db, 
    "INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws-gw','gw','active',?)",
now);
  await q(db, 
    "INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at) VALUES ('wal-gw','ws-gw','VND',1000000000,0,0,?)",
now);
  await q(db, 
    "INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at) VALUES ('key-gw','ws-gw',?,?,'gw','active',?)",
hashApiKey(PLAINTEXT), "sk-hbr-gw...", now);
  await q(db, 
    "INSERT INTO models (id, public_id, slug, display_name, provider, context_window, enabled, published, created_at, updated_at) VALUES ('mdl-a','anthropic/claude-mythos-5','claude-mythos-5','Mythos 5','anthropic',128000,true,true,?,?)",
now, now);
  await q(db, 
    "INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at) VALUES ('map-a','mdl-a','anthropic','claude-mythos-5-upstream',true,?,?)",
now, now);
  await q(db, 
    "INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at, retired_at) VALUES ('price-a','mdl-a',1000000,1000000,100000,100000,1000000,?,NULL)",
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

// Exact owner usage shape: no *_details objects at all.
const ownerUsage = {
  prompt_tokens: 13,
  completion_tokens: 264,
  total_tokens: 277,
};

const ownerJson = () =>
  new Response(
    JSON.stringify({
      id: "chatcmpl-owner",
      object: "chat.completion",
      model: "claude-mythos-5-upstream",
      choices: [
        { index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" },
      ],
      usage: ownerUsage,
    }),
    { headers: { "content-type": "application/json" } },
  );

const ownerSse = () => {
  const chunk = (extra: object) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-owner-s",
      object: "chat.completion.chunk",
      created: 1,
      model: "claude-mythos-5-upstream",
      ...extra,
    })}\n\n`;
  return (
    chunk({ choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] }) +
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
    chunk({ choices: [], usage: ownerUsage }) +
    "data: [DONE]\n\n"
  );
};

let fakeServer: ReturnType<typeof Bun.serve> | null = null;
function startFakeCpa(handler: () => Response) {
  fakeServer = Bun.serve({ port: 0, fetch: () => handler() });
  process.env.CPA_BASE_URL = `http://127.0.0.1:${fakeServer.port}`;
}

const lastUsageLog = async () =>
  (await q(db, 
      "SELECT status, failure, public_model, input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, charged_vnd, raw_payload FROM usage_logs ORDER BY ctid DESC LIMIT 1",
    ))[0] as {
    status: string;
    failure: string | null;
    public_model: string;
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
    reasoning_tokens: number;
    charged_vnd: number;
    raw_payload: string | null;
  };

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
  await q(db, "UPDATE wallets SET balance = 1000000000, reserved = 0 WHERE id = 'wal-gw'");
  await q(db, "DELETE FROM settlements");
});

afterAll(() => {
  fakeServer?.stop(true);
});

describe("gateway settles missing-split usage (owner case)", () => {
  test("non-stream: settles as usage, 8 VND, public_model set, assumption recorded", async () => {
    startFakeCpa(() => ownerJson());
    const res = await gwr({ model: "anthropic/claude-mythos-5", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model: string; usage: typeof ownerUsage };
    expect(body.model).toBe("anthropic/claude-mythos-5");
    expect(body.usage.total_tokens).toBe(277);
    const log = await lastUsageLog();
    expect(log.status).toBe("ok");
    expect(log.failure).toBeNull();
    expect(log.public_model).toBe("anthropic/claude-mythos-5");
    expect(log.input_tokens).toBe(13);
    expect(log.output_tokens).toBe(264);
    expect(log.cached_input_tokens).toBe(0); // cached rate 100000 <= input 1000000
    expect(log.reasoning_tokens).toBe(0); // reasoning rate <= output
    // 277 tokens * 1000000 micro/1M = 277 micro USD -> ceil(277*26000*1e6/1e12) = 8 VND
    expect(log.charged_vnd).toBe(8);
    expect(JSON.parse(log.raw_payload!)).toEqual({ assumed_splits: ["cached_input", "reasoning"] });
  });

  test("stream with include_usage chunk: settles as usage, 8 VND", async () => {
    startFakeCpa(() => new Response(ownerSse(), { headers: { "content-type": "text/event-stream" } }));
    const res = await gwr({
      model: "anthropic/claude-mythos-5",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("anthropic/claude-mythos-5");
    const log = await lastUsageLog();
    expect(log.status).toBe("ok");
    expect(log.public_model).toBe("anthropic/claude-mythos-5");
    expect(log.charged_vnd).toBe(8);
  });

  test("present cached_tokens billed at cached rate (live CPA body, ~1.3k system prompt)", async () => {
    // Exact live evidence: cached_tokens IS present through CPA when the prompt
    // exceeds the provider's cache minimum. 1280 cached @ 100000 + 56 input @
    // 1000000 + 13 output @ 1000000 = 197 micro USD -> ceil(197*26000*1e6/1e12)
    // = 6 VND. No reasoning details: conservative rule keeps reasoning=0.
    startFakeCpa(
      () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl-cached",
            object: "chat.completion",
            model: "claude-mythos-5-upstream",
            choices: [
              { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
            ],
            usage: {
              prompt_tokens: 1336,
              completion_tokens: 13,
              prompt_tokens_details: { cached_tokens: 1280 },
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const res = await gwr({ model: "anthropic/claude-mythos-5", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    const log = await lastUsageLog();
    expect(log.status).toBe("ok");
    expect(log.input_tokens).toBe(1336);
    expect(log.output_tokens).toBe(13);
    expect(log.cached_input_tokens).toBe(1280); // present => billed at cached rate
    expect(log.reasoning_tokens).toBe(0); // absent => conservative 0 (reasoning rate < output)
    expect(log.charged_vnd).toBe(6);
    expect(JSON.parse(log.raw_payload!)).toEqual({ assumed_splits: ["reasoning"] });
  });
});
