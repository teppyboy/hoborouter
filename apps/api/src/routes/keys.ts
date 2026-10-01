// Task 4 + key lifecycle: workspace-scoped sk-hbr- API key routes. Admin/owner
// only; plaintext shown exactly once at creation; PATCH enable/disable (revoked
// terminal → 409); DELETE revokes; model restrictions via
// api_key_model_permissions (zero rows = unrestricted). POST/DELETE/PATCH/PUT
// + audit atomic.
import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireWsRole, writeAudit, jsonError } from "../authz";
import { generateApiKey } from "@hoborouter/keys";

export const keysRoutes = (db: Database, auth: BetterAuthInstance) =>
  new Elysia({ name: "keys" })
    .post(
      "/api/v1/workspaces/:id/keys",
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({ name: t.Optional(t.String()) }),
        detail: {
          tags: ["Keys"],
          summary: "Create API key",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => {
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
            "INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at) VALUES (?,?,?,?,?,'enabled',?)",
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
        return new Response(
          JSON.stringify({ id, name, key_prefix: prefix, status: "enabled", plaintext }),
          {
            status: 201,
            headers: { "content-type": "application/json" },
          },
        );
      },
    )
    .get(
      "/api/v1/workspaces/:id/keys",
      {
        params: t.Object({ id: t.String() }),
        detail: {
          tags: ["Keys"],
          summary: "List API keys",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const denied = requireWsRole(db, params.id, gate.session.user.id, "admin");
        if (denied) return denied;
        const rows = db
          .prepare(
            "SELECT id, key_prefix, name, status, created_at, last_used_at, revoked_at FROM api_keys WHERE workspace_id = ? ORDER BY created_at",
          )
          .all(params.id) as { status: string }[];
        // legacy 'active' ≡ enabled — normalize for display
        for (const r of rows) if (r.status === "active") r.status = "enabled";
        return rows;
      },
    )
    .patch(
      "/api/v1/workspaces/:id/keys/:keyId",
      {
        params: t.Object({ id: t.String(), keyId: t.String() }),
        body: t.Object({ status: t.Optional(t.String()) }),
        detail: {
          tags: ["Keys"],
          summary: "Enable or disable API key",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const denied = requireWsRole(db, params.id, userId, "admin");
        if (denied) return denied;
        const requested = (body as { status?: unknown } | null)?.status;
        if (requested !== "enabled" && requested !== "disabled")
          return jsonError(400, "INVALID", "status must be 'enabled' or 'disabled'");
        let updated = 0;
        let terminal = false;
        db.transaction(() => {
          const key = db
            .prepare("SELECT status FROM api_keys WHERE id = ? AND workspace_id = ?")
            .get(params.keyId, params.id) as { status: string } | undefined;
          if (!key) return;
          if (key.status === "revoked") {
            terminal = true;
            return;
          }
          updated = db
            .prepare(`UPDATE api_keys SET status = ? WHERE id = ? AND workspace_id = ?`)
            .run(requested, params.keyId, params.id).changes;
          writeAudit(db, {
            actorUserId: userId,
            workspaceId: params.id,
            action: requested === "enabled" ? "key.enable" : "key.disable",
            target: params.keyId,
          });
        })();
        if (updated === 0)
          return terminal
            ? jsonError(409, "REVOKED", "Revoked keys cannot be re-enabled or disabled")
            : jsonError(404, "NOT_FOUND", "Key not found");
        return new Response(JSON.stringify({ id: params.keyId, status: requested }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    )
    .get(
      "/api/v1/workspaces/:id/keys/:keyId/models",
      {
        params: t.Object({ id: t.String(), keyId: t.String() }),
        detail: {
          tags: ["Keys"],
          summary: "Get key model permissions",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const denied = requireWsRole(db, params.id, gate.session.user.id, "admin");
        if (denied) return denied;
        const key = db
          .prepare("SELECT id FROM api_keys WHERE id = ? AND workspace_id = ?")
          .get(params.keyId, params.id);
        if (!key) return jsonError(404, "NOT_FOUND", "Key not found");
        const rows = db
          .prepare(
            "SELECT model_id FROM api_key_model_permissions WHERE api_key_id = ? ORDER BY model_id",
          )
          .all(params.keyId) as { model_id: string }[];
        return { modelIds: rows.map((r) => r.model_id) }; // [] = unrestricted
      },
    )
    .put(
      "/api/v1/workspaces/:id/keys/:keyId/models",
      {
        params: t.Object({ id: t.String(), keyId: t.String() }),
        body: t.Object({ modelIds: t.Optional(t.Array(t.String())) }),
        detail: {
          tags: ["Keys"],
          summary: "Set key model permissions",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const denied = requireWsRole(db, params.id, userId, "admin");
        if (denied) return denied;
        const key = db
          .prepare("SELECT id FROM api_keys WHERE id = ? AND workspace_id = ?")
          .get(params.keyId, params.id);
        if (!key) return jsonError(404, "NOT_FOUND", "Key not found");
        const raw = (body as { modelIds?: unknown } | null)?.modelIds;
        if (!Array.isArray(raw) || raw.some((m) => typeof m !== "string"))
          return jsonError(400, "INVALID", "modelIds must be an array of strings");
        const modelIds = [...new Set(raw as string[])];
        for (const m of modelIds) {
          if (!db.prepare("SELECT 1 FROM models WHERE id = ?").get(m))
            return jsonError(400, "INVALID", `Unknown model: ${m}`);
        }
        db.transaction(() => {
          db.prepare("DELETE FROM api_key_model_permissions WHERE api_key_id = ?").run(
            params.keyId,
          );
          const ins = db.prepare(
            "INSERT INTO api_key_model_permissions (api_key_id, model_id, created_at) VALUES (?,?,?)",
          );
          for (const m of modelIds) ins.run(params.keyId, m, Date.now());
          writeAudit(db, {
            actorUserId: userId,
            workspaceId: params.id,
            action: "key.models.set",
            target: params.keyId,
            detail: { modelIds },
          });
        })();
        return new Response(JSON.stringify({ modelIds }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    )
    .delete(
      "/api/v1/workspaces/:id/keys/:keyId",
      {
        params: t.Object({ id: t.String(), keyId: t.String() }),
        detail: {
          tags: ["Keys"],
          summary: "Revoke API key",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
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
            // status list is a fixed allowlist literal, not user input
            .prepare(
              "UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ? AND workspace_id = ? AND status IN ('active','enabled','disabled')",
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
      },
    );
