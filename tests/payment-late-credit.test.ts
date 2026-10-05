// Late-paid webhooks + admin late credit (owner decisions):
//   - paid webhook for an EXPIRED payment: durable payment_events evidence +
//     payment.late_paid_detected audit, 2xx late-paid outcome, NO credit;
//   - rejected payments are never reopened (no event, no audit, 4xx);
//   - instance-admin credit-late credits exactly once at the payment's own
//     amount with payment.late_credit audit; replays never double-credit.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, type Db } from "../packages/db/src/index";
import { processMockPaymentEvent } from "../packages/payments/src/credit";

const NOW = 1_700_000_000_000;
let seq = 0;

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
    `INSERT INTO workspaces (id, name, status, created_at) VALUES ($1, $1, 'active', $2)`,
    [id, NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO wallets (id, workspace_id, currency, kind, balance, reserved, version, created_at)
     VALUES ($1, $2, 'VND', 'topup', 0, 0, 0, $3)`,
    ["wal-" + id, id, NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
     VALUES ('admin-1', 'Admin', 'admin-1@example.com', true, $1, $1)
     ON CONFLICT DO NOTHING`,
    [NOW] as never[],
  );
  // Disable the first-topup bonus so the credit assertions track exactly the
  // payment amount (same pattern as subscription-settlement.test.ts).
  await db.$client.unsafe(
    `INSERT INTO instance_settings (key, value, updated_at)
     VALUES ('first_topup_bonus_enabled', 'false', $1)
     ON CONFLICT (key) DO UPDATE SET value = 'false'`,
    [NOW] as never[],
  );
}

