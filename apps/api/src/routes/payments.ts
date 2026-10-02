// Task 9: payments routes (member+, workspace-scoped) + manual top-up creation.
// Manual payments are admin-approved: creation is always available (no env
// gate); completion happens via the instance-admin complete endpoint. The
// legacy signed mock webhook stays for pre-existing 'mock' provider rows and
// is never routed for new 'manual' rows.
import { Elysia, t } from "elysia";
import type { Db } from "@hoborouter/db";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireWsRole, writeAudit, jsonError } from "../authz";
import { requirePositiveSafeInteger } from "@hoborouter/wallet";
import { eq } from "drizzle-orm";
import { workspaces, payments } from "@hoborouter/db";

export const paymentsRoutes = (db: Db, auth: BetterAuthInstance) =>
  new Elysia({ name: "payments" })
    .post(
      "/api/v1/workspaces/:id/payments",
      {
        params: t.Object({ id: t.String() }),
        body: t.Optional(t.Object({ amount: t.Optional(t.Number()) })),
        response: t.Object({
          id: t.String(),
          amount: t.Number(),
          status: t.String(),
          provider: t.String(),
          provider_order_code: t.String(),
          checkout_url: t.String(),
        }),
        detail: {
          tags: ["Payments"],
          summary: "Create manual payment",
          description:
            "Create a pending manual top-up; completed only by an instance admin (out-of-band payment confirmation).",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => {
        const gate = await requireSession(auth, request);
        if (gate.error) return gate.error;
        const userId = gate.session.user.id;
        const denied = await requireWsRole(db, params.id, userId, "member");
        if (denied) return denied;
        const wsRows = await db
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, params.id))
          .limit(1);
        if (!wsRows[0]) return jsonError(404, "NOT_FOUND", "Workspace not found");
        const raw = (body as { amount?: unknown } | null)?.amount;
        let amount: number;
        try {
          amount = requirePositiveSafeInteger("amount", raw);
        } catch {
          return jsonError(400, "INVALID", "amount must be a positive integer VND amount");
        }
        const id = crypto.randomUUID();
        const orderCode = `MANUAL-${id}`;
        const now = Date.now();
        await db.transaction(async (tx) => {
          await tx.insert(payments).values({
            id,
            workspace_id: params.id,
            amount,
            status: "pending",
            provider: "manual",
            provider_order_code: orderCode,
            created_at: now,
          });
          await writeAudit(tx, {
            actorUserId: userId,
            workspaceId: params.id,
            action: "payment.create",
            target: id,
            detail: { amount, provider: "manual" },
          });
        });
        // No provider checkout: admin approval happens out-of-band; the
        // member tracks status in the billing UI.
        return new Response(
          JSON.stringify({
            id,
            amount,
            status: "pending",
            provider: "manual",
            provider_order_code: orderCode,
            checkout_url: `/billing/payments?payment=${id}`,
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      },
    )
    .get(
      "/api/v1/workspaces/:id/payments/:paymentId",
      {
        params: t.Object({ id: t.String(), paymentId: t.String() }),
        detail: {
          tags: ["Payments"],
          summary: "Get payment",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
        const gate = await requireSession(auth, request);
        if (gate.error) return gate.error;
        const userId = gate.session.user.id;
        const denied = await requireWsRole(db, params.id, userId, "member");
        if (denied) return denied;
        const rows = await db
          .select({ workspace_id: payments.workspace_id })
          .from(payments)
          .where(eq(payments.id, params.paymentId))
          .limit(1);
        const row = rows[0];
        if (!row) return jsonError(404, "NOT_FOUND", "Payment not found");
        if (row.workspace_id !== params.id)
          return jsonError(403, "FORBIDDEN", "Payment belongs to another workspace");
        const paymentRows = await db
          .select({
            id: payments.id,
            workspace_id: payments.workspace_id,
            amount: payments.amount,
            status: payments.status,
            provider: payments.provider,
            provider_order_code: payments.provider_order_code,
            created_at: payments.created_at,
          })
          .from(payments)
          .where(eq(payments.id, params.paymentId))
          .limit(1);
        return new Response(JSON.stringify(paymentRows[0]), {
          headers: { "content-type": "application/json" },
        });
      },
    );
