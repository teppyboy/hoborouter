// Task 8: ledger append-only enforcement + one-topup-per-payment.
import { describe, expect, test, beforeAll } from "bun:test";
import type { Database } from "bun:sqlite";
import { creditWallet } from "../src/wallet";
import { makeDb, seedFixture, makePayment } from "./helpers";

let db: Database;

beforeAll(() => {
  db = makeDb();
  seedFixture(db);
  makePayment(db, "pay-ledger-1", "ws-a");
  makePayment(db, "pay-ledger-2", "ws-a");
  creditWallet(db, { walletId: "wallet-a", amount: 500, kind: "topup", paymentId: "pay-ledger-1" });
});

describe("ledger append-only (DB triggers)", () => {
  test("UPDATE → RAISE(ABORT)", () => {
    expect(() =>
      db.prepare("UPDATE ledger_entries SET amount = 1 WHERE wallet_id = 'wallet-a'").run(),
    ).toThrow(/append-only/);
  });

  test("DELETE → RAISE(ABORT)", () => {
    expect(() =>
      db.prepare("DELETE FROM ledger_entries WHERE wallet_id = 'wallet-a'").run(),
    ).toThrow(/append-only/);
  });
});

describe("one topup per payment", () => {
  test("different paymentIds both succeed; same paymentId rejected", () => {
    creditWallet(db, {
      walletId: "wallet-a",
      amount: 10,
      kind: "topup",
      paymentId: "pay-ledger-2",
    });
    expect(() =>
      creditWallet(db, {
        walletId: "wallet-a",
        amount: 10,
        kind: "topup",
        paymentId: "pay-ledger-2",
      }),
    ).toThrow();
    const n = db
      .prepare("SELECT count(*) c FROM ledger_entries WHERE payment_id='pay-ledger-2'")
      .get() as { c: number };
    expect(n.c).toBe(1);
  });
});
