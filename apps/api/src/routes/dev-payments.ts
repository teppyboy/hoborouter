// Task 4: POST /api/dev/payments/:id/complete — dev/demo-only completion.
// Gated: NODE_ENV !== 'production' AND HBR_DEV_PAYMENTS === '1'; otherwise 404.
// Instance admin or workspace owner. Credits through the same idempotent
// payment_events path used by webhooks (one top-up per payment).
import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, isInstanceAdmin, wsRole, writeAudit, jsonError } from "../authz";
import { MockPaymentError, processMockPaymentEvent } from "@hoborouter/payments";

export const devPaymentsRoutes = (db: Database, auth: BetterAuthInstance) =>
  new Elysia({ name: "dev-payments" }).post(
    "/api/dev/payments/:id/complete",
    async ({ request, params }) => {
      if (process.env.NODE_ENV === "production" || process.env.HBR_DEV_PAYMENTS !== "1") {
        return jsonError(404, "NOT_FOUND", "Not found");
      }
      const gate = await requireSession(auth, request);
      if ("error" in gate) return gate.error;
      const userId = gate.session.user.id;
      const payment = db
        .prepare(
          "SELECT id, workspace_id, amount, status, provider, provider_order_code FROM payments WHERE id = ?",
        )
        .get(params.id) as
        | {
            id: string;
            workspace_id: string;
            amount: number;
            status: string;
            provider: string;
            provider_order_code: string;
          }
        | undefined;
      if (!payment) return jsonError(404, "NOT_FOUND", "Payment not found");
      const isAdmin = isInstanceAdmin(db, userId);
      if (!isAdmin && wsRole(db, payment.workspace_id, userId) !== "owner") {
        return jsonError(403, "FORBIDDEN", "Instance admin or workspace owner required");
      }
      try {
        const result = processMockPaymentEvent(db, {
          provider: payment.provider,
          orderCode: payment.provider_order_code,
          // Fixed reference per payment: replays are idempotent (already_processed).
          providerReference: `dev-complete-${payment.id}`,
          amount: payment.amount,
          rawPayload: JSON.stringify({ source: "dev-complete", paymentId: payment.id }),
        });
        writeAudit(db, {
          actorUserId: userId,
          workspaceId: payment.workspace_id,
          action: "payment.dev_complete",
          target: payment.id,
          detail: { outcome: result.outcome },
        });
        return new Response(JSON.stringify({ success: true, outcome: result.outcome }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        if (err instanceof MockPaymentError && err.code === "not_found") {
          return jsonError(404, "NOT_FOUND", err.message);
        }
        throw err;
      }
    },
  );
