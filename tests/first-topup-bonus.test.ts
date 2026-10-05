// First topup bonus (D2): once per workspace, granted inside the credit
// transaction via first_topup_bonuses ON CONFLICT DO NOTHING. Missing enabled
// key = enabled, missing amount key = 20000, only the string 'false'
// disables, any present-but-invalid amount means no bonus (topup still credits).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, type Db } from "../packages/db/src/index";
import {
  processMockPaymentEvent,
  type ProcessMockEventResult,
} from "../packages/payments/src/credit";

// Narrow the discriminated result union so `balanceAfter` reads type-check;
// throws (failing the test) on any non-credited outcome.
function assertCredited(
  r: ProcessMockEventResult,
): asserts r is Extract<ProcessMockEventResult, { outcome: "credited" }> {
  if (r.outcome !== "credited") throw new Error(`expected credited outcome, got ${r.outcome}`);
}

const NOW = 1_700_000_000_000;

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

let wsSeq = 0;
async function seedWorkspace(): Promise<string> {
  const ws = `ws-bonus-${++wsSeq}`;
  await db.$client.unsafe(
    `INSERT INTO workspaces (id, name, status, created_at) VALUES ($1, $2, 'active', $3)`,
    [ws, ws, NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at)
     VALUES ($1, $2, 'VND', 0, 0, 0, $3)`,
    ["wal-" + ws, ws, NOW] as never[],
  );
  return ws;
}

async function seedPlainPayment(ws: string, id: string, amount: number): Promise<void> {
  await db.$client.unsafe(
    `INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at)
     VALUES ($1, $2, $3, 'pending', 'mock', $4, $5)`,
    [id, ws, amount, "ORD-" + id, NOW] as never[],
  );
}

async function setSetting(key: string, value: string): Promise<void> {
  await db.$client.unsafe(
    `INSERT INTO instance_settings (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value, NOW] as never[],
  );
}

async function clearBonusSettings(): Promise<void> {
  await db.$client.unsafe(
    `DELETE FROM instance_settings WHERE key IN ('first_topup_bonus_enabled','first_topup_bonus_amount_vnd')`,
  );
}

async function balance(ws: string): Promise<number> {
  const rows = await q<{ balance: string }>(`SELECT balance FROM wallets WHERE workspace_id = $1`, [
    ws,
  ]);
  return Number(rows[0]!.balance);
}

async function adjustments(paymentId: string): Promise<{ memo: string; amount: number }[]> {
  const rows = await q<{ memo: string; amount: string }>(
    `SELECT memo, amount FROM ledger_entries WHERE payment_id = $1 AND kind = 'adjustment' ORDER BY memo`,
    [paymentId],
  );
  return rows.map((r) => ({ memo: r.memo, amount: Number(r.amount) }));
}

async function topups(paymentId: string): Promise<unknown[]> {
  return q(`SELECT 1 FROM ledger_entries WHERE payment_id = $1 AND kind = 'topup'`, [paymentId]);
}

const ev = (orderCode: string, ref: string, amount: number) => ({
  orderCode,
  providerReference: ref,
  amount,
  rawPayload: JSON.stringify({ orderCode, ref }),
});

