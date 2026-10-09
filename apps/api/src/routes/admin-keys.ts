// Instance-admin-only generic API key management at /api/v1/admin/workspaces/
// :workspaceId/keys. Distinct from the workspace routes in keys.ts (which stay
// requireWsRole-gated and give instance admins nothing): this path is gated by
// requireInstanceAdmin so an instance admin can manage keys in any workspace
// without membership. Generic purpose only — chat keys are never created or
// listed here. Plaintext is returned exactly once at grant; audit rows carry
// no secret material.
import { Elysia, t } from "elysia";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireInstanceAdmin, jsonError, writeAudit } from "../authz";
import { generateApiKey } from "@hoborouter/keys";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { type Db, workspaces, apiKeys, models, apiKeyModelPermissions } from "@hoborouter/db";

// Same display-name bound as keys.ts, so both creation paths stay consistent.
const MAX_KEY_NAME = 128;
// Matches the admin adjustment reason bound: short human justifications only.
const MAX_REASON = 500;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export const adminKeysRoutes = (db: Db, auth: BetterAuthInstance) =>
  new Elysia({ name: "admin-keys" })
    .get(
      "/api/v1/admin/workspaces/:workspaceId/keys",
      {
        params: t.Object({ workspaceId: t.String() }),
        detail: {
          tags: ["Admin"],
          summary: "List workspace API keys (admin)",
          description:
            "Instance-admin-only. Generic-purpose keys only; soft-deleted keys excluded; no hash or plaintext material.",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const denied = await requireInstanceAdmin(db, gate.session.user.id);
        if (denied) return denied;
        const ws = await db
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, params.workspaceId))
          .limit(1);
        if (!ws[0]) return jsonError(404, "NOT_FOUND", "Workspace not found");
        const rows = await db
          .select({
            id: apiKeys.id,
            name: apiKeys.name,
            key_prefix: apiKeys.key_prefix,
            status: apiKeys.status,
            created_at: apiKeys.created_at,
            last_used_at: apiKeys.last_used_at,
          })
          .from(apiKeys)
          .where(
            and(
              eq(apiKeys.workspace_id, params.workspaceId),
              eq(apiKeys.purpose, "generic"),
              isNull(apiKeys.deleted_at),
            ),
          )
          .orderBy(asc(apiKeys.created_at));
        const perms = rows.length
          ? await db
              .select({
                api_key_id: apiKeyModelPermissions.api_key_id,
                model_id: apiKeyModelPermissions.model_id,
              })
              .from(apiKeyModelPermissions)
              .where(
                inArray(
                  apiKeyModelPermissions.api_key_id,
                  rows.map((r) => r.id),
                ),
              )
              .orderBy(asc(apiKeyModelPermissions.model_id))
          : [];
        const byKey = new Map<string, string[]>();
        for (const p of perms) {
          const list = byKey.get(p.api_key_id) ?? [];
          list.push(p.model_id);
          byKey.set(p.api_key_id, list);
        }
        // legacy 'active' ≡ enabled — normalize for display, same as keys.ts
        return rows.map((r) => ({
          id: r.id,
          name: r.name,
          key_prefix: r.key_prefix,
          status: r.status === "active" ? "enabled" : r.status,
          created_at: r.created_at,
          last_used_at: r.last_used_at,
          modelIds: byKey.get(r.id) ?? [],
        }));
      },
    )
    .post(
      "/api/v1/admin/workspaces/:workspaceId/keys",
      {
        params: t.Object({ workspaceId: t.String() }),
        body: t.Object({
          name: t.Optional(t.String()),
          modelIds: t.Optional(t.Array(t.String())),
        }),
        detail: {
          tags: ["Admin"],
          summary: "Create generic API key (admin)",
          description:
            "Instance-admin-only. Plaintext is returned exactly once in this response and is never recoverable. Empty/absent modelIds = unrestricted.",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const denied = await requireInstanceAdmin(db, userId);
        if (denied) return denied;
        const ws = await db
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, params.workspaceId))
          .limit(1);
        if (!ws[0]) return jsonError(404, "NOT_FOUND", "Workspace not found");
        const name = (body?.name ?? "").trim();
        if (!name) return jsonError(400, "INVALID", "name is required");
        if (name.length > MAX_KEY_NAME)
          return jsonError(400, "INVALID", `name must be at most ${MAX_KEY_NAME} characters`);
        const modelIds = [...new Set(body?.modelIds ?? [])];
        const known = new Set(
          modelIds.length
            ? (
                await db.select({ id: models.id }).from(models).where(inArray(models.id, modelIds))
              ).map((m) => m.id)
            : [],
        );
        for (const m of modelIds) {
          if (!known.has(m)) return jsonError(400, "INVALID", `Unknown model: ${m}`);
        }

        const { plaintext, hash, prefix } = generateApiKey();
        const id = crypto.randomUUID();
        const now = Date.now();
        await db.transaction(async (tx) => {
          await tx.insert(apiKeys).values({
            id,
            workspace_id: params.workspaceId,
            key_hash: hash,
            key_prefix: prefix,
            name,
            status: "enabled",
            purpose: "generic",
            created_at: now,
          });
          if (modelIds.length) {
            await tx
              .insert(apiKeyModelPermissions)
              .values(modelIds.map((m) => ({ api_key_id: id, model_id: m, created_at: now })));
          }
          // audit detail carries only non-secret metadata — never plaintext or hash
          await writeAudit(tx, {
            actorUserId: userId,
            workspaceId: params.workspaceId,
            action: "admin.key.grant",
            target: id,
            detail: { keyId: id, modelIds },
          });
        });
        // The ONLY place plaintext is ever emitted on this route.
        return json(
          {
            id,
            name,
            key_prefix: prefix,
            status: "enabled",
            purpose: "generic",
            plaintext,
            modelIds,
          },
          201,
        );
      },
    )
    .post(
      "/api/v1/admin/workspaces/:workspaceId/keys/:keyId/revoke",
      {
        params: t.Object({ workspaceId: t.String(), keyId: t.String() }),
        body: t.Object({ reason: t.Optional(t.String()) }),
        detail: {
          tags: ["Admin"],
          summary: "Revoke API key (admin)",
          description:
            "Instance-admin-only. Terminal and idempotent: already-revoked keys return 200 without a second audit row. Reason is admin-private (audit-only).",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const denied = await requireInstanceAdmin(db, userId);
        if (denied) return denied;
        const reason = (body?.reason ?? "").trim();
        if (!reason) return jsonError(400, "INVALID", "reason is required");
        if (reason.length > MAX_REASON)
          return jsonError(400, "INVALID", `reason must be at most ${MAX_REASON} characters`);
        const ws = await db
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, params.workspaceId))
          .limit(1);
        if (!ws[0]) return jsonError(404, "NOT_FOUND", "Workspace not found");

        let notFound = false;
        await db.transaction(async (tx) => {
          // FOR UPDATE serializes concurrent revokes so exactly one txn takes
          // the terminal transition and writes the single audit row.
          const key = await tx
            .select({ id: apiKeys.id, status: apiKeys.status })
            .from(apiKeys)
            .where(
              and(
                eq(apiKeys.id, params.keyId),
                eq(apiKeys.workspace_id, params.workspaceId),
                isNull(apiKeys.deleted_at),
              ),
            )
            .limit(1)
            .for("update");
          if (!key[0]) {
            notFound = true;
            return;
          }
          if (key[0].status === "revoked") return; // idempotent replay, no audit
          await tx
            .update(apiKeys)
            .set({ status: "revoked", revoked_at: Date.now() })
            .where(eq(apiKeys.id, params.keyId));
          await writeAudit(tx, {
            actorUserId: userId,
            workspaceId: params.workspaceId,
            action: "admin.key.revoked",
            target: params.keyId,
            detail: { keyId: params.keyId, reason },
          });
        });
        if (notFound) return jsonError(404, "NOT_FOUND", "Key not found");
        return json({ status: "revoked" });
      },
    );
