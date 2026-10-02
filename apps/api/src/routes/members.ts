// Members CRUD + role mutation: owner-only per route matrix.
// No owner lockout: the last owner cannot be demoted or removed (409).
import { Elysia, t } from "elysia";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireWsRole, writeAudit, jsonError, type WsRole } from "../authz";
import { and, asc, eq, sql } from "drizzle-orm";
import { type Db, isUniqueViolation, users, workspaces, workspaceMembers } from "@hoborouter/db";

const ROLES: WsRole[] = ["owner", "admin", "member"];

async function ownerCount(db: Db, wsId: string): Promise<number> {
  const rows = await db
    .select({ c: sql<number>`count(*)` })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspace_id, wsId), eq(workspaceMembers.role, "owner")));
  return Number(rows[0]?.c ?? 0);
}

export const membersRoutes = (db: Db, auth: BetterAuthInstance) =>
  new Elysia({ name: "members" })
    .get(
      "/api/v1/workspaces/:id/members",
      {
        params: t.Object({ id: t.String() }),
        detail: {
          tags: ["Members"],
          summary: "List workspace members",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const denied = await requireWsRole(db, params.id, gate.session.user.id, "member");
        if (denied) return denied;
        return db
          .select({
            user_id: workspaceMembers.user_id,
            role: workspaceMembers.role,
            email: users.email,
            name: users.name,
          })
          .from(workspaceMembers)
          .innerJoin(users, eq(users.id, workspaceMembers.user_id))
          .where(eq(workspaceMembers.workspace_id, params.id))
          .orderBy(
            sql`case ${workspaceMembers.role} when 'owner' then 0 when 'admin' then 1 else 2 end`,
            asc(users.createdAt),
          );
      },
    )
    .post(
      "/api/v1/workspaces/:id/members",
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({ email: t.Optional(t.String()), role: t.Optional(t.String()) }),
        detail: {
          tags: ["Members"],
          summary: "Add member to workspace",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const denied = await requireWsRole(db, params.id, userId, "owner");
        if (denied) return denied;
        const wsRow = await db
          .select({ one: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, params.id))
          .limit(1);
        if (!wsRow[0])
          return jsonError(404, "NOT_FOUND", "Workspace not found");
        const emailRaw = (body as { email?: unknown } | null)?.email;
        const email = typeof emailRaw === "string" ? emailRaw : "";
        const role =
          typeof (body as { role?: unknown } | null)?.role === "string"
            ? ((body as { role: string }).role as WsRole)
            : null;
        if (!email) return jsonError(400, "INVALID", "email is required");
        if (!ROLES.includes(role as WsRole)) return jsonError(400, "INVALID", "Invalid role");
        const target = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, email))
          .limit(1);
        if (!target[0]) return jsonError(404, "NOT_FOUND", "User not found");
        try {
          await db
            .insert(workspaceMembers)
            .values({ workspace_id: params.id, user_id: target[0].id, role: role as WsRole });
        } catch (e) {
          // 409 only for UNIQUE(workspace_id,user_id) violation (composite PK); other DB errors → 500.
          if (isUniqueViolation(e)) {
            return jsonError(409, "CONFLICT", "User is already a member");
          }
          throw e;
        }
        await writeAudit(db, {
          actorUserId: userId,
          workspaceId: params.id,
          action: "member.add",
          target: target[0].id,
          detail: { role },
        });
        return new Response(JSON.stringify({ user_id: target[0].id, role }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    )
    .patch(
      "/api/v1/workspaces/:id/members/:userId",
      {
        params: t.Object({ id: t.String(), userId: t.String() }),
        body: t.Object({ role: t.Optional(t.String()) }),
        detail: {
          tags: ["Members"],
          summary: "Change member role",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const denied = await requireWsRole(db, params.id, userId, "owner");
        if (denied) return denied;
        const rawRole = (body as { role?: unknown } | null)?.role;
        if (!ROLES.includes(rawRole as WsRole)) return jsonError(400, "INVALID", "Invalid role");
        const role = rawRole as WsRole;
        const member = await db
          .select({ role: workspaceMembers.role })
          .from(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspace_id, params.id),
              eq(workspaceMembers.user_id, params.userId),
            ),
          )
          .limit(1);
        if (!member[0]) return jsonError(403, "FORBIDDEN", "Not a member of this workspace");
        // Owner lockout guard: last owner cannot lose the owner role.
        if (
          member[0].role === "owner" &&
          role !== "owner" &&
          (await ownerCount(db, params.id)) === 1
        ) {
          return jsonError(409, "LAST_OWNER", "Cannot demote the last owner");
        }
        await db
          .update(workspaceMembers)
          .set({ role })
          .where(
            and(
              eq(workspaceMembers.workspace_id, params.id),
              eq(workspaceMembers.user_id, params.userId),
            ),
          );
        await writeAudit(db, {
          actorUserId: userId,
          workspaceId: params.id,
          action: "member.role_change",
          target: params.userId,
          detail: { from: member[0].role, to: role },
        });
        return new Response(JSON.stringify({ user_id: params.userId, role }), {
          headers: { "content-type": "application/json" },
        });
      },
    )
    .delete(
      "/api/v1/workspaces/:id/members/:userId",
      {
        params: t.Object({ id: t.String(), userId: t.String() }),
        detail: {
          tags: ["Members"],
          summary: "Remove member from workspace",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const denied = await requireWsRole(db, params.id, userId, "owner");
        if (denied) return denied;
        const member = await db
          .select({ role: workspaceMembers.role })
          .from(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspace_id, params.id),
              eq(workspaceMembers.user_id, params.userId),
            ),
          )
          .limit(1);
        if (!member[0]) return jsonError(403, "FORBIDDEN", "Not a member of this workspace");
        // Owner lockout guard: last owner cannot be removed either.
        if (member[0].role === "owner" && (await ownerCount(db, params.id)) === 1) {
          return jsonError(409, "LAST_OWNER", "Cannot remove the last owner");
        }
        await db
          .delete(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspace_id, params.id),
              eq(workspaceMembers.user_id, params.userId),
            ),
          );
        await writeAudit(db, {
          actorUserId: userId,
          workspaceId: params.id,
          action: "member.remove",
          target: params.userId,
          detail: { role: member[0].role },
        });
        return new Response(null, { status: 200 });
      },
    );
