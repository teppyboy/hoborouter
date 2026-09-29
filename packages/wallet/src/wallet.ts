// Task 8: VND wallet core — creditWallet, getWallet.
// All money = integer VND. All mutations run in BEGIN IMMEDIATE transactions.
import type { Database } from "bun:sqlite";

export type WalletErrorCode =
  | "not_found"
  | "ownership"
  | "conflict"
  | "terminal"
  | "invalid"
  | "insufficient"
  | "overflow";

export class WalletError extends Error {
  code: WalletErrorCode;
  constructor(code: WalletErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Reject non-integers, floats, non-safe, non-positive amounts BEFORE any SQL. */
export function requirePositiveSafeInteger(name: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) {
    throw new WalletError("invalid", `${name} must be a positive safe integer, got ${String(v)}`);
  }
  return v;
}

function overflowCheckedAdd(name: string, a: number, b: number): number {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) {
    throw new WalletError("overflow", `${name} overflow: ${a} + ${b} exceeds MAX_SAFE_INTEGER`);
  }
  return sum;
}

/**
 * Transaction composition for callers that group multiple mutations (e.g. the
 * mock payment webhook: event insert + credit + status update in ONE atomic
 * unit). Opens BEGIN IMMEDIATE unless already inside a transaction — in that
 * case it runs fn inline and the OUTERMOST transaction owns commit/rollback.
 * creditWallet's own atomicity/CAS behavior is unchanged either way.
 */
export function runInImmediate<T>(db: Database, fn: () => T): T {
  if (db.inTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

function getWalletRow(
  db: Database,
  walletId: string,
): { id: string; balance: number; reserved: number; version: number } {
  const row = db
    .prepare("SELECT id, balance, reserved, version FROM wallets WHERE id = ?")
    .get(walletId) as
    | { id: string; balance: number; reserved: number; version: number }
    | undefined;
  if (!row) throw new WalletError("not_found", `wallet not found: ${walletId}`);
  return row;
}

export function creditWallet(
  db: Database,
  opts: {
    walletId: string;
    amount: number;
    kind: "topup";
    paymentId: string | null;
    memo?: string;
  },
): { ledgerEntryId: string; balanceAfter: number } {
  const amount = requirePositiveSafeInteger("amount", opts.amount);
  return runInImmediate(db, () => {
    const wallet = getWalletRow(db, opts.walletId);
    if (opts.paymentId !== null) {
      const existing = db
        .prepare("SELECT 1 FROM ledger_entries WHERE payment_id = ? AND kind = 'topup'")
        .get(opts.paymentId);
      if (existing) {
        throw new WalletError(
          "conflict",
          `topup credit already exists for payment ${opts.paymentId}`,
        );
      }
    }
    const balanceAfter = overflowCheckedAdd("balance", wallet.balance, amount);
    const version = overflowCheckedAdd("version", wallet.version, 1);
    const updated = db
      .prepare(
        "UPDATE wallets SET balance = ?, version = ? WHERE id = ? AND balance = ? AND version = ?",
      )
      .run(balanceAfter, version, wallet.id, wallet.balance, wallet.version);
    // Unreachable under BEGIN IMMEDIATE today, but if the txn wrapper ever
    // changes, a 0-change CAS miss must NOT produce a ledger row with a wrong
    // balance_after.
    if (updated.changes !== 1) {
      throw new WalletError(
        "conflict",
        `wallet ${wallet.id} concurrent modification detected (CAS miss)`,
      );
    }
    const ledgerEntryId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO ledger_entries (id, wallet_id, direction, amount, kind, payment_id, balance_after, memo, created_at) VALUES (?, ?, 'credit', ?, 'topup', ?, ?, ?, ?)",
    ).run(
      ledgerEntryId,
      wallet.id,
      amount,
      opts.paymentId,
      balanceAfter,
      opts.memo ?? null,
      Date.now(),
    );
    return { ledgerEntryId, balanceAfter };
  });
}

export function getWallet(
  db: Database,
  walletId: string,
): {
  balance: number;
  reserved: number;
  available: number;
  version: number;
} {
  const w = getWalletRow(db, walletId);
  return {
    balance: w.balance,
    reserved: w.reserved,
    available: w.balance - w.reserved,
    version: w.version,
  };
}

export { createReservation } from "./reservation";
export { releaseHold } from "./reservation";
