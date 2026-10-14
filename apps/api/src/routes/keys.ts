// Task 4 + key lifecycle: workspace-scoped sk-hbr- API key routes. Admin/owner
// only; plaintext shown exactly once at creation; PATCH enable/disable + rename
// (revoked terminal → 409); DELETE revokes; POST /remove soft-deletes (hidden
// from lists, never authenticates, row kept for audit/usage joins); model
// restrictions via api_key_model_permissions (zero rows = unrestricted).
// POST/DELETE/PATCH/PUT + audit atomic.
import { Elysia, t } from "elysia";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireWsRole, wsRole, writeAudit, jsonError } from "../authz";
import { generateApiKey, budgetWindow, type KeyBudgetPeriod } from "@hoborouter/keys";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  type Db,
  workspaces,
  apiKeys,
  models,
  apiKeyModelPermissions,
  usageLogs,
  workspaceMembers,
  MAX_SAFE_INTEGER_MONEY,
} from "@hoborouter/db";

// Shared display-name bound for create and rename; keeps the two paths consistent.
const MAX_KEY_NAME = 128;

const BUDGET_PERIODS: readonly string[] = ["daily", "weekly", "monthly"];

interface KeyPolicyInput {
  expires_at?: unknown;
  budget_vnd?: unknown;
  budget_period?: unknown;
}

/** Validated policy fields; undefined = field absent from the request. */
interface KeyPolicyValidated {
  expires_at?: number | null;
  budget_vnd?: number | null;
  budget_period?: KeyBudgetPeriod | null;
}

/**
 * Strict validation for key policy fields (create + PATCH): epoch-ms expiry
 * must be a FUTURE safe integer; a VND budget is a positive safe integer and
 * requires its reset period; clearing requires both budget fields null. On
 * CREATE (forCreate) there is no prior budget, so a period-only field is
 * meaningless and rejected; on PATCH it may adjust an existing budget.
 */
function validateKeyPolicy(
  body: KeyPolicyInput,
  now: number,
  opts: { forCreate?: boolean } = {},
): { ok: true; policy: KeyPolicyValidated } | { ok: false; error: Response } {
  const policy: KeyPolicyValidated = {};
  if (body.expires_at !== undefined) {
    if (body.expires_at === null) policy.expires_at = null;
    else if (
      typeof body.expires_at !== "number" ||
      !Number.isSafeInteger(body.expires_at) ||
      body.expires_at <= now ||
      body.expires_at > MAX_SAFE_INTEGER_MONEY
    )
      return {
        ok: false,
        error: jsonError(400, "INVALID", "expires_at must be a future epoch ms integer"),
      };
    else policy.expires_at = body.expires_at;
  }
  if (body.budget_vnd !== undefined) {
    if (body.budget_vnd === null) policy.budget_vnd = null;
    else if (
      typeof body.budget_vnd !== "number" ||
      !Number.isSafeInteger(body.budget_vnd) ||
      body.budget_vnd <= 0 ||
      body.budget_vnd > MAX_SAFE_INTEGER_MONEY
    )
      return {
        ok: false,
        error: jsonError(400, "INVALID", "budget_vnd must be a positive integer VND amount"),
      };
    else policy.budget_vnd = body.budget_vnd;
  }
  if (body.budget_period !== undefined) {
    if (body.budget_period === null) policy.budget_period = null;
    else if (typeof body.budget_period !== "string" || !BUDGET_PERIODS.includes(body.budget_period))
      return {
        ok: false,
        error: jsonError(400, "INVALID", "budget_period must be daily, weekly, or monthly"),
      };
    else policy.budget_period = body.budget_period as KeyBudgetPeriod;
  }
  if (opts.forCreate && policy.budget_period !== undefined && policy.budget_vnd === undefined)
    return {
      ok: false,
      error: jsonError(400, "INVALID", "budget_period is only valid together with budget_vnd"),
    };
  if (policy.budget_vnd !== undefined && policy.budget_vnd !== null) {
    if (policy.budget_period === undefined)
      return {
        ok: false,
        error: jsonError(400, "INVALID", "budget_period is required with budget_vnd"),
      };
  }
  if (policy.budget_vnd === null && policy.budget_period != null)
    return {
      ok: false,
      error: jsonError(400, "INVALID", "budget_period must be null when clearing budget_vnd"),
    };
  return { ok: true, policy };
}

