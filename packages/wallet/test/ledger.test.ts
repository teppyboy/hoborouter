// Task 8: ledger append-only enforcement + one-topup-per-payment.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { creditWallet } from "../src/wallet";
import { makeDb, seedFixture, makePayment, q1 } from "./helpers";

let db: Awaited<ReturnType<typeof makeDb>>["db"];
let drop: () => Promise<void>;

beforeAll(async () => {
  const t = await makeDb();
  db = t.db;
  drop = t.drop;
  await seedFixture(db);
  await makePayment(db, "pay-ledger-1", "ws-a");
  await makePayment(db, "pay-ledger-2", "ws-a");
  await creditWallet(db, { walletId: "wallet-a", amount: 500, kind: "topup", paymentId: "pay-ledger-1" });
});

afterAll(async () => {
  await drop();
});

describe("ledger append-only (DB triggers)", () => {
  // Drizzle wraps the driver error ("Failed query: ..."); the trigger text
  // lives on the cause. Assert on the unwrapped message.
  async function expectAppendOnly(query: ReturnType<typeof sql>): Promise<void> {
    try {
      await db.execute(query);
      throw new Error("expected append-only violation, query succeeded");
    } catch (err) {
      const msg = String((err as { cause?: Error }).cause?.message ?? (err as Error).message);
      expect(msg).toMatch(/append-only/i);
    }
  }

  test("UPDATE → RAISE EXCEPTION", async () => {
    await expectAppendOnly(sql`UPDATE ledger_entries SET amount = 1 WHERE wallet_id = 'wallet-a'`);
  });

  test("DELETE → RAISE EXCEPTION", async () => {
    await expectAppendOnly(sql`DELETE FROM ledger_entries WHERE wallet_id = 'wallet-a'`);
  });
});

describe("one topup per payment", () => {
  test("different paymentIds both succeed; same paymentId rejected", async () => {
    await creditWallet(db, {
      walletId: "wallet-a",
      amount: 10,
      kind: "topup",
      paymentId: "pay-ledger-2",
    });
    expect(
      creditWallet(db, {
        walletId: "wallet-a",
        amount: 10,
        kind: "topup",
        paymentId: "pay-ledger-2",
      }),
    ).rejects.toThrow();
    const n = await q1<{ c: number }>(
      db,
      sql`SELECT count(*)::int c FROM ledger_entries WHERE payment_id='pay-ledger-2'`,
    );
    expect(n.c).toBe(1);
  });
});
