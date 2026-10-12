// Safe rate-limit headers (parity Task 3): X-RateLimit-* metadata is set ONLY
// when a concrete workspace limit exists (active subscription plan or prepaid
// throughput allowance) and every value comes from the limiter's own state.
// No limit known -> no headers, nothing fabricated.
import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { Elysia } from "elysia";
import { createTestDb, type Db } from "@hoborouter/db";
import { hashApiKey } from "@hoborouter/keys";
import { q, trackDrop } from "./helpers";
import { gatewayRoutes } from "../src/routes/v1-gateway";
import {
  resetSubscriptionRateLimits,
  resetThroughputAllowanceLimits,
  setRateLimitClock,
} from "../src/rate-limit";

const PLAINTEXT = "sk-hbr-rlh-test-key";
const CPA_KEY = "test-cpa-secret";
const CHAT_PATH = "/v1/chat/completions";
const RATE_LIMIT = 2;
const DAY_MS = 86_400_000;
// Pinned limiter clock so the 429 and its headers land inside one 60s window.
const T0 = 1_700_000_000_000;

const ENV_KEYS = ["HBR_GATEWAY_ENABLED", "CPA_BASE_URL", "CPA_ACCESS_KEY", "HBR_USD_VND_RATE"];
let savedEnv: Record<string, string | undefined> = {};

async function seed(db: Db) {
  const now = Date.now();
  await q(
    db,
    "INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws-rlh','rlh','active',?)",
    now,
  );
  await q(
    db,
    `INSERT INTO wallets (id, workspace_id, currency, kind, balance, reserved, version, created_at)
     VALUES ('wal-top','ws-rlh','VND','topup',0,0,0,?)`,
    now,
  );
  await q(
    db,
    `INSERT INTO wallets (id, workspace_id, currency, kind, balance, reserved, version, created_at)
     VALUES ('wal-sub','ws-rlh','VND','subscription',1000000,0,0,?)`,
    now,
  );
  await q(
    db,
    "INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at) VALUES ('key-rlh','ws-rlh',?,?,'rlh','active',?)",
    hashApiKey(PLAINTEXT),
    "sk-hbr-rlh...",
    now,
  );
  await q(
    db,
    "INSERT INTO models (id, public_id, slug, display_name, provider, context_window, enabled, published, created_at, updated_at) VALUES ('mdl-r','openai/rlh-test','rlh-test','RLH Test','openai',128000,true,true,?,?)",
    now,
    now,
  );
  await q(
    db,
    "INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at) VALUES ('map-r','mdl-r','openai','rlh-upstream',true,?,?)",
    now,
    now,
  );
  await q(
    db,
    "INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at, retired_at) VALUES ('price-r','mdl-r',1000000,2000000,0,0,1200000,?,NULL)",
    now - 1000,
  );
}

let db: Db;
let gw: (req: Request) => Promise<Response>;

beforeAll(async () => {
  const t = await createTestDb();
  trackDrop(t.drop);
  db = t.db;
  await seed(db);
  gw = (req) => new Elysia().use(gatewayRoutes(db)).handle(req);
});

afterAll(() => {
  setRateLimitClock(Date.now);
  fakeServer?.stop(true);
});

