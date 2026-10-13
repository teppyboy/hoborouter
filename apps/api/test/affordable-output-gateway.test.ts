// Affordable output cap (approved policy): BOTH explicit and omitted output
// limits are clamped to eligible wallet + key-budget affordability; the
// affordable cap is what is reserved AND forwarded upstream. Covers the
// previously-402 full-context-hold case dispatching an affordable positive
// cap, protocol/stream truthful clamp fields, zero-balance rejection, key
// budget/expiry precedence, subscription grant-only funding, and concurrency
// (no double spend / duplicate charge; full hold on failed CPA).
import { describe, expect, test, beforeAll, beforeEach, afterEach } from "bun:test";
import { Elysia } from "elysia";
import { createTestDb } from "@hoborouter/db";
import { hashApiKey } from "@hoborouter/keys";
import { q, trackDrop } from "./helpers";
import { estimateAffordableOutputTokens, estimateCapVnd } from "@hoborouter/wallet";
import { gatewayRoutes } from "../src/routes/v1-gateway";

const PLAINTEXT = "sk-hbr-ao-test-key";
const CPA_KEY = "test-cpa-secret";
const CHAT_PATH = "/v1/chat/completions";
const RESPONSES_PATH = "/v1/responses";
const MESSAGES_PATH = "/v1/messages";
const PUBLIC_MODEL = "openai/ao-test";
const UPSTREAM_MODEL = "ao-upstream";
// ctx 1M, $10/1M input, $50/1M output, markup 1e6 (1x), fx 26000:
// per-token cost = 0.26 VND input, 1.3 VND output.
const FX = 26000;
const PRICE = {
  inputUsdMicroPer1m: 10_000_000,
  outputUsdMicroPer1m: 50_000_000,
  cachedInputUsdMicroPer1m: 0,
  reasoningUsdMicroPer1m: 0,
};
const MARKUP = 1_000_000;
const CTX = 1_000_000;
const WALLET_19USD = 494_000; // $19 = 494000 VND at 26k

const ENV_KEYS = [
  "HBR_GATEWAY_ENABLED",
  "CPA_BASE_URL",
  "CPA_ACCESS_KEY",
  "HBR_USD_VND_RATE",
  "HBR_DEFAULT_MAX_OUTPUT_TOKENS",
];
let savedEnv: Record<string, string | undefined> = {};

let db: Awaited<ReturnType<typeof createTestDb>>["db"];

async function seedAffordable() {
  const now = Date.now();
  await q(
    db,
    "INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws-ao','ao','active',?)",
    now,
  );
  await q(
    db,
    "INSERT INTO wallets (id, workspace_id, currency, kind, balance, reserved, version, created_at) VALUES ('wal-ao','ws-ao','VND','topup',?,0,0,?)",
    WALLET_19USD,
    now,
  );
  await q(
    db,
    "INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at) VALUES ('key-ao','ws-ao',?,?,'ao','active',?)",
    hashApiKey(PLAINTEXT),
    "sk-hbr-ao...",
    now,
  );
  await q(
    db,
    "INSERT INTO models (id, public_id, slug, display_name, provider, context_window, enabled, published, created_at, updated_at) VALUES ('mdl-ao',?,?,'AO Test','openai',?,true,true,?,?)",
    PUBLIC_MODEL,
    "ao-test",
    CTX,
    now,
    now,
  );
  await q(
    db,
    "INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at) VALUES ('map-ao','mdl-ao','openai',?,true,?,?)",
    UPSTREAM_MODEL,
    now,
    now,
  );
  await q(
    db,
    "INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at, retired_at) VALUES ('price-ao','mdl-ao',?,?,?,?,?,?,NULL)",
    PRICE.inputUsdMicroPer1m,
    PRICE.outputUsdMicroPer1m,
    PRICE.cachedInputUsdMicroPer1m,
    PRICE.reasoningUsdMicroPer1m,
    MARKUP,
    now - 1000,
  );
}

let gw: (req: Request) => Promise<Response>;
beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  trackDrop(t.drop);
  await seedAffordable();
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
let fakeServer: ReturnType<typeof Bun.serve> | null = null;

