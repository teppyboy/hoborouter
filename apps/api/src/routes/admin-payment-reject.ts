// Admin payment reject: instance-admin-only cancellation of a pending manual
// payment. No wallet/ledger/event writes — this never credits or debits money;
// it only flips status pending -> rejected and writes one audit row, all in
// the same transaction as the row lock. The payment row SELECT FOR UPDATE
// serializes against approve (processMockPaymentEvent locks the same row), so
// a concurrent reject + complete lets exactly one win.
import { Elysia, t } from "elysia";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@hoborouter/db";
import { payments } from "@hoborouter/db";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireInstanceAdmin, jsonError, writeAudit } from "../authz";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export const adminPaymentRejectRoutes = (db: Db, auth: BetterAuthInstance) =>
  new Elysia({ name: "admin-payment-reject" }).post(
    "/api/v1/admin/payments/:id/reject",
    {
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Billing"],
        summary: "Reject pending payment (admin)",
        description:
          "Instance-admin-only. Idempotent on already-rejected payments; no money movement.",
        security: [{ cookieAuth: [] }],
      },
    },
    async ({ request, params }) => {
      // Auth before any write; mirrors admin-extra guard ordering.
      const gate = await requireSession(auth, request);
      if ("error" in gate) return gate.error;
      const denied = await requireInstanceAdmin(db, gate.session.user.id);
      if (denied) return denied;
      const userId = gate.session.user.id;

      let resp: Response | undefined;
      await db.transaction(async (tx) => {
        const rows = await tx
          .select({
            id: payments.id,
            workspace_id: payments.workspace_id,
            status: payments.status,
          })
          .from(payments)
          .where(eq(payments.id, params.id))
          .limit(1)
          // Same lock processMockPaymentEvent takes: approve/reject serialize.
          .for("update");
        const p = rows[0];
        if (!p) {
          resp = jsonError(404, "NOT_FOUND", "Payment not found");
          return;
        }
        // Runtime statuses exceed the TS enum (cancelled exists too); compare
        // as string. Status is TEXT with no DB CHECK, so 'rejected' needs no
        // migration.
        const status = String(p.status);
        if (status === "rejected") {
          // Idempotent replay: no duplicate audit.
          resp = json({ success: true });
          return;
        }
        if (status !== "pending") {
          resp = jsonError(409, "INVALID_STATE", `payment ${p.id} is ${status}`);
          return;
        }
        await tx.execute(sql`update payments set status = 'rejected' where id = ${p.id}`);
        await writeAudit(tx, {
          actorUserId: userId,
          workspaceId: p.workspace_id,
          action: "payment.admin_reject",
          target: p.id,
        });
        resp = json({ success: true });
      });
      return resp!;
    },
  );
