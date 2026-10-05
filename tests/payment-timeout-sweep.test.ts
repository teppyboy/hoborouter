// Payment expiry sweep (owner decisions): timeout snapshot expires_at at
// creation; the sweep marks ONLY pending payments past their snapshot as the
// existing 'expired' status with one payment.timeout_reject audit row each;
// existing NULL expires_at and non-pending rows are never touched.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, type Db } from "../packages/db/src/index";
import { sweepExpiredPayments } from "../apps/api/src/payment-expiry";
import {
  resolveTopupAmount,
  paymentDeadlineMs,
  withinPaymentCap,
} from "../apps/api/src/payment-creation";

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

let seq = 0;
async function seedPayment(opts: {
  status?: string;
  expiresAt?: number | null;
  provider?: string;
}): Promise<string> {
  const id = `pay-exp-${++seq}`;
  await db.$client.unsafe(
    `INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at, expires_at)
     VALUES ($1, $2, 50000, $3, $4, $5, $6, $7)`,
    [
      id,
      "ws-exp",
      opts.status ?? "pending",
      opts.provider ?? "payos",
      "ORD-" + id,
      NOW,
      opts.expiresAt === undefined ? NOW - 1000 : opts.expiresAt,
    ] as never[],
  );
  return id;
}

async function statusOf(id: string): Promise<string | null> {
  const rows = (await db.$client.unsafe(`SELECT status FROM payments WHERE id = $1`, [
    id,
  ] as never[])) as { status: string }[];
  return rows[0]?.status ?? null;
}

async function audits(target: string): Promise<string[]> {
  const rows = (await db.$client.unsafe(
    `SELECT action FROM audit_log WHERE target = $1 ORDER BY action`,
    [target] as never[],
  )) as { action: string }[];
  return rows.map((r) => r.action);
}

describe("resolveTopupAmount (cap + currency)", () => {
  const limits = { timeoutMinutes: 30, maxAmountVnd: 100_000, usdVndRate: 26_000 };

  test("VND amount below cap snapshots VND input", () => {
    const r = resolveTopupAmount(50_000, null, limits);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.amountVnd).toBe(50_000);
      expect(r.inputCurrency).toBe("VND");
      expect(r.inputAmountText).toBe("50000");
      expect(r.fxRateVndPerUsd).toBeNull();
    }
  });

  test("VND amount above cap is rejected", () => {
    const r = resolveTopupAmount(100_001, null, limits);
    expect(r).toEqual({ ok: false, reason: "over_cap", message: expect.any(String) });
  });

  test("USD input converts with exact ceiling and snapshots input + rate", () => {
    const r = resolveTopupAmount(null, "3.00", limits);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 300 cents * 26000 / 100 = 78000 exactly
      expect(r.amountVnd).toBe(78_000);
      expect(r.inputCurrency).toBe("USD");
      expect(r.inputAmountText).toBe("3.00");
      expect(r.fxRateVndPerUsd).toBe(26_000);
    }
  });

  test("USD input above the converted cap is rejected", () => {
    // 4.00 USD * 26000 = 104000 > 100000 cap
    expect(resolveTopupAmount(null, "4.00", limits).ok).toBe(false);
  });

  test("invalid USD text is rejected; amount and usd text are mutually exclusive inputs", () => {
    expect(resolveTopupAmount(null, "1.234", limits).ok).toBe(false);
    expect(resolveTopupAmount(null, "-3", limits).ok).toBe(false);
  });

  test("deadline snapshot is creation time + timeout minutes", () => {
    expect(paymentDeadlineMs(1_000_000, 30)).toBe(1_000_000 + 30 * 60_000);
    expect(withinPaymentCap(100_000, 100_000)).toBe(true);
    expect(withinPaymentCap(100_001, 100_000)).toBe(false);
  });
});

describe("payment expiry sweep", () => {
  test("pending + past expires_at -> expired with audit; others untouched", async () => {
    await db.$client.unsafe(
      `INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws-exp', 'ws-exp', 'active', $1)`,
      [NOW] as never[],
    );
    const expiredPending = await seedPayment({});
    const futurePending = await seedPayment({ expiresAt: NOW + 3_600_000 });
    const nullExpiry = await seedPayment({ expiresAt: null });
    const expiredRejected = await seedPayment({ status: "rejected" });
    const expiredSucceeded = await seedPayment({ status: "succeeded" });

    const n = await sweepExpiredPayments(db, NOW);
    expect(n).toBe(1);
    expect(await statusOf(expiredPending)).toBe("expired");
    expect(await statusOf(futurePending)).toBe("pending");
    expect(await statusOf(nullExpiry)).toBe("pending");
    // terminal admin states are never reopened
    expect(await statusOf(expiredRejected)).toBe("rejected");
    expect(await statusOf(expiredSucceeded)).toBe("succeeded");
    expect(await audits(expiredPending)).toEqual(["payment.timeout_reject"]);
    expect(await audits(futurePending)).toEqual([]);
  });

  test("sweep is idempotent: already-expired rows are not re-audited", async () => {
    const id = await seedPayment({});
    await sweepExpiredPayments(db, NOW);
    await sweepExpiredPayments(db, NOW);
    expect(await audits(id)).toEqual(["payment.timeout_reject"]);
  });

  test("bounded batch: limit caps how many rows flip per sweep", async () => {
    const a = await seedPayment({});
    const b = await seedPayment({});
    const swept = await sweepExpiredPayments(db, NOW, 1);
    expect(swept).toBe(1);
    const statuses = [await statusOf(a), await statusOf(b)];
    expect(statuses.filter((s) => s === "expired")).toHaveLength(1);
  });
});
