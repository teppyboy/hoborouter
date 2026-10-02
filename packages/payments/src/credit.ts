// Task 9: transaction composition for the mock payment webhook.
// creditWallet opens its own transaction, so this module never nests a second
// transaction: runInImmediate runs inline when already inside one. The whole
// handler runs as ONE transaction: event insert (UNIQUE provider+
// provider_reference) -> creditWallet -> payments.status=succeeded -> COMMIT.
// Replay hits the UNIQUE constraint and is answered 2xx with no second credit;
// any failure rolls back everything.
import { and, eq } from "drizzle-orm";
import type { Db, Tx } from "@hoborouter/db";
import { paymentEvents, payments, wallets } from "@hoborouter/db";
import { creditWallet, runInImmediate, WalletError } from "@hoborouter/wallet";

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

export async function processMockPaymentEvent(db: Db | Tx, args: ProcessMockEventArgs) {
  const provider = args.provider ?? "mock";
  return runInImmediate(db, async (tx) => {
    const paymentRows = await tx
      .select({
        id: payments.id,
        amount: payments.amount,
        status: payments.status,
        workspace_id: payments.workspace_id,
      })
      .from(payments)
      .where(
        and(
          eq(payments.provider, provider as "mock"),
          eq(payments.provider_order_code, args.orderCode),
        ),
      );
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

    const credit = await creditWallet(tx, {
      walletId: wallet.id,
      amount: payment.amount,
      kind: "topup",
      paymentId: payment.id,
      memo: `${provider} topup ${args.providerReference}`,
    });

    await tx.update(payments).set({ status: "succeeded" }).where(eq(payments.id, payment.id));
    return {
      outcome: "credited",
      paymentId: payment.id,
      balanceAfter: credit.balanceAfter,
    } as const;
  });
}

export { WalletError };
