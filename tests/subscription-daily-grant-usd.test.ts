// Daily grant for a USD-authored plan (migration 0020): the grant path uses
// the plan's FROZEN derived daily_grant_vnd (5 USD/day at the creation FX
// snapshot = 130000), never the current canonical FX rate. Pins: exact
// amount, same-day replay grants nothing more, and concurrent funding
// transactions credit exactly once (gate UNIQUE(workspace, subscription, day)).
import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { createTestDb, type Db } from "../packages/db/src/index";
import { reserveRequest, utcDay } from "../packages/wallet/src/index";

// 2023-11-14T22:13:20.000Z — late in UTC day "2023-11-14".
const NOW = 1_700_000_000_000;
const DAY_MS = 86_400_000;
const GRANT = 130_000; // 5 USD/day frozen at the 26000 creation FX snapshot.
const CAP = 65_000;

let db: Db;
let drop: () => Promise<void>;

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  drop = t.drop;
});

afterAll(async () => {
  await drop();
});

async function q<T>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.$client.unsafe(text, params as never[])) as T[];
}

const FIX = { ws: "ws-dgu", key: "key-dgu", topup: "wal-topup-dgu" };

beforeAll(async () => {
  await db.$client.unsafe(
    `INSERT INTO users (id, name, email, created_at, updated_at) VALUES ('u-dgu','U','u-dgu@t.local',$1,$1)`,
    [NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO workspaces (id, name, status, created_at) VALUES ($1,'D','active',$2)`,
    [FIX.ws, NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at)
     VALUES ($1,$2,'hash-dgu','sk-hbr-d','key d','active',$3)`,
    [FIX.key, FIX.ws, NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO models (id, public_id, slug, display_name, provider, enabled, published, created_at, updated_at)
     VALUES ('model-dgu','pub-dgu','slug-dgu','Model D','openai',true,true,$1,$1)`,
    [NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at)
     VALUES ('pm-dgu','model-dgu','openai','upstream-dgu',true,$1,$1)`,
    [NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at)
     VALUES ('price-dgu','model-dgu',1000000,2000000,500000,3000000,1000000,$1)`,
    [NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at)
     VALUES ($1,$2,'VND',0,0,0,$3)`,
    [FIX.topup, FIX.ws, NOW] as never[],
  );
  // Authored 5 USD/day at the frozen 26000 VND/USD creation snapshot
  // (exactly what the admin API derives for daily_grant_usd "5").
  await db.$client.unsafe(
    `INSERT INTO subscription_plans (id, name, price_vnd, credit_per_period_vnd, period_days,
       daily_grant_vnd, daily_grant_usd, creation_fx_rate_vnd_per_usd, active, created_at)
     VALUES ('plan-dgu','plan-dgu',100000,100000,30,$1,'5',26000,true,$2)`,
    [GRANT, NOW] as never[],
  );
  // A LATER canonical FX change must be irrelevant to the frozen grant.
  await db.$client.unsafe(
    `INSERT INTO instance_settings (key, value, updated_at) VALUES ('payment_usd_vnd_rate','30000',$1)`,
    [NOW] as never[],
  );
});

async function seedSubscription(): Promise<void> {
  await db.$client.unsafe(
    `INSERT INTO subscriptions (id, workspace_id, plan_id, status, current_period_start, current_period_end, created_at)
     VALUES ('sub-dgu',$1,'plan-dgu','active',$2,$3,$2)`,
    [FIX.ws, NOW - 2 * DAY_MS, NOW + 28 * DAY_MS] as never[],
  );
}

let reqSeq = 0;
function reserveArgs(over: Partial<Parameters<typeof reserveRequest>[1]> = {}) {
  reqSeq += 1;
  return {
    requestId: `req-dgu-${reqSeq}`,
    workspaceId: FIX.ws,
    apiKeyId: FIX.key,
    modelId: "model-dgu",
    mappingId: "pm-dgu",
    modelPriceId: "price-dgu",
    endpoint: "/v1/chat/completions" as const,
    mode: "stream" as const,
    fxRate: 30_000,
    capVnd: CAP,
    now: NOW,
    ...over,
  };
}

async function grantRows(): Promise<{ day: string; amount: string }[]> {
  return q<{ day: string; amount: string }>(
    `SELECT grant_day AS "day", amount::text AS amount FROM subscription_daily_grants ORDER BY grant_day`,
  );
}

afterEach(async () => {
  await db.$client.unsafe(
    `TRUNCATE requests, billing_reservations, settlements, usage_logs, ledger_entries,
     subscription_expiries, subscription_daily_grants, subscriptions, audit_log, wallets CASCADE`,
  );
  await db.$client.unsafe(
    `INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at)
     VALUES ($1, $2, 'VND', 0, 0, 0, $3)`,
    [FIX.topup, FIX.ws, NOW] as never[],
  );
});

describe("USD-authored daily grant uses the frozen derived VND", () => {
  test("grants exactly 5-USD-at-creation-FX VND, not the current FX", async () => {
    await seedSubscription();
    const r = await reserveRequest(db, reserveArgs({ funding: { underLimit: true } }));
    expect(r.walletKind).toBe("subscription");
    expect(await grantRows()).toEqual([{ day: utcDay(NOW), amount: String(GRANT) }]);
  });

  test("same-day replay grants nothing more", async () => {
    await seedSubscription();
    await reserveRequest(db, reserveArgs({ funding: { underLimit: true } }));
    await reserveRequest(db, reserveArgs({ funding: { underLimit: true } }));
    expect(await grantRows()).toEqual([{ day: utcDay(NOW), amount: String(GRANT) }]);
  });

  test("concurrent funding transactions credit exactly once", async () => {
    await seedSubscription();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        reserveRequest(db, reserveArgs({ funding: { underLimit: true } })),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;
    // The single 130000 grant funds exactly 2 holds of 65000.
    expect(ok).toBe(2);
    expect(failed).toBe(4);
    expect(await grantRows()).toEqual([{ day: utcDay(NOW), amount: String(GRANT) }]);
  });
});
