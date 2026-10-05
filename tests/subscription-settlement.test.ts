// Subscription settlement through processMockPaymentEvent (O4/O5): plan
// payments credit the subscription wallet (never the topup wallet), webhook
// replays never double credit, admin manual approval uses the same settlement
// code, renewal before/after expiry follows the owner rules, and expiry
// forfeits exactly (balance - reserved) once — idempotent under repeat and
// concurrency, never deleting rows.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, type Db } from "../packages/db/src/index";
import { processMockPaymentEvent } from "../packages/payments/src/credit";
import { applySubscriptionExpiry, runInImmediate } from "../packages/wallet/src/index";
import { MockPaymentError } from "../packages/payments/src/credit";

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

async function seedWorkspace(id: string): Promise<void> {
  await db.$client.unsafe(
    `INSERT INTO workspaces (id, name, status, created_at) VALUES ($1, $2, 'active', $3)`,
    [id, id, NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at)
     VALUES ($1, $2, 'VND', 0, 0, 0, $3)`,
    ["wal-" + id, id, NOW] as never[],
  );
}

async function seedPlan(id: string, creditVnd: number, periodDays = 30): Promise<void> {
  await db.$client.unsafe(
    `INSERT INTO subscription_plans (id, name, price_vnd, credit_per_period_vnd, period_days, active, created_at)
     VALUES ($1, $1, $2, $3, $4, true, $5)`,
    [id, creditVnd, creditVnd, periodDays, NOW] as never[],
  );
}

async function seedPayment(opts: {
  id: string;
  ws: string;
  amount: number;
  orderCode: string;
  provider?: string;
  planId: string;
}): Promise<void> {
  await db.$client.unsafe(
    `INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at, subscription_plan_id)
     VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7)`,
    [
      opts.id,
      opts.ws,
      opts.amount,
      opts.provider ?? "mock",
      opts.orderCode,
      NOW,
      opts.planId,
    ] as never[],
  );
}

const ev = (orderCode: string, ref: string, amount: number, provider = "mock") => ({
  provider,
  orderCode,
  providerReference: ref,
  amount,
  rawPayload: JSON.stringify({ orderCode, ref }),
});

async function walletBalances(ws: string): Promise<{ topup: number; subscription: number | null }> {
  const rows = await q<{ kind: string; balance: string }>(
    `SELECT kind, balance FROM wallets WHERE workspace_id = $1`,
    [ws],
  );
  let topup = -1;
  let subscription: number | null = null;
  for (const r of rows) {
    if (r.kind === "topup") topup = Number(r.balance);
    if (r.kind === "subscription") subscription = Number(r.balance);
  }
  return { topup, subscription };
}

async function subscription(ws: string): Promise<{
  status: string;
  start: number;
  end: number;
} | null> {
  const rows = await q<{ status: string; start: string; end: string }>(
    `SELECT status, current_period_start start, current_period_end end FROM subscriptions WHERE workspace_id = $1`,
    [ws],
  );
  const r = rows[0];
  return r ? { status: r.status, start: Number(r.start), end: Number(r.end) } : null;
}

async function ledgerFor(walletId: string): Promise<
  {
    kind: string;
    direction: string;
    amount: number;
    memo: string | null;
    payment_id: string | null;
  }[]
> {
  const rows = await q<{
    kind: string;
    direction: string;
    amount: string;
    memo: string | null;
    payment_id: string | null;
  }>(
    `SELECT l.kind, l.direction, l.amount, l.memo, l.payment_id
     FROM ledger_entries l JOIN wallets w ON w.id = l.wallet_id
     WHERE w.workspace_id = $1 ORDER BY l.created_at, l.id`,
    [walletId],
  );
  return rows.map((r) => ({
    kind: r.kind,
    direction: r.direction,
    amount: Number(r.amount),
    memo: r.memo,
    payment_id: r.payment_id,
  }));
}

/** Ledger invariant: sum of credits minus debits equals wallet balance. */
async function assertLedgerMatchesBalance(ws: string): Promise<void> {
  const rows = await q<{ kind: string; balance: string; sum: string }>(
    `SELECT w.kind, w.balance,
            COALESCE(SUM(CASE WHEN l.direction='credit' THEN l.amount ELSE -l.amount END),0) sum
     FROM wallets w LEFT JOIN ledger_entries l ON l.wallet_id = w.id
     WHERE w.workspace_id = $1 GROUP BY w.id, w.kind, w.balance`,
    [ws],
  );
  for (const r of rows) expect(Number(r.sum)).toBe(Number(r.balance));
}

function expiryForfeit(db: Db, ws: string, now: number): Promise<number> {
  return runInImmediate(db, (tx) => applySubscriptionExpiry(tx, ws, now));
}

beforeAll(async () => {
  await seedWorkspace("ws-sub");
  await seedWorkspace("ws-replay");
  await seedWorkspace("ws-manual");
  await seedWorkspace("ws-renew");
  await seedWorkspace("ws-expired");
  await seedWorkspace("ws-bonus");
  await seedPlan("plan-1", 100_000);
  await seedPlan("plan-30", 100_000);
  await db.$client.unsafe(
    `INSERT INTO instance_settings (key, value, updated_at) VALUES ('first_topup_bonus_enabled','false',$1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [NOW] as never[],
  );
});

