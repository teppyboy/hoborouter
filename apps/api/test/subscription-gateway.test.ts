// Subscription gateway behaviors (O3): per-workspace fixed-window rate limit
// for subscription-funded requests, topup fallback, 429 shape, rollover.
// Fake CPA is the same local Bun.serve pattern as gateway.test.ts.
import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { Elysia } from "elysia";
import { createTestDb } from "@hoborouter/db";
import { hashApiKey } from "@hoborouter/keys";
import { q, trackDrop } from "./helpers";
import { gatewayRoutes } from "../src/routes/v1-gateway";
import { resetSubscriptionRateLimits, setRateLimitClock } from "../src/rate-limit";

const PLAINTEXT = "sk-hbr-sub-test-key";
const CPA_KEY = "test-cpa-secret";
const CHAT_PATH = "/v1/chat/completions";
const RATE_LIMIT = 2; // plan rate_limit_per_minute
const DAY_MS = 86_400_000;

const ENV_KEYS = ["HBR_GATEWAY_ENABLED", "CPA_BASE_URL", "CPA_ACCESS_KEY", "HBR_USD_VND_RATE"];
let savedEnv: Record<string, string | undefined> = {};

async function seedWorkspace(db: Awaited<ReturnType<typeof makeDb>>["db"]) {
  const now = Date.now();
  await q(
    db,
    "INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws-sub','sub','active',?)",
    now,
  );
  await q(
    db,
    `INSERT INTO wallets (id, workspace_id, currency, kind, balance, reserved, version, created_at)
     VALUES ('wal-top','ws-sub','VND','topup',0,0,0,?)`,
    now,
  );
  await q(
    db,
    `INSERT INTO wallets (id, workspace_id, currency, kind, balance, reserved, version, created_at)
     VALUES ('wal-sub','ws-sub','VND','subscription',1000000,0,0,?)`,
    now,
  );
  await q(
    db,
    "INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at) VALUES ('key-sub','ws-sub',?,?,'sub','active',?)",
    hashApiKey(PLAINTEXT),
    "sk-hbr-sub...",
    now,
  );
  await q(
    db,
    "INSERT INTO models (id, public_id, slug, display_name, provider, context_window, enabled, published, created_at, updated_at) VALUES ('mdl-s','openai/sub-test','sub-test','Sub Test','openai',128000,true,true,?,?)",
    now,
    now,
  );
  await q(
    db,
    "INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at) VALUES ('map-s','mdl-s','openai','gpt-4o-upstream',true,?,?)",
    now,
    now,
  );
  await q(
    db,
    "INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at, retired_at) VALUES ('price-s','mdl-s',1000000,2000000,500000,3000000,1200000,?,NULL)",
    now - 1000,
  );
}

async function seedSubscription(db: Awaited<ReturnType<typeof makeDb>>["db"]) {
  const now = Date.now();
  await q(
    db,
    "INSERT INTO subscription_plans (id, name, price_vnd, credit_per_period_vnd, period_days, rate_limit_per_minute, active, created_at) VALUES ('plan-s','Sub',100000,500000,30,?,true,?) ON CONFLICT (id) DO NOTHING",
    RATE_LIMIT,
    now,
  );
  await q(
    db,
    "INSERT INTO subscriptions (id, workspace_id, plan_id, status, current_period_start, current_period_end, created_at) VALUES ('subs-1','ws-sub','plan-s','active',?, ?, ?)",
    now,
    now + 30 * DAY_MS,
    now,
  );
}

let db: Awaited<ReturnType<typeof makeDb>>["db"];
let gw: (req: Request) => Promise<Response>;

async function makeDb() {
  const t = await createTestDb();
  trackDrop(t.drop);
  return t;
}

beforeAll(async () => {
  const t = await makeDb();
  db = t.db;
  await seedWorkspace(db);
  gw = (req) => new Elysia().use(gatewayRoutes(db)).handle(req);
});

afterAll(async () => {
  fakeServer?.stop(true);
});

const gwr = (path: string, body: unknown) =>
  gw(
    new Request("http://localhost" + path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${PLAINTEXT}` },
      body: JSON.stringify(body),
    }),
  );

const chatBody = (extra: Record<string, unknown> = {}) => ({
  model: "openai/sub-test",
  messages: [{ role: "user", content: "hi" }],
  ...extra,
});

type Captured = { path: string };
let captured: Captured[] = [];
let fakeServer: ReturnType<typeof Bun.serve> | null = null;

function startFakeCpa(handler: () => Response | Promise<Response>) {
  captured = [];
  fakeServer = Bun.serve({
    port: 0,
    fetch: async (req) => {
      captured.push({ path: new URL(req.url).pathname });
      return await handler();
    },
  });
  process.env.CPA_BASE_URL = `http://127.0.0.1:${fakeServer.port}`;
}

const chatJson = () =>
  new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      model: "gpt-4o-upstream",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 100,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    }),
    { headers: { "content-type": "application/json" } },
  );

