// Subscription cancel (owner decision b): cancel stops renewal only — the
// subscription row keeps status 'active' and its credit stays fully spendable
// through current_period_end, then the existing lazy expiry (O5) forfeits the
// leftover exactly as an uncanceled subscription would. Cancel itself never
// touches the wallet or the ledger, and repeats are idempotent.
import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { createTestDb, type Db } from "../packages/db/src/index";
import {
  applySubscriptionExpiry,
  cancelSubscription,
  getActiveUnexpiredSubscription,
  reserveRequest,
  runInImmediate,
} from "../packages/wallet/src/index";

const NOW = 1_700_000_000_000;
const DAY_MS = 86_400_000;

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

beforeAll(async () => {
  await db.$client.unsafe(
    `INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws-cancel','C','active',$1)`,
    [NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at)
     VALUES ('key-cancel','ws-cancel','hash-cancel','sk-hbr-c','key c','active',$1)`,
    [NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at)
     VALUES ('wal-topup-cancel','ws-cancel','VND',0,0,0,$1)`,
    [NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO models (id, public_id, slug, display_name, provider, enabled, published, created_at, updated_at)
     VALUES ('model-cancel','pub-c','slug-c','Model C','openai',true,true,$1,$1)`,
    [NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at)
     VALUES ('pm-cancel','model-cancel','openai','upstream-c',true,$1,$1)`,
    [NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at)
     VALUES ('price-cancel','model-cancel',1000000,2000000,500000,3000000,1000000,$1)`,
    [NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO subscription_plans (id, name, price_vnd, credit_per_period_vnd, period_days, active, created_at)
     VALUES ('plan-cancel','plan-cancel',100000,100000,30,true,$1)`,
    [NOW] as never[],
  );
});

// Each case seeds its own active subscription + subscription wallet with an
// opening balance recorded AS a ledger credit (balance == sum(ledger)).
async function seedActiveSubscription(over: { periodEnd?: number } = {}): Promise<void> {
  const periodEnd = over.periodEnd ?? NOW + 30 * DAY_MS;
  await db.$client.unsafe(
    `INSERT INTO wallets (id, workspace_id, currency, kind, balance, reserved, version, created_at)
     VALUES ('wal-sub-cancel','ws-cancel','VND','subscription',250000,0,0,$1)`,
    [NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO ledger_entries (id, wallet_id, direction, amount, kind, balance_after, memo, created_at)
     VALUES ('led-sub-cancel','wal-sub-cancel','credit',250000,'topup',250000,'test seed',$1)`,
    [NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO subscriptions (id, workspace_id, plan_id, status, current_period_start, current_period_end, created_at)
     VALUES ('sub-cancel','ws-cancel','plan-cancel','active',$1,$2,$1)`,
    [Math.min(NOW - DAY_MS, periodEnd - DAY_MS), periodEnd] as never[],
  );
}

afterEach(async () => {
  await db.$client.unsafe(
    `TRUNCATE requests, billing_reservations, settlements, usage_logs, ledger_entries,
     subscription_expiries, subscriptions, audit_log, wallets CASCADE`,
  );
  await db.$client.unsafe(
    `INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at)
     VALUES ('wal-topup-cancel','ws-cancel','VND',0,0,0,$1)`,
    [NOW] as never[],
  );
});

describe("cancelSubscription (domain)", () => {
  test("cancel keeps status active + credit, writes no ledger, audits once", async () => {
    await seedActiveSubscription();
    const result = await runInImmediate(db, (tx) => cancelSubscription(tx, "ws-cancel", NOW));
    expect(result).toEqual({
      id: "sub-cancel",
      canceled_at: NOW,
      current_period_end: NOW + 30 * DAY_MS,
    });
    // Status stays 'active': credit remains spendable through period end and
    // the existing lazy expiry keeps applying at period end.
    const rows = await q<{ status: string; canceled_at: number }>(
      `SELECT status, canceled_at FROM subscriptions WHERE id = 'sub-cancel'`,
    );
    expect(rows[0]!.status).toBe("active");
    expect(Number(rows[0]!.canceled_at)).toBe(NOW);
    // No money moved: wallet balance unchanged, zero new ledger entries.
    const balance = await q<{ balance: number }>(
      `SELECT balance FROM wallets WHERE id = 'wal-sub-cancel'`,
    );
    expect(Number(balance[0]!.balance)).toBe(250_000);
    const ledger = await q<{ n: string }>(
      `SELECT count(*) AS n FROM ledger_entries WHERE wallet_id = 'wal-sub-cancel'`,
    );
    expect(ledger[0]!.n).toBe("1"); // only the seeded opening credit
    const audits = await q<{ action: string }>(
      `SELECT action FROM audit_log WHERE workspace_id = 'ws-cancel' AND action = 'subscription.cancel'`,
    );
    expect(audits.length).toBe(1);
  });

  test("cancel is idempotent: repeat returns the same row, no extra audit", async () => {
    await seedActiveSubscription();
    const first = await runInImmediate(db, (tx) => cancelSubscription(tx, "ws-cancel", NOW));
    const second = await runInImmediate(db, (tx) =>
      cancelSubscription(tx, "ws-cancel", NOW + 1_000),
    );
    expect(second).toEqual(first);
    const audits = await q<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log WHERE action = 'subscription.cancel'`,
    );
    expect(audits[0]!.n).toBe("1");
  });

  test("cancel with no active subscription returns null", async () => {
    const result = await runInImmediate(db, (tx) => cancelSubscription(tx, "ws-cancel", NOW));
    expect(result).toBeNull();
  });

  test("credit remains spendable on the subscription wallet after cancel", async () => {
    await seedActiveSubscription();
    await runInImmediate(db, (tx) => cancelSubscription(tx, "ws-cancel", NOW));
    const sub = await runInImmediate(db, (tx) =>
      getActiveUnexpiredSubscription(tx, "ws-cancel", NOW),
    );
    // Still active + unexpired, now with the cancel marker visible to display.
    expect(sub?.status).toBe("active");
    expect(sub?.canceled_at).toBe(NOW);
    const r = await reserveRequest(db, {
      requestId: "req-cancel-1",
      workspaceId: "ws-cancel",
      apiKeyId: "key-cancel",
      modelId: "model-cancel",
      mappingId: "pm-cancel",
      modelPriceId: "price-cancel",
      endpoint: "/v1/chat/completions",
      mode: "stream",
      fxRate: 26_000,
      capVnd: 5_000,
      now: NOW,
      funding: { underLimit: true },
    });
    expect(r.walletKind).toBe("subscription");
  });

  test("after period end the existing expiry forfeits the canceled credit unchanged", async () => {
    await seedActiveSubscription({ periodEnd: NOW - DAY_MS });
    await runInImmediate(db, (tx) => cancelSubscription(tx, "ws-cancel", NOW));
    const forfeited = await runInImmediate(db, (tx) =>
      applySubscriptionExpiry(tx, "ws-cancel", NOW),
    );
    expect(forfeited).toBe(250_000);
    const wallet = await q<{ balance: number }>(
      `SELECT balance FROM wallets WHERE id = 'wal-sub-cancel'`,
    );
    expect(Number(wallet[0]!.balance)).toBe(0);
  });
});