function startFakeCpa(handler: (c: Captured) => Response | Promise<Response>) {
  captured = [];
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

const usage = { input_tokens: 10, output_tokens: 5 };
const chatJson = () =>
  new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      model: UPSTREAM_MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: usage.input_tokens,
        completion_tokens: usage.output_tokens,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
const chatSse = () => {
  const chunk = (extra: object) =>
    `data: ${JSON.stringify({ id: "chatcmpl-2", object: "chat.completion.chunk", created: 1, model: UPSTREAM_MODEL, ...extra })}\n\n`;
  return (
    chunk({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] }) +
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
    chunk({
      choices: [],
      usage: {
        prompt_tokens: usage.input_tokens,
        completion_tokens: usage.output_tokens,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    }) +
    "data: [DONE]\n\n"
  );
};
const sse = (body: string) =>
  new Response(body, { headers: { "content-type": "text/event-stream" } });
const responsesJson = () =>
  new Response(
    JSON.stringify({ id: "resp-1", object: "response", status: "completed", output: [], usage }),
    { headers: { "content-type": "application/json" } },
  );
const responsesSse = () =>
  sse(
    `data: ${JSON.stringify({ type: "response.created", response: { id: "r1" } })}\n\n` +
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hi" })}\n\n` +
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "r1", status: "completed", usage } })}\n\n`,
  );
const messageJson = () =>
  new Response(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: UPSTREAM_MODEL,
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage,
    }),
    { headers: { "content-type": "application/json" } },
  );
const messageSse = () => {
  const event = (name: string, data: object) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  return sse(
    event("message_start", {
      type: "message_start",
      message: {
        id: "msg_2",
        type: "message",
        role: "assistant",
        model: UPSTREAM_MODEL,
        content: [],
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    }) +
      event("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hi" },
      }) +
      event("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 10, output_tokens: 5 },
      }) +
      event("message_stop", { type: "message_stop" }),
  );
};

const lastCharge = async () =>
  (
    await q(
      db,
      "SELECT br.cap_vnd, br.status, le.amount FROM billing_reservations br LEFT JOIN ledger_entries le ON le.billing_reservation_id = br.id ORDER BY br.ctid DESC LIMIT 1",
    )
  )[0] as { cap_vnd: number; status: string; amount: number | null };

const requestCount = async () =>
  ((await q(db, "SELECT COUNT(*) c FROM requests"))[0] as { c: number }).c;

const setBalance = async (balance: number) =>
  q(db, "UPDATE wallets SET balance = ?, reserved = 0 WHERE id = 'wal-ao'", balance);

const ledgerBalance = async (walletId: string) =>
  Number(
    (
      await q(
        db,
        "SELECT COALESCE(SUM(CASE WHEN direction='credit' THEN amount ELSE -amount END),0) s FROM ledger_entries WHERE wallet_id = ?",
        walletId,
      )
    )[0]!.s,
  );

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.HBR_GATEWAY_ENABLED = "1";
  process.env.CPA_ACCESS_KEY = CPA_KEY;
  process.env.HBR_USD_VND_RATE = String(FX);
  delete process.env.HBR_DEFAULT_MAX_OUTPUT_TOKENS;
  delete process.env.CPA_BASE_URL;
});

afterEach(async () => {
  fakeServer?.stop(true);
  fakeServer = null;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await setBalance(WALLET_19USD);
});

const chatBody = (extra: Record<string, unknown> = {}) => ({
  model: PUBLIC_MODEL,
  messages: [{ role: "user", content: "hi" }],
  ...extra,
});
const chatRaw = (extra: Record<string, unknown> = {}) => JSON.stringify(chatBody(extra));
const maxInputOf = (raw: string) => Math.min(Math.ceil(Buffer.byteLength(raw)), CTX);

describe("affordable output cap: $10/$50 per 1M, ctx 1M, $19 wallet (previously 402)", () => {
  test("implicit limit dispatches an affordable positive cap; hold = cap", async () => {
    startFakeCpa(() => chatJson());
    const raw = chatRaw();
    const maxInput = maxInputOf(raw);
    const affordable = estimateAffordableOutputTokens(
      maxInput,
      CTX,
      WALLET_19USD,
      PRICE,
      FX,
      MARKUP,
    );
    expect(affordable).toBeGreaterThan(0);
    expect(affordable).toBeLessThan(CTX);
    const res = await gwr(CHAT_PATH, JSON.parse(raw));
    expect(res.status).toBe(200);
    expect((JSON.parse(captured[0]!.body) as Record<string, unknown>).max_tokens).toBe(affordable);
    expect((await lastCharge()).cap_vnd).toBe(
      estimateCapVnd({ maxInputTokens: maxInput, maxOutputTokens: affordable }, PRICE, FX, MARKUP),
    );
    expect((await lastCharge()).cap_vnd).toBeLessThanOrEqual(WALLET_19USD);
  });

  test("explicit already-affordable limit is preserved unchanged", async () => {
    startFakeCpa(() => chatJson());
    const raw = chatRaw({ max_tokens: 1234 });
    const maxInput = maxInputOf(raw);
    const res = await gwr(CHAT_PATH, JSON.parse(raw));
    expect(res.status).toBe(200);
    expect((JSON.parse(captured[0]!.body) as Record<string, unknown>).max_tokens).toBe(1234);
    expect((await lastCharge()).cap_vnd).toBe(
      estimateCapVnd({ maxInputTokens: maxInput, maxOutputTokens: 1234 }, PRICE, FX, MARKUP),
    );
  });

  test("explicit too-large limit clamps to context then affordability", async () => {
    startFakeCpa(() => chatJson());
    const res = await gwr(CHAT_PATH, chatBody({ max_tokens: 5_000_000 }));
    expect(res.status).toBe(200);
    const forwarded = (JSON.parse(captured[0]!.body) as Record<string, unknown>)
      .max_tokens as number;
    expect(forwarded).toBeGreaterThan(0);
    expect(forwarded).toBeLessThanOrEqual(CTX);
    expect((await lastCharge()).cap_vnd).toBeLessThanOrEqual(WALLET_19USD);
  });

  test("zero/min-input unfundable -> 402 before any CPA call or request row", async () => {
    startFakeCpa(() => chatJson());
    await setBalance(0);
    const before = await requestCount();
    const res = await gwr(CHAT_PATH, chatBody());
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "insufficient_balance",
    );
    expect(captured.length).toBe(0);
    expect(await requestCount()).toBe(before);
  });

  test("six protocol/stream cases: truthful clamp field + exact reserved cap", async () => {
    // Ample wallet: affordable cap == candidate == ctx, so the forwarded limit
    // is the context bound and the hold is priced exactly at it.
    await setBalance(1_000_000_000);
    const cases: Array<[string, unknown, string, string]> = [
      [CHAT_PATH, chatBody(), "max_tokens", "nonstream"],
      [RESPONSES_PATH, { model: PUBLIC_MODEL, input: "hi" }, "max_output_tokens", "nonstream"],
      [
        MESSAGES_PATH,
        { model: PUBLIC_MODEL, max_tokens: 2_000_000, messages: [{ role: "user", content: "hi" }] },
        "max_tokens",
        "nonstream",
      ],
    ];
    for (const [path, body, field] of cases) {
      startFakeCpa(() =>
        path === CHAT_PATH ? chatJson() : path === RESPONSES_PATH ? responsesJson() : messageJson(),
      );
      const maxInput = maxInputOf(JSON.stringify(body));
      const res = await gwr(path, body);
      expect(res.status).toBe(200);
      const forwarded = JSON.parse(captured[0]!.body) as Record<string, unknown>;
      expect(forwarded[field]).toBe(CTX);
      expect((await lastCharge()).cap_vnd).toBe(
        estimateCapVnd({ maxInputTokens: maxInput, maxOutputTokens: CTX }, PRICE, FX, MARKUP),
      );
    }
    for (const [path, body, field] of cases) {
      startFakeCpa(() =>
        path === CHAT_PATH
          ? sse(chatSse())
          : path === RESPONSES_PATH
            ? responsesSse()
            : messageSse(),
      );
      const streamed = { ...(body as Record<string, unknown>), stream: true };
      const maxInput = maxInputOf(JSON.stringify(streamed));
      const res = await gwr(path, streamed);
      expect(res.status).toBe(200);
      await res.text();
      const forwarded = JSON.parse(captured[0]!.body) as Record<string, unknown>;
      expect(forwarded[field]).toBe(CTX);
      expect(forwarded.stream).toBe(true);
      expect((await lastCharge()).cap_vnd).toBe(
        estimateCapVnd({ maxInputTokens: maxInput, maxOutputTokens: CTX }, PRICE, FX, MARKUP),
      );
    }
  });
});

describe("key budget headroom precedence", () => {
  // The daily window start is today's UTC midnight; a stored period_start
  // outside it reads as unused in the headroom helper.
  const dayStart = new Date(new Date().toISOString().slice(0, 10)).getTime();

  test("exhausted key budget -> 429 key_budget_exceeded (retry-after), not wallet 402", async () => {
    await q(
      db,
      "UPDATE api_keys SET budget_vnd = 1000, budget_period = 'daily', budget_used_vnd = 1000, budget_period_start = ? WHERE id = 'key-ao'",
      dayStart,
    );
    try {
      startFakeCpa(() => chatJson());
      const res = await gwr(CHAT_PATH, chatBody());
      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("key_budget_exceeded");
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(captured.length).toBe(0);
    } finally {
      await q(
        db,
        "UPDATE api_keys SET budget_vnd = NULL, budget_period = NULL, budget_used_vnd = 0, budget_period_start = NULL WHERE id = 'key-ao'",
      );
    }
  });

  test("partial positive key budget below the minimum hold -> key 429 when the wallet could fund", async () => {
    // remaining 10 VND < input+1-output hold (~20 VND); wallet ample.
    await q(
      db,
      "UPDATE api_keys SET budget_vnd = 1000, budget_period = 'daily', budget_used_vnd = 990, budget_period_start = ? WHERE id = 'key-ao'",
      dayStart,
    );
    try {
      startFakeCpa(() => chatJson());
      const res = await gwr(CHAT_PATH, chatBody());
      expect(res.status).toBe(429);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "key_budget_exceeded",
      );
      expect(captured.length).toBe(0);
    } finally {
      await q(
        db,
        "UPDATE api_keys SET budget_vnd = NULL, budget_period = NULL, budget_used_vnd = 0, budget_period_start = NULL WHERE id = 'key-ao'",
      );
    }
  });

  test("expired key -> 403 before thinking-budget instruction and zero branch", async () => {
    await q(db, "UPDATE api_keys SET expires_at = ? WHERE id = 'key-ao'", Date.now() - 1000);
    try {
      startFakeCpa(() => messageJson());
      // Thinking conflict would be a 400 if expiry did not take precedence.
      const res = await gwr(MESSAGES_PATH, {
        model: PUBLIC_MODEL,
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
        thinking: { type: "enabled", budget_tokens: 50 },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { message?: string; code?: string } };
      const code = body.error.code ?? body.error.message ?? "";
      expect(code).toContain("expired");
      expect(captured.length).toBe(0);
    } finally {
      await q(db, "UPDATE api_keys SET expires_at = NULL WHERE id = 'key-ao'");
    }
  });
});

describe("native Anthropic thinking budget vs clamped max_tokens", () => {
  test("clamp below thinking budget -> 400 with instruction, no silent rewrite, no CPA", async () => {
    startFakeCpa(() => messageJson());
    await setBalance(1000); // affordable << 5000
    const res = await gwr(MESSAGES_PATH, {
      model: PUBLIC_MODEL,
      max_tokens: 100_000,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 5000 },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("thinking.budget_tokens");
    expect(captured.length).toBe(0);
  });

  test("thinking budget below the affordable clamp stays valid and dispatches", async () => {
    startFakeCpa(() => messageJson());
    await setBalance(100_000); // affordable >> 500
    const res = await gwr(MESSAGES_PATH, {
      model: PUBLIC_MODEL,
      max_tokens: 100_000,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 500 },
    });
    expect(res.status).toBe(200);
    const forwarded = JSON.parse(captured[0]!.body) as Record<string, unknown>;
    const thinking = forwarded.thinking as { type: string; budget_tokens: number };
    expect(thinking).toEqual({ type: "enabled", budget_tokens: 500 });
    expect(forwarded.max_tokens as number).toBeGreaterThan(500);
  });
});

describe("subscription pending daily grant funds an otherwise-empty wallet", () => {
  test("grant-only day dispatches; grant applied exactly once, no double count", async () => {
    const now = Date.now();
    const runId = crypto.randomUUID().slice(0, 8);
    const planId = `plan-ao-${runId}`;
    const subId = `sub-ao-${runId}`;
    // Money rows (ledger, reservations, settlements, usage_logs, requests,
    // wallets) are append-only or FK-anchored and accumulate harmlessly;
    // neutralize prior runs with updates and scope assertions to this run.
    await q(db, "UPDATE subscriptions SET status = 'canceled' WHERE workspace_id = 'ws-ao'");
    await q(
      db,
      "UPDATE wallets SET balance = 0, reserved = 0 WHERE workspace_id = 'ws-ao' AND kind = 'subscription'",
    );
    await q(
      db,
      "INSERT INTO subscription_plans (id, name, price_vnd, credit_per_period_vnd, period_days, rate_limit_per_minute, daily_grant_vnd, active, created_at) VALUES (?,?,100000,100000,30,60,2000,true,?)",
      planId,
      planId,
      now,
    );
    await q(
      db,
      "INSERT INTO subscriptions (id, workspace_id, plan_id, status, current_period_start, current_period_end, created_at) VALUES (?,'ws-ao',?,'active',?,?,?)",
      subId,
      planId,
      now - 1000,
      now + 86_400_000,
      now,
    );
    await setBalance(0);
    try {
      startFakeCpa(() => chatJson());
      const res = await gwr(CHAT_PATH, chatBody());
      expect(res.status).toBe(200);
      // The lazy grant materialized/funded the subscription wallet.
      const rows = await q<{ balance: number }>(
        db,
        "SELECT balance FROM wallets WHERE workspace_id = 'ws-ao' AND kind = 'subscription'",
      );
      expect(rows.length).toBe(1);
      expect(rows[0]!.balance).toBeGreaterThan(0);
      const grants = await q<{ c: number }>(
        db,
        "SELECT COUNT(*) c FROM subscription_daily_grants WHERE subscription_id = ?",
        subId,
      );
      expect(grants[0]!.c).toBe(1);
    } finally {
      await q(db, "UPDATE subscriptions SET status = 'canceled' WHERE id = ?", subId);
      await setBalance(WALLET_19USD);
    }
  });
});

describe("concurrency and failure money invariants", () => {
  test("five parallel requests afford exactly one hold: no overspend, no duplicate charge", async () => {
    startFakeCpa(() => chatJson());
    const raw = chatRaw();
    const maxInput = maxInputOf(raw);
    const affordable = estimateAffordableOutputTokens(
      maxInput,
      CTX,
      WALLET_19USD,
      PRICE,
      FX,
      MARKUP,
    );
    const hold = estimateCapVnd(
      { maxInputTokens: maxInput, maxOutputTokens: affordable },
      PRICE,
      FX,
      MARKUP,
    );
    // Balance covers ONE hold (with 5 VND slack < the ~20 VND minimum hold).
    await setBalance(hold + 5);
    const ledgerBefore = await ledgerBalance("wal-ao");
    const debitsBefore = Number(
      (
        (
          await q(
            db,
            "SELECT COUNT(*) c FROM ledger_entries WHERE wallet_id = 'wal-ao' AND direction = 'debit'",
          )
        )[0] as { c: number }
      ).c,
    );
    const results = await Promise.all(
      Array.from({ length: 5 }, () => gwr(CHAT_PATH, JSON.parse(raw))),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200).length).toBe(1);
    expect(statuses.filter((s) => s === 402).length).toBe(4);
    for (const r of results) await r.text();
    const wallet = (
      await q(db, "SELECT balance, reserved FROM wallets WHERE id = 'wal-ao'")
    )[0] as { balance: number; reserved: number };
    expect(wallet.reserved).toBe(0);
    expect(wallet.balance).toBeGreaterThanOrEqual(0);
    // Ledger delta matches the balance delta: exactly one debit, no duplicates.
    expect((await ledgerBalance("wal-ao")) - ledgerBefore).toBe(wallet.balance - (hold + 5));
    const debitsAfter = Number(
      (
        (
          await q(
            db,
            "SELECT COUNT(*) c FROM ledger_entries WHERE wallet_id = 'wal-ao' AND direction = 'debit'",
          )
        )[0] as { c: number }
      ).c,
    );
    expect(debitsAfter - debitsBefore).toBe(1);
  });

  test("failed CPA after dispatching -> 502 + settled_full_hold (cap debited, no overdraft)", async () => {
    startFakeCpa(() => new Response("boom", { status: 502 }));
    const res = await gwr(CHAT_PATH, chatBody());
    expect(res.status).toBe(502);
    expect((await lastCharge()).status).toBe("settled_full_hold");
    const wallet = (
      await q(db, "SELECT balance, reserved FROM wallets WHERE id = 'wal-ao'")
    )[0] as { balance: number; reserved: number };
    expect(wallet.reserved).toBe(0);
    expect(wallet.balance).toBeGreaterThanOrEqual(0);
    expect(wallet.balance).toBe(WALLET_19USD - (await lastCharge()).cap_vnd);
  });
});
