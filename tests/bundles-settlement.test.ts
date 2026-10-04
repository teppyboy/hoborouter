// Bundle settlement through processMockPaymentEvent: topup(credit_vnd) +
// adjustment 'bundle bonus' when bonus > 0; replay/concurrency never double
// credit; plain top-up path unchanged (regression gate).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, type Db } from "../packages/db/src/index";
import { processMockPaymentEvent } from "../packages/payments/src/credit";

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

async function seedBundle(id: string, creditVnd: number, bonusVnd: number): Promise<void> {
  await db.$client.unsafe(
    `INSERT INTO credit_bundles (id, name, price_vnd, credit_vnd, bonus_vnd, active, created_at)
     VALUES ($1, $1, $2, $3, $4, true, $5)`,
    [id, creditVnd + bonusVnd, creditVnd, bonusVnd, NOW] as never[],
  );
}

async function seedPayment(opts: {
  id: string;
  ws: string;
  amount: number;
  orderCode: string;
  provider?: string;
  bundleId?: string;
  planId?: string;
}): Promise<void> {
  await db.$client.unsafe(
    `INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at, bundle_id, subscription_plan_id)
     VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8)`,
    [
      opts.id,
      opts.ws,
      opts.amount,
      opts.provider ?? "mock",
      opts.orderCode,
      NOW,
      opts.bundleId ?? null,
      opts.planId ?? null,
    ] as never[],
  );
}

async function balance(ws: string): Promise<number> {
  const rows = await q<{ balance: string }>(
    `SELECT balance FROM wallets WHERE workspace_id = $1`,
    [ws],
  );
  return Number(rows[0]!.balance);
}

async function ledger(
  paymentId: string,
  kind?: string,
): Promise<{ kind: string; amount: number; memo: string | null }[]> {
  const rows = await q<{ kind: string; amount: string; memo: string | null }>(
    `SELECT kind, amount, memo FROM ledger_entries WHERE payment_id = $1 AND ($2::text IS NULL OR kind = $2) ORDER BY kind`,
    [paymentId, kind ?? null],
  );
  return rows.map((r) => ({ kind: r.kind, amount: Number(r.amount), memo: r.memo }));
}

