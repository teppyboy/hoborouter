// Admin request-log removal — instance-admin only in every environment.
// SOFT delete: sets requests.deleted_at/deleted_by. No money movement:
// wallet, ledger, payments and financial spend/token totals are unchanged.
import { Elysia, t } from "elysia";
import { type Db, requests as requestsTable } from "@hoborouter/db";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireInstanceAdmin, jsonError, writeAudit } from "../authz";
import { eq } from "drizzle-orm";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export const adminRequestsRoutes = (db: Db, auth: BetterAuthInstance) =>
  new Elysia({ name: "admin-requests" })
    .delete(
      "/api/v1/admin/requests/:id",
      {
        params: t.Object({ id: t.String() }),
        detail: {
          tags: ["Admin"],
          summary: "Remove a usage log (soft delete)",
          description:
            "Hides a request's usage log from customer views. Instance-admin only. Idempotent; no financial data is modified.",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const denied = await requireInstanceAdmin(db, gate.session.user.id);
        if (denied) return denied;
        const row = await db
          .select({ id: requestsTable.id, workspace_id: requestsTable.workspace_id, deleted_at: requestsTable.deleted_at })
          .from(requestsTable)
          .where(eq(requestsTable.id, params.id))
          .limit(1);
        if (!row[0]) return jsonError(404, "NOT_FOUND", "Request not found");
        if (row[0].deleted_at == null) {
          await db
            .update(requestsTable)
            .set({ deleted_at: Date.now(), deleted_by: gate.session.user.id })
            .where(eq(requestsTable.id, params.id));
          await writeAudit(db, {
            actorUserId: gate.session.user.id,
            workspaceId: row[0].workspace_id,
            action: "request.delete",
            target: params.id,
          });
        }
        // Already-deleted: idempotent success, no duplicate audit entry.
        return json({ success: true });
      },
    );
