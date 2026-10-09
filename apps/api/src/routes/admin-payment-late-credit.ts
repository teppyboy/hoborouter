// Admin late-credit: instance-admin-only settlement of an EXPIRED payment
// whose late paid webhook was durably retained as evidence. Exactly-once
// credit through the same idempotent path as webhooks (payment_events UNIQUE
// gate + ledger one-topup-per-payment), with an explicit audited admin action
// (payment.late_credit). Amount and provider reference always come from the
// locked payment row — never from the client. 'rejected' payments are never
// reopened; 'pending' payments go through /complete; 'succeeded' is a no-op.
import { Elysia, t } from "elysia";
import { and, eq } from "drizzle-orm";
import type { Db } from "@hoborouter/db";
import { paymentEvents, payments } from "@hoborouter/db";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireInstanceAdmin, jsonError, writeAudit } from "../authz";
import { MockPaymentError, processMockPaymentEvent } from "@hoborouter/payments";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export const adminPaymentLateCreditRoutes = (db: Db, auth: BetterAuthInstance) =>
  new Elysia({ name: "admin-payment-late-credit" }).post(
    "/api/v1/admin/payments/:id/credit-late",
    {
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Billing"],
        summary: "Credit a timed-out payment with retained late-paid evidence (admin)",
        description:
          "Instance-admin-only. Requires an expired payment with a retained payment event; credits exactly once at the payment's own amount; audited.",
        security: [{ cookieAuth: [] }],
      },
    },
    async ({ request, params }) => {
      // Auth before any write; mirrors the reject/complete guard ordering.
      const gate = await requireSession(auth, request);
      if ("error" in gate) return gate.error;
      const denied = await requireInstanceAdmin(db, gate.session.user.id);
      if (denied) return denied;
      const userId = gate.session.user.id;

      let resp: Response | undefined;
      try {
        await db.transaction(async (tx) => {
          // Lock the payment row first: serializes against the webhook path
          // and a concurrent second credit-late (same lock as
          // processMockPaymentEvent, re-taken harmlessly inside the same tx).
          const rows = await tx
            .select({
              id: payments.id,
              workspace_id: payments.workspace_id,
              amount: payments.amount,
              status: payments.status,
              provider: payments.provider,
              provider_order_code: payments.provider_order_code,
            })
            .from(payments)
            .where(eq(payments.id, params.id))
            .limit(1)
            .for("update");
          const p = rows[0];
          if (!p) {
            resp = jsonError(404, "NOT_FOUND", "Payment not found");
            return;
          }
          const status = String(p.status);
          if (status !== "expired") {
            resp = json(
              {
                error: {
                  code: "INVALID_STATE",
                  message:
                    status === "pending"
                      ? "payment is still pending; use /complete instead"
                      : `payment ${p.id} is ${status}`,
                },
              },
              409,
            );
            return;
          }
          // Evidence gate: the late-paid webhook must have retained a
          // payment event for THIS payment; otherwise there is no verified
          // provider confirmation to credit against.
          const retained = await tx
            .select({ provider_reference: paymentEvents.provider_reference })
            .from(paymentEvents)
            .where(
              and(
                eq(paymentEvents.payment_id, p.id),
                eq(paymentEvents.provider, p.provider),
                eq(paymentEvents.signature_valid, true),
              ),
            )
            .limit(1);
          if (retained.length === 0) {
            resp = json(
              {
                error: {
                  code: "NO_EVIDENCE",
                  message: "no retained late-paid payment event for this payment",
                },
              },
              409,
            );
            return;
          }
          // No inner try/catch here: a rethrow-only catch is a no-op. The
          // Postgres tx is aborted once an error surfaces, so it rolls back
          // (no partial writes) and the outer handler maps MockPaymentError
          // to 409 below; anything else propagates unchanged.
          const result = await processMockPaymentEvent(tx, {
            provider: p.provider,
            orderCode: p.provider_order_code,
            // Fixed reference derived from the payment id: the client can
            // never choose it, and replays are idempotent.
            providerReference: `admin-late-credit-${p.id}`,
            // Amount ALWAYS comes from the locked payment row.
            amount: p.amount,
            rawPayload: JSON.stringify({ source: "admin-late-credit", paymentId: p.id }),
            adminLateCredit: { actorUserId: userId },
          });
          resp = json({ success: true, outcome: result.outcome });
        });
      } catch (err) {
        if (err instanceof MockPaymentError) {
          return json({ error: { code: "INVALID_STATE", message: err.message } }, 409);
        }
        throw err;
      }
      // Audit of the explicit admin review decision (the credit itself is
      // audited inside the credit transaction as payment.late_credit).
      if (resp && resp.status === 200) {
        await writeAudit(db, {
          actorUserId: userId,
          workspaceId: null,
          action: "payment.admin_late_credit_review",
          target: params.id,
        });
      }
      return resp!;
    },
  );
