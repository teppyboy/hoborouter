// Subscription wallet + expiry (O5) — lazy, transactional helpers shared by
// the funding selector (billing.ts) and plan settlement (payments/credit.ts).
// All money is integer VND; ledger is append-only; expired credit is forfeited
// via an adjustment debit, never by deleting rows.
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import type { Tx } from "@hoborouter/db";
import {
  auditLog,
  ledgerEntries,
  subscriptionExpiries,
  subscriptions,
  wallets,
} from "@hoborouter/db";
import { lockWallet, overflowCheckedAdd, WalletError } from "./wallet";

export const MEMO_SUBSCRIPTION_EXPIRED = "subscription expired";
const DAY_MS = 86_400_000;

export type SubscriptionRow = {
  id: string;
  plan_id: string;
  status: "active" | "canceled";
  // Cancellation marker (decision b): set when the member cancels; the row
  // keeps status 'active' and its credit stays spendable through period end.
  canceled_at: number | null;
  current_period_start: number;
  current_period_end: number;
};

export type WalletRow = {
  id: string;
  balance: number;
  reserved: number;
  version: number;
};

/**
 * The workspace's subscription wallet row, or null when it has never been
 * created (created lazily at first plan settlement).
 */
export async function getSubscriptionWallet(
  tx: Tx,
  workspaceId: string,
): Promise<WalletRow | null> {
  const rows = await tx
    .select({
      id: wallets.id,
      balance: wallets.balance,
      reserved: wallets.reserved,
      version: wallets.version,
    })
    .from(wallets)
    .where(and(eq(wallets.workspace_id, workspaceId), eq(wallets.kind, "subscription")));
  return rows[0] ?? null;
}

/**
 * Lazily create the subscription wallet (UNIQUE(workspace_id, kind) upsert)
 * and return it locked FOR UPDATE with a post-lock re-read, so the returned
 * balance/reserved reflect the committed state after any concurrent txn that
 * held the lock (e.g. a renewal) has committed.
 */
export async function ensureSubscriptionWallet(
  tx: Tx,
  workspaceId: string,
  now: number,
): Promise<WalletRow> {
  await tx
    .insert(wallets)
    .values({
      id: crypto.randomUUID(),
      workspace_id: workspaceId,
      kind: "subscription",
      balance: 0,
      reserved: 0,
      version: 0,
      created_at: now,
    })
    .onConflictDoNothing({ target: [wallets.workspace_id, wallets.kind] });
  const wallet = await getSubscriptionWallet(tx, workspaceId);
  if (!wallet) {
    throw new WalletError("not_found", `subscription wallet missing for workspace ${workspaceId}`);
  }
  await lockWallet(tx, wallet.id);
  // Re-read AFTER the lock: the pre-lock read may be stale.
  const fresh = await getSubscriptionWallet(tx, workspaceId);
  if (!fresh) {
    throw new WalletError("not_found", `subscription wallet missing for workspace ${workspaceId}`);
  }
  return fresh;
}

/**
 * The workspace's active subscription that has NOT ended yet (O3 "active,
 * unexpired"), or null. An expired period keeps status 'active' — expiry is
 * purely period-based so the one-active-per-workspace index and row history
 * are preserved.
 */
export async function getActiveUnexpiredSubscription(
  tx: Tx,
  workspaceId: string,
  now: number,
): Promise<SubscriptionRow | null> {
  const rows = await tx
    .select({
      id: subscriptions.id,
      plan_id: subscriptions.plan_id,
      status: subscriptions.status,
      canceled_at: subscriptions.canceled_at,
      current_period_start: subscriptions.current_period_start,
      current_period_end: subscriptions.current_period_end,
    })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.workspace_id, workspaceId),
        eq(subscriptions.status, "active"),
        gt(subscriptions.current_period_end, now),
      ),
    );
  return rows[0] ?? null;
}

export type CanceledSubscription = {
  id: string;
  canceled_at: number;
  current_period_end: number;
};

/**
 * Member cancel (decision b): stops renewal ONLY. The row keeps status
 * 'active' (so the one-active index, gateway funding and lazy expiry are
 * untouched) and the credit stays spendable through current_period_end;
 * the normal lazy expiry then forfeits the leftover exactly as for an
 * uncanceled subscription. No wallet or ledger mutation here — cancel moves
 * no money. Idempotent: repeats return the first cancel marker without a
 * second audit row. Null when the workspace has no active subscription.
 */
