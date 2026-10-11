// Subscription daily grant (migration 0019): the plan's authored
// daily_grant_vnd is credited lazily ONCE per current UTC day inside the
// gateway funding transaction (reserveRequest with a funding arg), gated by
// UNIQUE(workspace, subscription, grant_day). Pins: first grant, same-day
// repeat, concurrent grants, UTC-day rollover boundary, no catch-up, no grant
// at plan settlement, cancel keeps grants through period end, expiry forfeits
// unused grant credit, and a failed reserve rolls the grant back atomically.
import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { createTestDb, type Db } from "../packages/db/src/index";
import {
  reserveRequest,
  runInImmediate,
  cancelSubscription,
  ensureSubscriptionWallet,
  applySubscriptionExpiry,
  extendOrCreateSubscription,
  creditWallet,
  utcDay,
  WalletError,
} from "../packages/wallet/src/index";

// 2023-11-14T22:13:20.000Z — late in UTC day "2023-11-14".
const NOW = 1_700_000_000_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const GRANT = 10_000;
const CAP = 5_000;
// Early in the NEXT UTC day — the rollover boundary.
const NEXT_DAY = NOW + 4 * HOUR_MS;

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

interface Fixture {
  ws: string;
  key: string;
  topup: string;
  model: string;
  mapping: string;
  price: string;
}

const FIX: Fixture = {
  ws: "ws-dg",
  key: "key-dg",
  topup: "wal-topup-dg",
  model: "model-dg",
  mapping: "pm-dg",
  price: "price-dg",
};

