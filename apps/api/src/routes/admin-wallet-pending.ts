// Bounded pending-billing inspection for the admin UI (read-only):
// GET /api/v1/admin/workspaces/:workspaceId/pending-billing returns the
// workspace's non-terminal requests (plus terminal requests whose billing
// reservation is still held) with their billing reservation snapshot. Oldest
// first, hard limit 50, total reported so the UI can say "and N older" instead
// of rendering a wall. No money movement, no audit write (read-only, matching
// /admin/users/:userId/context).
// app.ts registration is the integration owner's lane; this module only
// exports the plugin (already routable; .handle() works in tests).
import { Elysia, t } from "elysia";
import { and, asc, eq, ne, or, sql, count } from "drizzle-orm";
import type { Db } from "@hoborouter/db";
import { billingReservations, requests as requestsTable, workspaces } from "@hoborouter/db";
import type { BetterAuthInstance } from "../auth-types";
import { jsonError, requireInstanceAdmin, requireSession } from "../authz";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const PENDING_LIMIT = 50;

export const adminWalletPendingRoutes = (db: Db, auth: BetterAuthInstance) =>
  new Elysia({ name: "admin-wallet-pending" }).get(
    "/api/v1/admin/workspaces/:workspaceId/pending-billing",
    {
      params: t.Object({ workspaceId: t.String() }),
      detail: {
        tags: ["Admin"],
        summary: "Bounded pending billing records for a workspace",
        description:
          "Instance-admin-only read. Non-terminal requests plus terminal requests with a still-held reservation, oldest first, limit 50 with total count. No money movement.",
        security: [{ cookieAuth: [] }],
      },
    },
    async ({ request, params }) => {
      const gate = await requireSession(auth, request);
      if ("error" in gate) return gate.error;
      const denied = await requireInstanceAdmin(db, gate.session.user.id);
      if (denied) return denied;
      const ws = await db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, params.workspaceId))
        .limit(1);
      if (!ws[0]) return jsonError(404, "NOT_FOUND", "Workspace not found");
      // Ambiguous = still needs a decision: request not terminal, or terminal
      // with the hold not yet resolved (settled/released).
      const where = and(
        eq(requestsTable.workspace_id, params.workspaceId),
        or(
          ne(requestsTable.dispatch_state, "terminal"),
          eq(billingReservations.status, "held"),
        ),
      );
      const totalRows = await db
        .select({ n: count() })
        .from(requestsTable)
        .leftJoin(billingReservations, eq(billingReservations.request_id, requestsTable.id))
        .where(where);
      const rows = await db
        .select({
          request_id: requestsTable.id,
          created_at: sql<number>`${requestsTable.created_at}`.mapWith(Number),
          status: requestsTable.status,
          dispatch_state: requestsTable.dispatch_state,
          endpoint: requestsTable.endpoint,
          br_id: billingReservations.id,
          br_status: billingReservations.status,
          br_cap_vnd: billingReservations.cap_vnd,
        })
        .from(requestsTable)
        .leftJoin(billingReservations, eq(billingReservations.request_id, requestsTable.id))
        .where(where)
        // Oldest first: the longest-pending ambiguity is the most urgent.
        .orderBy(asc(requestsTable.created_at), asc(requestsTable.id))
        .limit(PENDING_LIMIT);
      return json({
        data: rows.map((r) => ({
          request_id: r.request_id,
          created_at: r.created_at,
          status: r.status,
          dispatch_state: r.dispatch_state,
          endpoint: r.endpoint,
          billing_reservation:
            r.br_id !== null
              ? { id: r.br_id, status: r.br_status, cap_vnd: Number(r.br_cap_vnd) }
              : null,
        })),
        total: Number(totalRows[0]?.n ?? 0),
        limit: PENDING_LIMIT,
      });
    },
  );