describe("plan payment settlement", () => {
  test("credits the subscription wallet, not the topup wallet; creates the subscription", async () => {
    await seedPayment({
      id: "pay-sub-1",
      ws: "ws-sub",
      amount: 150_000,
      orderCode: "ORD-SUB-1",
      planId: "plan-1",
    });
    const r = await processMockPaymentEvent(db, ev("ORD-SUB-1", "evt-sub-1", 150_000));
    expect(r.outcome).toBe("credited");
    const b = await walletBalances("ws-sub");
    expect(b.subscription).toBe(100_000);
    expect(b.topup).toBe(0);
    const sub = await subscription("ws-sub");
    expect(sub?.status).toBe("active");
    expect(sub!.end - sub!.start).toBe(30 * DAY_MS);
    // Ledger: the plan credit is a 'topup' kind entry on the subscription
    // wallet referencing the payment; nothing on the topup wallet.
    const rows = await q<{ kind: string; wallet_kind: string; amount: string }>(
      `SELECT l.kind, w.kind wallet_kind, l.amount FROM ledger_entries l
       JOIN wallets w ON w.id = l.wallet_id WHERE l.payment_id = 'pay-sub-1'`,
    );
    expect(rows).toEqual([{ kind: "topup", wallet_kind: "subscription", amount: "100000" }]);
    await assertLedgerMatchesBalance("ws-sub");
  });

  test("webhook replay (same reference) never double credits", async () => {
    await seedPayment({
      id: "pay-replay",
      ws: "ws-replay",
      amount: 150_000,
      orderCode: "ORD-REPLAY",
      planId: "plan-1",
    });
    const first = await processMockPaymentEvent(db, ev("ORD-REPLAY", "evt-replay", 150_000));
    expect(first.outcome).toBe("credited");
    const replay = await processMockPaymentEvent(db, ev("ORD-REPLAY", "evt-replay", 150_000));
    expect(replay.outcome).toBe("already_processed");
    expect((await walletBalances("ws-replay")).subscription).toBe(100_000);
    const n = await q<{ c: string }>(
      `SELECT COUNT(*) c FROM ledger_entries l JOIN wallets w ON w.id = l.wallet_id
       WHERE w.workspace_id = 'ws-replay' AND w.kind = 'subscription'`,
    );
    expect(Number(n[0]!.c)).toBe(1);
  });

  test("distinct reference on an already-succeeded plan payment is rejected, no second credit", async () => {
    let threw: unknown;
    try {
      await processMockPaymentEvent(db, ev("ORD-REPLAY", "evt-replay-x", 150_000));
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(MockPaymentError);
    expect((await walletBalances("ws-replay")).subscription).toBe(100_000);
    const n = await q<{ c: string }>(
      `SELECT COUNT(*) c FROM ledger_entries l JOIN wallets w ON w.id = l.wallet_id
       WHERE w.workspace_id = 'ws-replay' AND w.kind = 'subscription'`,
    );
    expect(Number(n[0]!.c)).toBe(1);
  });

  test("admin manual approval path credits exactly like the webhook (same settlement code)", async () => {
    await seedPayment({
      id: "pay-manual",
      ws: "ws-manual",
      amount: 150_000,
      orderCode: "ORD-MANUAL",
      provider: "manual",
      planId: "plan-1",
    });
    // Mirrors routes/admin-extra.ts: provider = payment.provider, fixed
    // reference admin-complete-<payment id>.
    const r = await processMockPaymentEvent(db, {
      provider: "manual",
      orderCode: "ORD-MANUAL",
      providerReference: "admin-complete-pay-manual",
      amount: 150_000,
      rawPayload: JSON.stringify({ source: "admin-complete", paymentId: "pay-manual" }),
    });
    expect(r.outcome).toBe("credited");
    expect((await walletBalances("ws-manual")).subscription).toBe(100_000);
    expect((await walletBalances("ws-manual")).topup).toBe(0);
    // Admin replay is idempotent too.
    const again = await processMockPaymentEvent(db, {
      provider: "manual",
      orderCode: "ORD-MANUAL",
      providerReference: "admin-complete-pay-manual",
      amount: 150_000,
      rawPayload: JSON.stringify({ source: "admin-complete", paymentId: "pay-manual" }),
    });
    expect(again.outcome).toBe("already_processed");
    expect((await walletBalances("ws-manual")).subscription).toBe(100_000);
  });
});

describe("renewal", () => {
  test("renewal BEFORE period end keeps leftover credit and extends from period end", async () => {
    await seedPayment({
      id: "pay-r1",
      ws: "ws-renew",
      amount: 150_000,
      orderCode: "ORD-R1",
      planId: "plan-30",
    });
    await processMockPaymentEvent(db, ev("ORD-R1", "evt-r1", 150_000));
    const first = (await subscription("ws-renew"))!;
    // Renew while the first period is still active.
    await seedPayment({
      id: "pay-r2",
      ws: "ws-renew",
      amount: 150_000,
      orderCode: "ORD-R2",
      planId: "plan-30",
    });
    await processMockPaymentEvent(db, ev("ORD-R2", "evt-r2", 150_000));
    const second = (await subscription("ws-renew"))!;
    expect(second.start).toBe(first.end); // extends from period end
    expect(second.end - second.start).toBe(30 * DAY_MS);
    expect(second.end).toBeGreaterThan(first.end);
    // Leftover credit kept: 2 x 100_000 on the subscription wallet.
    expect((await walletBalances("ws-renew")).subscription).toBe(200_000);
    await assertLedgerMatchesBalance("ws-renew");
  });

  test("renewal AFTER expiry forfeits leftover first, then starts a fresh period from now", async () => {
    await seedPayment({
      id: "pay-e1",
      ws: "ws-expired",
      amount: 150_000,
      orderCode: "ORD-E1",
      planId: "plan-30",
    });
    await processMockPaymentEvent(db, ev("ORD-E1", "evt-e1", 150_000));
    // Simulate the period lapsing without renewal: move the whole period into
    // the past (start < end CHECK still holds).
    await db.$client.unsafe(
      `UPDATE subscriptions SET current_period_start = $1, current_period_end = $2 WHERE workspace_id = 'ws-expired'`,
      [NOW - 40 * DAY_MS, NOW - 5_000] as never[],
    );
    await seedPayment({
      id: "pay-e2",
      ws: "ws-expired",
      amount: 150_000,
      orderCode: "ORD-E2",
      planId: "plan-30",
    });
    await processMockPaymentEvent(db, ev("ORD-E2", "evt-e2", 150_000));
    // Forfeit happened exactly once as an adjustment debit on the sub wallet.
    const forfeits = (await ledgerFor("ws-expired")).filter(
      (l) => l.kind === "adjustment" && l.memo === "subscription expired",
    );
    expect(forfeits).toHaveLength(1);
    expect(forfeits[0]!.direction).toBe("debit");
    expect(forfeits[0]!.amount).toBe(100_000);
    // Fresh period starts near the settlement time (after the expired end),
    // balance = new credit only.
    const sub = (await subscription("ws-expired"))!;
    expect(sub.start).toBeGreaterThan(NOW - 5_000);
    expect(sub.end - sub.start).toBe(30 * DAY_MS);
    expect((await walletBalances("ws-expired")).subscription).toBe(100_000);
    await assertLedgerMatchesBalance("ws-expired");
  });

  test("renewal with a DIFFERENT plan stores the NEW plan_id and credits the NEW plan amount", async () => {
    const ws = "ws-switch";
    await seedWorkspace(ws);
    await seedPlan("plan-a", 50_000); // 30-day period (default)
    await seedPlan("plan-b", 80_000, 7);
    await seedPayment({ id: "pay-a", ws, amount: 50_000, orderCode: "ORD-A", planId: "plan-a" });
    await processMockPaymentEvent(db, ev("ORD-A", "evt-a", 50_000));
    const first = (await subscription(ws))!;
    // Renew while plan A is active, paying for plan B.
    await seedPayment({ id: "pay-b", ws, amount: 200_000, orderCode: "ORD-B", planId: "plan-b" });
    await processMockPaymentEvent(db, ev("ORD-B", "evt-b", 200_000));
    // The stored plan (the row the gateway/display join on) is plan B.
    const rows = await q<{ plan_id: string; s: string; e: string }>(
      `SELECT plan_id, current_period_start s, current_period_end e FROM subscriptions WHERE workspace_id = $1`,
      [ws],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.plan_id).toBe("plan-b");
    expect(Number(rows[0]!.s)).toBe(first.end); // extended from the prior period end
    expect(Number(rows[0]!.e) - Number(rows[0]!.s)).toBe(7 * DAY_MS); // plan B's period length
    // Credit = plan B's amount on top of plan A's leftover.
    expect((await walletBalances(ws)).subscription).toBe(130_000);
    await assertLedgerMatchesBalance(ws);
    // Replay of the plan-B webhook never double credits.
    const replay = await processMockPaymentEvent(db, ev("ORD-B", "evt-b", 200_000));
    expect(replay.outcome).toBe("already_processed");
    expect((await walletBalances(ws)).subscription).toBe(130_000);
  });
});

describe("expiry forfeiture audit", () => {
  test("nonzero forfeit writes ONE subscription.expire audit row in the same txn; repeat and zero forfeit add none", async () => {
    const ws = "ws-audit";
    await seedWorkspace(ws);
    await db.$client.unsafe(
      `INSERT INTO wallets (id, workspace_id, currency, kind, balance, reserved, version, created_at)
       VALUES ('wal-sub-audit', $1, 'VND', 'subscription', 100000, 20000, 0, $2)`,
      [ws, NOW] as never[],
    );
    await db.$client.unsafe(
      `INSERT INTO subscriptions (id, workspace_id, plan_id, status, current_period_start, current_period_end, created_at)
       VALUES ('sub-audit', $1, 'plan-a', 'active', $2, $3, $2)`,
      [ws, NOW - 40 * DAY_MS, NOW - 10 * DAY_MS] as never[],
    );
    expect(await expiryForfeit(db, ws, NOW)).toBe(80_000);
    const audits = await q<{
      target: string;
      detail: Record<string, unknown>;
    }>(
      `SELECT target, detail FROM audit_log WHERE action = 'subscription.expire' AND workspace_id = $1`,
      [ws],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.target).toBe("sub-audit");
    const ledgerRow = await q<{ id: string }>(
      `SELECT id FROM ledger_entries WHERE wallet_id = 'wal-sub-audit' AND kind = 'adjustment' AND memo = 'subscription expired'`,
    );
    const detail = JSON.parse(audits[0]!.detail as unknown as string) as Record<string, unknown>;
    expect(detail).toEqual({
      periodEnd: NOW - 10 * DAY_MS,
      walletId: "wal-sub-audit",
      amount: 80_000,
      ledgerEntryId: ledgerRow[0]!.id,
    });
    // Repeat application: zero forfeit, no extra audit row.
    expect(await expiryForfeit(db, ws, NOW)).toBe(0);
    const audits2 = await q<{ c: string }>(
      `SELECT COUNT(*) c FROM audit_log WHERE action = 'subscription.expire' AND workspace_id = $1`,
      [ws],
    );
    expect(Number(audits2[0]!.c)).toBe(1);
  });

  test("zero-credit expiry writes no audit row", async () => {
    const ws = "ws-audit-zero";
    await seedWorkspace(ws);
    await db.$client.unsafe(
      `INSERT INTO wallets (id, workspace_id, currency, kind, balance, reserved, version, created_at)
       VALUES ('wal-sub-az', $1, 'VND', 'subscription', 0, 0, 0, $2)`,
      [ws, NOW] as never[],
    );
    await db.$client.unsafe(
      `INSERT INTO subscriptions (id, workspace_id, plan_id, status, current_period_start, current_period_end, created_at)
       VALUES ('sub-az', $1, 'plan-a', 'active', $2, $3, $2)`,
      [ws, NOW - 40 * DAY_MS, NOW - 10 * DAY_MS] as never[],
    );
    expect(await expiryForfeit(db, ws, NOW)).toBe(0);
    const audits = await q<{ c: string }>(
      `SELECT COUNT(*) c FROM audit_log WHERE action = 'subscription.expire' AND workspace_id = $1`,
      [ws],
    );
    expect(Number(audits[0]!.c)).toBe(0);
  });
});

describe("expiry forfeiture (O5)", () => {
  test("forfeits exactly balance minus reserved once; idempotent under repeat and concurrency; never deletes rows", async () => {
    const ws = "ws-forfeit";
    await seedWorkspace(ws);
    await db.$client.unsafe(
      `INSERT INTO wallets (id, workspace_id, currency, kind, balance, reserved, version, created_at)
       VALUES ('wal-sub-forfeit', $1, 'VND', 'subscription', 100000, 20000, 0, $2)`,
      [ws, NOW] as never[],
    );
    await db.$client.unsafe(
      `INSERT INTO subscriptions (id, workspace_id, plan_id, status, current_period_start, current_period_end, created_at)
       VALUES ('sub-forfeit', $1, 'plan-30', 'active', $2, $3, $2)`,
      [ws, NOW - 40 * DAY_MS, NOW - 10 * DAY_MS] as never[],
    );
    const countsBefore = await q<{ c: string }>(
      `SELECT (SELECT COUNT(*) FROM ledger_entries) +
              (SELECT COUNT(*) FROM wallets) +
              (SELECT COUNT(*) FROM subscriptions) c`,
    );

    // Repeat sequential application: second is a no-op.
    expect(await expiryForfeit(db, ws, NOW)).toBe(80_000);
    expect(await expiryForfeit(db, ws, NOW)).toBe(0);
    // Concurrent applicants: exactly one forfeit in total.
    const [a, b, c] = await Promise.all([
      expiryForfeit(db, ws, NOW),
      expiryForfeit(db, ws, NOW),
      expiryForfeit(db, ws, NOW),
    ]);
    expect([a, b, c].reduce((s, x) => s + x, 0)).toBe(0);
    const forfeits = (await ledgerFor(ws)).filter(
      (l) => l.kind === "adjustment" && l.memo === "subscription expired",
    );
    expect(forfeits).toHaveLength(1);
    expect(forfeits[0]!.amount).toBe(80_000);
    const gate = await q<{ c: string }>(
      `SELECT COUNT(*) c FROM subscription_expiries WHERE subscription_id = 'sub-forfeit'`,
    );
    expect(Number(gate[0]!.c)).toBe(1);
    // Nothing was deleted: wallet and subscription rows still exist, ledger
    // only grew by the forfeit entry.
    const countsAfter = await q<{ c: string }>(
      `SELECT (SELECT COUNT(*) FROM ledger_entries) +
              (SELECT COUNT(*) FROM wallets) +
              (SELECT COUNT(*) FROM subscriptions) c`,
    );
    expect(Number(countsAfter[0]!.c)).toBe(Number(countsBefore[0]!.c) + 1);
    const b2 = await walletBalances(ws);
    expect(b2.subscription).toBe(20_000); // reserved untouched by forfeit
  });

  test("zero-balance expiry is a repeatable no-op with no ledger row", async () => {
    const ws = "ws-forfeit-zero";
    await seedWorkspace(ws);
    await db.$client.unsafe(
      `INSERT INTO wallets (id, workspace_id, currency, kind, balance, reserved, version, created_at)
       VALUES ('wal-sub-fz', $1, 'VND', 'subscription', 0, 0, 0, $2)`,
      [ws, NOW] as never[],
    );
    await db.$client.unsafe(
      `INSERT INTO subscriptions (id, workspace_id, plan_id, status, current_period_start, current_period_end, created_at)
       VALUES ('sub-fz', $1, 'plan-30', 'active', $2, $3, $2)`,
      [ws, NOW - 40 * DAY_MS, NOW - 10 * DAY_MS] as never[],
    );
    expect(await expiryForfeit(db, ws, NOW)).toBe(0);
    expect(await expiryForfeit(db, ws, NOW)).toBe(0);
    const rows = await q<{ c: string }>(
      `SELECT COUNT(*) c FROM ledger_entries l JOIN wallets w ON w.id = l.wallet_id WHERE w.workspace_id = $1`,
      [ws],
    );
    expect(Number(rows[0]!.c)).toBe(0);
  });
});

describe("first topup bonus with plan payments", () => {
  test("a plan payment counts as a succeeded payment: bonus lands on the TOPUP wallet", async () => {
    await db.$client.unsafe(
      `INSERT INTO instance_settings (key, value, updated_at) VALUES ('first_topup_bonus_enabled','true',$1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [NOW] as never[],
    );
    await seedPayment({
      id: "pay-bonus",
      ws: "ws-bonus",
      amount: 150_000,
      orderCode: "ORD-BONUS",
      planId: "plan-1",
    });
    const r = await processMockPaymentEvent(db, ev("ORD-BONUS", "evt-bonus", 150_000));
    expect(r.outcome).toBe("credited");
    const b = await walletBalances("ws-bonus");
    expect(b.subscription).toBe(100_000);
    expect(b.topup).toBe(20_000); // bonus on the topup wallet, not subscription
    const bonusRows = await q<{ kind: string; wallet_kind: string; memo: string; amount: string }>(
      `SELECT l.kind, w.kind wallet_kind, l.memo, l.amount FROM ledger_entries l
       JOIN wallets w ON w.id = l.wallet_id WHERE l.memo = 'first topup bonus'`,
    );
    expect(bonusRows).toHaveLength(1);
    expect(bonusRows[0]!.wallet_kind).toBe("topup");
    // A later plain top-up must not grant a second bonus.
    await seedPayment({
      id: "pay-bonus-2",
      ws: "ws-bonus",
      amount: 10_000,
      orderCode: "ORD-BONUS-2",
      planId: "plan-1",
    });
    await db.$client.unsafe(
      `UPDATE payments SET subscription_plan_id = NULL WHERE id = 'pay-bonus-2'`,
    );
    await processMockPaymentEvent(db, ev("ORD-BONUS-2", "evt-bonus-2", 10_000));
    const bonusRows2 = await q<{ c: string }>(
      `SELECT COUNT(*) c FROM ledger_entries WHERE memo = 'first topup bonus'`,
    );
    expect(Number(bonusRows2[0]!.c)).toBe(1);
    await db.$client.unsafe(
      `INSERT INTO instance_settings (key, value, updated_at) VALUES ('first_topup_bonus_enabled','false',$1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [NOW] as never[],
    );
  });
});