describe("first topup bonus", () => {
  test("missing settings: default 20000 bonus, ledger + grant row + audit", async () => {
    await clearBonusSettings();
    const ws = await seedWorkspace();
    await seedPlainPayment(ws, "pay-ftb-1", 50_000);
    const r = await processMockPaymentEvent(db, ev("ORD-pay-ftb-1", "evt-ftb-1", 50_000));
    expect(r.outcome).toBe("credited");
    assertCredited(r);
    expect(r.balanceAfter).toBe(70_000);
    expect(await balance(ws)).toBe(70_000);
    expect(await adjustments("pay-ftb-1")).toEqual([{ memo: "first topup bonus", amount: 20_000 }]);
    expect(await topups("pay-ftb-1")).toHaveLength(1);
    const grants = await q<{ amount: string; payment_id: string }>(
      `SELECT amount, payment_id FROM first_topup_bonuses WHERE workspace_id = $1`,
      [ws],
    );
    expect(grants).toHaveLength(1);
    expect(Number(grants[0]!.amount)).toBe(20_000);
    expect(grants[0]!.payment_id).toBe("pay-ftb-1");
    const audits = await q<{ action: string; target: string }>(
      `SELECT action, target FROM audit_log WHERE action = 'bonus.first_topup' AND workspace_id = $1`,
      [ws],
    );
    expect(audits).toEqual([{ action: "bonus.first_topup", target: "pay-ftb-1" }]);
  });

  test("replayed webhook: no second bonus, no second topup", async () => {
    await clearBonusSettings();
    const ws = await seedWorkspace();
    await seedPlainPayment(ws, "pay-ftb-2", 50_000);
    await processMockPaymentEvent(db, ev("ORD-pay-ftb-2", "evt-ftb-2", 50_000));
    const r = await processMockPaymentEvent(db, ev("ORD-pay-ftb-2", "evt-ftb-2", 50_000));
    expect(r.outcome).toBe("already_processed");
    expect(await balance(ws)).toBe(70_000);
    expect(await adjustments("pay-ftb-2")).toHaveLength(1);
    expect(await topups("pay-ftb-2")).toHaveLength(1);
    expect(await q(`SELECT 1 FROM first_topup_bonuses WHERE workspace_id = $1`, [ws])).toHaveLength(
      1,
    );
  });

  test("second payment on same workspace: no bonus", async () => {
    await clearBonusSettings();
    const ws = await seedWorkspace();
    await seedPlainPayment(ws, "pay-ftb-3a", 50_000);
    await processMockPaymentEvent(db, ev("ORD-pay-ftb-3a", "evt-ftb-3a", 50_000));
    await seedPlainPayment(ws, "pay-ftb-3b", 30_000);
    const r = await processMockPaymentEvent(db, ev("ORD-pay-ftb-3b", "evt-ftb-3b", 30_000));
    assertCredited(r);
    expect(r.balanceAfter).toBe(100_000); // 50k + 20k bonus (3a) + 30k, no second bonus
    expect(await adjustments("pay-ftb-3b")).toEqual([]);
  });

  test("concurrent race on different payments: exactly one bonus", async () => {
    await clearBonusSettings();
    const ws = await seedWorkspace();
    await seedPlainPayment(ws, "pay-ftb-4a", 10_000);
    await seedPlainPayment(ws, "pay-ftb-4b", 20_000);
    await Promise.allSettled([
      processMockPaymentEvent(db, ev("ORD-pay-ftb-4a", "evt-ftb-4a", 10_000)),
      processMockPaymentEvent(db, ev("ORD-pay-ftb-4b", "evt-ftb-4b", 20_000)),
    ]);
    // Exactly one bonus was granted; the losing transaction rolled back whole
    // (no bonus credit committed) and its payment settles on provider retry.
    const bonusRows = await q<{ memo: string }>(
      `SELECT le.memo memo FROM ledger_entries le JOIN wallets w ON w.id = le.wallet_id
       WHERE w.workspace_id = $1 AND le.kind = 'adjustment' AND le.memo = 'first topup bonus'`,
      [ws],
    );
    expect(bonusRows).toHaveLength(1);
    expect(await q(`SELECT 1 FROM first_topup_bonuses WHERE workspace_id = $1`, [ws])).toHaveLength(
      1,
    );
    const sums = await q<{ topup: string; balance: string }>(
      `SELECT COALESCE(SUM(le.amount) FILTER (WHERE le.kind = 'topup'), 0) topup, w.balance balance
       FROM wallets w LEFT JOIN ledger_entries le ON le.wallet_id = w.id WHERE w.workspace_id = $1 GROUP BY w.balance`,
      [ws],
    );
    expect(Number(sums[0]!.balance)).toBe(Number(sums[0]!.topup) + 20_000);
  });

  test("enabled=false: no bonus, topup still credits", async () => {
    const ws = await seedWorkspace();
    await setSetting("first_topup_bonus_enabled", "false");
    await seedPlainPayment(ws, "pay-ftb-5", 50_000);
    const r = await processMockPaymentEvent(db, ev("ORD-pay-ftb-5", "evt-ftb-5", 50_000));
    assertCredited(r);
    expect(r.balanceAfter).toBe(50_000);
    expect(await adjustments("pay-ftb-5")).toEqual([]);
    expect(await topups("pay-ftb-5")).toHaveLength(1);
    expect(await q(`SELECT 1 FROM first_topup_bonuses WHERE workspace_id = $1`, [ws])).toHaveLength(
      0,
    );
  });

  test("invalid amount setting: no bonus, topup still credits", async () => {
    const ws = await seedWorkspace();
    await setSetting("first_topup_bonus_amount_vnd", "not-a-number");
    await seedPlainPayment(ws, "pay-ftb-6", 50_000);
    const r = await processMockPaymentEvent(db, ev("ORD-pay-ftb-6", "evt-ftb-6", 50_000));
    assertCredited(r);
    expect(r.balanceAfter).toBe(50_000);
    expect(await adjustments("pay-ftb-6")).toEqual([]);
    expect(await topups("pay-ftb-6")).toHaveLength(1);
  });

  test("custom amount honored", async () => {
    await clearBonusSettings();
    const ws = await seedWorkspace();
    await setSetting("first_topup_bonus_amount_vnd", "5000");
    await seedPlainPayment(ws, "pay-ftb-7", 50_000);
    const r = await processMockPaymentEvent(db, ev("ORD-pay-ftb-7", "evt-ftb-7", 50_000));
    assertCredited(r);
    expect(r.balanceAfter).toBe(55_000);
    expect(await adjustments("pay-ftb-7")).toEqual([{ memo: "first topup bonus", amount: 5_000 }]);
  });

  test("pre-release workspace: earlier succeeded payment, no bonus row -> no bonus on next topup", async () => {
    await clearBonusSettings();
    const ws = await seedWorkspace();
    // A payment succeeded before the bonus release: no first_topup_bonuses row exists.
    await db.$client.unsafe(
      `INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at)
       VALUES ('pay-ftb-9a', $1, 50000, 'succeeded', 'mock', 'ORD-pay-ftb-9a', $2)`,
      [ws, NOW] as never[],
    );
    // The pre-release payment already credited the wallet (no ledger row seeded).
    await db.$client.unsafe(`UPDATE wallets SET balance = 50000 WHERE workspace_id = $1`, [
      ws,
    ] as never[]);
    await seedPlainPayment(ws, "pay-ftb-9b", 30_000);
    const r = await processMockPaymentEvent(db, ev("ORD-pay-ftb-9b", "evt-ftb-9b", 30_000));
    assertCredited(r);
    expect(r.balanceAfter).toBe(80_000); // 50k (pre-release) + 30k, no bonus
    expect(await adjustments("pay-ftb-9b")).toEqual([]);
    expect(await q(`SELECT 1 FROM first_topup_bonuses WHERE workspace_id = $1`, [ws])).toHaveLength(
      0,
    );
  });

  test("brand-new workspace (no other succeeded payment): bonus still granted", async () => {
    await clearBonusSettings();
    const ws = await seedWorkspace();
    await seedPlainPayment(ws, "pay-ftb-10", 50_000);
    const r = await processMockPaymentEvent(db, ev("ORD-pay-ftb-10", "evt-ftb-10", 50_000));
    assertCredited(r);
    expect(r.balanceAfter).toBe(70_000);
    expect(await adjustments("pay-ftb-10")).toEqual([
      { memo: "first topup bonus", amount: 20_000 },
    ]);
  });

  test("manual admin complete path grants bonus once", async () => {
    await clearBonusSettings();
    const ws = await seedWorkspace();
    await db.$client.unsafe(
      `INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at)
       VALUES ('pay-ftb-8', $1, 50000, 'pending', 'manual', 'ORD-pay-ftb-8', $2)`,
      [ws, NOW] as never[],
    );
    const r = await processMockPaymentEvent(db, {
      provider: "manual",
      orderCode: "ORD-pay-ftb-8",
      providerReference: "admin-complete-pay-ftb-8",
      amount: 50_000,
      rawPayload: JSON.stringify({ source: "admin-complete" }),
    });
    expect(r.outcome).toBe("credited");
    assertCredited(r);
    expect(r.balanceAfter).toBe(70_000);
    expect(await adjustments("pay-ftb-8")).toEqual([{ memo: "first topup bonus", amount: 20_000 }]);
    expect(await topups("pay-ftb-8")).toHaveLength(1);
  });
});
