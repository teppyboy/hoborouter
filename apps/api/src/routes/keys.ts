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
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  workspaces,
  apiKeys,
  models,
  apiKeyModelPermissions,
  orm,
  runChanges,
} from "@hoborouter/db";

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
        const ws = orm(db)
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, params.id))
          .get();
        if (!ws) return jsonError(404, "NOT_FOUND", "Workspace not found");
        const raw = (body as { name?: unknown } | null)?.name;
        const name = typeof raw === "string" ? raw.trim() : "";
        if (!name) return jsonError(400, "INVALID", "name is required");

        const { plaintext, hash, prefix } = generateApiKey();
        const id = crypto.randomUUID();
        const now = Date.now();
        db.transaction(() => {
          orm(db)
            .insert(apiKeys)
            .values({
              id,
              workspace_id: params.id,
              key_hash: hash,
              key_prefix: prefix,
              name,
              status: "enabled",
              created_at: now,
            })
            .run();
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
        const rows = orm(db)
          .select({
            id: apiKeys.id,
            key_prefix: apiKeys.key_prefix,
            name: apiKeys.name,
            status: apiKeys.status,
            created_at: apiKeys.created_at,
            last_used_at: apiKeys.last_used_at,
            revoked_at: apiKeys.revoked_at,
          })
          .from(apiKeys)
          .where(eq(apiKeys.workspace_id, params.id))
          .orderBy(asc(apiKeys.created_at))
          .all();
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
          const key = orm(db)
            .select({ status: apiKeys.status })
            .from(apiKeys)
            .where(and(eq(apiKeys.id, params.keyId), eq(apiKeys.workspace_id, params.id)))
            .get();
          if (!key) return;
          if (key.status === "revoked") {
            terminal = true;
            return;
          }
          updated = runChanges(
            orm(db)
              .update(apiKeys)
              .set({ status: requested })
              .where(and(eq(apiKeys.id, params.keyId), eq(apiKeys.workspace_id, params.id))),
          ).changes;
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
        const key = orm(db)
          .select({ id: apiKeys.id })
          .from(apiKeys)
          .where(and(eq(apiKeys.id, params.keyId), eq(apiKeys.workspace_id, params.id)))
          .get();
        if (!key) return jsonError(404, "NOT_FOUND", "Key not found");
        const rows = orm(db)
          .select({ model_id: apiKeyModelPermissions.model_id })
          .from(apiKeyModelPermissions)
          .where(eq(apiKeyModelPermissions.api_key_id, params.keyId))
          .orderBy(asc(apiKeyModelPermissions.model_id))
          .all();
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
        const key = orm(db)
          .select({ id: apiKeys.id })
          .from(apiKeys)
          .where(and(eq(apiKeys.id, params.keyId), eq(apiKeys.workspace_id, params.id)))
          .get();
        if (!key) return jsonError(404, "NOT_FOUND", "Key not found");
        const raw = (body as { modelIds?: unknown } | null)?.modelIds;
        if (!Array.isArray(raw) || raw.some((m) => typeof m !== "string"))
          return jsonError(400, "INVALID", "modelIds must be an array of strings");
        const modelIds = [...new Set(raw as string[])];
        const knownIds = new Set(
          modelIds.length
            ? orm(db)
                .select({ id: models.id })
                .from(models)
                .where(inArray(models.id, modelIds))
                .all()
                .map((k) => k.id)
            : [],
        );
        for (const m of modelIds) {
          if (!knownIds.has(m)) return jsonError(400, "INVALID", `Unknown model: ${m}`);
        }
        db.transaction(() => {
          orm(db)
            .delete(apiKeyModelPermissions)
            .where(eq(apiKeyModelPermissions.api_key_id, params.keyId))
            .run();
          const now = Date.now();
          if (modelIds.length) {
            orm(db)
              .insert(apiKeyModelPermissions)
              .values(
                modelIds.map((m) => ({ api_key_id: params.keyId, model_id: m, created_at: now })),
              )
              .run();
          }
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
          // status list is a fixed allowlist literal, not user input
          revoked = runChanges(
            orm(db)
              .update(apiKeys)
              .set({ status: "revoked", revoked_at: now })
              .where(
                and(
                  eq(apiKeys.id, params.keyId),
                  eq(apiKeys.workspace_id, params.id),
                  inArray(apiKeys.status, ["active", "enabled", "disabled"]),
                ),
              ),
          ).changes;
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
