// Task 9: transaction composition for the mock payment webhook.
// creditWallet opens its own transaction, so this module never nests a second
// transaction: runInImmediate runs inline when already inside one. The whole
// handler runs as ONE transaction: event insert (UNIQUE provider+
// provider_reference) -> creditWallet -> payments.status=succeeded -> COMMIT.
// Replay hits the UNIQUE constraint and is answered 2xx with no second credit;
// any failure rolls back everything.
import { and, eq, ne } from "drizzle-orm";
import type { Db, Tx } from "@hoborouter/db";
import {
  auditLog,
  creditBundles,
  firstTopupBonuses,
  instanceSettings,
  paymentEvents,
  payments,
  wallets,
} from "@hoborouter/db";
import { creditWallet, runInImmediate, WalletError } from "@hoborouter/wallet";
import { isFirstTopupBonusEnabled } from "./bonus-settings";

export type MockPaymentErrorCode =
  | "not_found"
  | "amount_mismatch"
  | "invalid"
  | "already_processed";

export class MockPaymentError extends Error {
  code: MockPaymentErrorCode;
  constructor(code: MockPaymentErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ProcessMockEventArgs {
  /** Provider slug stored on payments.provider; defaults to the legacy 'mock'. */
  provider?: string;
  orderCode: string;
  providerReference: string;
  amount: number;
  rawPayload: string;
}

export type ProcessMockEventResult =
  | { outcome: "credited"; paymentId: string; balanceAfter: number }
  | { outcome: "already_processed"; paymentId: string };

// Fixed adjustment memos — the partial UNIQUE(payment_id, memo) WHERE
// kind='adjustment' index makes replays of each leg impossible; changing a
// memo string would orphan old idempotency keys.
const MEMO_BUNDLE_BONUS = "bundle bonus";
const MEMO_FIRST_TOPUP_BONUS = "first topup bonus";

/**
 * First-topup bonus amount from instance_settings (read inside the credit
 * transaction). D2: enabled defaults to true, amount defaults to 20000;
 * any present-but-invalid value fails closed to no bonus. Returns null when
 * the bonus must not be granted.
 */
async function firstTopupBonusAmountVnd(tx: Tx): Promise<number | null> {
  const rows = await tx
    .select({ key: instanceSettings.key, value: instanceSettings.value })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, "first_topup_bonus_enabled"));
  const enabled = rows[0]?.value;
  if (!isFirstTopupBonusEnabled(enabled)) return null;
  const amountRows = await tx
    .select({ value: instanceSettings.value })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, "first_topup_bonus_amount_vnd"));
  const raw = amountRows[0]?.value;
  if (raw === undefined) return 20_000;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