export async function cancelSubscription(
  tx: Tx,
  workspaceId: string,
  now: number,
): Promise<CanceledSubscription | null> {
  const rows = await tx
    .select({
      id: subscriptions.id,
      canceled_at: subscriptions.canceled_at,
      current_period_end: subscriptions.current_period_end,
    })
    .from(subscriptions)
    .where(and(eq(subscriptions.workspace_id, workspaceId), eq(subscriptions.status, "active")));
  const existing = rows[0];
  if (!existing) return null;
  if (existing.canceled_at !== null) {
    return {
      id: existing.id,
      canceled_at: existing.canceled_at,
      current_period_end: existing.current_period_end,
    };
  }
  const cas = await tx
    .update(subscriptions)
    .set({ canceled_at: now })
    .where(and(eq(subscriptions.id, existing.id), isNull(subscriptions.canceled_at)))
    .returning({ id: subscriptions.id });
  if (cas.length !== 1) {
    // A concurrent cancel won the CAS; its marker is the same decision, so
    // re-read instead of failing the (idempotent) request.
    const fresh = await tx
      .select({
        id: subscriptions.id,
        canceled_at: subscriptions.canceled_at,
        current_period_end: subscriptions.current_period_end,
      })
      .from(subscriptions)
      .where(eq(subscriptions.id, existing.id));
    const cur = fresh[0];
    if (!cur || cur.canceled_at === null) {
      throw new WalletError(
        "conflict",
        `subscription ${existing.id} changed concurrently during cancel`,
      );
    }
    return {
      id: cur.id,
      canceled_at: cur.canceled_at,
      current_period_end: cur.current_period_end,
    };
  }
  await tx.insert(auditLog).values({
    id: crypto.randomUUID(),
    workspace_id: workspaceId,
    action: "subscription.cancel",
    target: existing.id,
    detail: { periodEnd: existing.current_period_end },
    created_at: now,
  });
  return {
    id: existing.id,
    canceled_at: now,
    current_period_end: existing.current_period_end,
  };
}

/**
 * Renew/resume (undoes the cancel marker): clears canceled_at on the active
 * subscription so it re-enters the normal renewal path. Renewal itself is
 * payment-driven (plan settlement), so this moves NO money — no credit, no
 * refund, no new charge; the period end and expiry behavior are untouched.
 * Idempotent: repeating on an already-renewed row returns it unchanged with
 * no extra audit row. Null when the workspace has no active subscription.
 */
export async function resumeSubscription(
  tx: Tx,
  workspaceId: string,
  now: number,
): Promise<{ id: string; current_period_end: number } | null> {
  const rows = await tx
    .select({
      id: subscriptions.id,
      canceled_at: subscriptions.canceled_at,
      current_period_end: subscriptions.current_period_end,
    })
    .from(subscriptions)
    .where(and(eq(subscriptions.workspace_id, workspaceId), eq(subscriptions.status, "active")));
  const existing = rows[0];
  if (!existing) return null;
  if (existing.canceled_at === null) {
    return { id: existing.id, current_period_end: existing.current_period_end };
  }
  const cas = await tx
    .update(subscriptions)
    .set({ canceled_at: null })
    .where(
      and(eq(subscriptions.id, existing.id), eq(subscriptions.canceled_at, existing.canceled_at)),
    )
    .returning({ id: subscriptions.id });
  if (cas.length !== 1) {
    // A concurrent resume won the CAS; the marker is cleared either way, so
    // re-read instead of failing the (idempotent) request.
    const fresh = await tx
      .select({
        id: subscriptions.id,
        canceled_at: subscriptions.canceled_at,
        current_period_end: subscriptions.current_period_end,
      })
      .from(subscriptions)
      .where(eq(subscriptions.id, existing.id));
    const cur = fresh[0];
    if (!cur || cur.canceled_at !== null) {
      throw new WalletError(
        "conflict",
        `subscription ${existing.id} changed concurrently during resume`,
      );
    }
    return { id: cur.id, current_period_end: cur.current_period_end };
  }
  await tx.insert(auditLog).values({
    id: crypto.randomUUID(),
    workspace_id: workspaceId,
    action: "subscription.renew",
    target: existing.id,
    detail: { periodEnd: existing.current_period_end },
    created_at: now,
  });
  return { id: existing.id, current_period_end: existing.current_period_end };
}

/**
 * O5 lazy expiry: while the active subscription's period has ended, forfeit
 * the currently available credit (balance - reserved) with an adjustment debit
 * memo 'subscription expired' on the subscription wallet.
 *
 * The subscription_expiries gate row records the FIRST forfeit of a period
 * (its PK is (subscription_id, period_end)); it is a record, not a one-shot
 * switch: credit that was RESERVED at expiry (an in-flight request hold) must
 * still be forfeited once the hold later releases or settles, so expiry is
 * re-applied on every touch and forfeits whatever is available at that time.
 * Idempotency comes from the wallet lock plus the post-lock re-read: repeat
 * and concurrent applicants serialize and each sees the already-reduced
 * balance, so total forfeited per period is exactly the credit that was
 * available (including freed holds) and never a cent more. The period is
 * revalidated AFTER the lock so an expiry that raced a renewal is a no-op.
 * Returns the forfeited amount (0 when nothing was due).
 */
