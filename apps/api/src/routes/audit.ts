// Audit read per route matrix: workspace admin/owner read own-ws rows
// (requires ?workspace_id=); instance admin reads globally (no filter → all).
import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireWsRole, requireInstanceAdmin, isInstanceAdmin } from "../authz";

export const auditRoutes = (db: Database, auth: BetterAuthInstance) =>
  new Elysia({ name: "audit" }).get("/api/v1/audit", async (ctx) => {
    const request: Request = ctx.request;
    const wsId = new URL(request.url).searchParams.get("workspace_id");
    const gate = await requireSession(auth, request);
    if ("error" in gate) return gate.error;
    const userId = gate.session.user.id;
    if (wsId) {
      // Instance admin may read any scope; otherwise admin/owner of that ws.
      if (!isInstanceAdmin(db, userId)) {
        const denied = requireWsRole(db, wsId, userId, "admin");
        if (denied) return denied;
      }
      return db
        .prepare(
          "SELECT id, actor_user_id, workspace_id, action, target, detail, created_at FROM audit_log WHERE workspace_id = ? ORDER BY created_at DESC",
        )
        .all(wsId);
    }
    const denied = requireInstanceAdmin(db, userId);
    if (denied) return denied;
    return db
      .prepare(
        "SELECT id, actor_user_id, workspace_id, action, target, detail, created_at FROM audit_log ORDER BY created_at DESC",
      )
      .all();
  });