export async function processMockPaymentEvent(db: Db | Tx, args: ProcessMockEventArgs) {
  const provider = args.provider ?? "mock";
  return runInImmediate(db, async (tx) => {
    const paymentRows = await tx
      .select({
        id: payments.id,
        amount: payments.amount,
        status: payments.status,
        workspace_id: payments.workspace_id,
        bundle_id: payments.bundle_id,
        subscription_plan_id: payments.subscription_plan_id,
      })
      .from(payments)
      .where(
        and(
          eq(payments.provider, provider as "mock"),
          eq(payments.provider_order_code, args.orderCode),
        ),
      )
      // Lock the payment row so concurrent approve/reject/webhook paths
      // serialize on the same row (e.g. admin reject vs admin complete).
      .for("update");
    const payment = paymentRows[0];
    if (!payment) throw new MockPaymentError("not_found", `unknown order ${args.orderCode}`);
    if (payment.status !== "pending" && payment.status !== "succeeded") {
      throw new MockPaymentError("invalid", `payment ${payment.id} is ${payment.status}`);
    }
    // Server-side amount check against the payments row — never trust the event.
    // Applies to succeeded payments too: an exact-duplicate replay must carry
    // the same amount; a changed amount is rejected, never answered 2xx.
    if (
      typeof args.amount !== "number" ||
      !Number.isSafeInteger(args.amount) ||
      args.amount !== payment.amount
    ) {
      throw new MockPaymentError(
        "amount_mismatch",
        `event amount ${args.amount} != order amount ${payment.amount}`,
      );
    }

    // Insert-first: UNIQUE(provider, provider_reference) is the replay gate
    // under transaction serialization. ON CONFLICT DO NOTHING (no error, so
    // the tx stays usable) + empty returning = replay; the follow-up lookup
    // disambiguates replay vs cross-payment reuse. Every other insert
    // failure propagates so the txn rolls back and the provider retries.
    const inserted = await tx
      .insert(paymentEvents)
      .values({
        id: crypto.randomUUID(),
        payment_id: payment.id,
        provider,
        provider_reference: args.providerReference,
        raw_payload: args.rawPayload,
        signature_valid: true,
        processed_at: Date.now(),
      })
      .onConflictDoNothing({
        target: [paymentEvents.provider, paymentEvents.provider_reference],
      })
      .returning({ id: paymentEvents.id });
    if (inserted.length === 0) {
      // Re-read the payment AFTER the conflict: a concurrent txn may have
      // committed the credit since this txn's snapshot was taken.
      const freshRows = await tx
        .select({ status: payments.status })
        .from(payments)
        .where(eq(payments.id, payment.id));
      const freshStatus = freshRows[0]?.status ?? payment.status;
      const existingRows = await tx
        .select({ payment_id: paymentEvents.payment_id })
        .from(paymentEvents)
        .where(
          and(
            eq(paymentEvents.provider, provider),
            eq(paymentEvents.provider_reference, args.providerReference),
          ),
        );
      const existing = existingRows[0];
      if (existing && existing.payment_id !== payment.id) {
        throw new MockPaymentError(
          "invalid",
          `provider_reference ${args.providerReference} already used by payment ${existing.payment_id}`,
        );
      }
      if (existing && freshStatus === "succeeded") {
        return { outcome: "already_processed", paymentId: payment.id } as const;
      }
      if (existing) {
        throw new MockPaymentError(
          "invalid",
          `payment ${payment.id} has an event but is still pending`,
        );
      }
      // Conflict on (provider, provider_reference) must always have a row —
      // unreachable, but fail closed rather than double-crediting.
      throw new MockPaymentError("invalid", "event conflict without existing row");
    }

    if (payment.status === "succeeded") {
      // Succeeded order + distinct reference: reject without a second credit.
      // The event insert above is rolled back with the txn — no unaudited 2xx.
      throw new MockPaymentError(
        "invalid",
        `payment ${payment.id} already succeeded with a different provider reference`,
      );
    }

    // Wallet for the payment's workspace (workspace_id UNIQUE on wallets).
    const walletRows = await tx
      .select({ id: wallets.id })
      .from(wallets)
      .where(eq(wallets.workspace_id, payment.workspace_id));
    const wallet = walletRows[0];
    if (!wallet)
      throw new MockPaymentError("not_found", `no wallet for workspace ${payment.workspace_id}`);

    // Lock the wallet before branching: serializes concurrent subscription
    // create/renew per workspace and keeps all credits in one lock order.
    await tx.select({ id: wallets.id }).from(wallets).where(eq(wallets.id, wallet.id)).for("update");

    const plainMemo = `${provider} topup ${args.providerReference}`;
    let balanceAfter: number;
    if (payment.bundle_id !== null) {
      // Bundle: price paid becomes credit_vnd of topup + an adjustment for the
      // promo bonus, so the ledger stays legible about what was granted vs paid.
      const bundleRows = await tx
        .select({ credit_vnd: creditBundles.credit_vnd, bonus_vnd: creditBundles.bonus_vnd })
        .from(creditBundles)
        .where(eq(creditBundles.id, payment.bundle_id));
      const bundle = bundleRows[0];
      if (!bundle)
        throw new MockPaymentError("invalid", `missing bundle ${payment.bundle_id}`);
      balanceAfter = 0;
      if (bundle.credit_vnd > 0) {
        const topup = await creditWallet(tx, {
          walletId: wallet.id,
          amount: bundle.credit_vnd,
          kind: "topup",
          paymentId: payment.id,
          memo: plainMemo,
        });
        balanceAfter = topup.balanceAfter;
      }
      if (bundle.bonus_vnd > 0) {
        const adj = await creditWallet(tx, {
          walletId: wallet.id,
          amount: bundle.bonus_vnd,
          kind: "adjustment",
          paymentId: payment.id,
          memo: MEMO_BUNDLE_BONUS,
        });
        balanceAfter = adj.balanceAfter;
      }
    } else if (payment.subscription_plan_id !== null) {
      // Owner change: subscription credit moves to a separate rate-limited
      // subscription balance designed later. Until then, plan payments must
      // not touch the main wallet — fail the whole settlement closed.
      throw new MockPaymentError(
        "invalid",
        `subscription settlement not enabled (plan ${payment.subscription_plan_id})`,
      );
    } else {
      // Plain top-up: unchanged settlement path.
      const credit = await creditWallet(tx, {
        walletId: wallet.id,
        amount: payment.amount,
        kind: "topup",
        paymentId: payment.id,
        memo: plainMemo,
      });
      balanceAfter = credit.balanceAfter;
    }

    // First topup bonus (D2): once per workspace, inside this same
    // transaction. The first_topup_bonuses UNIQUE(workspace_id) is the grant
    // gate: its ledger_entry_id FK forces credit-before-gate, so on a
    // concurrent loss the whole transaction rolls back (no bonus credit
    // committed) and the provider retry settles the payment without a bonus.
    const bonusAmount = await firstTopupBonusAmountVnd(tx);
    if (bonusAmount !== null) {
      // Skip when this workspace already has its one grant (committed earlier).
      const existingGrant = await tx
        .select({ ws: firstTopupBonuses.workspace_id })
        .from(firstTopupBonuses)
        .where(eq(firstTopupBonuses.workspace_id, payment.workspace_id));
      // Owner rule: first successful PAID top-up ever. first_topup_bonuses is
      // empty after deploy, so without this check every pre-release workspace
      // would get the bonus on its next top-up. The current payment is still
      // pending here, so count OTHER succeeded payments for the workspace.
      const otherSucceeded = await tx
        .select({ id: payments.id })
        .from(payments)
        .where(
          and(
            eq(payments.workspace_id, payment.workspace_id),
            eq(payments.status, "succeeded"),
            ne(payments.id, payment.id),
          ),
        );
      if (existingGrant.length === 0 && otherSucceeded.length === 0) {
        const adj = await creditWallet(tx, {
          walletId: wallet.id,
          amount: bonusAmount,
          kind: "adjustment",
          paymentId: payment.id,
          memo: MEMO_FIRST_TOPUP_BONUS,
        });
        const granted = await tx
          .insert(firstTopupBonuses)
          .values({
            workspace_id: payment.workspace_id,
            payment_id: payment.id,
            ledger_entry_id: adj.ledgerEntryId,
            amount: bonusAmount,
            created_at: Date.now(),
          })
          .onConflictDoNothing({ target: firstTopupBonuses.workspace_id })
          .returning({ workspace_id: firstTopupBonuses.workspace_id });
        if (granted.length === 0) {
          // Concurrent payment won the grant between our check and insert:
          // roll back so no un-gated bonus credit commits; the provider retry
          // settles this payment cleanly without a bonus.
          throw new MockPaymentError(
            "invalid",
            `first topup bonus already granted for workspace ${payment.workspace_id}`,
          );
        }
        balanceAfter = adj.balanceAfter;
        await tx.insert(auditLog).values({
          id: crypto.randomUUID(),
          workspace_id: payment.workspace_id,
          action: "bonus.first_topup",
          target: payment.id,
          created_at: Date.now(),
        });
      }
    }

    await tx.update(payments).set({ status: "succeeded" }).where(eq(payments.id, payment.id));
    return {
      outcome: "credited",
      paymentId: payment.id,
      balanceAfter: balanceAfter,
    } as const;
  });
}

export { WalletError };
