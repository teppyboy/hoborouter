// Prepaid throughput allowance gateway admission: an active allowance caps
// ALL workspace traffic regardless of funding source (these requests are
// topup-funded, proving the cap is not subscription-funding-scoped). Over
// cap -> 429 with Retry-After and code throughput_allowance_limited, zero
// new rows; reserve-failure returns the admission slot so the next request
// is not falsely limited; window gating is [starts_at, ends_at) with lazy
// expiry/promotion, so a queued window limits only once its start passes.
// Wording contract: the 429 message describes a gateway admission limit.
import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { Elysia } from "elysia";
import { createTestDb } from "@hoborouter/db";
import { hashApiKey } from "@hoborouter/keys";
import { q, trackDrop } from "./helpers";
import { gatewayRoutes } from "../src/routes/v1-gateway";
import {
  resetSubscriptionRateLimits,
  resetThroughputAllowanceLimits,
  setRateLimitClock,
} from "../src/rate-limit";

const PLAINTEXT = "sk-hbr-tp-test-key";
const CPA_KEY = "test-cpa-secret";
const CHAT_PATH = "/v1/chat/completions";
const RPM = 2; // allowance requests_per_minute
const DAY_MS = 86_400_000;

const ENV_KEYS = ["HBR_GATEWAY_ENABLED", "CPA_BASE_URL", "CPA_ACCESS_KEY", "HBR_USD_VND_RATE"];
let savedEnv: Record<string, string | undefined> = {};