const chatSse = () =>
  `data: ${JSON.stringify({
    id: "chatcmpl-2",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4o-upstream",
    choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
  })}\n\ndata: ${JSON.stringify({
    id: "chatcmpl-2",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4o-upstream",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  })}\n\ndata: ${JSON.stringify({
    id: "chatcmpl-2",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4o-upstream",
    choices: [],
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 100,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    },
  })}\n\ndata: [DONE]\n\n`;

const count = async (table: string) =>
  ((await q(db, `SELECT COUNT(*) c FROM ${table}`))[0] as { c: number }).c;

// ledger_entries is append-only (DB guard), so tests assert on DELTAS over a
// per-test baseline instead of deleting rows between tests.
let base = { requests: 0, reservations: 0, ledger: 0, sub: 0, top: 0 };
const delta = (cur: number, key: keyof typeof base) => cur - base[key];

const subFundedCount = async () =>
  delta(
    (
      (
        await q(db, "SELECT COUNT(*) c FROM billing_reservations WHERE wallet_id = 'wal-sub'")
      )[0] as { c: number }
    ).c,
    "sub",
  );

const topFundedCount = async () =>
  delta(
    (
      (
        await q(db, "SELECT COUNT(*) c FROM billing_reservations WHERE wallet_id = 'wal-top'")
      )[0] as { c: number }
    ).c,
    "top",
  );

const newRequests = async () => delta(await count("requests"), "requests");
const newReservations = async () => delta(await count("billing_reservations"), "reservations");
const newLedger = async () => delta(await count("ledger_entries"), "ledger");

const walletOf = async (id: string) =>
  (await q(db, "SELECT balance, reserved FROM wallets WHERE id = ?", id))[0] as {
    balance: number;
    reserved: number;
  };

const setTopup = (balance: number) =>
  q(db, "UPDATE wallets SET balance = ?, reserved = 0 WHERE id = 'wal-top'", balance);
const resetSubWallet = () =>
  q(db, "UPDATE wallets SET balance = 1000000, reserved = 0 WHERE id = 'wal-sub'");

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.HBR_GATEWAY_ENABLED = "1";
  process.env.CPA_ACCESS_KEY = CPA_KEY;
  process.env.HBR_USD_VND_RATE = "26000";
  delete process.env.CPA_BASE_URL;
  resetSubscriptionRateLimits();
  setRateLimitClock(Date.now);
  // Fresh subscription row (the topup-only test removes it) + fresh baseline.
  await q(db, "DELETE FROM subscriptions");
  await seedSubscription(db);
  await resetSubWallet();
  await setTopup(0);
  const funded = async (id: string) =>
    (
      (await q(db, "SELECT COUNT(*) c FROM billing_reservations WHERE wallet_id = ?", id))[0] as {
        c: number;
      }
    ).c;
  base = {
    requests: await count("requests"),
    reservations: await count("billing_reservations"),
    ledger: await count("ledger_entries"),
    sub: await funded("wal-sub"),
    top: await funded("wal-top"),
  };
});

afterEach(async () => {
  fakeServer?.stop(true);
  fakeServer = null;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await q(db, "DELETE FROM settlements");
});