async function seedPayment(
  ws: string,
  opts: { status?: string; provider?: string; amount?: number } = {},
): Promise<string> {
  const id = `pay-late-${++seq}`;
  await db.$client.unsafe(
    `INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      ws,
      opts.amount ?? 50_000,
      opts.status ?? "expired",
      opts.provider ?? "payos",
      "ORD-" + id,
      NOW,
    ] as never[],
  );
  return id;
}

async function balance(ws: string): Promise<number> {
  const rows = await q<{ balance: string }>(
    `SELECT balance FROM wallets WHERE workspace_id = $1 AND kind = 'topup'`,
    [ws],
  );
  return Number(rows[0]!.balance);
}

const ev = (orderCode: string, ref: string, amount: number, txn?: string) => ({
  // payments lookup is provider-scoped: UNIQUE(provider, provider_order_code).
  provider: "payos",
  orderCode,
  providerReference: ref,
  amount,
  rawPayload: JSON.stringify({ orderCode, ref, transactionDateTime: txn }),
  ...(txn ? { transactionDateTime: txn } : {}),
});

describe("late paid webhook on expired payment", () => {
  test("retains evidence + audit, returns late_paid, no credit, status unchanged", async () => {
    const ws = "ws-late-1";
    await seedWorkspace(ws);
    const id = await seedPayment(ws);
    const r = await processMockPaymentEvent(
      db,
      ev("ORD-" + id, "evt-late-1", 50_000, "2026-09-30 12:00:00"),
    );
    expect(r).toEqual({ outcome: "late_paid", paymentId: id });
    // evidence is durable
    const events = await q<{ raw_payload: string; signature_valid: boolean }>(
      `SELECT raw_payload, signature_valid FROM payment_events WHERE payment_id = $1`,
      [id],
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.signature_valid).toBe(true);
    // signed timestamp lands in the audit detail only
    const audits = await q<{ action: string; detail: Record<string, unknown> }>(
      `SELECT action, detail FROM audit_log WHERE target = $1 AND action = 'payment.late_paid_detected'`,
      [id],
    );
    expect(audits).toHaveLength(1);
    const detail =
      typeof audits[0]!.detail === "string" ? JSON.parse(audits[0]!.detail) : audits[0]!.detail;
    expect(detail.transaction_date_time).toBe("2026-09-30 12:00:00");
    // no money movement, no status change
    expect(await balance(ws)).toBe(0);
    expect(await q<{ status: string }>(`SELECT status FROM payments WHERE id = $1`, [id])).toEqual([
      { status: "expired" },
    ]);
    // no ledger rows for this payment
    expect(await q(`SELECT 1 FROM ledger_entries WHERE payment_id = $1`, [id])).toHaveLength(0);
  });

  test("replayed late event is idempotent 2xx with a single evidence row", async () => {
    const ws = "ws-late-2";
    await seedWorkspace(ws);
    const id = await seedPayment(ws);
    const args = ev("ORD-" + id, "evt-late-2", 50_000);
    expect(await processMockPaymentEvent(db, args)).toEqual({
      outcome: "late_paid",
      paymentId: id,
    });
    expect(await processMockPaymentEvent(db, args)).toEqual({
      outcome: "late_paid",
      paymentId: id,
    });
    expect(
      await q(`SELECT 1 FROM payment_events WHERE provider_reference = 'evt-late-2'`),
    ).toHaveLength(1);
    expect(
      await q(
        `SELECT 1 FROM audit_log WHERE target = $1 AND action = 'payment.late_paid_detected'`,
        [id],
      ),
    ).toHaveLength(1);
  });

  test("amount mismatch on expired payment is rejected, no evidence", async () => {
    const ws = "ws-late-3";
    await seedWorkspace(ws);
    const id = await seedPayment(ws);
    expect(processMockPaymentEvent(db, ev("ORD-" + id, "evt-late-3", 999))).rejects.toMatchObject({
      code: "amount_mismatch",
    });
    expect(await q(`SELECT 1 FROM payment_events WHERE payment_id = $1`, [id])).toHaveLength(0);
  });

  test("rejected payment is never reopened: invalid, no event, no audit", async () => {
    const ws = "ws-late-4";
    await seedWorkspace(ws);
    const id = await seedPayment(ws, { status: "rejected" });
    expect(
      processMockPaymentEvent(db, ev("ORD-" + id, "evt-late-4", 50_000)),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await q(`SELECT 1 FROM payment_events WHERE payment_id = $1`, [id])).toHaveLength(0);
    expect(await balance(ws)).toBe(0);
  });

  test("late evidence for another payment's reference is invalid", async () => {
    const ws = "ws-late-5";
    await seedWorkspace(ws);
    const a = await seedPayment(ws);
    const b = await seedPayment(ws);
    await processMockPaymentEvent(db, ev("ORD-" + a, "evt-late-5", 50_000));
    expect(processMockPaymentEvent(db, ev("ORD-" + b, "evt-late-5", 50_000))).rejects.toMatchObject(
      { code: "invalid" },
    );
  });
});

describe("admin late credit (exactly once)", () => {
  const adminArgs = (id: string) => ({
    provider: "payos",
    orderCode: "ORD-" + id,
    providerReference: `admin-late-credit-${id}`,
    amount: 50_000,
    rawPayload: JSON.stringify({ source: "admin-late-credit", paymentId: id }),
    adminLateCredit: { actorUserId: "admin-1" },
  });

  async function credit(dbh: Db, id: string) {
    return processMockPaymentEvent(dbh, adminArgs(id));
  }

  test("credits once at the payment's own amount with late_credit audit", async () => {
    const ws = "ws-credit-1";
    await seedWorkspace(ws);
    const id = await seedPayment(ws);
    // evidence must exist first
    expect(credit(db, id)).rejects.toMatchObject({ code: "invalid" });
    expect(await balance(ws)).toBe(0);
    await processMockPaymentEvent(db, ev("ORD-" + id, "evt-credit-1", 50_000));
    const r = await credit(db, id);
    expect(r.outcome).toBe("credited");
    if (r.outcome === "credited") expect(r.balanceAfter).toBe(50_000);
    expect(await balance(ws)).toBe(50_000);
    const audits = await q<{ action: string; actor_user_id: string | null }>(
      `SELECT action, actor_user_id FROM audit_log WHERE target = $1 AND action = 'payment.late_credit'`,
      [id],
    );
    expect(audits).toEqual([{ action: "payment.late_credit", actor_user_id: "admin-1" }]);
    // exactly one topup ledger row
    expect(
      await q(
        `SELECT 1 FROM ledger_entries WHERE payment_id = $1 AND kind = 'topup' AND amount = 50000`,
        [id],
      ),
    ).toHaveLength(1);
  });

  test("replay of the admin credit is idempotent: no second credit", async () => {
    const ws = "ws-credit-2";
    await seedWorkspace(ws);
    const id = await seedPayment(ws);
    await processMockPaymentEvent(db, ev("ORD-" + id, "evt-credit-2", 50_000));
    await credit(db, id);
    expect(await credit(db, id)).toMatchObject({ outcome: "already_processed" });
    expect(await balance(ws)).toBe(50_000);
    expect(
      await q(`SELECT 1 FROM audit_log WHERE target = $1 AND action = 'payment.late_credit'`, [id]),
    ).toHaveLength(1);
  });

  test("a distinct second reference after credit is rejected (no double credit)", async () => {
    const ws = "ws-credit-3";
    await seedWorkspace(ws);
    const id = await seedPayment(ws);
    await processMockPaymentEvent(db, ev("ORD-" + id, "evt-credit-3", 50_000));
    await credit(db, id);
    expect(
      processMockPaymentEvent(db, ev("ORD-" + id, "evt-credit-3b", 50_000)),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await balance(ws)).toBe(50_000);
  });

  test("concurrent admin credits credit exactly once (unique gates)", async () => {
    const ws = "ws-credit-4";
    await seedWorkspace(ws);
    const id = await seedPayment(ws);
    await processMockPaymentEvent(db, ev("ORD-" + id, "evt-credit-4", 50_000));
    const results = await Promise.allSettled([credit(db, id), credit(db, id)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    // money invariant: balance moved exactly once
    expect(await balance(ws)).toBe(50_000);
    expect(
      await q(`SELECT 1 FROM ledger_entries WHERE payment_id = $1 AND kind = 'topup'`, [id]),
    ).toHaveLength(1);
    expect(
      await q(`SELECT 1 FROM audit_log WHERE target = $1 AND action = 'payment.late_credit'`, [id]),
    ).toHaveLength(1);
  });
});
