// Admin-extra: instance-admin-only overview routes (users, payments,
// usage-logs, CPA model discovery, system status). No secrets ever emitted:
// no key hashes, no raw provider payloads, no env values — booleans only.
import { Elysia, t } from "elysia";
import { APIError } from "better-auth";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireInstanceAdmin, isInstanceAdmin, jsonError, writeAudit } from "../authz";
import { MockPaymentError, processMockPaymentEvent } from "@hoborouter/payments";
import { and, desc, eq, ne, notExists, sql, count, inArray } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import {
  type Db,
  type Tx,
  requests as requestsTable,
  users,
  workspaces,
  workspaceMembers,
  payments,
  usageLogs,
  apiKeys,
  providerModelMappings,
  models,
  instanceAdmins,
  auditLog,
  unknownResolutions,
  refundOperations,
} from "@hoborouter/db";

const cpaBase = () => process.env.CPA_BASE_URL || "http://cpa:8317";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Sole-owner workspaces for a user: workspaces where the user is an owner and
 * no OTHER owner exists. Used to block user removal that would orphan a
 * workspace (409 SOLE_OWNER).
 */
async function soleOwnedWorkspaces(db: Db | Tx, userId: string) {
  return db
    .selectDistinct({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspace_id, workspaces.id),
        eq(workspaceMembers.user_id, userId),
        eq(workspaceMembers.role, "owner"),
      ),
    )
    .where(
      notExists(
        db
          .select({ one: sql`1` })
          .from(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspace_id, workspaces.id),
              ne(workspaceMembers.user_id, userId),
              eq(workspaceMembers.role, "owner"),
            ),
          ),
      ),
    );
}

/**
 * Remove a user's live identity (sessions, accounts, memberships, admin flag)
 * and try to delete the users row. workspace_members/audit_log have no ON
 * DELETE CASCADE, and audit rows are history that must never be deleted, so a
 * FK-blocked delete falls back to anonymizing the user row (no login: the
 * credential account row is already gone). Money/history tables untouched.
 */
async function removeUserIdentity(db: Db | Tx, userId: string) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`delete from session where user_id = ${userId}`);
    await tx.execute(sql`delete from "account" where user_id = ${userId}`);
    await tx.execute(sql`delete from workspace_members where user_id = ${userId}`);
    await tx.execute(sql`delete from instance_admins where user_id = ${userId}`);
    // Postgres poisons a transaction after any statement error, so the old
    // try-delete/catch-anonymize pattern cannot work: pre-check remaining FK
    // references (money/history tables) and anonymize instead of deleting.
    const refCount =
      (
        await tx
          .select({ n: count() })
          .from(auditLog)
          .where(eq(auditLog.actor_user_id, userId))
      )[0]!.n +
      (
        await tx
          .select({ n: count() })
            .from(unknownResolutions)
          .where(eq(unknownResolutions.actor_user_id, userId))
      )[0]!.n +
      (
        await tx
          .select({ n: count() })
          .from(refundOperations)
          .where(eq(refundOperations.actor_user_id, userId))
      )[0]!.n;
    if (refCount > 0) {
      // History rows must never be deleted; anonymize the user row instead
      // (no login: the credential account row is already gone).
      await tx.execute(
        sql`update users set email = ${`deleted+${userId}@invalid`}, name = 'Deleted user', image = null where id = ${userId}`,
      );
    } else {
      await tx.execute(sql`delete from users where id = ${userId}`);
    }
  });
}

