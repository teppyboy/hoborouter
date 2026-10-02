// Task 4: POST /api/dev/payments/:id/complete — dev/demo-only completion.
// Gated by explicit allowlist: HBR_DEV_PAYMENTS === '1' AND NODE_ENV is
// 'development' or 'test'; otherwise 404. NODE_ENV unset (e.g. non-Docker
// prod deploy) must NOT enable this.
// Instance admin or workspace owner. Credits through the same idempotent
// payment_events path used by webhooks (one top-up per payment).
import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, isInstanceAdmin, wsRole, writeAudit, jsonError } from "../authz";
import { MockPaymentError, processMockPaymentEvent } from "@hoborouter/payments";
import { eq } from "drizzle-orm";
import { payments, orm } from "@hoborouter/db";

export const devPaymentsRoutes = (db: Database, auth: BetterAuthInstance) =>
  new Elysia({ name: "dev-payments" }).post(
    "/api/v1/dev/payments/:id/complete",
    {
      params: t.Object({ id: t.String() }),
      response: t.Object({ success: t.Boolean(), outcome: t.String() }),
      detail: {
        tags: ["Payments"],
        summary: "Complete mock payment (dev only)",
        description:
          "Dev/demo-only completion; requires NODE_ENV=development (or test) and HBR_DEV_PAYMENTS=1, instance admin or workspace owner.",
        security: [{ cookieAuth: [] }],
      },
    },
    async ({ request, params }) => {
      const env = process.env.NODE_ENV;
      if (process.env.HBR_DEV_PAYMENTS !== "1" || (env !== "development" && env !== "test")) {
        return jsonError(404, "NOT_FOUND", "Not found");
      }
      const gate = await requireSession(auth, request);
      if (gate.error) return gate.error;
      const userId = gate.session.user.id;
      const payment = orm(db)
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
        .get();
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