const gwr = (body: unknown) =>
  gw(
    new Request("http://localhost" + CHAT_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${PLAINTEXT}` },
      body: JSON.stringify(body),
    }),
  );

const chatBody = () => ({
  model: "openai/rlh-test",
  messages: [{ role: "user", content: "hi" }],
});

const chatJson = () =>
  new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      model: "rlh-upstream",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 1,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    }),
    { headers: { "content-type": "application/json" } },
  );

let fakeServer: ReturnType<typeof Bun.serve> | null = null;
function startFakeCpa() {
  fakeServer = Bun.serve({ port: 0, fetch: async () => chatJson() });
  process.env.CPA_BASE_URL = `http://127.0.0.1:${fakeServer.port}`;
}

async function seedSubscription() {
  const now = Date.now();
  await q(
    db,
    "INSERT INTO subscription_plans (id, name, price_vnd, credit_per_period_vnd, period_days, rate_limit_per_minute, active, created_at) VALUES ('plan-rlh','Sub',100000,500000,30,?,true,?) ON CONFLICT (id) DO NOTHING",
    RATE_LIMIT,
    now,
  );
  await q(
    db,
    "INSERT INTO subscriptions (id, workspace_id, plan_id, status, current_period_start, current_period_end, created_at) VALUES ('subs-rlh','ws-rlh','plan-rlh','active',?, ?, ?)",
    now,
    now + 30 * DAY_MS,
    now,
  );
}

async function seedAllowance(rpm: number) {
  const now = Date.now();
  await q(
    db,
    "INSERT INTO throughput_products (id, name, price_vnd, requests_per_minute, duration_days, active, created_at) VALUES ('prod-rlh','tp',1000,30,7,true,?)",
    now,
  );
  await q(
    db,
    "INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at, throughput_product_id) VALUES ('pay-rlh','ws-rlh',1000,'succeeded','mock','RLH-1',?,NULL)",
    now,
  );
  await q(
    db,
    `INSERT INTO throughput_allowances (id, workspace_id, payment_id, product_id, requests_per_minute, starts_at, ends_at, status, created_at)
     VALUES ('ta-rlh','ws-rlh','pay-rlh','prod-rlh',?, ?, ?, 'active', ?)`,
    rpm,
    now - 1000,
    now + DAY_MS,
    now,
  );
}

const setBalances = (sub: number, top: number) =>
  q(db, "UPDATE wallets SET balance = ?, reserved = 0 WHERE id IN ('wal-sub','wal-top')", sub).then(
    () => q(db, "UPDATE wallets SET balance = ? WHERE id = 'wal-top'", top),
  );

const rlh = (res: Response, name: string) => res.headers.get(`x-ratelimit-${name}`);

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.HBR_GATEWAY_ENABLED = "1";
  process.env.CPA_ACCESS_KEY = CPA_KEY;
  process.env.HBR_USD_VND_RATE = "26000";
  delete process.env.CPA_BASE_URL;
  resetSubscriptionRateLimits();
  setRateLimitClock(() => T0);
  await q(db, "DELETE FROM subscriptions");
  await q(db, "DELETE FROM throughput_allowances");
  await setBalances(1000000, 0);
});

afterEach(() => {
  fakeServer?.stop(true);
  fakeServer = null;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("gateway rate-limit headers", () => {
  test("subscription 429: limit/remaining/reset + retry-after from limiter state", async () => {
    await seedSubscription();
    startFakeCpa();
    for (let i = 0; i < RATE_LIMIT; i++) expect((await gwr(chatBody())).status).toBe(200);
    const res = await gwr(chatBody());
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "subscription_rate_limited",
    );
    expect(rlh(res, "limit")).toBe(String(RATE_LIMIT));
    expect(rlh(res, "remaining")).toBe("0");
    const retryAfter = Number(res.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    const reset = Number(rlh(res, "reset"));
    expect(reset).toBeGreaterThanOrEqual(1);
    expect(reset).toBeLessThanOrEqual(60);
  });

  test("402 with a concrete subscription limit: quota state, remaining decremented", async () => {
    await seedSubscription();
    await setBalances(0, 0); // no wallet can fund -> 402 while still under limit
    const res = await gwr(chatBody());
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "insufficient_balance",
    );
    expect(rlh(res, "limit")).toBe(String(RATE_LIMIT));
    // This request counted a slot before the reserve failed: 2 - 1.
    expect(rlh(res, "remaining")).toBe("1");
    expect(rlh(res, "reset")).toBeTruthy();
  });

  test("no known limit: no rate-limit headers on 402", async () => {
    await setBalances(0, 0); // no subscription, no allowance
    const res = await gwr(chatBody());
    expect(res.status).toBe(402);
    expect(rlh(res, "limit")).toBeNull();
    expect(rlh(res, "remaining")).toBeNull();
    expect(rlh(res, "reset")).toBeNull();
    expect(res.headers.get("retry-after")).toBeNull();
  });

  test("allowance 429: headers describe the admission cap", async () => {
    // The allowance window is seeded on the real clock, so the limiter must
    // run on it too — the pinned T0 clock would read the window as not started.
    setRateLimitClock(Date.now);
    resetThroughputAllowanceLimits();
    await seedAllowance(RATE_LIMIT);
    startFakeCpa();
    await setBalances(0, 1000000); // topup-funded: proves the cap is admission-scoped
    for (let i = 0; i < RATE_LIMIT; i++) expect((await gwr(chatBody())).status).toBe(200);
    const res = await gwr(chatBody());
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "throughput_allowance_limited",
    );
    expect(rlh(res, "limit")).toBe(String(RATE_LIMIT));
    expect(rlh(res, "remaining")).toBe("0");
    expect(res.headers.get("retry-after")).toBeTruthy();
  });
});