async function seed(db: Awaited<ReturnType<typeof makeDb>>["db"]) {
  const now = Date.now();
  await q(
    db,
    "INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws-tp','tp','active',?)",
    now,
  );
  await q(
    db,
    `INSERT INTO wallets (id, workspace_id, kind, currency, balance, reserved, version, created_at)
     VALUES ('wal-top','ws-tp','topup','VND',1000000,0,0,?)`,
    now,
  );
  await q(
    db,
    "INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at) VALUES ('key-tp','ws-tp',?,?,'tp','active',?)",
    hashApiKey(PLAINTEXT),
    "sk-hbr-tp...",
    now,
  );
  await q(
    db,
    "INSERT INTO models (id, public_id, slug, display_name, provider, context_window, enabled, published, created_at, updated_at) VALUES ('mdl-t','openai/tp-test','tp-test','TP Test','openai',128000,true,true,?,?)",
    now,
    now,
  );
  await q(
    db,
    "INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at) VALUES ('map-t','mdl-t','openai','tp-upstream',true,?,?)",
    now,
    now,
  );
  await q(
    db,
    "INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at, retired_at) VALUES ('price-t','mdl-t',1000000,2000000,500000,3000000,1200000,?,NULL)",
    now - 1000,
  );
  await q(
    db,
    "INSERT INTO throughput_products (id, name, price_vnd, requests_per_minute, duration_days, active, created_at) VALUES ('prod-tp','tp',1000,30,7,true,?)",
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
  await seed(db);
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

const chatBody = () => ({
  model: "openai/tp-test",
  messages: [{ role: "user", content: "hi" }],
});

let fakeServer: ReturnType<typeof Bun.serve> | null = null;
let hits = 0;
function startFakeCpa() {
  hits = 0;
  fakeServer = Bun.serve({
    port: 0,
    fetch: async () => {
      hits++;
      return new Response(
        JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          model: "tp-upstream",
          choices: [
            { index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 1,
            prompt_tokens_details: { cached_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 0 },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  process.env.CPA_BASE_URL = `http://127.0.0.1:${fakeServer.port}`;
}

const count = async (table: string) =>
  ((await q(db, `SELECT COUNT(*) c FROM ${table}`))[0] as { c: number }).c;

// The allowance row under test; starts/ends absolute epoch ms (default:
// started 1s ago, lasts a day — valid under both the real and injected clock).
async function seedAllowance(over: { rpm?: number; startsAt?: number; endsAt?: number } = {}) {
  const now = Date.now();
  const startsAt = over.startsAt ?? now - 1000;
  const endsAt = over.endsAt ?? now + DAY_MS;
  await q(
    db,
    "INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at, throughput_product_id) VALUES ('pay-tp','ws-tp',1000,'succeeded','mock','TP-1',?,NULL)",
    now,
  );
  await q(
    db,
    `INSERT INTO throughput_allowances (id, workspace_id, payment_id, product_id, requests_per_minute, starts_at, ends_at, status, created_at)
     VALUES ('ta-tp','ws-tp','pay-tp','prod-tp',?, ?, ?, 'active', ?)`,
    over.rpm ?? RPM,
    startsAt,
    endsAt,
    now,
  );
}

const setTopup = (balance: number) =>
  q(db, "UPDATE wallets SET balance = ?, reserved = 0 WHERE id = 'wal-top'", balance);

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.HBR_GATEWAY_ENABLED = "1";
  process.env.CPA_ACCESS_KEY = CPA_KEY;
  process.env.HBR_USD_VND_RATE = "26000";
  delete process.env.CPA_BASE_URL;
  resetSubscriptionRateLimits();
  resetThroughputAllowanceLimits();
  setRateLimitClock(Date.now);
  await setTopup(1000000);
  await q(db, "DELETE FROM throughput_allowances");
  await q(db, "DELETE FROM payments WHERE id = 'pay-tp'");
});

afterEach(async () => {
  fakeServer?.stop(true);
  fakeServer = null;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("throughput allowance gateway admission", () => {
  test("up to N topup-funded requests pass under the allowance cap", async () => {
    startFakeCpa();
    await seedAllowance();
    for (let i = 0; i < RPM; i++) {
      const res = await gwr(CHAT_PATH, chatBody());
      expect(res.status).toBe(200);
    }
    expect(hits).toBe(RPM);
  });

  test("N+1 -> 429 with Retry-After, admission code, and zero new rows", async () => {
    startFakeCpa();
    await seedAllowance();
    for (let i = 0; i < RPM; i++) expect((await gwr(CHAT_PATH, chatBody())).status).toBe(200);
    const before = await count("billing_reservations");
    const res = await gwr(CHAT_PATH, chatBody());
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string; message: string; type: string } };
    expect(body.error.code).toBe("throughput_allowance_limited");
    expect(body.error.type).toBe("rate_limit_error");
    // Admission-limit wording, never a provider-capacity or priority claim.
    expect(body.error.message).toContain("gateway admission limit");
    expect(body.error.message).not.toContain("provider capacity");
    const retryAfter = Number(res.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(hits).toBe(RPM);
    expect(await count("billing_reservations")).toBe(before);
    // Repeated 429s never erode the admitted count.
    expect((await gwr(CHAT_PATH, chatBody())).status).toBe(429);
  });

  test("reserve failure returns the admission slot (no false 429)", async () => {
    startFakeCpa();
    await seedAllowance({ rpm: 1 });
    await setTopup(0); // reserve will fail with insufficient balance
    const first = await gwr(CHAT_PATH, chatBody());
    expect(first.status).toBe(402); // admitted (slot counted) but unfundable
    // The slot was returned: without the undo this would be a false 429.
    const second = await gwr(CHAT_PATH, chatBody());
    expect(second.status).toBe(402);
  });

  test("window gating: future window does not limit until its start passes", async () => {
    const T0 = 1_700_000_000_000;
    setRateLimitClock(() => T0);
    startFakeCpa();
    // Window starts 60s after the injected clock, ends a day later.
    await seedAllowance({ startsAt: T0 + 60_000, endsAt: T0 + 61_000 + DAY_MS });
    // Clock inside the queued window's future: not limiting yet.
    for (let i = 0; i < RPM + 2; i++) expect((await gwr(CHAT_PATH, chatBody())).status).toBe(200);
    // Clock past the window start: the cap applies (lazy promotion).
    setRateLimitClock(() => T0 + 61_000);
    // The earlier requests ran before the window: the fresh window starts empty.
    for (let i = 0; i < RPM; i++) expect((await gwr(CHAT_PATH, chatBody())).status).toBe(200);
    expect((await gwr(CHAT_PATH, chatBody())).status).toBe(429);
  });

  test("lapsed window limits nothing (lazy expiry)", async () => {
    startFakeCpa();
    await seedAllowance({ startsAt: Date.now() - 2000, endsAt: Date.now() - 1000 });
    for (let i = 0; i < RPM + 2; i++) expect((await gwr(CHAT_PATH, chatBody())).status).toBe(200);
    const rows = await q<{ status: string }>(
      db,
      "SELECT status FROM throughput_allowances WHERE id = 'ta-tp'",
    );
    expect(rows[0]!.status).toBe("expired");
  });

  test("without an allowance, topup-funded traffic is never admission-limited", async () => {
    startFakeCpa();
    for (let i = 0; i < RPM + 3; i++) {
      expect((await gwr(CHAT_PATH, chatBody())).status).toBe(200);
    }
    expect(hits).toBe(RPM + 3);
  });
});
