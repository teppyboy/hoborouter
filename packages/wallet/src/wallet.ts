// Task 8: VND wallet core — creditWallet, getWallet.
// All money = integer VND. All mutations run in Postgres transactions that
// first lock the wallet row (SELECT ... FOR UPDATE).
import { and, eq, isNull, type SQL } from "drizzle-orm";
import type { Db, Tx } from "@hoborouter/db";
import { ledgerEntries, wallets } from "@hoborouter/db";

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

/** A drizzle transaction handle has no $client; the connection-level Db does. */
export function isTx(db: Db | Tx): db is Tx {
  return !("$client" in db);
}

/** Lock one wallet row FOR UPDATE inside the current transaction. */
export async function lockWallet(tx: Tx, walletId: string): Promise<void> {
  await tx.select({ id: wallets.id }).from(wallets).where(eq(wallets.id, walletId)).for("update");
}

/**
 * Transaction composition for callers that group multiple mutations (e.g. the
 * mock payment webhook: event insert + credit + status update in ONE atomic
 * unit). Opens a Postgres transaction unless already inside one (then runs
 * fn inline — the OUTERMOST transaction owns commit/rollback). When
 * opts.walletId is given, the wallet row is locked FOR UPDATE before fn runs,
 * serializing concurrent read-modify-write on the same wallet. Read COMMITTED.
 */
export async function runInImmediate<T>(
  db: Db | Tx,
  fn: (tx: Tx) => Promise<T>,
  opts: { walletId?: string } = {},
): Promise<T> {
  if (isTx(db)) return fn(db);
  return db.transaction(async (tx) => {
    if (opts.walletId) await lockWallet(tx, opts.walletId);
    return fn(tx);
  });
}

async function getWalletRow(
  tx: Db | Tx,
  walletId: string,
): Promise<{ id: string; balance: number; reserved: number; version: number }> {
  const rows = await tx
    .select({
      id: wallets.id,
      balance: wallets.balance,
      reserved: wallets.reserved,
      version: wallets.version,
    })
    .from(wallets)
    .where(eq(wallets.id, walletId));
  const row = rows[0];
  if (!row) throw new WalletError("not_found", `wallet not found: ${walletId}`);
  return row;
}

export async function creditWallet(
  db: Db | Tx,
  opts: {
    walletId: string;
    amount: number;
    kind: "topup" | "adjustment";
    paymentId: string | null;
    memo?: string;
  },
): Promise<{ ledgerEntryId: string; balanceAfter: number }> {
  const amount = requirePositiveSafeInteger("amount", opts.amount);
  return runInImmediate(
    db,
    async (tx) => {
      // Lock first: serializes concurrent credits on the same wallet.
      await lockWallet(tx, opts.walletId);
      const wallet = await getWalletRow(tx, opts.walletId);
      if (opts.paymentId !== null) {
        // Kind-aware dedup: topup keeps its one-per-payment gate; adjustments
        // dedup per (payment, memo) so distinct memos (bundle bonus, first
        // topup bonus) can coexist on one payment — matching the partial
        // UNIQUE(payment_id, memo) WHERE kind='adjustment' index.
        const dedup = [
          eq(ledgerEntries.payment_id, opts.paymentId),
          eq(ledgerEntries.kind, opts.kind),
        ];
        if (opts.kind === "adjustment") {
          if (opts.memo === undefined) dedup.push(isNull(ledgerEntries.memo));
          else dedup.push(eq(ledgerEntries.memo, opts.memo));
        }
        const existing = await tx
          .select({ x: ledgerEntries.payment_id })
          .from(ledgerEntries)
          .where(and(...dedup));
        if (existing.length > 0) {
          throw new WalletError(
            "conflict",
            `${opts.kind} credit already exists for payment ${opts.paymentId}`,
          );
        }
      }
      const balanceAfter = overflowCheckedAdd("balance", wallet.balance, amount);
      const version = overflowCheckedAdd("version", wallet.version, 1);
      // CAS guard on (balance, version); 0 returning rows = concurrent change.
      const updated = await tx
        .update(wallets)
        .set({ balance: balanceAfter, version })
        .where(
          and(
            eq(wallets.id, wallet.id),
            eq(wallets.balance, wallet.balance),
            eq(wallets.version, wallet.version),
          ),
        )
        .returning({ id: wallets.id });
      if (updated.length !== 1) {
        throw new WalletError(
          "conflict",
          `wallet ${wallet.id} concurrent modification detected (CAS miss)`,
        );
      }
      const ledgerEntryId = crypto.randomUUID();
      await tx.insert(ledgerEntries).values({
        id: ledgerEntryId,
        wallet_id: wallet.id,
        direction: "credit",
        amount,
        kind: opts.kind,
        payment_id: opts.paymentId,
        balance_after: balanceAfter,
        memo: opts.memo ?? null,
        created_at: Date.now(),
      });
      return { ledgerEntryId, balanceAfter };
    },
    { walletId: opts.walletId },
  );
}

export async function getWallet(
  db: Db | Tx,
  walletId: string,
): Promise<{
  balance: number;
  reserved: number;
  available: number;
  version: number;
}> {
  const w = await getWalletRow(db, walletId);
  return {
    balance: w.balance,
    reserved: w.reserved,
    available: w.balance - w.reserved,
    version: w.version,
  };
}

/** Row-fetch helper for raw SQL assertions and reads that need SQL literals. */
export async function rawRows<T>(db: Db | Tx, query: SQL): Promise<T[]> {
  const result: unknown = await db.execute(query);
  // Connection-level execute wraps rows in { rows }; tx-level returns them.
  const rows = (result as { rows?: T[] }).rows ?? (result as T[]);
  return rows;
}

export { createReservation } from "./reservation";
export { releaseHold } from "./reservation";
