// Task 4 + key lifecycle: workspace-scoped sk-hbr- API key routes. Admin/owner
// only; plaintext shown exactly once at creation; PATCH enable/disable + rename
// (revoked terminal → 409); DELETE revokes; POST /remove soft-deletes (hidden
// from lists, never authenticates, row kept for audit/usage joins); model
// restrictions via api_key_model_permissions (zero rows = unrestricted).
// POST/DELETE/PATCH/PUT + audit atomic.
import { Elysia, t } from "elysia";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireWsRole, writeAudit, jsonError } from "../authz";
import { generateApiKey } from "@hoborouter/keys";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { type Db, workspaces, apiKeys, models, apiKeyModelPermissions } from "@hoborouter/db";

// Shared display-name bound for create and rename; keeps the two paths consistent.
const MAX_KEY_NAME = 128;

export const keysRoutes = (db: Db, auth: BetterAuthInstance) => {
  // Shared key creation for POST /keys (generic) and POST /chat-key (chat):
  // same session + owner/admin gate, plaintext shown exactly once, audit
  // carries only non-secret metadata. purpose is server-owned state; clients
  // never set it.
  const createKey = async (
    request: Request,
    params: { id: string },
    body: { name?: unknown } | null,
    purpose: "generic" | "chat",
  ) => {
    const gate = await requireSession(auth, request);
    if ("error" in gate) return gate.error;
    const userId = gate.session.user.id;
    const denied = await requireWsRole(db, params.id, userId, "admin");
    if (denied) return denied;
    const ws = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, params.id))
      .limit(1);
    if (!ws[0]) return jsonError(404, "NOT_FOUND", "Workspace not found");
    const raw = (body as { name?: unknown } | null)?.name;
    const name = typeof raw === "string" ? raw.trim() : "";
    if (!name) return jsonError(400, "INVALID", "name is required");
    if (name.length > MAX_KEY_NAME)
      return jsonError(400, "INVALID", `name must be at most ${MAX_KEY_NAME} characters`);

    const { plaintext, hash, prefix } = generateApiKey();
    const id = crypto.randomUUID();
    const now = Date.now();
    await db.transaction(async (tx) => {
      await tx.insert(apiKeys).values({
        id,
        workspace_id: params.id,
        key_hash: hash,
        key_prefix: prefix,
        name,
        status: "enabled",
        created_at: now,
        purpose,
      });
      // audit detail carries only non-secret metadata — never plaintext or full hash
      await writeAudit(tx, {
        actorUserId: userId,
        workspaceId: params.id,
        action: "key.create",
        target: id,
        detail: { name, key_prefix: prefix, purpose },
      });
    });
    // The ONLY place plaintext is ever emitted.
    return new Response(
      JSON.stringify({ id, name, key_prefix: prefix, status: "enabled", plaintext, purpose }),
      {
        status: 201,
        headers: { "content-type": "application/json" },
      },
    );
  };

  return new Elysia({ name: "keys" })
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
      async ({ request, params, body }) => createKey(request, params, body, "generic"),
    )
    .post(
      "/api/v1/workspaces/:id/chat-key",
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({ name: t.Optional(t.String()) }),
        detail: {
          tags: ["Keys"],
          summary: "Create chat-purpose API key",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => createKey(request, params, body, "chat"),
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
        const denied = await requireWsRole(db, params.id, gate.session.user.id, "admin");
        if (denied) return denied;
        const rows = await db
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
          // removed keys are hidden from the management list
          .where(and(eq(apiKeys.workspace_id, params.id), isNull(apiKeys.deleted_at)))
          .orderBy(asc(apiKeys.created_at));
        // legacy 'active' ≡ enabled — normalize for display
        for (const r of rows) if (r.status === "active") r.status = "enabled";
        return rows;
      },
    )
    .patch(
      "/api/v1/workspaces/:id/keys/:keyId",
      {
        params: t.Object({ id: t.String(), keyId: t.String() }),
        body: t.Object({ status: t.Optional(t.String()), name: t.Optional(t.String()) }),
        detail: {
          tags: ["Keys"],
          summary: "Update API key (enable/disable, rename)",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const denied = await requireWsRole(db, params.id, userId, "admin");
        if (denied) return denied;
        const rawBody = (body as { status?: unknown; name?: unknown } | null) ?? {};
        const requested = rawBody.status;
        const hasStatus = requested !== undefined;
        const hasName = rawBody.name !== undefined;
        if (!hasStatus && !hasName) return jsonError(400, "INVALID", "status or name is required");
        let name: string | undefined;
        if (hasName) {
          if (typeof rawBody.name !== "string")
            return jsonError(400, "INVALID", "name must be a string");
          name = rawBody.name.trim();
          // Same validation as create: trimmed, nonempty, bounded.
          if (!name) return jsonError(400, "INVALID", "name is required");
          if (name.length > MAX_KEY_NAME)
            return jsonError(400, "INVALID", `name must be at most ${MAX_KEY_NAME} characters`);
        }
        if (hasStatus && requested !== "enabled" && requested !== "disabled")
          return jsonError(400, "INVALID", "status must be 'enabled' or 'disabled'");
        let updated = 0;
        let terminal = false;
        // Plain strings instead of a nullable row object: closure assignments
        // are invisible to TS flow analysis, which would narrow an object
        // variable to never after the null check.
        let finalName = "";
        let finalStatus = "";
        await db.transaction(async (tx) => {
          const key = await tx
            .select({ status: apiKeys.status, name: apiKeys.name })
            .from(apiKeys)
            .where(
              and(
                eq(apiKeys.id, params.keyId),
                eq(apiKeys.workspace_id, params.id),
                isNull(apiKeys.deleted_at),
              ),
            )
            .limit(1);
          if (!key[0]) return;
          // Revoked stays terminal for status changes; a name-only rename is
          // cosmetic and does not resurrect the key, so it is allowed.
          if (key[0].status === "revoked" && hasStatus) {
            terminal = true;
            return;
          }
          const changed = await tx
            .update(apiKeys)
            .set({
              ...(hasStatus ? { status: requested as "enabled" | "disabled" } : {}),
              ...(hasName ? { name: name! } : {}),
            })
            .where(
              and(
                eq(apiKeys.id, params.keyId),
                eq(apiKeys.workspace_id, params.id),
                isNull(apiKeys.deleted_at),
              ),
            )
            .returning({ id: apiKeys.id, name: apiKeys.name, status: apiKeys.status });
          updated = changed.length;
          if (updated === 1) {
            finalName = changed[0]!.name;
            finalStatus = changed[0]!.status;
            if (hasStatus)
              await writeAudit(tx, {
                actorUserId: userId,
                workspaceId: params.id,
                action: requested === "enabled" ? "key.enable" : "key.disable",
                target: params.keyId,
              });
            if (hasName)
              // audit detail carries only display names — never hash or plaintext
              await writeAudit(tx, {
                actorUserId: userId,
                workspaceId: params.id,
                action: "key.rename",
                target: params.keyId,
                detail: { name, previous_name: key[0].name },
              });
          }
        });
        if (updated === 0)
          return terminal
            ? jsonError(409, "REVOKED", "Revoked keys cannot be re-enabled or disabled")
            : jsonError(404, "NOT_FOUND", "Key not found");
        // status-only PATCH keeps its original response shape
        const resBody = hasName
          ? { id: params.keyId, name: finalName, status: finalStatus }
          : { id: params.keyId, status: requested };
        return new Response(JSON.stringify(resBody), {
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
        const denied = await requireWsRole(db, params.id, gate.session.user.id, "admin");
        if (denied) return denied;
        const key = await db
          .select({ id: apiKeys.id })
          .from(apiKeys)
          .where(
            and(
              eq(apiKeys.id, params.keyId),
              eq(apiKeys.workspace_id, params.id),
              isNull(apiKeys.deleted_at),
            ),
          )
          .limit(1);
        if (!key[0]) return jsonError(404, "NOT_FOUND", "Key not found");
        const rows = await db
          .select({ model_id: apiKeyModelPermissions.model_id })
          .from(apiKeyModelPermissions)
          .where(eq(apiKeyModelPermissions.api_key_id, params.keyId))
          .orderBy(asc(apiKeyModelPermissions.model_id));
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
        const denied = await requireWsRole(db, params.id, userId, "admin");
        if (denied) return denied;
        const key = await db
          .select({ id: apiKeys.id })
          .from(apiKeys)
          .where(
            and(
              eq(apiKeys.id, params.keyId),
              eq(apiKeys.workspace_id, params.id),
              isNull(apiKeys.deleted_at),
            ),
          )
          .limit(1);
        if (!key[0]) return jsonError(404, "NOT_FOUND", "Key not found");
        const raw = (body as { modelIds?: unknown } | null)?.modelIds;
        if (!Array.isArray(raw) || raw.some((m) => typeof m !== "string"))
          return jsonError(400, "INVALID", "modelIds must be an array of strings");
        const modelIds = [...new Set(raw as string[])];
        const knownIds = new Set(
          modelIds.length
            ? (
                await db.select({ id: models.id }).from(models).where(inArray(models.id, modelIds))
              ).map((k) => k.id)
            : [],
        );
        for (const m of modelIds) {
          if (!knownIds.has(m)) return jsonError(400, "INVALID", `Unknown model: ${m}`);
        }
        await db.transaction(async (tx) => {
          await tx
            .delete(apiKeyModelPermissions)
            .where(eq(apiKeyModelPermissions.api_key_id, params.keyId));
          const now = Date.now();
          if (modelIds.length) {
            await tx
              .insert(apiKeyModelPermissions)
              .values(
                modelIds.map((m) => ({ api_key_id: params.keyId, model_id: m, created_at: now })),
              );
          }
          await writeAudit(tx, {
            actorUserId: userId,
            workspaceId: params.id,
            action: "key.models.set",
            target: params.keyId,
            detail: { modelIds },
          });
        });
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
        const denied = await requireWsRole(db, params.id, userId, "admin");
        if (denied) return denied;
        const now = Date.now();
        // Key must belong to :wsId — cross-workspace key ids 404 here.
        // status list is a fixed allowlist literal, not user input
        const revoked = await db
          .update(apiKeys)
          .set({ status: "revoked", revoked_at: now })
          .where(
            and(
              eq(apiKeys.id, params.keyId),
              eq(apiKeys.workspace_id, params.id),
              inArray(apiKeys.status, ["active", "enabled", "disabled"]),
              isNull(apiKeys.deleted_at),
            ),
          )
          .returning({ id: apiKeys.id });
        if (revoked.length === 1) {
          await writeAudit(db, {
            actorUserId: userId,
            workspaceId: params.id,
            action: "key.revoke",
            target: params.keyId,
          });
        }
        if (revoked.length === 0) return jsonError(404, "NOT_FOUND", "Key not found");
        return new Response(null, { status: 200 });
      },
    )
    .post(
      "/api/v1/workspaces/:id/keys/:keyId/remove",
      {
        params: t.Object({ id: t.String(), keyId: t.String() }),
        detail: {
          tags: ["Keys"],
          summary: "Remove API key (soft delete; hides it, keeps the row for audit)",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const denied = await requireWsRole(db, params.id, userId, "admin");
        if (denied) return denied;
        // Soft delete per repo convention: deleted_at/deleted_by, row retained
        // so audit_log and usage joins still resolve the key's name/prefix.
        // Any non-removed status (incl. revoked) can be removed; the key stops
        // authenticating immediately via the verifyApiKey deleted_at filter.
        const removed = await db
          .update(apiKeys)
          .set({ deleted_at: Date.now(), deleted_by: userId })
          .where(
            and(
              eq(apiKeys.id, params.keyId),
              eq(apiKeys.workspace_id, params.id),
              isNull(apiKeys.deleted_at),
            ),
          )
          .returning({ id: apiKeys.id });
        if (removed.length === 0) return jsonError(404, "NOT_FOUND", "Key not found");
        await writeAudit(db, {
          actorUserId: userId,
          workspaceId: params.id,
          action: "key.remove",
          target: params.keyId,
        });
        return new Response(null, { status: 200 });
      },
    );
};