async function guard(db: Db, auth: BetterAuthInstance, request: Request) {
  const gate = await requireSession(auth, request);
  if ("error" in gate) return { error: gate.error } as const;
  const denied = await requireInstanceAdmin(db, gate.session.user.id);
  if (denied) return { error: denied } as const;
  return { session: gate.session } as const;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export const adminExtraRoutes = (db: Db, auth: BetterAuthInstance) =>
  new Elysia({ name: "admin-extra" })
    .get(
      "/api/v1/me",
      {
        detail: {
          tags: ["Admin"],
          summary: "Current session user",
          description:
            "Identity + instance-admin flag for any authenticated session (no admin required).",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const row = await db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        if (!row[0]) return jsonError(404, "NOT_FOUND", "User not found");
        return json({
          id: row[0].id,
          name: row[0].name,
          email: row[0].email,
          is_instance_admin: await isInstanceAdmin(db, userId),
        });
      },
    )
    .get(
      "/api/v1/admin/users",
      {
        detail: {
          tags: ["Admin"],
          summary: "List users",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request }) => {
        const g = await guard(db, auth, request);
        if ("error" in g) return g.error;
        const rows = await db
          .select({
            id: users.id,
            email: users.email,
            name: users.name,
            // Raw bigint comes back as a STRING from Bun SQL/PG; mapWith(Number)
            // keeps created_at a JSON epoch-ms number (web formatDate needs it).
            created_at: sql<number>`${users.createdAt}`.mapWith(Number),
            is_instance_admin:
              sql<number>`exists(select 1 from instance_admins ia where ia.user_id = ${users.id})`,
            // count(*) is bigint → string on PG; same mapWith(Number) treatment.
            workspace_count:
              sql<number>`(select count(*) from workspace_members wm where wm.user_id = ${users.id})`.mapWith(
                Number,
              ),
          })
          .from(users)
          .orderBy(desc(users.createdAt));
        return json({ data: rows });
      },
    )
    .get(
      "/api/v1/admin/payments",
      {
        detail: {
          tags: ["Billing"],
          summary: "List payments",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request }) => {
        const g = await guard(db, auth, request);
        if ("error" in g) return g.error;
        // provider_order_code is the merchant-facing code, not a secret; raw
        // payloads live in payment_events and are never joined here.
        const rows = await db
          .select({
            id: payments.id,
            workspace_id: payments.workspace_id,
            workspace_name: workspaces.name,
            amount: payments.amount,
            status: payments.status,
            provider: payments.provider,
            provider_order_code: payments.provider_order_code,
            created_at: payments.created_at,
            expires_at: payments.expires_at,
          })
          .from(payments)
          .innerJoin(workspaces, eq(workspaces.id, payments.workspace_id))
          .orderBy(desc(payments.created_at))
          .limit(200);
        // Creator comes ONLY from payment.create audits (the create route
        // writes one atomically with the payment insert); never from workspace
        // ownership or the approving admin. One batched query for the whole
        // page; earliest audit (created_at, then id) wins on duplicates —
        // a null actor on that earliest audit yields initiator null.
        const ids = rows.map((r) => r.id);
        const wsOf = new Map(rows.map((r) => [r.id, r.workspace_id]));
        const initiators = new Map<
          string,
          { id: string; name: string | null; email: string | null } | null
        >();
        if (ids.length > 0) {
          const audits = await db
            .select({
              target: auditLog.target,
              workspace_id: auditLog.workspace_id,
              actor_id: auditLog.actor_user_id,
              name: users.name,
              email: users.email,
            })
            .from(auditLog)
            .leftJoin(users, eq(users.id, auditLog.actor_user_id))
            .where(and(eq(auditLog.action, "payment.create"), inArray(auditLog.target, ids)))
            .orderBy(auditLog.created_at, auditLog.id);
          for (const a of audits) {
            if (initiators.has(a.target)) continue;
            // The audit must belong to the payment's own workspace.
            if (a.workspace_id !== wsOf.get(a.target)) continue;
            initiators.set(
              a.target,
              a.actor_id ? { id: a.actor_id, name: a.name, email: a.email } : null,
            );
          }
        }
        return json({
          data: rows.map((r) => ({ ...r, initiator: initiators.get(r.id) ?? null })),
        });
      },
    )
    .get(
      "/api/v1/admin/usage-logs",
      {
        detail: {
          tags: ["Admin"],
          summary: "List usage logs",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request }) => {
        const g = await guard(db, auth, request);
        if ("error" in g) return g.error;
        // raw_payload excluded — may contain upstream response data.
        const rows = await db
          .select({
            id: usageLogs.id,
            workspace_id: usageLogs.workspace_id,
            workspace_name: workspaces.name,
            key_prefix: apiKeys.key_prefix,
            provider: usageLogs.provider,
            public_model: usageLogs.public_model,
            upstream_model: usageLogs.upstream_model,
            input_tokens: usageLogs.input_tokens,
            output_tokens: usageLogs.output_tokens,
            cached_input_tokens: usageLogs.cached_input_tokens,
            reasoning_tokens: usageLogs.reasoning_tokens,
            status: usageLogs.status,
            failure: usageLogs.failure,
            latency_ms: usageLogs.latency_ms,
            upstream_cost_usd_micro: usageLogs.upstream_cost_usd_micro,
            charged_vnd: usageLogs.charged_vnd,
            created_at: usageLogs.created_at,
          })
          .from(usageLogs)
          .innerJoin(workspaces, eq(workspaces.id, usageLogs.workspace_id))
          .leftJoin(apiKeys, eq(apiKeys.id, usageLogs.api_key_id))
          .orderBy(desc(usageLogs.created_at))
          .limit(200);
        return json({ data: rows });
      },
    )
    .get(
      "/api/v1/admin/cpa/models",
      {
        detail: {
          tags: ["System"],
          summary: "List CPA models with mapping status",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request }) => {
        const g = await guard(db, auth, request);
        if ("error" in g) return g.error;
        const key = process.env.CPA_ACCESS_KEY;
        if (!key) return jsonError(502, "CPA_UNCONFIGURED", "CPA_ACCESS_KEY is not set");
        let resp: Response;
        try {
          resp = await fetch(`${cpaBase()}/v1/models`, {
            headers: { authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(3000),
          });
        } catch {
          return jsonError(502, "CPA_UNREACHABLE", "CPA did not respond");
        }
        if (resp.status === 401 || resp.status === 403)
          return jsonError(502, "CPA_AUTH_FAILED", `CPA rejected CPA_ACCESS_KEY (${resp.status})`);
        if (!resp.ok) return jsonError(502, "CPA_UNHEALTHY", `/v1/models returned ${resp.status}`);
        type Model = { id?: unknown; owned_by?: unknown };
        let upstream: { data?: Model[] };
        try {
          upstream = (await resp.json()) as { data?: Model[] };
        } catch {
          return jsonError(502, "CPA_UNHEALTHY", "invalid /v1/models response");
        }
        const mappedIds = await db
          .selectDistinct({
            upstream_model: providerModelMappings.upstream_model,
            public_id: models.public_id,
          })
          .from(providerModelMappings)
          .innerJoin(models, eq(models.id, providerModelMappings.model_id))
          .where(eq(providerModelMappings.enabled, true));
        const mapped = new Set(mappedIds.map((r) => r.upstream_model));
        const publicIdsByUpstream = new Map<string, string[]>();
        for (const r of mappedIds) {
          const list = publicIdsByUpstream.get(r.upstream_model);
          if (list) list.push(r.public_id);
          else publicIdsByUpstream.set(r.upstream_model, [r.public_id]);
        }
        const data = (upstream.data ?? [])
          .filter((m): m is { id: string; owned_by?: string } => typeof m.id === "string")
          .map((m) => ({
            id: m.id,
            owned_by: typeof m.owned_by === "string" ? m.owned_by : null,
            mapped: mapped.has(m.id),
            mapped_public_ids: publicIdsByUpstream.get(m.id) ?? [],
          }));
        return json({ data });
      },
    )
    .post(
      "/api/v1/admin/users",
      {
        detail: {
          tags: ["Admin"],
          summary: "Create user",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request }) => {
        const g = await guard(db, auth, request);
        if ("error" in g) return g.error;
        let body: Record<string, unknown>;
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return jsonError(400, "INVALID", "Invalid JSON body");
        }
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        const password = typeof body.password === "string" ? body.password : "";
        const instanceAdmin = body.instance_admin === true;
        if (!name || name.length > 80 || !EMAIL_RE.test(email) || password.length < 8 ||
          password.length > 200 || email.length > 254) {
          return jsonError(400, "INVALID", "name (1..80), valid email, and password (min 8) required");
        }
        let created: { user: { id: string; email: string; name: string } };
        try {
          // Through Better Auth so password hashing matches signup/login.
          // Non-null: real Better Auth always exposes this (mock test auths don't).
          created = await auth.api.signUpEmail!({ body: { email, password, name } });
        } catch (err) {
          // Better Auth 1.7 reports status as the string 'UNPROCESSABLE_ENTITY'.
          if (
            err instanceof APIError &&
            (err.status === 422 || err.status === "UNPROCESSABLE_ENTITY")
          ) {
            return jsonError(409, "EMAIL_TAKEN", "Email already registered");
          }
          throw err;
        }
        if (instanceAdmin) {
          await db
            .insert(instanceAdmins)
            .values({ user_id: created.user.id, created_at: Date.now(), added_by: g.session.user.id })
            .onConflictDoNothing();
        }
        await writeAudit(db, {
          actorUserId: g.session.user.id,
          workspaceId: null,
          action: "user.create",
          target: created.user.id,
          detail: { email: created.user.email, instance_admin: instanceAdmin },
        });
        return json(
          {
            id: created.user.id,
            name: created.user.name,
            email: created.user.email,
            instance_admin: instanceAdmin,
          },
          201,
        );
      },
    )
    .delete(
      "/api/v1/admin/users/:id",
      {
        params: t.Object({ id: t.String() }),
        detail: {
          tags: ["Admin"],
          summary: "Remove user",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
        const g = await guard(db, auth, request);
        if ("error" in g) return g.error;
        const actorId = g.session.user.id;
        const target = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, params.id))
          .limit(1);
        if (!target[0]) return jsonError(404, "NOT_FOUND", "User not found");
        // Guards re-read inside the same transaction as the removal:
        // check-then-act between separate statements could otherwise remove
        // the last admin or self after a concurrent change. LAST_ADMIN before
        // self: removing the final instance admin is blocked even when the
        // remover is that admin (add another admin first).
        let violation: Response | undefined;
        await db.transaction(async (tx) => {
          if (await isInstanceAdmin(tx, params.id)) {
            const adminCount = await tx
              .select({ n: sql<number>`count(*)` })
              .from(instanceAdmins);
            if (Number(adminCount[0]?.n ?? 0) <= 1) {
              violation = jsonError(409, "LAST_ADMIN", "Cannot remove the last instance admin");
              return;
            }
          }
          if (params.id === actorId) {
            violation = jsonError(400, "CANNOT_REMOVE_SELF", "You cannot remove your own account");
            return;
          }
          const sole = await soleOwnedWorkspaces(tx, params.id);
          if (sole.length > 0) {
            violation = new Response(
              JSON.stringify({
                error: {
                  code: "SOLE_OWNER",
                  message: "User is the sole owner of workspaces",
                  workspaces: sole,
                },
              }),
              { status: 409, headers: { "content-type": "application/json" } },
            );
            return;
          }
          await removeUserIdentity(tx, params.id);
        });
        if (violation) return violation;
        await writeAudit(db, {
          actorUserId: actorId,
          workspaceId: null,
          action: "user.remove",
          target: params.id,
        });
        return json({ removed: true });
      },
    )
    .post(
      "/api/v1/admin/payments/:id/complete",
      {
        params: t.Object({ id: t.String() }),
        detail: {
          tags: ["Billing"],
          summary: "Mark payment as received (admin credit)",
          description:
            "Instance-admin-only idempotent credit for out-of-band payment confirmation.",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
        // SECURITY: instance-admin-only in every environment. The owner confirms
        // money received out-of-band; ordinary users can never credit
        // themselves. Same idempotent credit path as webhooks; this is the
        // only completion route for manual payments.
        const g = await guard(db, auth, request);
        if ("error" in g) return g.error;
        const userId = g.session.user.id;
        const payment = await db
          .select({
            id: payments.id,
            workspace_id: payments.workspace_id,
            amount: payments.amount,
            status: payments.status,
            provider: payments.provider,
            provider_order_code: payments.provider_order_code,
          })
          .from(payments)
          .where(eq(payments.id, params.id))
          .limit(1);
        if (!payment[0]) return jsonError(404, "NOT_FOUND", "Payment not found");
        const p = payment[0];
        try {
          const result = await processMockPaymentEvent(db, {
            provider: p.provider,
            orderCode: p.provider_order_code,
            // Fixed reference per payment: replays are idempotent (already_processed).
            providerReference: `admin-complete-${p.id}`,
            amount: p.amount,
            rawPayload: JSON.stringify({ source: "admin-complete", paymentId: p.id }),
          });
          await writeAudit(db, {
            actorUserId: userId,
            workspaceId: p.workspace_id,
            action: "payment.admin_complete",
            target: p.id,
            detail: { outcome: result.outcome },
          });

          return new Response(JSON.stringify({ success: true, outcome: result.outcome }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        } catch (err) {
          if (err instanceof MockPaymentError) {
            if (err.code === "not_found") return jsonError(404, "NOT_FOUND", err.message);
            // e.g. cancelled/failed payment — invalid state, not a server error.
            return json({ error: { code: "INVALID_STATE", message: err.message } }, 409);
          }
          throw err;
        }
      },
    )
    .get(
      "/api/v1/admin/system",
      {
        detail: {
          tags: ["System"],
          summary: "System status",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request }) => {
        const g = await guard(db, auth, request);
        if ("error" in g) return g.error;
        // Count via SQL aggregate; PG has no cheap table row count.
        const countOf = async (t: PgTable) => {
          const rows = await db.select({ n: count() }).from(t);
          return Number(rows[0]?.n ?? 0);
        };
        return json({
          gateway_enabled: process.env.HBR_GATEWAY_ENABLED !== "0",
          usd_vnd_rate: Number(process.env.HBR_USD_VND_RATE) || 26000,
          payos_configured:
            !!process.env.PAYOS_CLIENT_ID &&
            !!process.env.PAYOS_API_KEY &&
            !!process.env.PAYOS_CHECKSUM_KEY,
          manual_payments: true,
          db: { engine: "postgres" },
          counts: {
            users: await countOf(users),
            workspaces: await countOf(workspaces),
            models: await countOf(models),
            requests: await countOf(requestsTable),
          },
        });
      },
    );
