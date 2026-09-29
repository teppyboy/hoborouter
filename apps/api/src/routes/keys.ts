// Task 4: workspace-scoped API key routes (api-boundaries.md §2 key shorthand
// realized as /api/workspaces/:wsId/keys). Admin/owner only; plaintext shown
// exactly once at creation; revocation immediate; POST/DELETE + audit atomic.
import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireWsRole, writeAudit, jsonError } from "../authz";
import { generateApiKey } from "@hoborouter/keys";

export const keysRoutes = (db: Database, auth: BetterAuthInstance) =>
  new Elysia({ name: "keys" })
    .post("/api/workspaces/:id/keys", async ({ request, params, body }) => {
      const gate = await requireSession(auth, request);
      if ("error" in gate) return gate.error;
      const userId = gate.session.user.id;
      const denied = requireWsRole(db, params.id, userId, "admin");
      if (denied) return denied;
      const ws = db.prepare("SELECT id FROM workspaces WHERE id = ?").get(params.id);
      if (!ws) return jsonError(404, "NOT_FOUND", "Workspace not found");
      const raw = (body as { name?: unknown } | null)?.name;
      const name = typeof raw === "string" ? raw.trim() : "";
      if (!name) return jsonError(400, "INVALID", "name is required");

      const { plaintext, hash, prefix } = generateApiKey();
      const id = crypto.randomUUID();
      const now = Date.now();
      db.transaction(() => {
        db.prepare(
          "INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at) VALUES (?,?,?,?,?,'active',?)",
        ).run(id, params.id, hash, prefix, name, now);
        // audit detail carries only non-secret metadata — never plaintext or full hash
        writeAudit(db, {
          actorUserId: userId,
          workspaceId: params.id,
          action: "key.create",
          target: id,
          detail: { name, key_prefix: prefix },
        });
      })();
      // The ONLY place plaintext is ever emitted.
      return new Response(JSON.stringify({ id, name, key_prefix: prefix, plaintext }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    })
    .get("/api/workspaces/:id/keys", async ({ request, params }) => {
      const gate = await requireSession(auth, request);
      if ("error" in gate) return gate.error;
      const denied = requireWsRole(db, params.id, gate.session.user.id, "admin");
      if (denied) return denied;
      return db
        .prepare(
          "SELECT id, key_prefix, name, status, created_at, last_used_at, revoked_at FROM api_keys WHERE workspace_id = ? ORDER BY created_at",
        )
        .all(params.id);
    })
    .delete("/api/workspaces/:id/keys/:keyId", async ({ request, params }) => {
      const gate = await requireSession(auth, request);
      if ("error" in gate) return gate.error;
      const userId = gate.session.user.id;
      const denied = requireWsRole(db, params.id, userId, "admin");
      if (denied) return denied;
      const now = Date.now();
      let revoked = 0;
      db.transaction(() => {
        // Key must belong to :wsId — cross-workspace key ids 404 here.
        revoked = db
          .prepare(
            "UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ? AND workspace_id = ? AND status = 'active'",
          )
          .run(now, params.keyId, params.id).changes;
        if (revoked === 1) {
          writeAudit(db, {
            actorUserId: userId,
            workspaceId: params.id,
            action: "key.revoke",
            target: params.keyId,
          });
        }
      })();
      if (revoked === 0) return jsonError(404, "NOT_FOUND", "Key not found");
      return new Response(null, { status: 200 });
    });
