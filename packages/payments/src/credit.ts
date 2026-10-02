// Task 9: transaction composition for the mock payment webhook.
// creditWallet opens its own BEGIN IMMEDIATE, so this module never nests a
// second transaction: runInImmediate (from wallet) no-ops the inner BEGIN
// when already inside one. The whole handler runs as ONE BEGIN IMMEDIATE:
// event insert (UNIQUE provider+provider_reference) -> creditWallet ->
// payments.status=succeeded -> COMMIT. Replay hits the UNIQUE constraint and
// is answered 2xx with no second credit; any failure rolls back everything.
import type { Database } from "bun:sqlite";
import { and, eq, sql } from "drizzle-orm";
import { orm, paymentEvents, payments, wallets } from "@hoborouter/db";
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

/** Process one verified mock webhook event atomically; idempotent on replay. */
export function processMockPaymentEvent(db: Database, args: ProcessMockEventArgs) {
  const provider = args.provider ?? "mock";
  return runInImmediate(db, () => {
    const payment = orm(db)
      .select({ id: payments.id, amount: payments.amount, status: payments.status, workspace_id: payments.workspace_id })
      .from(payments)
      .where(and(sql`${payments.provider} = ${provider}`, eq(payments.provider_order_code, args.orderCode)))
      .get();
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
    // under BEGIN IMMEDIATE serialization. ONLY the UNIQUE constraint resolves
    // to already_processed / cross-payment 400 — every other insert failure
    // propagates so the txn rolls back and the provider retries.
    try {
      orm(db)
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
        .run();
    } catch (err) {
      if ((err as { code?: string })?.code !== "SQLITE_CONSTRAINT_UNIQUE") throw err;
      const existing = orm(db)
        .select({ payment_id: paymentEvents.payment_id })
        .from(paymentEvents)
        .where(
          and(
            sql`${paymentEvents.provider} = ${provider}`,
            eq(paymentEvents.provider_reference, args.providerReference),
          ),
        )
        .get();
      if (existing && existing.payment_id !== payment.id) {
        throw new MockPaymentError(
          "invalid",
          `provider_reference ${args.providerReference} already used by payment ${existing.payment_id}`,
        );
      }
      if (existing && payment.status === "succeeded") {
        return { outcome: "already_processed", paymentId: payment.id } as const;
      }
      if (existing) {
        throw new MockPaymentError(
          "invalid",
          `payment ${payment.id} has an event but is still pending`,
        );
      }
      throw err; // UNIQUE hit with no matching row: propagate, don't mask.
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
    const wallet = orm(db)
      .select({ id: wallets.id })
      .from(wallets)
      .where(eq(wallets.workspace_id, payment.workspace_id))
      .get();
    if (!wallet)
      throw new MockPaymentError("not_found", `no wallet for workspace ${payment.workspace_id}`);

    const credit = creditWallet(db, {
      walletId: wallet.id,
      amount: payment.amount,
      kind: "topup",
      paymentId: payment.id,
      memo: `${provider} topup ${args.providerReference}`,
    });

    orm(db).update(payments).set({ status: "succeeded" }).where(eq(payments.id, payment.id)).run();
    return {
      outcome: "credited",
      paymentId: payment.id,
      balanceAfter: credit.balanceAfter,
    } as const;
  });
}

export { WalletError };
