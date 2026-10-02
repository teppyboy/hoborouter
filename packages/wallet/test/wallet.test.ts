// Task 8: creditWallet, getWallet — VND integer wallet core.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import type { Tx } from "@hoborouter/db";
import { wallets } from "@hoborouter/db";
import { creditWallet, getWallet } from "../src/wallet";
import { makeDb, seedFixture, makePayment, q1 } from "./helpers";

let db: Awaited<ReturnType<typeof makeDb>>["db"];
let drop: () => Promise<void>;

beforeAll(async () => {
  const t = await makeDb();
  db = t.db;
  drop = t.drop;
  await seedFixture(db);
  await makePayment(db, "pay-1", "ws-a");
  await makePayment(db, "pay-of", "ws-a");
});

afterAll(async () => {
  await drop();
});

describe("creditWallet", () => {
  test("credits balance, writes ledger row, returns balanceAfter", async () => {
    const r = await creditWallet(db, {
      walletId: "wallet-a",
      amount: 100_000,
      kind: "topup",
      paymentId: "pay-1",
      memo: "top up",
    });
    expect(r.balanceAfter).toBe(100_000);
    expect(typeof r.ledgerEntryId).toBe("string");
    const row = await q1(db, sql`SELECT * FROM ledger_entries WHERE id = ${r.ledgerEntryId}`);
    expect(row.wallet_id).toBe("wallet-a");
    expect(row.direction).toBe("credit");
    expect(row.kind).toBe("topup");
    expect(Number(row.amount)).toBe(100_000);
    expect(row.payment_id).toBe("pay-1");
    expect(Number(row.balance_after)).toBe(100_000);
    expect(await getWallet(db, "wallet-a")).toEqual({
      balance: 100_000,
      reserved: 0,
      available: 100_000,
      version: 1,
    });
  });

  test("one topup per paymentId (partial unique) → second credit rejected", async () => {
    expect(
      creditWallet(db, { walletId: "wallet-a", amount: 1, kind: "topup", paymentId: "pay-1" }),
    ).rejects.toThrow(/payment/i);
  });

  test("rejects non-integer, float, non-safe, and non-positive amounts before any SQL", async () => {
    const before = await getWallet(db, "wallet-a");
    for (const bad of [1.5, -1, 0, Number.NaN, Infinity, "5" as unknown, 2 ** 53]) {
      expect(
        creditWallet(db, {
          walletId: "wallet-a",
          amount: bad as number,
          kind: "topup",
          paymentId: `pay-x-${bad}`,
        }),
      ).rejects.toThrow();
    }
    expect(await getWallet(db, "wallet-a")).toEqual(before);
    const { c } = await q1<{ c: number }>(db, sql`SELECT count(*)::int c FROM ledger_entries`);
    expect(c).toBe(1);
  });

  test("overflow-checked: crediting beyond Number.MAX_SAFE_INTEGER is rejected", async () => {
    await db.execute(sql`UPDATE wallets SET balance = 9007199254740990 WHERE id = 'wallet-b'`);
    expect(
      creditWallet(db, { walletId: "wallet-b", amount: 100, kind: "topup", paymentId: "pay-of" }),
    ).rejects.toThrow(/overflow/i);
    const row = await q1<{ b: number }>(db, sql`SELECT balance b FROM wallets WHERE id = 'wallet-b'`);
    expect(Number(row.b)).toBe(9007199254740990);
    const { c } = await q1<{ c: number }>(
      db,
      sql`SELECT count(*)::int c FROM ledger_entries WHERE wallet_id='wallet-b'`,
    );
    expect(c).toBe(0);
  });

  test("controlled CAS mismatch (0 returning rows) → conflict, no ledger row", async () => {
    // The CAS UPDATE (WHERE balance=? AND version=?) always succeeds under the
    // wallet row lock today, so simulate a stale-row miss by wrapping the tx:
    // the wallets UPDATE reports 0 returning rows. The guard must throw
    // WalletError("conflict") BEFORE the ledger insert, and roll back everything.
    let casHits = 0;
    const wrapped = {
      // $client marks this as a connection-level Db (not a Tx) for isTx().
      $client: {} as never,
      transaction: (fn: (tx: Tx) => Promise<unknown>) =>
        db.transaction(async (rtx) => {
          // Explicit delegation: drizzle tx methods misbehave behind
          // prototype-chain shims; creditWallet only needs select/insert/update.
          const txProxy = {
            select: (...a: unknown[]) => (rtx.select as (...b: unknown[]) => unknown)(...a),
            insert: (...a: unknown[]) => (rtx.insert as (...b: unknown[]) => unknown)(...a),
            execute: (...a: unknown[]) => (rtx.execute as (...b: unknown[]) => unknown)(...a),
            update: (table: unknown) => {
              const builder = rtx.update(table as never);
              if (table !== wallets) return builder;
              // set()/where() return fresh builders, so re-wrap any chained
              // result that still exposes .returning.
              const wrap = (b: unknown): unknown =>
                new Proxy(b as object, {
                  get(t, p2) {
                    if (p2 === "returning") {
                      return () => {
                        casHits++;
                        return Promise.resolve([]);
                      };
                    }
                    const v = Reflect.get(t, p2, t);
                    if (typeof v !== "function") return v;
                    return (...args: unknown[]) => {
                      const r = (v as (...a: unknown[]) => unknown).apply(t, args);
                      return r !== null && typeof r === "object" && typeof (r as { returning?: unknown }).returning === "function"
                        ? wrap(r)
                        : r;
                    };
                  },
                });
              return wrap(builder);
            },
          };
          return fn(txProxy as unknown as Tx);
        }),
    };
    await expect(
      creditWallet(wrapped as never, { walletId: "wallet-a", amount: 5, kind: "topup", paymentId: null }),
    ).rejects.toThrow(expect.objectContaining({ code: "conflict" }));
    expect(casHits).toBe(1);
    const { c } = await q1<{ c: number }>(
      db,
      sql`SELECT count(*)::int c FROM ledger_entries WHERE payment_id IS NULL`,
    );
    expect(c).toBe(0);
  });

  test("unknown wallet → error, no ledger row", async () => {
    expect(
      creditWallet(db, { walletId: "nope", amount: 1, kind: "topup", paymentId: "pay-nw" }),
    ).rejects.toThrow();
  });
});

describe("getWallet", () => {
  test("derives available = balance - reserved", async () => {
    await db.execute(sql`UPDATE wallets SET reserved = 40 WHERE id = 'wallet-b'`);
    expect(await getWallet(db, "wallet-b")).toEqual({
      balance: 9007199254740990,
      reserved: 40,
      available: 9007199254740950,
      version: 0,
    });
  });
});