export const keysRoutes = (db: Db, auth: BetterAuthInstance) => {
  // Shared key creation for POST /keys (generic) and POST /chat-key (chat):
  // same session + owner/admin gate, plaintext shown exactly once, audit
  // carries only non-secret metadata. purpose is server-owned state; clients
  // never set it.
  const createKey = async (
    request: Request,
    params: { id: string },
    body: { name?: unknown } | null,
    purpose: "generic" | "chat" | "chat_member",
    policyInput?: KeyPolicyInput,
    opts: { minRole?: "admin" | "member"; ownerUserId?: string } = {},
  ) => {
    const gate = await requireSession(auth, request);
    if ("error" in gate) return gate.error;
    const userId = gate.session.user.id;
    const denied = await requireWsRole(db, params.id, userId, opts.minRole ?? "admin");
    if (denied) return denied;
    const ownerUserId = opts.ownerUserId ?? null;
    const wsExists = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, params.id))
      .limit(1);
    if (!wsExists[0]) return jsonError(404, "NOT_FOUND", "Workspace not found");
    const raw = (body as { name?: unknown } | null)?.name;
    const name = typeof raw === "string" ? raw.trim() : "";
    if (!name) return jsonError(400, "INVALID", "name is required");
    if (name.length > MAX_KEY_NAME)
      return jsonError(400, "INVALID", `name must be at most ${MAX_KEY_NAME} characters`);
    const policyCheck = validateKeyPolicy(policyInput ?? {}, Date.now(), { forCreate: true });
    if (!policyCheck.ok) return policyCheck.error;
    const policy = policyCheck.policy;
    const budgetVnd = policy.budget_vnd ?? null;
    const budgetPeriod = policy.budget_period ?? null;

    const { plaintext, hash, prefix } = generateApiKey();
    const id = crypto.randomUUID();
    const now = Date.now();
    // Workspace lock protocol: a key create that waited behind a concurrent
    // sole-owner archive must recheck status under the lock, never insert
    // into a suspended workspace.
    let suspended = false;
    await db.transaction(async (tx) => {
      const ws = await tx
        .select({ id: workspaces.id, status: workspaces.status })
        .from(workspaces)
        .where(eq(workspaces.id, params.id))
        .for("update")
        .limit(1);
      if (!ws[0]) throw new Error("workspace vanished before key insert");
      // Archived (sole-owner removal) workspaces cannot issue new keys; existing
      // keys already fail gateway auth via the workspace-status join.
      if (ws[0].status !== "active") {
        suspended = true;
        return;
      }
      await tx.insert(apiKeys).values({
        id,
        workspace_id: params.id,
        key_hash: hash,
        key_prefix: prefix,
        name,
        status: "enabled",
        created_at: now,
        purpose,
        owner_user_id: ownerUserId,
        expires_at: policy.expires_at ?? null,
        budget_vnd: budgetVnd,
        budget_period: budgetPeriod,
        // A new budget always starts at its current window's beginning.
        budget_period_start: budgetVnd !== null ? budgetWindow(budgetPeriod!, now).start : null,
      });
      // audit detail carries only non-secret metadata — never plaintext or full hash
      await writeAudit(tx, {
        actorUserId: userId,
        workspaceId: params.id,
        action: "key.create",
        target: id,
        detail: {
          name,
          key_prefix: prefix,
          purpose,
          ...(ownerUserId !== null ? { owner_user_id: ownerUserId } : {}),
          ...(policy.expires_at !== undefined ? { expires_at: policy.expires_at } : {}),
          ...(budgetVnd !== null ? { budget_vnd: budgetVnd, budget_period: budgetPeriod } : {}),
        },
      });
    });
    if (suspended) {
      return jsonError(403, "WORKSPACE_SUSPENDED", "Workspace is suspended");
    }
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
        body: t.Object({
          name: t.Optional(t.String()),
          expires_at: t.Optional(t.Any()),
          budget_vnd: t.Optional(t.Any()),
          budget_period: t.Optional(t.Any()),
        }),
        detail: {
          tags: ["Keys"],
          summary: "Create API key",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => createKey(request, params, body, "generic", body),
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
      async ({ request, params, body }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const role = await wsRole(db, params.id, userId);
        if (!role) return jsonError(403, "FORBIDDEN", "Not a workspace member");
        const wsRows = await db
          .select({ enabled: workspaces.member_chat_enabled })
          .from(workspaces)
          .where(eq(workspaces.id, params.id))
          .limit(1);
        if (!wsRows[0]) return jsonError(404, "NOT_FOUND", "Workspace not found");
        // Member chat policy active: the chat-key route mints a personal
        // 'chat_member' key — purpose and owner are server-forced (owner is
        // ALWAYS the caller, never client input; members cannot mint generic
        // keys or set their own policy). Policy off: admins keep the
        // instance-wide 'chat' key, members get nothing.
        if (wsRows[0].enabled) {
          return createKey(request, params, body, "chat_member", undefined, {
            minRole: "member",
            ownerUserId: userId,
          });
        }
        return createKey(request, params, body, "chat");
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
            // Key policy (Task 4): expiry + per-period VND budget state for
            // the status/reset display; used includes pending admission holds.
            expires_at: apiKeys.expires_at,
            budget_vnd: apiKeys.budget_vnd,
            budget_period: apiKeys.budget_period,
            budget_used_vnd: apiKeys.budget_used_vnd,
            budget_period_start: apiKeys.budget_period_start,
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
        body: t.Object({
          status: t.Optional(t.String()),
          name: t.Optional(t.String()),
          expires_at: t.Optional(t.Any()),
          budget_vnd: t.Optional(t.Any()),
          budget_period: t.Optional(t.Any()),
        }),
        detail: {
          tags: ["Keys"],
          summary: "Update API key (enable/disable, rename, policy)",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const denied = await requireWsRole(db, params.id, userId, "admin");
        if (denied) return denied;
        const rawBody =
          (body as {
            status?: unknown;
            name?: unknown;
            expires_at?: unknown;
            budget_vnd?: unknown;
            budget_period?: unknown;
          } | null) ?? {};
        const requested = rawBody.status;
        const hasStatus = requested !== undefined;
        const hasName = rawBody.name !== undefined;
        const hasPolicy =
          rawBody.expires_at !== undefined ||
          rawBody.budget_vnd !== undefined ||
          rawBody.budget_period !== undefined;
        if (!hasStatus && !hasName && !hasPolicy)
          return jsonError(400, "INVALID", "status, name, or policy field is required");
        const now = Date.now();
        let policy: KeyPolicyValidated = {};
        if (hasPolicy) {
          const check = validateKeyPolicy(rawBody, now);
          if (!check.ok) return check.error;
          policy = check.policy;
        }
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
            .select({
              status: apiKeys.status,
              name: apiKeys.name,
              budget_vnd: apiKeys.budget_vnd,
              budget_period: apiKeys.budget_period,
            })
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
          // Policy update: any change to budget_vnd/budget_period starts a
          // FRESH period (used reset to 0 at the new/current window start) so
          // a lowered budget can never be instantly exhausted by past spend.
          let budgetReset: { budget_used_vnd: number; budget_period_start: number } | null = null;
          if (hasPolicy) {
            const newVnd = policy.budget_vnd !== undefined ? policy.budget_vnd : key[0].budget_vnd;
            const newPeriod =
              policy.budget_period !== undefined ? policy.budget_period : key[0].budget_period;
            if (newVnd !== null && newPeriod !== null) {
              const window = budgetWindow(newPeriod, now);
              budgetReset = { budget_used_vnd: 0, budget_period_start: window.start };
            }
          }
          const changed = await tx
            .update(apiKeys)
            .set({
              ...(hasStatus ? { status: requested as "enabled" | "disabled" } : {}),
              ...(hasName ? { name: name! } : {}),
              ...(hasPolicy ? { ...policy, ...(budgetReset ?? {}) } : {}),
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
            if (hasPolicy)
              await writeAudit(tx, {
                actorUserId: userId,
                workspaceId: params.id,
                action: "key.policy.update",
                target: params.keyId,
                detail: { ...policy },
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
          return new Response(null, { status: 200 });
        }
        // Idempotent replay: revoking an already-revoked (not removed) key is
        // a no-op 200 with no second audit row and no revoked_at churn —
        // mirroring the terminal-idempotent admin revoke contract. Removed or
        // unknown keys still 404 so soft-deleted rows stay inert.
        const already = await db
          .select({ id: apiKeys.id })
          .from(apiKeys)
          .where(
            and(
              eq(apiKeys.id, params.keyId),
              eq(apiKeys.workspace_id, params.id),
              eq(apiKeys.status, "revoked"),
              isNull(apiKeys.deleted_at),
            ),
          )
          .limit(1);
        if (already.length === 0) return jsonError(404, "NOT_FOUND", "Key not found");
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
    )
    .get(
      "/api/v1/keys/:id/usage",
      {
        params: t.Object({ id: t.String() }),
        detail: {
          tags: ["Keys"],
          summary: "Key usage and budget state",
          description:
            "Per-key usage totals, effective expiry, and current-period budget state (workspace member+). No secret material.",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        // Key id is global; authorization resolves through the key's workspace
        // (member+). Cross-workspace key ids are invisible (404).
        const keyRows = await db
          .select({
            id: apiKeys.id,
            workspace_id: apiKeys.workspace_id,
            key_prefix: apiKeys.key_prefix,
            name: apiKeys.name,
            status: apiKeys.status,
            expires_at: apiKeys.expires_at,
            budget_vnd: apiKeys.budget_vnd,
            budget_period: apiKeys.budget_period,
            budget_used_vnd: apiKeys.budget_used_vnd,
            budget_period_start: apiKeys.budget_period_start,
          })
          .from(apiKeys)
          .where(and(eq(apiKeys.id, params.id), isNull(apiKeys.deleted_at)))
          .limit(1);
        const key = keyRows[0];
        // Existence check BEFORE authorization: a non-member must not learn
        // that a key id exists, so any foreign workspace yields the same 404.
        if (!key) return jsonError(404, "NOT_FOUND", "Key not found");
        const membership = await db
          .select({ role: workspaceMembers.role })
          .from(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspace_id, key.workspace_id),
              eq(workspaceMembers.user_id, gate.session.user.id),
            ),
          )
          .limit(1);
        // Any workspace role (owner/admin/member) satisfies member+ access.
        if (!membership[0]) return jsonError(404, "NOT_FOUND", "Key not found");
        const now = Date.now();
        const totalsRows = await db
          .select({
            requests: sql<number>`count(*)`.mapWith(Number),
            input_tokens: sql<number>`coalesce(sum(${usageLogs.input_tokens}), 0)`.mapWith(Number),
            output_tokens: sql<number>`coalesce(sum(${usageLogs.output_tokens}), 0)`.mapWith(
              Number,
            ),
            cached_input_tokens:
              sql<number>`coalesce(sum(${usageLogs.cached_input_tokens}), 0)`.mapWith(Number),
            reasoning_tokens: sql<number>`coalesce(sum(${usageLogs.reasoning_tokens}), 0)`.mapWith(
              Number,
            ),
            charged_vnd: sql<number>`coalesce(sum(${usageLogs.charged_vnd}), 0)`.mapWith(Number),
          })
          .from(usageLogs)
          .where(eq(usageLogs.api_key_id, key.id));
        const totals = totalsRows[0]!;
        // Effective status: a key past expires_at no longer admits requests
        // even while its status column still reads enabled/disabled.
        const expired = key.expires_at !== null && now >= key.expires_at;
        const budget =
          key.budget_vnd === null || key.budget_period === null
            ? null
            : (() => {
                const window = budgetWindow(key.budget_period, now);
                // The counter may predate the current window (no request has
                // admitted since the boundary); report the effective in-window
                // usage, not the stale stored value.
                const used = key.budget_period_start === window.start ? key.budget_used_vnd : 0;
                return {
                  budget_vnd: key.budget_vnd,
                  period: key.budget_period,
                  used_vnd: used,
                  remaining_vnd: Math.max(0, key.budget_vnd - used),
                  period_start: window.start,
                  resets_at: window.end,
                };
              })();
        return {
          key_id: key.id,
          name: key.name,
          key_prefix: key.key_prefix,
          status: key.status,
          expired,
          expires_at: key.expires_at,
          budget,
          totals,
        };
      },
    );
};
