// Subscription renew (resume): the counterpart of cancel (decision b).
// Renew clears the canceled_at marker so the subscription re-enters the
// normal renewal path. Renewal itself is payment-driven (plan settlement),
// so renew moves NO money — no credit, no refund, no new charge; the period
// end, status and lazy expiry behavior are untouched. Repeats are idempotent.
import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { createTestDb, type Db } from "../packages/db/src/index";
import {
  applySubscriptionExpiry,
  cancelSubscription,
  getActiveUnexpiredSubscription,
  reserveRequest,
  resumeSubscription,
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
    `INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws-renew','R','active',$1)`,
    [NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at)
     VALUES ('key-renew','ws-renew','hash-renew','sk-hbr-r','key r','active',$1)`,
    [NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at)
     VALUES ('wal-topup-renew','ws-renew','VND',0,0,0,$1)`,
    [NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO models (id, public_id, slug, display_name, provider, enabled, published, created_at, updated_at)
     VALUES ('model-renew','pub-r','slug-r','Model R','openai',true,true,$1,$1)`,
    [NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at)
     VALUES ('pm-renew','model-renew','openai','upstream-r',true,$1,$1)`,
    [NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at)
     VALUES ('price-renew','model-renew',1000000,2000000,500000,3000000,1000000,$1)`,
    [NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO subscription_plans (id, name, price_vnd, credit_per_period_vnd, period_days, active, created_at)
     VALUES ('plan-renew','plan-renew',100000,100000,30,true,$1)`,
    [NOW] as never[],
  );
});

