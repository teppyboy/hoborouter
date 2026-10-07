// Prepaid throughput allowance lifecycle transitions. The gateway gates on
// status='active' rows whose [starts_at, ends_at) window contains now, but
// windows move forward in wall-clock time without a scheduler: expiry and
// promotion are applied lazily by every caller that reads or extends
// allowance state (gateway admission, status endpoint, settlement chaining).
//
// Wording contract: an allowance is a gateway admission limit — never a
// provider-capacity guarantee or a priority promise.
import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { Db, Tx } from "@hoborouter/db";
import { throughputAllowances } from "@hoborouter/db";

/**
 * Lazy transitions for one workspace, iterated to a fixed point (windows are
 * chained and ordered, so each pass either resolves one row or is done):
 *  1. Expire lapsed 'active' windows (ends_at <= now) -> 'expired'.
 *  2. Promote the earliest 'scheduled' window whose starts_at <= now ->
 *     'active', only when no 'active' row exists. The
 *     one-active-per-workspace partial unique index is the storage-level
 *     backstop against concurrent promotion races.
 * After the loop, at most one 'active' row remains and its window contains
 * now or is still in the future — exactly what gateway admission gates on.
 *
 * Callers that cannot tolerate a lost race (gateway hot path) catch errors
 * and skip; the stored state stays consistent and the next call retries.
 */
export async function transitionThroughputAllowances(
  db: Db | Tx,
  workspaceId: string,
  now: number,
): Promise<void> {
  // Each iteration resolves at least one row; purchases per workspace are
  // bounded by real money spent, so a small fixed bound is safe.
  for (let i = 0; i < 8; i++) {
    const expired = await db
      .update(throughputAllowances)
      .set({ status: "expired" })
      .where(
        and(
          eq(throughputAllowances.workspace_id, workspaceId),
          eq(throughputAllowances.status, "active"),
          lte(throughputAllowances.ends_at, now),
        ),
      )
      .returning({ id: throughputAllowances.id });
    const next = await db
      .select({ id: throughputAllowances.id })
      .from(throughputAllowances)
      .where(
        and(
          eq(throughputAllowances.workspace_id, workspaceId),
          eq(throughputAllowances.status, "scheduled"),
          lte(throughputAllowances.starts_at, now),
        ),
      )
      .orderBy(asc(throughputAllowances.starts_at))
      .limit(1)
      .for("update", { skipLocked: true });
    if (next.length === 0) {
      if (expired.length === 0) return;
      continue;
    }
    const promoted = await db
      .update(throughputAllowances)
      .set({ status: "active" })
      .where(
        and(
          eq(throughputAllowances.id, next[0]!.id),
          // Guard against a concurrent transition having activated another
          // row between the select and this update.
          sql`NOT EXISTS (SELECT 1 FROM throughput_allowances a WHERE a.workspace_id = ${workspaceId} AND a.status = 'active')`,
        ),
      )
      .returning({ id: throughputAllowances.id });
    if (promoted.length === 0) return;
  }
}