async function setSetting(key: string, value: string): Promise<void> {
  await db.$client.unsafe(
    `INSERT INTO instance_settings (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value, NOW] as never[],
  );
}

const ev = (orderCode: string, ref: string, amount: number, provider = "mock") => ({
  provider,
  orderCode,
  providerReference: ref,
  amount,
  rawPayload: JSON.stringify({ orderCode, ref }),
});

beforeAll(async () => {
  await seedWorkspace("ws-plain");
  await seedWorkspace("ws-bundle");
  await seedWorkspace("ws-b0");
  await seedWorkspace("ws-race");
  await seedWorkspace("ws-manual");
  await seedBundle("b-std", 30_000, 10_000);
  await seedBundle("b-zero", 25_000, 0);
  // Isolate bundle behavior from the first topup bonus (covered in its own suite).
  await setSetting("first_topup_bonus_enabled", "false");
});

describe("plain top-up regression (unchanged path)", () => {
  test("credits exactly payment.amount as one topup ledger row, no adjustments", async () => {
    await seedPayment({ id: "pay-plain", ws: "ws-plain", amount: 50_000, orderCode: "ORD-PLAIN" });
    const r = await processMockPaymentEvent(db, ev("ORD-PLAIN", "evt-plain", 50_000));
    expect(r.outcome).toBe("credited");
    expect(r.balanceAfter).toBe(50_000);
    expect(await balance("ws-plain")).toBe(50_000);
    expect(await ledger("pay-plain")).toEqual([
      { kind: "topup", amount: 50_000, memo: "mock topup evt-plain" },
    ]);
    const pay = await q<{ status: string }>(`SELECT status FROM payments WHERE id = 'pay-plain'`);
    expect(pay[0]!.status).toBe("succeeded");
  });
});

describe("bundle settlement", () => {
  test("webhook: balance = credit+bonus, one topup(credit_vnd) + one adjustment 'bundle bonus'", async () => {
    await seedPayment({
      id: "pay-b1",
      ws: "ws-bundle",
      amount: 40_000,
      orderCode: "ORD-B1",
      bundleId: "b-std",
    });
    const r = await processMockPaymentEvent(db, ev("ORD-B1", "evt-b1", 40_000));
    expect(r.outcome).toBe("credited");
    expect(r.balanceAfter).toBe(40_000);
    expect(await balance("ws-bundle")).toBe(40_000);
    expect(await ledger("pay-b1", "topup")).toEqual([
      { kind: "topup", amount: 30_000, memo: "mock topup evt-b1" },
    ]);
    expect(await ledger("pay-b1", "adjustment")).toEqual([
      { kind: "adjustment", amount: 10_000, memo: "bundle bonus" },
    ]);
  });

  test("replayed webhook: 2xx already_processed, no second credit", async () => {
    const r = await processMockPaymentEvent(db, ev("ORD-B1", "evt-b1", 40_000));
    expect(r.outcome).toBe("already_processed");
    expect(await balance("ws-bundle")).toBe(40_000);
    expect(await ledger("pay-b1", "topup")).toHaveLength(1);
    expect(await ledger("pay-b1", "adjustment")).toHaveLength(1);
  });

  test("bonus 0 bundle: topup only, no adjustment row", async () => {
    await seedPayment({
      id: "pay-b0",
      ws: "ws-b0",
      amount: 25_000,
      orderCode: "ORD-B0",
      bundleId: "b-zero",
    });
    const r = await processMockPaymentEvent(db, ev("ORD-B0", "evt-b0", 25_000));
    expect(r.outcome).toBe("credited");
    expect(await balance("ws-b0")).toBe(25_000);
    expect(await ledger("pay-b0", "topup")).toHaveLength(1);
    expect(await ledger("pay-b0", "adjustment")).toHaveLength(0);
  });

  test("concurrent duplicate events: exactly one credit", async () => {
    await seedPayment({
      id: "pay-race",
      ws: "ws-race",
      amount: 40_000,
      orderCode: "ORD-RACE",
      bundleId: "b-std",
    });
    const results = await Promise.allSettled([
      processMockPaymentEvent(db, ev("ORD-RACE", "evt-race", 40_000)),
      processMockPaymentEvent(db, ev("ORD-RACE", "evt-race", 40_000)),
    ]);
    const outcomes = results.map((r) =>
      r.status === "fulfilled" ? r.value.outcome : `rejected: ${r.reason?.code ?? r.reason}`,
    );
    expect(outcomes.filter((o) => o === "credited")).toHaveLength(1);
    expect(await balance("ws-race")).toBe(40_000);
    expect(await ledger("pay-race", "topup")).toHaveLength(1);
    expect(await ledger("pay-race", "adjustment")).toHaveLength(1);
  });

  test("manual admin complete path credits identically", async () => {
    await seedPayment({
      id: "pay-man",
      ws: "ws-manual",
      amount: 40_000,
      orderCode: "ORD-MAN",
      provider: "manual",
      bundleId: "b-std",
    });
    const r = await processMockPaymentEvent(
      db,
      ev("ORD-MAN", "admin-complete-pay-man", 40_000, "manual"),
    );
    expect(r.outcome).toBe("credited");
    expect(await balance("ws-manual")).toBe(40_000);
    expect(await ledger("pay-man", "topup")).toHaveLength(1);
    expect(await ledger("pay-man", "adjustment")).toEqual([
      { kind: "adjustment", amount: 10_000, memo: "bundle bonus" },
    ]);
  });

  test("plan payment: not credited, settlement rejected closed", async () => {
    await db.$client.unsafe(
      `INSERT INTO subscription_plans (id, name, price_vnd, credit_per_period_vnd, period_days, active, created_at)
       VALUES ('plan-future', 'plan-future', 150000, 20000, 30, true, $1)`,
      [NOW] as never[],
    );
    await seedPayment({
      id: "pay-plan",
      ws: "ws-plain",
      amount: 150_000,
      orderCode: "ORD-PLAN",
      planId: "plan-future",
    });
    expect(
      processMockPaymentEvent(db, ev("ORD-PLAN", "evt-plan", 150_000)),
    ).rejects.toThrow(/subscription settlement not enabled/);
    // Nothing credited by accident: balance, ledger, status all untouched.
    expect(await balance("ws-plain")).toBe(50_000);
    expect(await ledger("pay-plan")).toEqual([]);
    const pay = await q<{ status: string }>(`SELECT status FROM payments WHERE id = 'pay-plan'`);
    expect(pay[0]!.status).toBe("pending");
  });
});
