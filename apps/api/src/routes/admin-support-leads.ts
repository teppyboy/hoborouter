// Instance-admin support-lead management. GET list (bounded filters +
// cursor pagination) and PATCH /:id status transition. Deliberately NO
// DELETE (leads are intake history) and no outbound email — "handled" is a
// bookkeeping transition the admin performs on their own channel.
// Trust boundary: instance-admin only (never implied by workspace roles).
import { Elysia, t } from "elysia"; // t: params schema on PATCH
import { type Db } from "@hoborouter/db";
import { supportLeads } from "@hoborouter/db";
import { and, desc, eq, gte, lte, lt, or, type SQL } from "drizzle-orm";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireInstanceAdmin, jsonError, writeAudit } from "../authz";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

// Bounded epoch-ms window: safe integers only, never negative.
const epochMs = (raw: string | null): number | null => {
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

// Integer limit, clamped 1..200; anything non-integer is invalid (no silent
// coercion — a typo like "1oo" must not quietly become the default page size).
const parseLimit = (raw: string | null): number | "invalid" => {
  if (raw === null || raw === "") return 100;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return "invalid";
  return Math.min(Math.max(n, 1), 200);
};

export const adminSupportLeadRoutes = (db: Db, auth: BetterAuthInstance) =>
  new Elysia({ name: "admin-support-leads" })
    .get(
      "/api/v1/admin/support-leads",
      {
        detail: {
          tags: ["Admin"],
          summary: "List support leads",
          description:
            "Instance-admin only. Bounded filters (status, from/to epoch ms), cursor pagination via before (created_at), limit clamped 1-200.",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const denied = await requireInstanceAdmin(db, gate.session.user.id);
        if (denied) return denied;

        const q = new URL(request.url).searchParams;
        const limit = parseLimit(q.get("limit"));
        if (limit === "invalid") {
          return jsonError(400, "INVALID", "limit must be an integer (1-200)");
        }
        const before = epochMs(q.get("before"));
        const beforeId = q.get("before_id");
        const from = epochMs(q.get("from"));
        const to = epochMs(q.get("to"));
        const status = q.get("status");
        if (status !== null && status !== "open" && status !== "handled") {
          return jsonError(400, "INVALID", "status must be 'open' or 'handled'");
        }
        if (before === null && q.get("before")) {
          return jsonError(400, "INVALID", "before must be a non-negative epoch ms number");
        }
        if (beforeId !== null && before === null) {
          return jsonError(400, "INVALID", "before_id requires before");
        }
        if (from === null && q.get("from")) {
          return jsonError(400, "INVALID", "from must be a non-negative epoch ms number");
        }
        if (to === null && q.get("to")) {
          return jsonError(400, "INVALID", "to must be a non-negative epoch ms number");
        }

        const filters: SQL[] = [];
        // Composite cursor (created_at, id): rows sharing a created_at never
        // get skipped or repeated across pages. before alone keeps the old
        // strict-lt contract working.
        if (before !== null) {
          filters.push(
            beforeId !== null
              ? or(
                  lt(supportLeads.created_at, before),
                  and(eq(supportLeads.created_at, before), lt(supportLeads.id, beforeId)),
                )!
              : lt(supportLeads.created_at, before),
          );
        }
        if (from !== null) filters.push(gte(supportLeads.created_at, from));
        if (to !== null) filters.push(lte(supportLeads.created_at, to));
        if (status) filters.push(eq(supportLeads.status, status));

        const rows = await db
          .select()
          .from(supportLeads)
          .where(filters.length ? and(...filters) : undefined)
          .orderBy(desc(supportLeads.created_at), desc(supportLeads.id))
          .limit(limit);

        // Cursor for the next page: the oldest row's (created_at, id), passed
        // back as before + before_id; null signals the last page.
        const more = rows.length === limit;
        const last = rows[rows.length - 1];
        return json({
          data: rows,
          next_before: more ? last!.created_at : null,
          next_before_id: more ? last!.id : null,
        });
      },
    )
    .patch(
      "/api/v1/admin/support-leads/:id",
      {
        params: t.Object({ id: t.String() }),
        detail: {
          tags: ["Admin"],
          summary: "Set a support lead's status (open/handled)",
          description:
            "Instance-admin only. Marks a lead handled (records actor + handled_at) or reopens it. Every transition is audited; no delete, no outbound email.",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const denied = await requireInstanceAdmin(db, userId);
        if (denied) return denied;

        // Manual body validation: always a 400 INVALID, never a bare 422.
        const status = (body as { status?: unknown } | null)?.status;
        if (status !== "open" && status !== "handled") {
          return jsonError(400, "INVALID", "status must be 'open' or 'handled'");
        }

        // Lock the row + update + audit inside ONE transaction so concurrent
        // PATCHes serialize and the audit entry can never be missing while the
        // status already changed.
        const result = await db.transaction(async (tx) => {
          const rows = await tx
            .select()
            .from(supportLeads)
            .where(eq(supportLeads.id, params.id))
            .limit(1)
            .for("update");
          const lead = rows[0];
          if (!lead) return { notFound: true as const };

          if (lead.status !== status) {
            const handled = status === "handled";
            await tx
              .update(supportLeads)
              .set({
                status,
                // Reopening clears the handling record so handled_at/by always
                // reflect the admin who actually closed the CURRENT handled spell.
                handled_at: handled ? Date.now() : null,
                handled_by: handled ? userId : null,
              })
              .where(eq(supportLeads.id, params.id));
            await writeAudit(tx, {
              actorUserId: userId,
              workspaceId: lead.workspace_id,
              action: "support_lead.status",
              target: params.id,
              detail: { from: lead.status, to: status },
            });
          }
          // Same-status PATCH: idempotent success, no duplicate audit row.
          const updated = (
            await tx.select().from(supportLeads).where(eq(supportLeads.id, params.id)).limit(1)
          )[0]!;
          return { notFound: false as const, lead: updated };
        });
        if (result.notFound) return jsonError(404, "NOT_FOUND", "Support lead not found");
        return json(result.lead);
      },
    );
