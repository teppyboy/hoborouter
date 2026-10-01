// Members CRUD + role mutation: owner-only per route matrix.
// No owner lockout: the last owner cannot be demoted or removed (409).
import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireWsRole, writeAudit, jsonError, type WsRole } from "../authz";

const ROLES: WsRole[] = ["owner", "admin", "member"];

function ownerCount(db: Database, wsId: string): number {
  return (
    db
      .prepare("SELECT count(*) c FROM workspace_members WHERE workspace_id=? AND role='owner'")
      .get(wsId) as any
  ).c;
}

export const membersRoutes = (db: Database, auth: BetterAuthInstance) =>
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
        const denied = requireWsRole(db, params.id, gate.session.user.id, "member");
        if (denied) return denied;
        return db
          .prepare(
            "SELECT wm.user_id, wm.role, u.email, u.name FROM workspace_members wm JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id = ?",
          )
          .all(params.id);
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
        const denied = requireWsRole(db, params.id, userId, "owner");
        if (denied) return denied;
        if (!wsExists(db, params.id)) return jsonError(404, "NOT_FOUND", "Workspace not found");
        const emailRaw = (body as { email?: unknown } | null)?.email;
        const email = typeof emailRaw === "string" ? emailRaw : "";
        const role =
          typeof (body as { role?: unknown } | null)?.role === "string"
            ? ((body as { role: string }).role as WsRole)
            : null;
        if (!email) return jsonError(400, "INVALID", "email is required");
        if (!ROLES.includes(role as WsRole)) return jsonError(400, "INVALID", "Invalid role");
        const target = db.prepare("SELECT id FROM users WHERE email = ?").get(email) as
          | { id: string }
          | undefined;
        if (!target) return jsonError(404, "NOT_FOUND", "User not found");
        try {
          db.prepare(
            "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?,?,?)",
          ).run(params.id, target.id, role);
        } catch (e) {
          // 409 only for UNIQUE(workspace_id,user_id) violation (composite PK); other DB errors → 500.
          if (
            (e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE" ||
            (e as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY"
          ) {
            return jsonError(409, "CONFLICT", "User is already a member");
          }
          throw e;
        }
        writeAudit(db, {
          actorUserId: userId,
          workspaceId: params.id,
          action: "member.add",
          target: target.id,
          detail: { role },
        });
        return new Response(JSON.stringify({ user_id: target.id, role }), {
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
        const denied = requireWsRole(db, params.id, userId, "owner");
        if (denied) return denied;
        const rawRole = (body as { role?: unknown } | null)?.role;
        if (!ROLES.includes(rawRole as WsRole)) return jsonError(400, "INVALID", "Invalid role");
        const role = rawRole as WsRole;
        const member = db
          .prepare("SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?")
          .get(params.id, params.userId) as { role: WsRole } | undefined;
        if (!member) return jsonError(403, "FORBIDDEN", "Not a member of this workspace");
        // Owner lockout guard: last owner cannot lose the owner role.
        if (member.role === "owner" && role !== "owner" && ownerCount(db, params.id) === 1) {
          return jsonError(409, "LAST_OWNER", "Cannot demote the last owner");
        }
        db.prepare("UPDATE workspace_members SET role=? WHERE workspace_id=? AND user_id=?").run(
          role,
          params.id,
          params.userId,
        );
        writeAudit(db, {
          actorUserId: userId,
          workspaceId: params.id,
          action: "member.role_change",
          target: params.userId,
          detail: { from: member.role, to: role },
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
        const denied = requireWsRole(db, params.id, userId, "owner");
        if (denied) return denied;
        const member = db
          .prepare("SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?")
          .get(params.id, params.userId) as { role: WsRole } | undefined;
        if (!member) return jsonError(403, "FORBIDDEN", "Not a member of this workspace");
        // Owner lockout guard: last owner cannot be removed either.
        if (member.role === "owner" && ownerCount(db, params.id) === 1) {
          return jsonError(409, "LAST_OWNER", "Cannot remove the last owner");
        }
        db.prepare("DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?").run(
          params.id,
          params.userId,
        );
        writeAudit(db, {
          actorUserId: userId,
          workspaceId: params.id,
          action: "member.remove",
          target: params.userId,
          detail: { role: member.role },
        });
        return new Response(null, { status: 200 });
      },
    );

function wsExists(db: Database, id: string): boolean {
  return !!db.prepare("SELECT 1 FROM workspaces WHERE id = ?").get(id);
}
