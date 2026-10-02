// Workspace CRUD per route matrix: create/list (any authed user),
// detail (member+), delete (owner-only, ws-scoped).
import { Elysia, t } from "elysia";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireWsRole, writeAudit, jsonError } from "../authz";
import { eq } from "drizzle-orm";
import { type Db, workspaces, workspaceMembers, wallets, auditLog } from "@hoborouter/db";

export const workspacesRoutes = (db: Db, auth: BetterAuthInstance) =>
  new Elysia({ name: "workspaces" })
    .post(
      "/api/v1/workspaces",
      {
        body: t.Object({ name: t.Optional(t.String()) }),
        detail: {
          tags: ["Workspaces"],
          summary: "Create workspace",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, body }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const id = crypto.randomUUID();
        const raw = (body as { name?: unknown } | null)?.name;
        const name = typeof raw === "string" ? raw.trim() : "";
        if (!name) return jsonError(400, "INVALID", "name is required");
        await db.transaction(async (tx) => {
          await tx.insert(workspaces).values({ id, name, status: "active", created_at: Date.now() });
          await tx
            .insert(workspaceMembers)
            .values({ workspace_id: id, user_id: userId, role: "owner" });
          // Every workspace needs a wallet: payments, gateway billing and the
          // ledger all assume one exists (they 404 without it).
          await tx.insert(wallets).values({
            id: crypto.randomUUID(),
            workspace_id: id,
            currency: "VND",
            balance: 0,
            reserved: 0,
            version: 0,
            created_at: Date.now(),
          });
          await writeAudit(tx, {
            actorUserId: userId,
            workspaceId: id,
            action: "workspace.create",
            target: id,
            detail: { name },
          });
        });
        return new Response(JSON.stringify({ id, name, status: "active" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    )
    .get(
      "/api/v1/workspaces",
      {
        detail: {
          tags: ["Workspaces"],
          summary: "List workspaces for current user",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const rows = await db
          .select({
            id: workspaces.id,
            name: workspaces.name,
            status: workspaces.status,
            role: workspaceMembers.role,
          })
          .from(workspaces)
          .innerJoin(workspaceMembers, eq(workspaceMembers.workspace_id, workspaces.id))
          .where(eq(workspaceMembers.user_id, gate.session.user.id))
          .orderBy(workspaces.created_at);
        return rows;
      },
    )
    .get(
      "/api/v1/workspaces/:id",
      {
        params: t.Object({ id: t.String() }),
        detail: {
          tags: ["Workspaces"],
          summary: "Get workspace",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const denied = await requireWsRole(db, params.id, gate.session.user.id, "member");
        if (denied) return denied;
        const ws = await db
          .select({
            id: workspaces.id,
            name: workspaces.name,
            status: workspaces.status,
            created_at: workspaces.created_at,
          })
          .from(workspaces)
          .where(eq(workspaces.id, params.id))
          .limit(1);
        if (!ws[0]) return jsonError(404, "NOT_FOUND", "Workspace not found");
        return ws[0];
      },
    )
    .patch(
      "/api/v1/workspaces/:id",
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({ name: t.Optional(t.String()) }),
        detail: {
          tags: ["Workspaces"],
          summary: "Rename workspace",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const denied = await requireWsRole(db, params.id, gate.session.user.id, "owner");
        if (denied) return denied;
        const raw = (body as { name?: unknown } | null)?.name;
        const name = typeof raw === "string" ? raw.trim() : "";
        if (!name) return jsonError(400, "INVALID", "name is required");
        const ws = await db
          .select({ id: workspaces.id, status: workspaces.status })
          .from(workspaces)
          .where(eq(workspaces.id, params.id))
          .limit(1);
        if (!ws[0]) return jsonError(404, "NOT_FOUND", "Workspace not found");
        await db.update(workspaces).set({ name }).where(eq(workspaces.id, params.id));
        await writeAudit(db, {
          actorUserId: gate.session.user.id,
          workspaceId: params.id,
          action: "workspace.rename",
          target: params.id,
          detail: { name },
        });
        return { id: ws[0].id, name, status: ws[0].status };
      },
    )
    .delete(
      "/api/v1/workspaces/:id",
      {
        params: t.Object({ id: t.String() }),
        detail: {
          tags: ["Workspaces"],
          summary: "Delete workspace",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const denied = await requireWsRole(db, params.id, gate.session.user.id, "owner");
        if (denied) return denied;
        const ws = await db
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, params.id))
          .limit(1);
        if (!ws[0]) return jsonError(404, "NOT_FOUND", "Workspace not found");
        try {
          await db.transaction(async (tx) => {
            // Detach audit history (audit_log.workspace_id is a live FK) before delete.
            await tx
              .update(auditLog)
              .set({ workspace_id: null })
              .where(eq(auditLog.workspace_id, params.id));
            // Empty wallet (no money ever held) is safe to remove with the
            // workspace; a funded or reserved wallet keeps the 409 guard.
            const wallet = await tx
              .select({ id: wallets.id, balance: wallets.balance, reserved: wallets.reserved })
              .from(wallets)
              .where(eq(wallets.workspace_id, params.id))
              .for("update")
              .limit(1);
            if (wallet[0] && wallet[0].balance === 0 && wallet[0].reserved === 0) {
              await tx.delete(wallets).where(eq(wallets.id, wallet[0].id));
            }
            await tx
              .delete(workspaceMembers)
              .where(eq(workspaceMembers.workspace_id, params.id));
            await tx.delete(workspaces).where(eq(workspaces.id, params.id));
          });
        } catch {
          // Remaining FK children (keys/wallets) — refuse rather than cascade-delete money data.
          return jsonError(409, "CONFLICT", "Workspace still has dependent resources");
        }
        await writeAudit(db, {
          actorUserId: gate.session.user.id,
          workspaceId: null,
          action: "workspace.delete",
          target: params.id,
        });
        return new Response(null, { status: 200 });
      },
    );
