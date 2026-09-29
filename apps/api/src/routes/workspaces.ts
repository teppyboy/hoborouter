// Workspace CRUD per route matrix: create/list (any authed user),
// detail (member+), delete (owner-only, ws-scoped).
import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireWsRole, writeAudit, jsonError } from "../authz";

export const workspacesRoutes = (db: Database, auth: BetterAuthInstance) =>
  new Elysia({ name: "workspaces" })
    .post("/api/workspaces", async ({ request, body }) => {
      const gate = await requireSession(auth, request);
      if ("error" in gate) return gate.error;
      const userId = gate.session.user.id;
      const id = crypto.randomUUID();
      const raw = (body as { name?: unknown } | null)?.name;
      const name = typeof raw === "string" ? raw.trim() : "";
      if (!name) return jsonError(400, "INVALID", "name is required");
      db.transaction(() => {
        db.prepare(
          "INSERT INTO workspaces (id, name, status, created_at) VALUES (?,?,'active',?)",
        ).run(id, name, Date.now());
        db.prepare(
          "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?,?,'owner')",
        ).run(id, userId);
        writeAudit(db, {
          actorUserId: userId,
          workspaceId: id,
          action: "workspace.create",
          target: id,
          detail: { name },
        });
      })();
      return new Response(JSON.stringify({ id, name, status: "active" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    })
    .get("/api/workspaces", async ({ request }) => {
      const gate = await requireSession(auth, request);
      if ("error" in gate) return gate.error;
      const rows = db
        .prepare(
          "SELECT w.id, w.name, w.status, wm.role FROM workspaces w JOIN workspace_members wm ON wm.workspace_id = w.id WHERE wm.user_id = ? ORDER BY w.created_at",
        )
        .all(gate.session.user.id);
      return rows;
    })
    .get("/api/workspaces/:id", async ({ request, params }) => {
      const gate = await requireSession(auth, request);
      if ("error" in gate) return gate.error;
      const denied = requireWsRole(db, params.id, gate.session.user.id, "member");
      if (denied) return denied;
      const ws = db
        .prepare("SELECT id, name, status, created_at FROM workspaces WHERE id = ?")
        .get(params.id);
      if (!ws) return jsonError(404, "NOT_FOUND", "Workspace not found");
      return ws;
    })
    .patch("/api/workspaces/:id", async ({ request, params, body }) => {
      const gate = await requireSession(auth, request);
      if ("error" in gate) return gate.error;
      const denied = requireWsRole(db, params.id, gate.session.user.id, "owner");
      if (denied) return denied;
      const raw = (body as { name?: unknown } | null)?.name;
      const name = typeof raw === "string" ? raw.trim() : "";
      if (!name) return jsonError(400, "INVALID", "name is required");
      const ws = db.prepare("SELECT id, status FROM workspaces WHERE id = ?").get(params.id) as
        | { id: string; status: string }
        | undefined;
      if (!ws) return jsonError(404, "NOT_FOUND", "Workspace not found");
      db.prepare("UPDATE workspaces SET name = ? WHERE id = ?").run(name, params.id);
      writeAudit(db, {
        actorUserId: gate.session.user.id,
        workspaceId: params.id,
        action: "workspace.rename",
        target: params.id,
        detail: { name },
      });
      return { id: ws.id, name, status: ws.status };
    })
    .delete("/api/workspaces/:id", async ({ request, params }) => {
      const gate = await requireSession(auth, request);
      if ("error" in gate) return gate.error;
      const denied = requireWsRole(db, params.id, gate.session.user.id, "owner");
      if (denied) return denied;
      const ws = db.prepare("SELECT id FROM workspaces WHERE id = ?").get(params.id);
      if (!ws) return jsonError(404, "NOT_FOUND", "Workspace not found");
      try {
        db.transaction(() => {
          // Detach audit history (audit_log.workspace_id is a live FK) before delete.
          db.prepare("UPDATE audit_log SET workspace_id = NULL WHERE workspace_id = ?").run(
            params.id,
          );
          db.prepare("DELETE FROM workspace_members WHERE workspace_id = ?").run(params.id);
          db.prepare("DELETE FROM workspaces WHERE id = ?").run(params.id);
        })();
      } catch {
        // Remaining FK children (keys/wallets) — refuse rather than cascade-delete money data.
        return jsonError(409, "CONFLICT", "Workspace still has dependent resources");
      }
      writeAudit(db, {
        actorUserId: gate.session.user.id,
        workspaceId: null,
        action: "workspace.delete",
        target: params.id,
      });
      return new Response(null, { status: 200 });
    });