// Each case seeds its own canceled subscription + subscription wallet with an
// opening balance recorded AS a ledger credit (balance == sum(ledger)).
async function seedCanceledSubscription(over: { periodEnd?: number } = {}): Promise<void> {
  const periodEnd = over.periodEnd ?? NOW + 30 * DAY_MS;
  await db.$client.unsafe(
    `INSERT INTO wallets (id, workspace_id, currency, kind, balance, reserved, version, created_at)
     VALUES ('wal-sub-renew','ws-renew','VND','subscription',250000,0,0,$1)`,
    [NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO ledger_entries (id, wallet_id, direction, amount, kind, balance_after, memo, created_at)
     VALUES ('led-sub-renew','wal-sub-renew','credit',250000,'topup',250000,'test seed',$1)`,
    [NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO subscriptions (id, workspace_id, plan_id, status, canceled_at, current_period_start, current_period_end, created_at)
     VALUES ('sub-renew','ws-renew','plan-renew','active',$1,$2,$3,$2)`,
    [NOW - 3_600_000, Math.min(NOW - DAY_MS, periodEnd - DAY_MS), periodEnd] as never[],
  );
}

afterEach(async () => {
  await db.$client.unsafe(
    `TRUNCATE requests, billing_reservations, settlements, usage_logs, ledger_entries,
     subscription_expiries, subscriptions, audit_log, wallets CASCADE`,
  );
  await db.$client.unsafe(
    `INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at)
     VALUES ('wal-topup-renew','ws-renew','VND',0,0,0,$1)`,
    [NOW] as never[],
  );
});

describe("resumeSubscription (domain)", () => {
  test("renew clears the cancel marker, moves no money, audits once", async () => {
    await seedCanceledSubscription();
    const result = await runInImmediate(db, (tx) => resumeSubscription(tx, "ws-renew", NOW));
    expect(result).toEqual({ id: "sub-renew", current_period_end: NOW + 30 * DAY_MS });
    // Status stays 'active' with the marker cleared: auto-renew notice path
    // is re-enabled without touching the period.
    const rows = await q<{ status: string; canceled_at: string | null }>(
      `SELECT status, canceled_at FROM subscriptions WHERE id = 'sub-renew'`,
    );
    expect(rows[0]!.status).toBe("active");
    expect(rows[0]!.canceled_at).toBeNull();
    // No money moved: wallet balance unchanged, zero new ledger entries.
    const balance = await q<{ balance: number }>(
      `SELECT balance FROM wallets WHERE id = 'wal-sub-renew'`,
    );
    expect(Number(balance[0]!.balance)).toBe(250_000);
    const ledger = await q<{ n: string }>(
      `SELECT count(*) AS n FROM ledger_entries WHERE wallet_id = 'wal-sub-renew'`,
    );
    expect(ledger[0]!.n).toBe("1"); // only the seeded opening credit
    const audits = await q<{ action: string }>(
      `SELECT action FROM audit_log WHERE workspace_id = 'ws-renew' AND action = 'subscription.renew'`,
    );
    expect(audits.length).toBe(1);
  });

  test("renew is idempotent: repeat returns the same row, no extra audit", async () => {
    await seedCanceledSubscription();
    const first = await runInImmediate(db, (tx) => resumeSubscription(tx, "ws-renew", NOW));
    const second = await runInImmediate(db, (tx) =>
      resumeSubscription(tx, "ws-renew", NOW + 1_000),
    );
    expect(second).toEqual(first);
    const audits = await q<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log WHERE action = 'subscription.renew'`,
    );
    expect(audits[0]!.n).toBe("1");
  });

  test("renew with no active subscription returns null", async () => {
    const result = await runInImmediate(db, (tx) => resumeSubscription(tx, "ws-renew", NOW));
    expect(result).toBeNull();
  });

  test("renew does not extend the period or create a new charge boundary", async () => {
    await seedCanceledSubscription();
    await runInImmediate(db, (tx) => resumeSubscription(tx, "ws-renew", NOW));
    const rows = await q<{ current_period_start: string; current_period_end: string }>(
      `SELECT current_period_start, current_period_end FROM subscriptions WHERE id = 'sub-renew'`,
    );
    // Period is byte-identical to the seed: renew is a marker flip, not a
    // settlement — no new charge boundary before the normal renewal.
    expect(Number(rows[0]!.current_period_start)).toBe(NOW - DAY_MS);
    expect(Number(rows[0]!.current_period_end)).toBe(NOW + 30 * DAY_MS);
  });

  test("cancel then renew round-trip restores the uncanceled state", async () => {
    await seedCanceledSubscription();
    // Reset the marker first so cancel applies its own audit, then renew.
    await db.$client.unsafe(`UPDATE subscriptions SET canceled_at = NULL WHERE id = 'sub-renew'`);
    await runInImmediate(db, (tx) => cancelSubscription(tx, "ws-renew", NOW));
    const renewed = await runInImmediate(db, (tx) => resumeSubscription(tx, "ws-renew", NOW + 1));
    expect(renewed).toEqual({ id: "sub-renew", current_period_end: NOW + 30 * DAY_MS });
    const sub = await runInImmediate(db, (tx) =>
      getActiveUnexpiredSubscription(tx, "ws-renew", NOW + 1),
    );
    expect(sub?.canceled_at).toBeNull();
    // Credit stays fully spendable after the round-trip.
    const r = await reserveRequest(db, {
      requestId: "req-renew-1",
      workspaceId: "ws-renew",
      apiKeyId: "key-renew",
      modelId: "model-renew",
      mappingId: "pm-renew",
      modelPriceId: "price-renew",
      endpoint: "/v1/chat/completions",
      mode: "stream",
      fxRate: 26_000,
      capVnd: 5_000,
      now: NOW + 1,
      funding: { underLimit: true },
    });
    expect(r.walletKind).toBe("subscription");
  });

  test("renew of an expired-period subscription changes nothing about expiry", async () => {
    await seedCanceledSubscription({ periodEnd: NOW - DAY_MS });
    const renewed = await runInImmediate(db, (tx) => resumeSubscription(tx, "ws-renew", NOW));
    expect(renewed).toEqual({ id: "sub-renew", current_period_end: NOW - DAY_MS });
    // The existing lazy expiry still forfeits the leftover unchanged.
    const forfeited = await runInImmediate(db, (tx) =>
      applySubscriptionExpiry(tx, "ws-renew", NOW),
    );
    expect(forfeited).toBe(250_000);
    const wallet = await q<{ balance: number }>(
      `SELECT balance FROM wallets WHERE id = 'wal-sub-renew'`,
    );
    expect(Number(wallet[0]!.balance)).toBe(0);
  });
});
