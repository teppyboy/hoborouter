// Wallet + member catalog FX surfaces (Task 2, C2): the wallet and the
// member bundle/plan lists expose the CANONICAL payment-settings FX rate
// (payment_usd_vnd_rate) — never the gateway HBR_USD_VND_RATE env — and USD
// catalog rows quote price_vnd at that rate while legacy rows keep their
// stored price. Usage-logs responses never leak upstream_model.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Elysia } from "elysia";
import { sql } from "drizzle-orm";
import { createTestDb, type Db } from "@hoborouter/db";
import { dashboardRoutes } from "../src/routes/dashboard";
import { bundlesRoutes } from "../src/routes/bundles";

const ws = "ws-usd";
const NOW = Date.now();
let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;

const authAs = (userId: string) => ({
  handler: async () => new Response("", { status: 404 }),
  api: { getSession: async () => ({ user: { id: userId }, session: { id: "s", userId } }) },
});

const buildTestApp = (db: Db, auth: ReturnType<typeof authAs>) =>
  new Elysia().use(dashboardRoutes(db, auth)).use(bundlesRoutes(db, auth));

let app: ReturnType<typeof buildTestApp>;

const setSetting = async (key: string, value: string) => {
  await db.execute(
    sql`INSERT INTO instance_settings (key, value, updated_at) VALUES (${key}, ${value}, ${NOW})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );
};

const deleteSetting = async (key: string) => {
  await db.execute(sql`DELETE FROM instance_settings WHERE key = ${key}`);
};

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  await db.execute(
    sql`INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES ('u1','U','u@t.test',true,${NOW},${NOW})`,
  );
  await db.execute(
    sql`INSERT INTO workspaces (id, name, status, created_at) VALUES (${ws},'ws','active',${NOW})`,
  );
  await db.execute(
    sql`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${ws},'u1','owner')`,
  );
  await db.execute(
    sql`INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at) VALUES (${`wal-${ws}`},${ws},'VND',100000,0,0,${NOW})`,
  );
  await db.execute(
    sql`INSERT INTO models (id, public_id, slug, display_name, provider, enabled, published, created_at, updated_at) VALUES ('m-1','gpt-public','gpt-public','GPT','vendor',true,true,${NOW},${NOW})`,
  );
  await db.execute(
    sql`INSERT INTO requests (id, workspace_id, endpoint, mode, status, dispatch_state, model_id, created_at) VALUES ('req-1',${ws},'/v1/chat/completions','non-stream','ok','terminal','m-1',${NOW})`,
  );
  await db.execute(
    sql`INSERT INTO usage_logs (id, idempotency_key, request_id, workspace_id, provider, public_model, upstream_model, input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, status, created_at) VALUES ('log-1','idem-1','req-1',${ws},'openrouter','gpt-public','gpt-secret-upstream-xyz',10,5,0,0,'ok',${NOW})`,
  );
  // USD-authored bundle: 9.99 USD frozen at creation FX 26001 (259750 VND);
  // plan: 5.50 USD / credit 10 USD at the same creation rate.
  await db.execute(
    sql`INSERT INTO credit_bundles (id, name, price_vnd, credit_vnd, bonus_vnd, price_usd, credit_usd, bonus_usd, creation_fx_rate_vnd_per_usd, active, created_at)
        VALUES ('b-usd','USD bundle',259750,130005,0,'9.99','5','0',26001,true,${NOW})`,
  );
  await db.execute(
    sql`INSERT INTO credit_bundles (id, name, price_vnd, credit_vnd, bonus_vnd, active, created_at)
        VALUES ('b-legacy','Legacy bundle',50000,50000,0,true,${NOW})`,
  );
  await db.execute(
    sql`INSERT INTO subscription_plans (id, name, price_vnd, credit_per_period_vnd, price_usd, credit_per_period_usd, creation_fx_rate_vnd_per_usd, period_days, active, created_at)
        VALUES ('p-usd','USD plan',143000,260000,'5.50','10',26001,30,true,${NOW})`,
  );
  app = buildTestApp(db, authAs("u1"));
});

afterAll(async () => {
  delete process.env.HBR_USD_VND_RATE;
  await t.drop();
});

const get = (path: string) => app.handle(new Request(`http://localhost${path}`));

describe("GET /workspaces/:id/wallet", () => {
  test("returns the canonical payment-settings rate despite conflicting env FX", async () => {
    process.env.HBR_USD_VND_RATE = "99999";
    await setSetting("payment_usd_vnd_rate", "27001");
    const res = await get(`/api/v1/workspaces/${ws}/wallet`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { usd_vnd_rate: number; available: number };
    expect(body.usd_vnd_rate).toBe(27001);
    expect(body.available).toBe(100000);
  });

  test("defaults to 26000 when the setting is unset (env still ignored)", async () => {
    process.env.HBR_USD_VND_RATE = "99999";
    await deleteSetting("payment_usd_vnd_rate");
    const res = await get(`/api/v1/workspaces/${ws}/wallet`);
    const body = (await res.json()) as { usd_vnd_rate: number };
    expect(body.usd_vnd_rate).toBe(26000);
  });
});

describe("member catalog quotes", () => {
  test("bundle envelope exposes the canonical rate; USD rows quote at it, legacy keep stored price", async () => {
    await setSetting("payment_usd_vnd_rate", "27001");
    const res = await get("/api/v1/bundles");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      usd_vnd_rate: number;
      data: Record<string, unknown>[];
    };
    expect(body.usd_vnd_rate).toBe(27001);
    const usd = body.data.find((b) => b.id === "b-usd")!;
    // Quote: 999 cents * 27001 -> ceiling 269740 (current rate, not creation).
    expect(usd.price_vnd).toBe(269740);
    expect(usd.price_usd).toBe("9.99");
    expect(usd.credit_usd).toBe("5");
    expect(usd.bonus_usd).toBe("0");
    expect(usd.credit_vnd).toBe(130005);
    expect(usd.creation_fx_rate_vnd_per_usd).toBe(26001);
    const legacy = body.data.find((b) => b.id === "b-legacy")!;
    expect(legacy.price_vnd).toBe(50000);
    expect(legacy.price_usd).toBeNull();
    expect(legacy.credit_usd).toBeNull();
    expect(legacy.bonus_usd).toBeNull();
    expect(legacy.creation_fx_rate_vnd_per_usd).toBeNull();
  });

  test("plan list quotes USD rows at the canonical rate and exposes USD metadata", async () => {
    const res = await get("/api/v1/subscription-plans");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      usd_vnd_rate: number;
      data: Record<string, unknown>[];
    };
    expect(body.usd_vnd_rate).toBe(27001);
    const usd = body.data.find((p) => p.id === "p-usd")!;
    // 550 cents * 27001 = 14,850,550 -> ceiling 148506 (current rate).
    expect(usd.price_vnd).toBe(148506);
    expect(usd.price_usd).toBe("5.50");
    expect(usd.credit_per_period_usd).toBe("10");
    expect(usd.credit_per_period_vnd).toBe(260000);
    expect(usd.creation_fx_rate_vnd_per_usd).toBe(26001);
  });
});

describe("usage-logs leak guard", () => {
  test("no upstream_model key, no upstream id string", async () => {
    const res = await get(`/api/v1/workspaces/${ws}/usage-logs`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("upstream_model");
    expect(text).not.toContain("gpt-secret-upstream-xyz");
    expect(text).toContain("gpt-public");
  });
});