export async function applySubscriptionExpiry(
  tx: Tx,
  workspaceId: string,
  now: number,
): Promise<number> {
  const subRows = await tx
    .select({
      id: subscriptions.id,
      status: subscriptions.status,
      current_period_end: subscriptions.current_period_end,
    })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.workspace_id, workspaceId),
        eq(subscriptions.status, "active"),
        lte(subscriptions.current_period_end, now),
      ),
    );
  const sub = subRows[0];
  if (!sub) return 0;
  const wallet = await getSubscriptionWallet(tx, workspaceId);
  if (!wallet) return 0;
  await lockWallet(tx, wallet.id);
  // Revalidate the period AFTER the lock: a concurrent renewal holds the same
  // wallet lock first, so if it committed while we waited the period is now
  // unexpired and nothing may be forfeited.
  const freshSub = await tx
    .select({ status: subscriptions.status, end: subscriptions.current_period_end })
    .from(subscriptions)
    .where(eq(subscriptions.id, sub.id));
  const current = freshSub[0];
  if (!current || current.status !== "active" || current.end > now) return 0;
  const fresh = await getSubscriptionWallet(tx, workspaceId);
  if (!fresh) return 0;
  const forfeit = fresh.balance - fresh.reserved;
  if (forfeit > 0) {
    const balanceAfter = fresh.balance - forfeit;
    const cas = await tx
      .update(wallets)
      .set({ balance: balanceAfter, version: overflowCheckedAdd("version", fresh.version, 1) })
      .where(
        and(
          eq(wallets.id, fresh.id),
          eq(wallets.balance, fresh.balance),
          eq(wallets.version, fresh.version),
        ),
      )
      .returning({ id: wallets.id });
    if (cas.length !== 1) {
      throw new WalletError(
        "conflict",
        `wallet ${fresh.id} concurrent modification during subscription expiry`,
      );
    }
    const ledgerEntryId = crypto.randomUUID();
    await tx.insert(ledgerEntries).values({
      id: ledgerEntryId,
      wallet_id: fresh.id,
      direction: "debit",
      amount: forfeit,
      kind: "adjustment",
      balance_after: balanceAfter,
      memo: MEMO_SUBSCRIPTION_EXPIRED,
      created_at: now,
    });
    // Record the first forfeit of this period in the gate table (references
    // the ledger entry: insert order enforces forfeit-before-gate so a failed
    // gate insert rolls the debit back). Later forfeits of credit freed by a
    // release/settle after expiry are real new debit events, not replays.
    const gate = await tx
      .select({ x: subscriptionExpiries.subscription_id })
      .from(subscriptionExpiries)
      .where(
        and(
          eq(subscriptionExpiries.subscription_id, sub.id),
          eq(subscriptionExpiries.period_end, current.end),
        ),
      );
    if (gate.length === 0) {
      await tx.insert(subscriptionExpiries).values({
        subscription_id: sub.id,
        period_end: current.end,
        ledger_entry_id: ledgerEntryId,
        created_at: now,
      });
    }
    // One audit row per forfeit event, same transaction as the debit: zero
    // forfeits write nothing (and repeats forfeit nothing, so no extra rows).
    await tx.insert(auditLog).values({
      id: crypto.randomUUID(),
      workspace_id: workspaceId,
      action: "subscription.expire",
      target: sub.id,
      detail: {
        periodEnd: current.end,
        walletId: fresh.id,
        amount: forfeit,
        ledgerEntryId,
      },
      created_at: now,
    });
  }
  return forfeit;
}

/**
 * Renewal per O5: renewal BEFORE period end keeps leftover credit and extends
 * from period end; renewal AFTER expiry starts a fresh period from now (the
 * caller must have applied lazy expiry first, which forfeits the leftover).
 * With no existing subscription this creates one starting now. Returns the
 * resulting period end.
 */
export async function extendOrCreateSubscription(
  tx: Tx,
  workspaceId: string,
  planId: string,
  periodDays: number,
  now: number,
): Promise<number> {
  const periodMs = periodDays * DAY_MS;
  if (periodDays < 1) {
    throw new WalletError("invalid", `periodDays must be >= 1, got ${periodDays}`);
  }
  const rows = await tx
    .select({
      id: subscriptions.id,
      current_period_start: subscriptions.current_period_start,
      current_period_end: subscriptions.current_period_end,
    })
    .from(subscriptions)
    .where(and(eq(subscriptions.workspace_id, workspaceId), eq(subscriptions.status, "active")));
  const existing = rows[0];
  if (!existing) {
    await tx.insert(subscriptions).values({
      id: crypto.randomUUID(),
      workspace_id: workspaceId,
      plan_id: planId,
      status: "active",
      current_period_start: now,
      current_period_end: now + periodMs,
      created_at: now,
    });
    return now + periodMs;
  }
  // Renewal before period end: extend from period end (leftover credit kept).
  // plan_id is updated in the SAME CAS so the row the gateway/display join on
  // always reflects the plan whose credit and rate limit are now in force.
  const renewFrom = Math.max(now, existing.current_period_end);
  const newEnd = renewFrom + periodMs;
  const cas = await tx
    .update(subscriptions)
    .set({ plan_id: planId, current_period_start: renewFrom, current_period_end: newEnd })
    .where(
      and(
        eq(subscriptions.id, existing.id),
        eq(subscriptions.current_period_end, existing.current_period_end),
      ),
    )
    .returning({ id: subscriptions.id });
  if (cas.length !== 1) {
    throw new WalletError(
      "conflict",
      `subscription ${existing.id} changed concurrently during renewal`,
    );
  }
  return newEnd;
}