describe("subscription gateway rate limit", () => {
  test("up to N subscription-funded requests succeed, funded from the subscription wallet", async () => {
    startFakeCpa(() => chatJson());
    await setTopup(0);
    for (let i = 0; i < RATE_LIMIT; i++) {
      const res = await gwr(CHAT_PATH, chatBody());
      expect(res.status).toBe(200);
    }
    expect(captured.length).toBe(RATE_LIMIT);
    expect(await subFundedCount()).toBe(RATE_LIMIT);
    expect(await topFundedCount()).toBe(0);
    // Settled charges debit the subscription wallet, holds released.
    const w = await walletOf("wal-sub");
    expect(w.balance).toBeLessThan(1000000);
    expect(w.reserved).toBe(0);
  });

  test("N+1 falls back to the topup wallet when topup has credit (not counted)", async () => {
    startFakeCpa(() => chatJson());
    await setTopup(1000000);
    for (let i = 0; i < RATE_LIMIT; i++)
      expect((await gwr(CHAT_PATH, chatBody())).status).toBe(200);
    const res = await gwr(CHAT_PATH, chatBody());
    expect(res.status).toBe(200);
    expect(await subFundedCount()).toBe(RATE_LIMIT);
    expect(await topFundedCount()).toBe(1);
    // The fallback request did not consume subscription quota: it still funds
    // after the window would have been "full" had it counted.
  });

  test("N+1 with empty topup -> 429 with Retry-After and zero new rows", async () => {
    startFakeCpa(() => chatJson());
    await setTopup(0);
    for (let i = 0; i < RATE_LIMIT; i++)
      expect((await gwr(CHAT_PATH, chatBody())).status).toBe(200);
    const before = {
      requests: await newRequests(),
      reservations: await newReservations(),
      ledger: await newLedger(),
    };
    const res = await gwr(CHAT_PATH, chatBody());
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { message: string; type: string; code: string } };
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.code).toBe("subscription_rate_limited");
    const retryAfter = Number(res.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(captured.length).toBe(RATE_LIMIT);
    expect(await newRequests()).toBe(before.requests);
    expect(await newReservations()).toBe(before.reservations);
    expect(await newLedger()).toBe(before.ledger);
    expect(await walletOf("wal-sub").then((w) => w.reserved)).toBe(0);
  });

  test("over-limit topup fallback does not erode the count (no extra sub-funded)", async () => {
    startFakeCpa(() => chatJson());
    await setTopup(1000000);
    for (let i = 0; i < RATE_LIMIT; i++)
      expect((await gwr(CHAT_PATH, chatBody())).status).toBe(200);
    // Over the limit: funded by topup, must NOT free a subscription slot.
    expect((await gwr(CHAT_PATH, chatBody())).status).toBe(200);
    expect(await topFundedCount()).toBe(1);
    await setTopup(0);
    const res = await gwr(CHAT_PATH, chatBody());
    expect(res.status).toBe(429);
    expect(await subFundedCount()).toBe(RATE_LIMIT);
  });

  test("repeated 429s do not erode the count", async () => {
    startFakeCpa(() => chatJson());
    await setTopup(0);
    for (let i = 0; i < RATE_LIMIT; i++)
      expect((await gwr(CHAT_PATH, chatBody())).status).toBe(200);
    for (let i = 0; i < RATE_LIMIT + 1; i++) {
      expect((await gwr(CHAT_PATH, chatBody())).status).toBe(429);
    }
    expect(await subFundedCount()).toBe(RATE_LIMIT);
    expect(await newReservations()).toBe(RATE_LIMIT);
  });

  test("concurrent burst of 10: at most N subscription-funded, 429s reserve nothing", async () => {
    startFakeCpa(() => chatJson());
    await setTopup(0);
    const results = await Promise.all(Array.from({ length: 10 }, () => gwr(CHAT_PATH, chatBody())));
    const ok = results.filter((r) => r.status === 200).length;
    const limited = results.filter((r) => r.status === 429).length;
    expect(ok).toBe(RATE_LIMIT);
    expect(limited).toBe(10 - RATE_LIMIT);
    expect(await subFundedCount()).toBe(RATE_LIMIT);
    expect(await topFundedCount()).toBe(0);
    expect(await newReservations()).toBe(RATE_LIMIT);
  });

  test("rollover: topup fallback in the old window does not affect the fresh window", async () => {
    const T0 = 1_700_000_000_000;
    setRateLimitClock(() => T0);
    startFakeCpa(() => chatJson());
    await setTopup(1000000);
    for (let i = 0; i < RATE_LIMIT; i++)
      expect((await gwr(CHAT_PATH, chatBody())).status).toBe(200);
    // Over the limit in this window: topup fallback, not counted.
    expect((await gwr(CHAT_PATH, chatBody())).status).toBe(200);
    await setTopup(0);
    setRateLimitClock(() => T0 + 61_000);
    const res = await gwr(CHAT_PATH, chatBody());
    expect(res.status).toBe(200);
    expect(await subFundedCount()).toBe(RATE_LIMIT + 1);
    expect(await topFundedCount()).toBe(1);
  });

  test("window rollover resets the count (injected clock)", async () => {
    const T0 = 1_700_000_000_000;
    setRateLimitClock(() => T0);
    startFakeCpa(() => chatJson());
    await setTopup(0);
    for (let i = 0; i < RATE_LIMIT; i++)
      expect((await gwr(CHAT_PATH, chatBody())).status).toBe(200);
    expect((await gwr(CHAT_PATH, chatBody())).status).toBe(429);
    // Next window: the limit is fresh and the subscription funds again.
    setRateLimitClock(() => T0 + 61_000);
    const res = await gwr(CHAT_PATH, chatBody());
    expect(res.status).toBe(200);
    expect(await subFundedCount()).toBe(RATE_LIMIT + 1);
  });

  test("topup-only workspaces never get 429", async () => {
    await q(db, "DELETE FROM subscriptions");
    startFakeCpa(() => chatJson());
    await setTopup(1000000);
    for (let i = 0; i < RATE_LIMIT + 3; i++) {
      const res = await gwr(CHAT_PATH, chatBody());
      expect(res.status).toBe(200);
    }
    expect(await topFundedCount()).toBe(RATE_LIMIT + 3);
    expect(await subFundedCount()).toBe(0);
  });

  test("streaming requests follow the same rules", async () => {
    startFakeCpa(
      () => new Response(chatSse(), { headers: { "content-type": "text/event-stream" } }),
    );
    await setTopup(0);
    for (let i = 0; i < RATE_LIMIT; i++) {
      const res = await gwr(CHAT_PATH, chatBody({ stream: true }));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("data: [DONE]");
    }
    expect(await subFundedCount()).toBe(RATE_LIMIT);
    const over = await gwr(CHAT_PATH, chatBody({ stream: true }));
    expect(over.status).toBe(429);
    expect(((await over.json()) as { error: { code: string } }).error.code).toBe(
      "subscription_rate_limited",
    );
    expect(over.headers.get("retry-after")).toBeTruthy();
  });
});
