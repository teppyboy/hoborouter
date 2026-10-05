// In-process payment expiry sweep (owner decision): timed-out payments use
// the existing 'expired' status. Bounded FOR UPDATE SKIP LOCKED scan so
// concurrent API instances never block each other or double-mark a payment;
// each sweep commits pending -> expired with one payment.timeout_reject audit
// row per payment in a single transaction. Never touches 'rejected' (never
// reopened) or payments without an expires_at snapshot.
import { and, asc, eq, isNotNull, lte } from "drizzle-orm";
import type { Db } from "@hoborouter/db";
import { auditLog, payments } from "@hoborouter/db";

export const PAYMENT_EXPIRY_SWEEP_INTERVAL_MS = 30_000;
const DEFAULT_BATCH = 200;

export async function sweepExpiredPayments(
  db: Db,
  nowMs: number = Date.now(),
  limit: number = DEFAULT_BATCH,
): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: payments.id,
        workspace_id: payments.workspace_id,
        provider: payments.provider,
        expires_at: payments.expires_at,
      })
      .from(payments)
      .where(
        and(
          eq(payments.status, "pending"),
          isNotNull(payments.expires_at),
          lte(payments.expires_at, nowMs),
        ),
      )
      .orderBy(asc(payments.expires_at))
      .limit(limit)
      .for("update", { skipLocked: true });
    for (const row of rows) {
      await tx
        .update(payments)
        .set({ status: "expired" })
        .where(and(eq(payments.id, row.id), eq(payments.status, "pending")));
      await tx.insert(auditLog).values({
        id: crypto.randomUUID(),
        actor_user_id: null,
        workspace_id: row.workspace_id,
        action: "payment.timeout_reject",
        target: row.id,
        detail: { provider: row.provider, expires_at: row.expires_at },
        created_at: nowMs,
      });
    }
    return rows.length;
  });
}

/**
 * Start the sweep loop: one immediate run, then every 30s. Returns a stop
 * function that clears the interval (and never throws after stop). Wired in
 * production boot (src/index.ts) only, so tests never hold timers.
 */
export function startPaymentExpirySweep(db: Db, intervalMs = PAYMENT_EXPIRY_SWEEP_INTERVAL_MS) {
  let stopped = false;
  const run = async () => {
    if (stopped) return;
    try {
      await sweepExpiredPayments(db);
    } catch (err) {
      // Sweep failure must never crash the server; the next tick retries.
      console.error("[hoborouter] payment expiry sweep failed", err);
    }
  };
  const timer = setInterval(run, intervalMs);
  void run();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
