// Task 8: creditWallet, getWallet — VND integer wallet core.
import { describe, expect, test, beforeAll } from "bun:test";
import type { Database } from "bun:sqlite";
import { creditWallet, getWallet } from "../src/wallet";
import { makeDb, seedFixture, makePayment } from "./helpers";

let db: Database;

beforeAll(() => {
  db = makeDb();
  seedFixture(db);
  makePayment(db, "pay-1", "ws-a");
  makePayment(db, "pay-of", "ws-a");
});

describe("creditWallet", () => {
  test("credits balance, writes ledger row, returns balanceAfter", () => {
    const r = creditWallet(db, {
      walletId: "wallet-a",
      amount: 100_000,
      kind: "topup",
      paymentId: "pay-1",
      memo: "top up",
    });
    expect(r.balanceAfter).toBe(100_000);
    expect(typeof r.ledgerEntryId).toBe("string");
    const row = db
      .prepare("SELECT * FROM ledger_entries WHERE id = ?")
      .get(r.ledgerEntryId) as Record<string, unknown>;
    expect(row.wallet_id).toBe("wallet-a");
    expect(row.direction).toBe("credit");
    expect(row.kind).toBe("topup");
    expect(row.amount).toBe(100_000);
    expect(row.payment_id).toBe("pay-1");
    expect(row.balance_after).toBe(100_000);
    expect(getWallet(db, "wallet-a")).toEqual({
      balance: 100_000,
      reserved: 0,
      available: 100_000,
      version: 1,
    });
  });

  test("one topup per paymentId (partial unique) → second credit rejected", () => {
    expect(() =>
      creditWallet(db, { walletId: "wallet-a", amount: 1, kind: "topup", paymentId: "pay-1" }),
    ).toThrow(/payment/i);
  });

  test("rejects non-integer, float, non-safe, and non-positive amounts before any SQL", () => {
    const before = getWallet(db, "wallet-a");
    for (const bad of [1.5, -1, 0, Number.NaN, Infinity, "5" as unknown, 2 ** 53]) {
      expect(() =>
        creditWallet(db, {
          walletId: "wallet-a",
          amount: bad as number,
          kind: "topup",
          paymentId: `pay-x-${bad}`,
        }),
      ).toThrow();
    }
    expect(getWallet(db, "wallet-a")).toEqual(before);
    expect(db.prepare("SELECT count(*) c FROM ledger_entries").get()).toEqual({ c: 1 });
  });

  test("overflow-checked: crediting beyond Number.MAX_SAFE_INTEGER is rejected", () => {
    db.prepare("UPDATE wallets SET balance = 9007199254740990 WHERE id = 'wallet-b'").run();
    expect(() =>
      creditWallet(db, { walletId: "wallet-b", amount: 100, kind: "topup", paymentId: "pay-of" }),
    ).toThrow(/overflow/i);
    expect(db.prepare("SELECT balance b FROM wallets WHERE id = 'wallet-b'").get()).toEqual({
      b: 9007199254740990,
    });
    expect(
      db.prepare("SELECT count(*) c FROM ledger_entries WHERE wallet_id='wallet-b'").get(),
    ).toEqual({ c: 0 });
  });

  test("controlled CAS mismatch (changes !== 1) → conflict, no ledger row", () => {
    // The CAS UPDATE (WHERE balance=? AND version=?) always succeeds under
    // BEGIN IMMEDIATE today, so simulate a stale-row miss by proxying the db:
    // the UPDATE wallets statement reports changes: 0. The guard must throw
    // WalletError("conflict") BEFORE the ledger insert, and rollback everything.
    const seen: { ledgerCount: number } = { ledgerCount: 0 };
    const realPrepare = db.prepare.bind(db);
    const proxied = new Proxy(db, {
      get(target, prop) {
        if (prop !== "prepare") {
          const v = Reflect.get(target, prop, target);
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        }
        return (sql: string) => {
          const stmt = realPrepare(sql) as { run: (...a: unknown[]) => { changes: number } };
          if (sql.includes("UPDATE wallets SET balance")) {
            return { run: () => ({ changes: 0 }) };
          }
          if (sql.includes("INSERT INTO ledger_entries")) {
            // should never run when the guard fires
            seen.ledgerCount += 1;
          }
          return stmt;
        };
      },
    }) as Database;
    expect(() =>
      creditWallet(proxied, { walletId: "wallet-a", amount: 5, kind: "topup", paymentId: null }),
    ).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(seen.ledgerCount).toBe(0);
  });

  test("unknown wallet → error, no ledger row", () => {
    expect(() =>
      creditWallet(db, { walletId: "nope", amount: 1, kind: "topup", paymentId: "pay-nw" }),
    ).toThrow();
  });
});

describe("getWallet", () => {
  test("derives available = balance - reserved", () => {
    db.prepare("UPDATE wallets SET reserved = 40 WHERE id = 'wallet-b'").run();
    expect(getWallet(db, "wallet-b")).toEqual({
      balance: 9007199254740990,
      reserved: 40,
      available: 9007199254740950,
      version: 0,
    });
  });
});
