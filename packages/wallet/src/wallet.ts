// Task 8: VND wallet core — creditWallet, getWallet.
// All money = integer VND. All mutations run in Postgres transactions that
// first lock the wallet row (SELECT ... FOR UPDATE).
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { Db, Tx } from "@hoborouter/db";
import {
  adminWalletAdjustments,
  auditLog,
  ledgerEntries,
  users,
  wallets,
  MAX_SAFE_INTEGER_MONEY,
} from "@hoborouter/db";
import { isUniqueViolation } from "@hoborouter/db";

export type WalletErrorCode =
  | "not_found"
  | "ownership"
  | "conflict"
  | "terminal"
  | "invalid"
  | "insufficient"
  | "overflow"
  | "idempotency_mismatch";

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

export function overflowCheckedAdd(name: string, a: number, b: number): number {
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

// --- admin wallet adjustment (instance-admin owner decisions) ---

export interface AdminAdjustmentArgs {
  /** Authenticated instance admin performing the adjustment. */
  actorUserId: string;
  /** Client-supplied replay key; UNIQUE per (actor, key). */
  idempotencyKey: string;
  /** Explicit workspace: the wallet must belong to it (no user->wallet inference). */
  workspaceId: string;
  /** Explicitly resolved topup wallet (subscription wallets are unreachable). */
  walletId: string;
  /** Signed non-zero VND delta; ledger.amount is |delta|. */
  delta: number;
  /** ADMIN-PRIVATE: stored on the receipt/audit, never in the generic ledger memo. */
  reason: string;
}

export interface AdminAdjustmentReceipt {
  id: string;
  walletId: string;
  workspaceId: string;
  delta: number;
  reason: string;
  balanceBefore: number;
  balanceAfter: number;
  reserved: number;
  ledgerEntryId: string;
  createdAt: number;
  /** True when an existing (actor, key) receipt was returned without re-applying. */
  replayed: boolean;
}

interface StoredReceipt {
  id: string;
  wallet_id: string;
  workspace_id: string;
  delta: number;
  reason: string;
  balance_before: number;
  balance_after: number;
  reserved: number;
  ledger_entry_id: string | null;
  request_payload: { workspaceId: string; delta: number; reason: string };
  created_at: number;
}

function validateAdjustmentArgs(args: AdminAdjustmentArgs): void {
  if (
    typeof args.delta !== "number" ||
    !Number.isSafeInteger(args.delta) ||
    args.delta === 0 ||
    Math.abs(args.delta) > MAX_SAFE_INTEGER_MONEY
  ) {
    throw new WalletError(
      "invalid",
      `delta must be a non-zero safe integer within ±MAX_SAFE_INTEGER_MONEY, got ${String(args.delta)}`,
    );
  }
  if (
    typeof args.idempotencyKey !== "string" ||
    args.idempotencyKey.length < 16 ||
    args.idempotencyKey.length > 128
  ) {
    throw new WalletError("invalid", "idempotencyKey must be 16..128 characters");
  }
  if (typeof args.reason !== "string" || args.reason.length < 1 || args.reason.length > 500) {
    throw new WalletError("invalid", "reason must be 1..500 characters");
  }
}

/** Replay mapping: the ORIGINAL receipt is returned verbatim (no recompute). */
function receiptFromStored(row: StoredReceipt, replayed: boolean): AdminAdjustmentReceipt {
  // The application contract commits every receipt WITH its ledger entry (same
  // txn, insert order below); a null here means a corrupt pre-contract row.
  if (row.ledger_entry_id === null) {
    throw new WalletError("conflict", `receipt ${row.id} has no ledger entry`);
  }
  return {
    id: row.id,
    walletId: row.wallet_id,
    workspaceId: row.workspace_id,
    delta: row.delta,
    reason: row.reason,
    balanceBefore: row.balance_before,
    balanceAfter: row.balance_after,
    reserved: row.reserved,
    ledgerEntryId: row.ledger_entry_id,
    createdAt: row.created_at,
    replayed,
  };
}

/**
 * Compare the stored canonical request payload (what the committed receipt
 * captured) against the incoming request. Any drift is a replay MISMATCH,
 * never a silent re-apply under a winning key.
 */
function assertReplayMatch(row: StoredReceipt, args: AdminAdjustmentArgs): void {
  const payload = row.request_payload;
  if (
    payload.workspaceId !== args.workspaceId ||
    payload.delta !== args.delta ||
    payload.reason !== args.reason
  ) {
    throw new WalletError(
      "idempotency_mismatch",
      `idempotency key ${args.idempotencyKey} was already used with a different workspace/delta/reason`,
    );
  }
}

async function readReceipt(
  db: Db | Tx,
  actorUserId: string,
  idempotencyKey: string,
): Promise<StoredReceipt | undefined> {
  const rows = await db
    .select()
    .from(adminWalletAdjustments)
    .where(
      and(
        eq(adminWalletAdjustments.actor_user_id, actorUserId),
        eq(adminWalletAdjustments.idempotency_key, idempotencyKey),
      ),
    )
    .limit(1);
  return rows[0];
}

/**
 * Instance-admin balance adjustment: THE Db-only transaction owner. ONE
 * transaction applies — topup-wallet/workspace validation, signed-delta math
 * against the locked (FOR UPDATE) snapshot, CAS balance update, positive-|delta|
 * ledger entry, admin audit, and the (actor, idempotency_key) receipt. The
 * receipt insert is the LAST write so a unique race rolls back every prior
 * write; the loser then re-reads the committed winner OUTSIDE the aborted
 * transaction and either replays it or surfaces idempotency_mismatch.
 * Never retries the financial mutation itself.
 */
export async function adjustWalletBalance(
  db: Db,
  args: AdminAdjustmentArgs,
): Promise<AdminAdjustmentReceipt> {
  validateAdjustmentArgs(args);
  // The receipt AND audit rows FK to users; validate the actor before opening
  // the transaction so an unknown admin is a clean not_found (no partial writes).
  const actor = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, args.actorUserId))
    .limit(1);
  if (!actor[0]) throw new WalletError("not_found", `actor user not found: ${args.actorUserId}`);

  try {
    return await runInImmediate(
      db,
      async (tx) => {
        // Replay check FIRST (right after the row lock): a replay must return
        // the original receipt even if role/workspace checks would now reject —
        // mismatched payloads surface as idempotency_mismatch, never ownership.
        const existing = await readReceipt(tx, args.actorUserId, args.idempotencyKey);
        if (existing) {
          assertReplayMatch(existing, args);
          return receiptFromStored(existing, true);
        }
        const wallet = await getWalletRow(tx, args.walletId);
        const full = (
          await tx
            .select({ kind: wallets.kind, workspace_id: wallets.workspace_id })
            .from(wallets)
            .where(eq(wallets.id, args.walletId))
            .limit(1)
        )[0];
        if (!full) throw new WalletError("not_found", `wallet not found: ${args.walletId}`);
        if (full.kind !== "topup") {
          throw new WalletError("invalid", `wallet ${args.walletId} is not a topup wallet`);
        }
        if (full.workspace_id !== args.workspaceId) {
          throw new WalletError(
            "ownership",
            `wallet ${args.walletId} does not belong to workspace ${args.workspaceId}`,
          );
        }
        const balanceBefore = wallet.balance;
        const balanceAfter = balanceBefore + args.delta;
        if (args.delta > 0) {
          if (!Number.isSafeInteger(balanceAfter) || balanceAfter > MAX_SAFE_INTEGER_MONEY) {
            throw new WalletError(
              "overflow",
              `balance overflow: ${balanceBefore} + ${args.delta} exceeds MAX_SAFE_INTEGER_MONEY`,
            );
          }
        } else if (balanceAfter < wallet.reserved) {
          throw new WalletError(
            "insufficient",
            `debit would drop balance ${balanceBefore} by ${-args.delta} below reserved ${wallet.reserved}`,
          );
        }
        if (balanceAfter < 0 || balanceAfter > MAX_SAFE_INTEGER_MONEY) {
          throw new WalletError("overflow", `balance ${balanceAfter} outside allowed range`);
        }

        const version = overflowCheckedAdd("version", wallet.version, 1);
        // CAS guard on the locked snapshot; 0 rows = concurrent change.
        const updated = await tx
          .update(wallets)
          .set({ balance: balanceAfter, version })
          .where(
            and(
              eq(wallets.id, wallet.id),
              eq(wallets.balance, balanceBefore),
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

        // Positive-|delta| ledger entry; memo stays generic so the private
        // reason never leaks into customer-visible ledger surfaces.
        const ledgerEntryId = crypto.randomUUID();
        await tx.insert(ledgerEntries).values({
          id: ledgerEntryId,
          wallet_id: wallet.id,
          direction: args.delta > 0 ? "credit" : "debit",
          amount: Math.abs(args.delta),
          kind: "adjustment",
          payment_id: null,
          balance_after: balanceAfter,
          memo: "admin adjustment",
          created_at: Date.now(),
        });

        // Admin audit IN the same txn: a failed audit rolls back the money.
        await tx.insert(auditLog).values({
          id: crypto.randomUUID(),
          actor_user_id: args.actorUserId,
          workspace_id: args.workspaceId,
          // Canonical admin-domain action name; the backend audit exclusion
          // filter (admin.*) keys off this exact prefix.
          action: "admin.wallet.adjust",
          target: wallet.id,
          detail: {
            delta: args.delta,
            balanceAfter,
            idempotencyKey: args.idempotencyKey,
            reason: args.reason,
          },
          created_at: Date.now(),
        });

        // Receipt LAST: the (actor, key) UNIQUE arbiter aborting here rolls
        // back ledger + audit + wallet CAS in the same transaction.
        const receiptId = crypto.randomUUID();
        const createdAt = Date.now();
        await tx.insert(adminWalletAdjustments).values({
          id: receiptId,
          actor_user_id: args.actorUserId,
          idempotency_key: args.idempotencyKey,
          wallet_id: wallet.id,
          workspace_id: args.workspaceId,
          delta: args.delta,
          reason: args.reason,
          balance_before: balanceBefore,
          balance_after: balanceAfter,
          reserved: wallet.reserved,
          ledger_entry_id: ledgerEntryId,
          // Bun SQL's unsafe() JSON-encodes STRING params, so Drizzle's jsonb
          // mapping (JSON.stringify → string param) lands as a double-encoded
          // jsonb *string*. Pass the payload as a raw sql fragment param: the
          // driver serializes the object once and Postgres stores a proper
          // jsonb object (asserted by jsonb_typeof in the regression test).
          request_payload: sql`${{
            workspaceId: args.workspaceId,
            delta: args.delta,
            reason: args.reason,
          }}`,
          created_at: createdAt,
        });
        return {
          id: receiptId,
          walletId: wallet.id,
          workspaceId: args.workspaceId,
          delta: args.delta,
          reason: args.reason,
          balanceBefore,
          balanceAfter,
          reserved: wallet.reserved,
          ledgerEntryId,
          createdAt,
          replayed: false,
        };
      },
      { walletId: args.walletId },
    );
  } catch (e) {
    // Lost the (actor, key) race: this transaction's writes are rolled back.
    // Read the committed winner in a FRESH connection context (outside the
    // aborted transaction), then replay or mismatch — never re-apply.
    if (isUniqueViolation(e)) {
      const winner = await readReceipt(db, args.actorUserId, args.idempotencyKey);
      if (winner) {
        assertReplayMatch(winner, args);
        return receiptFromStored(winner, true);
      }
    }
    throw e;
  }
}