async function seed(): Promise<void> {
  await db.$client.unsafe(
    `INSERT INTO users (id, name, email, created_at, updated_at) VALUES ('u-dg','U','u-dg@t.local',$1,$1)`,
    [NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO workspaces (id, name, status, created_at) VALUES ($1,'D','active',$2)`,
    [FIX.ws, NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at)
     VALUES ($1,$2,'hash-dg','sk-hbr-d','key d','active',$3)`,
    [FIX.key, FIX.ws, NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO models (id, public_id, slug, display_name, provider, enabled, published, created_at, updated_at)
     VALUES ($1,'pub-dg','slug-dg','Model D','openai',true,true,$2,$2)`,
    [FIX.model, NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at)
     VALUES ($1,$2,'openai','upstream-dg',true,$3,$3)`,
    [FIX.mapping, FIX.model, NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at)
     VALUES ($1,$2,1000000,2000000,500000,3000000,1000000,$3)`,
    [FIX.price, FIX.model, NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at)
     VALUES ($1,$2,'VND',0,0,0,$3)`,
    [FIX.topup, FIX.ws, NOW] as never[],
  );
}

beforeAll(async () => {
  await seed();
  await db.$client.unsafe(
    `INSERT INTO subscription_plans (id, name, price_vnd, credit_per_period_vnd, period_days, daily_grant_vnd, active, created_at)
     VALUES ('plan-dg','plan-dg',100000,100000,30,$1,true,$2)`,
    [GRANT, NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO subscription_plans (id, name, price_vnd, credit_per_period_vnd, period_days, daily_grant_vnd, active, created_at)
     VALUES ('plan-dg0','plan-dg0',100000,100000,30,0,true,$1)`,
    [NOW] as never[],
  );
});

// Active, unexpired 30-day subscription on the granting plan.
async function seedSubscription(planId = "plan-dg"): Promise<void> {
  await db.$client.unsafe(
    `INSERT INTO subscriptions (id, workspace_id, plan_id, status, current_period_start, current_period_end, created_at)
     VALUES ('sub-dg',$1,$2,'active',$3,$4,$3)`,
    [FIX.ws, planId, NOW - 2 * DAY_MS, NOW + 28 * DAY_MS] as never[],
  );
}

let reqSeq = 0;
function reserveArgs(over: Partial<Parameters<typeof reserveRequest>[1]> = {}) {
  reqSeq += 1;
  return {
    requestId: `req-dg-${reqSeq}`,
    workspaceId: FIX.ws,
    apiKeyId: FIX.key,
    modelId: FIX.model,
    mappingId: FIX.mapping,
    modelPriceId: FIX.price,
    endpoint: "/v1/chat/completions" as const,
    mode: "stream" as const,
    fxRate: 26_000,
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

async function grantLedgerRows(): Promise<{ amount: string; memo: string }[]> {
  return q<{ amount: string; memo: string }>(
    `SELECT amount::text AS amount, memo FROM ledger_entries WHERE kind = 'subscription_daily_grant' ORDER BY created_at, id`,
  );
}

afterEach(async () => {
  // Tests share one DB: reset the mutable billing tables between cases.
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

describe("lazy daily grant in the funding transaction", () => {
  test("first funding transaction of the UTC day grants once and lazily creates the wallet", async () => {
    await seedSubscription();
    const r = await reserveRequest(db, reserveArgs({ funding: { underLimit: true } }));
    // The grant itself made the subscription wallet fundable.
    expect(r.walletKind).toBe("subscription");
    const grants = await grantRows();
    expect(grants).toEqual([{ day: utcDay(NOW), amount: String(GRANT) }]);
    const ledger = await grantLedgerRows();
    expect(ledger).toEqual([{ amount: String(GRANT), memo: `daily grant ${utcDay(NOW)}` }]);
    const w = await q<{ balance: string; reserved: string }>(
      `SELECT balance::text AS balance, reserved::text AS reserved FROM wallets WHERE workspace_id = $1 AND kind = 'subscription'`,
      [FIX.ws],
    );
    expect(w[0]).toEqual({ balance: String(GRANT), reserved: String(CAP) });
    // Terms snapshot frozen on the gate row.
    const gate = await q<{ plan_id: string; subscription_id: string; ledger_entry_id: string }>(
      `SELECT plan_id, subscription_id, ledger_entry_id FROM subscription_daily_grants`,
    );
    expect(gate[0]).toEqual({
      plan_id: "plan-dg",
      subscription_id: "sub-dg",
      ledger_entry_id: (
        await q<{ id: string }>(
          `SELECT id FROM ledger_entries WHERE kind = 'subscription_daily_grant'`,
        )
      )[0]!.id,
    });
  });

  test("repeat funding the same UTC day grants nothing more", async () => {
    await seedSubscription();
    await reserveRequest(db, reserveArgs({ funding: { underLimit: true } }));
    await reserveRequest(db, reserveArgs({ funding: { underLimit: true } }));
    expect(await grantRows()).toHaveLength(1);
    expect(await grantLedgerRows()).toHaveLength(1);
    const w = await q<{ balance: string; reserved: string }>(
      `SELECT balance::text AS balance, reserved::text AS reserved FROM wallets WHERE workspace_id = $1 AND kind = 'subscription'`,
      [FIX.ws],
    );
    expect(w[0]).toEqual({ balance: String(GRANT), reserved: String(2 * CAP) });
  });

  test("no catch-up: a subscription active across past days gets only the current day", async () => {
    // Period started 2 days ago with no funding transactions on those days.
    await seedSubscription();
    await reserveRequest(db, reserveArgs({ funding: { underLimit: true } }));
    expect(await grantRows()).toEqual([{ day: utcDay(NOW), amount: String(GRANT) }]);
  });

  test("UTC day rollover grants the next day exactly once", async () => {
    await seedSubscription();
    await reserveRequest(db, reserveArgs({ funding: { underLimit: true } }));
    await reserveRequest(db, reserveArgs({ now: NEXT_DAY, funding: { underLimit: true } }));
    expect(await grantRows()).toEqual([
      { day: utcDay(NOW), amount: String(GRANT) },
      { day: utcDay(NEXT_DAY), amount: String(GRANT) },
    ]);
    expect(await grantLedgerRows()).toHaveLength(2);
  });

  test("plan with daily_grant_vnd 0 grants nothing", async () => {
    await seedSubscription("plan-dg0");
    await db.$client.unsafe(`UPDATE wallets SET balance = 50000 WHERE id = $1`, [
      FIX.topup,
    ] as never[]);
    const r = await reserveRequest(db, reserveArgs({ funding: { underLimit: true } }));
    // No grant, and without credit the subscription wallet cannot fund.
    expect(r.walletKind).toBe("topup");
    expect(await grantRows()).toEqual([]);
    expect(await grantLedgerRows()).toEqual([]);
  });

  test("concurrent funding transactions grant exactly once per day", async () => {
    await seedSubscription();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        reserveRequest(db, reserveArgs({ funding: { underLimit: true } })),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter(
      (r) => r.status === "rejected" && (r.reason as WalletError).code === "insufficient",
    ).length;
    // The single 10_000 grant funds exactly 2 holds of 5_000.
    expect(ok).toBe(2);
    expect(failed).toBe(4);
    expect(await grantRows()).toEqual([{ day: utcDay(NOW), amount: String(GRANT) }]);
    expect(await grantLedgerRows()).toHaveLength(1);
    const w = await q<{ balance: string; reserved: string }>(
      `SELECT balance::text AS balance, reserved::text AS reserved FROM wallets WHERE workspace_id = $1 AND kind = 'subscription'`,
      [FIX.ws],
    );
    expect(w[0]).toEqual({ balance: String(GRANT), reserved: String(2 * CAP) });
  });

  test("a failing reserve rolls the grant back (no orphan credit)", async () => {
    await seedSubscription();
    // Cap exceeds grant + no topup wallet balance: insufficient fails the
    // whole transaction, grant included.
    let err: unknown;
    try {
      await reserveRequest(db, reserveArgs({ capVnd: 50_000, funding: { underLimit: true } }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WalletError);
    expect((err as WalletError).code).toBe("insufficient");
    expect(await grantRows()).toEqual([]);
    expect(await grantLedgerRows()).toEqual([]);
    const counts = await q<{ subs: string; wallets: string; ledger: string }>(
      `SELECT (SELECT COUNT(*) FROM subscription_daily_grants) subs,
              (SELECT COUNT(*) FROM wallets WHERE kind = 'subscription') wallets,
              (SELECT COUNT(*) FROM ledger_entries) ledger`,
    );
    expect(counts[0]).toEqual({ subs: "0", wallets: "0", ledger: "0" });
  });
});

describe("daily grant vs cancel and expiry", () => {
  test("canceled-but-unexpired subscription still receives the grant (decision b)", async () => {
    await seedSubscription();
    await runInImmediate(db, (tx) => cancelSubscription(tx, FIX.ws, NOW));
    const r = await reserveRequest(db, reserveArgs({ funding: { underLimit: true } }));
    expect(r.walletKind).toBe("subscription");
    expect(await grantRows()).toEqual([{ day: utcDay(NOW), amount: String(GRANT) }]);
  });

  test("expired period: unused grant credit forfeits via lazy expiry, no new grant", async () => {
    await seedSubscription();
    await reserveRequest(db, reserveArgs({ funding: { underLimit: true } }));
    // Period lapses with the hold in place.
    await db.$client.unsafe(
      `UPDATE subscriptions SET current_period_end = $1 WHERE id = 'sub-dg'`,
      [NOW - 1_000] as never[],
    );
    await db.$client.unsafe(`UPDATE wallets SET balance = balance + 40000 WHERE kind = 'topup'`);
    const r = await reserveRequest(
      db,
      reserveArgs({ now: NEXT_DAY, funding: { underLimit: true } }),
    );
    // Subscription expired: topup funds, grant credit forfeited (available
    // part), and no grant row for the new day.
    expect(r.walletKind).toBe("topup");
    expect(await grantRows()).toEqual([{ day: utcDay(NOW), amount: String(GRANT) }]);
    const forfeits = await q<{ amount: string }>(
      `SELECT l.amount::text AS amount FROM ledger_entries l JOIN wallets w ON w.id = l.wallet_id
       WHERE w.kind = 'subscription' AND l.kind = 'adjustment'`,
    );
    expect(forfeits).toEqual([{ amount: String(GRANT - CAP) }]);
  });
});

describe("plan settlement never grants", () => {
  test("the settlement sequence (wallet ensure, expiry, extend, period credit) writes no daily grant", async () => {
    await seedSubscription();
    // Mirror packages/payments credit.ts settlement without the payment row.
    await runInImmediate(db, async (tx) => {
      const w = await ensureSubscriptionWallet(tx, FIX.ws, NEXT_DAY);
      await applySubscriptionExpiry(tx, FIX.ws, NEXT_DAY);
      await extendOrCreateSubscription(tx, FIX.ws, "plan-dg", 30, NEXT_DAY);
      await creditWallet(tx, {
        walletId: w.id,
        amount: 100_000,
        kind: "topup",
        paymentId: null,
        memo: "test period credit",
      });
    });
    expect(await grantRows()).toEqual([]);
    expect(await grantLedgerRows()).toEqual([]);
  });
});
