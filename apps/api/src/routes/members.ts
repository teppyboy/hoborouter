// Members CRUD + role mutation: owner-only per route matrix.
// No owner lockout: the last owner cannot be demoted or removed (409).
import { Elysia, t } from "elysia";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireWsRole, writeAudit, jsonError, type WsRole } from "../authz";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  type Db,
  type Tx,
  isUniqueViolation,
  users,
  workspaces,
  workspaceMembers,
} from "@hoborouter/db";

const ROLES: WsRole[] = ["owner", "admin", "member"];

async function ownerCount(db: Db | Tx, wsId: string): Promise<number> {
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
        const emailRaw = (body as { email?: unknown } | null)?.email;
        const email = typeof emailRaw === "string" ? emailRaw : "";
        const role =
          typeof (body as { role?: unknown } | null)?.role === "string"
            ? ((body as { role: string }).role as WsRole)
            : null;
        if (!email) return jsonError(400, "INVALID", "email is required");
        if (!ROLES.includes(role as WsRole)) return jsonError(400, "INVALID", "Invalid role");
        // Same workspace lock protocol as the sole-owner removal: lock the
        // workspace row, then recheck active status and owner authorization
        // under the lock. A member add that waited behind an archived
        // workspace must never insert into it.
        let resp: Response;
        await db.transaction(async (tx) => {
          const ws = await tx
            .select({ id: workspaces.id, status: workspaces.status })
            .from(workspaces)
            .where(eq(workspaces.id, params.id))
            .for("update")
            .limit(1);
          if (!ws[0]) {
            resp = jsonError(404, "NOT_FOUND", "Workspace not found");
            return;
          }
          const actorRole = await tx
            .select({ role: workspaceMembers.role })
            .from(workspaceMembers)
            .where(
              and(
                eq(workspaceMembers.workspace_id, params.id),
                eq(workspaceMembers.user_id, userId),
              ),
            )
            .limit(1);
          if (!actorRole[0] || actorRole[0].role !== "owner") {
            resp = jsonError(403, "FORBIDDEN", "Insufficient workspace role");
            return;
          }
          if (ws[0].status !== "active") {
            resp = jsonError(403, "WORKSPACE_SUSPENDED", "Workspace is suspended");
            return;
          }
          const target = await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.email, email))
            .limit(1);
          if (!target[0]) {
            resp = jsonError(404, "NOT_FOUND", "User not found");
            return;
          }
          try {
            await tx
              .insert(workspaceMembers)
              .values({ workspace_id: params.id, user_id: target[0].id, role: role as WsRole });
          } catch (e) {
            // 409 only for UNIQUE(workspace_id,user_id) violation (composite PK); other DB errors → 500.
            if (isUniqueViolation(e)) {
              resp = jsonError(409, "CONFLICT", "User is already a member");
              return;
            }
            throw e;
          }
          await writeAudit(tx, {
            actorUserId: userId,
            workspaceId: params.id,
            action: "member.add",
            target: target[0].id,
            detail: { role },
          });
          resp = new Response(JSON.stringify({ user_id: target[0].id, role }), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        });
        return resp!;
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
        // Workspace lock protocol: serialize against concurrent membership
        // mutations (including the admin sole-owner transfer promotion),
        // recheck the membership row under the lock.
        let resp: Response;
        await db.transaction(async (tx) => {
          await tx
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(eq(workspaces.id, params.id))
            .for("update")
            .limit(1);
          const member = await tx
            .select({ role: workspaceMembers.role })
            .from(workspaceMembers)
            .where(
              and(
                eq(workspaceMembers.workspace_id, params.id),
                eq(workspaceMembers.user_id, params.userId),
              ),
            )
            .for("update")
            .limit(1);
          if (!member[0]) {
            resp = jsonError(403, "FORBIDDEN", "Not a member of this workspace");
            return;
          }
          // Owner lockout guard: last owner cannot lose the owner role.
          if (
            member[0].role === "owner" &&
            role !== "owner" &&
            (await ownerCount(tx, params.id)) === 1
          ) {
            resp = jsonError(409, "LAST_OWNER", "Cannot demote the last owner");
            return;
          }
          const updated = await tx
            .update(workspaceMembers)
            .set({ role })
            .where(
              and(
                eq(workspaceMembers.workspace_id, params.id),
                eq(workspaceMembers.user_id, params.userId),
              ),
            )
            .returning({ user_id: workspaceMembers.user_id });
          if (updated.length !== 1) {
            // Membership vanished under a racing delete — roll back.
            throw new Error("member.role_change affected zero rows");
          }
          await writeAudit(tx, {
            actorUserId: userId,
            workspaceId: params.id,
            action: "member.role_change",
            target: params.userId,
            detail: { from: member[0].role, to: role },
          });
          resp = new Response(JSON.stringify({ user_id: params.userId, role }), {
            headers: { "content-type": "application/json" },
          });
        });
        return resp!;
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
        let resp: Response;
        await db.transaction(async (tx) => {
          await tx
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(eq(workspaces.id, params.id))
            .for("update")
            .limit(1);
          const member = await tx
            .select({ role: workspaceMembers.role })
            .from(workspaceMembers)
            .where(
              and(
                eq(workspaceMembers.workspace_id, params.id),
                eq(workspaceMembers.user_id, params.userId),
              ),
            )
            .for("update")
            .limit(1);
          if (!member[0]) {
            resp = jsonError(403, "FORBIDDEN", "Not a member of this workspace");
            return;
          }
          // Owner lockout guard: last owner cannot be removed either.
          if (member[0].role === "owner" && (await ownerCount(tx, params.id)) === 1) {
            resp = jsonError(409, "LAST_OWNER", "Cannot remove the last owner");
            return;
          }
          const deleted = await tx
            .delete(workspaceMembers)
            .where(
              and(
                eq(workspaceMembers.workspace_id, params.id),
                eq(workspaceMembers.user_id, params.userId),
              ),
            )
            .returning({ user_id: workspaceMembers.user_id });
          if (deleted.length !== 1) {
            throw new Error("member.remove affected zero rows");
          }
          await writeAudit(tx, {
            actorUserId: userId,
            workspaceId: params.id,
            action: "member.remove",
            target: params.userId,
            detail: { role: member[0].role },
          });
          resp = new Response(null, { status: 200 });
        });
        return resp!;
      },
    );
