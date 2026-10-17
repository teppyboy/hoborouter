// Admin-extra: instance-admin-only overview routes (users, payments,
// usage-logs, CPA model discovery, system status). No secrets ever emitted:
// no key hashes, no raw provider payloads, no env values — booleans only.
import { Elysia, t } from "elysia";
import { APIError } from "better-auth";
import type { BetterAuthInstance } from "../auth-types";
import {
  requireSession,
  requireInstanceAdmin,
  isInstanceAdmin,
  jsonError,
  writeAudit,
} from "../authz";
import { MockPaymentError, processMockPaymentEvent } from "@hoborouter/payments";
import { checkPassword } from "@hoborouter/shared";
import { and, asc, desc, eq, ilike, ne, notExists, or, sql, count, inArray } from "drizzle-orm";
import { z } from "zod";
import type { PgTable } from "drizzle-orm/pg-core";
import {
  type Db,
  type Tx,
  requests as requestsTable,
  users,
  workspaces,
  workspaceMembers,
  wallets,
  payments,
  usageLogs,
  apiKeys,
  providerModelMappings,
  models,
  instanceAdmins,
  auditLog,
  unknownResolutions,
  refundOperations,
  chatConversations,
  supportLeads,
} from "@hoborouter/db";

const cpaBase = (env: Record<string, string | undefined> = process.env) =>
  env.CPA_BASE_URL || "http://cpa:8317";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Trust boundary for the optional users-list query: strict (unknown params
// rejected). Absent query keeps the legacy whole-array response shape.
const usersListQuerySchema = z.strictObject({
  q: z.string().min(1).max(200).optional(),
  role: z.enum(["admin", "member"]).optional(),
  sort: z.enum(["created_at", "email", "name"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// Trust boundary for the optional DELETE body: strict (unknown keys rejected),
// absent body stays the legacy unconfirmed remove.
const removeUserBodySchema = z.strictObject({
  confirm: z.boolean().optional(),
  transfer_to: z.string().min(1).optional(),
});

/**
 * Sole-owner workspaces for a user: workspaces where the user is an owner and
 * no OTHER owner exists. Used to block user removal that would orphan a
 * workspace (409 SOLE_OWNER).
 */
async function soleOwnedWorkspaces(db: Db | Tx, userId: string) {
  const rows = await db
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
  if (rows.length === 0) return rows;
  // FOR UPDATE on workspaces: the exclusive row lock conflicts with the
  // FOR KEY SHARE a concurrent workspace_members insert takes on the parent,
  // so a member.add racing this transaction blocks until commit and then FK-
  // fails instead of sneaking a second owner in after the sole-owner check.
  // (PG forbids FOR UPDATE together with DISTINCT, hence the second pass.)
  await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      inArray(
        workspaces.id,
        rows.map((r) => r.id),
      ),
    )
    .for("update");
  // Re-read under the locks: READ COMMITTED gives this statement a fresh
  // snapshot, so an owner committed between the first read and the lock is
  // now visible and the workspace drops out of the sole-owned set.
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
      and(
        inArray(
          workspaces.id,
          rows.map((r) => r.id),
        ),
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
      (await tx.select({ n: count() }).from(auditLog).where(eq(auditLog.actor_user_id, userId)))[0]!
        .n +
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
      )[0]!.n +
      // Chat history is user content that must survive identity removal
      // (tombstone, not deletion) even when no other history references exist.
      (
        await tx
          .select({ n: count() })
          .from(chatConversations)
          .where(eq(chatConversations.user_id, userId))
      )[0]!.n +
      (
        await tx
          .select({ n: count() })
          .from(supportLeads)
          .where(eq(supportLeads.handled_by, userId))
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

/** Structured 409 bodies for the sole-owner removal flow (UI consumers read code + workspaces). */
const conflict = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ error: { code, message, ...extra } }), {
    status: 409,
    headers: { "content-type": "application/json" },
  });

/** True when the error (or a wrapped cause) is a Postgres FK violation (23503). */
function isFkViolation(e: unknown): boolean {
  let cur: unknown = e;
  while (cur) {
    if (typeof cur === "object") {
      const err = cur as { code?: string; errno?: string };
      // bun-sql puts the SQLSTATE in errno (code becomes ERR_POSTGRES_SERVER_ERROR);
      // drizzle wraps the original in .cause.
      if (err.code === "23503" || err.errno === "23503") return true;
    }
    cur = typeof cur === "object" ? (cur as { cause?: unknown }).cause : undefined;
  }
  return false;
}

export const adminExtraRoutes = (
  db: Db,
  auth: BetterAuthInstance,
  env: Record<string, string | undefined> = process.env,
) =>
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
        const select = {
          id: users.id,
          email: users.email,
          name: users.name,
          email_verified: users.emailVerified,
          // Raw bigint comes back as a STRING from Bun SQL/PG; mapWith(Number)
          // keeps created_at a JSON epoch-ms number (web formatDate needs it).
          created_at: sql<number>`${users.createdAt}`.mapWith(Number),
          is_instance_admin: sql<number>`exists(select 1 from instance_admins ia where ia.user_id = ${users.id})`,
          // count(*) is bigint → string on PG; same mapWith(Number) treatment.
          workspace_count:
            sql<number>`(select count(*) from workspace_members wm where wm.user_id = ${users.id})`.mapWith(
              Number,
            ),
        };
        // No query string: legacy whole-array response (unchanged shape).
        const url = new URL(request.url);
        if (url.search.length === 0) {
          const rows = await db.select(select).from(users).orderBy(desc(users.createdAt));
          return json({ data: rows });
        }
        const parsed = usersListQuerySchema.safeParse(Object.fromEntries(url.searchParams));
        if (!parsed.success) {
          return jsonError(
            400,
            "INVALID",
            "Invalid query: q, role (admin|member), sort (created_at|email|name), order (asc|desc), limit (1..200), offset (>=0)",
          );
        }
        const {
          q: term,
          role,
          sort = "created_at",
          order = "desc",
          limit = 200,
          offset = 0,
        } = parsed.data;
        const conds = [];
        if (term !== undefined) {
          conds.push(
            or(ilike(users.email, `%${term}%`), ilike(users.name, `%${term}%`), eq(users.id, term)),
          );
        }
        if (role !== undefined) {
          conds.push(
            role === "admin"
              ? sql`exists(select 1 from instance_admins ia where ia.user_id = ${users.id})`
              : sql`not exists(select 1 from instance_admins ia where ia.user_id = ${users.id})`,
          );
        }
        const where = conds.length > 0 ? and(...conds) : undefined;
        const totalRows = await db.select({ n: count() }).from(users).where(where);
        // Whitelisted column switch only — user input never reaches SQL text.
        const sortCol =
          sort === "email" ? users.email : sort === "name" ? users.name : users.createdAt;
        const rows = await db
          .select(select)
          .from(users)
          .where(where)
          // id tiebreak keeps the page order stable across paged fetches.
          .orderBy(order === "asc" ? asc(sortCol) : desc(sortCol), asc(users.id))
          .limit(limit)
          .offset(offset);
        return json({ data: rows, total: Number(totalRows[0]?.n ?? 0), limit, offset });
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
          summary: "List usage logs (request log)",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request }) => {
        const g = await guard(db, auth, request);
        if ("error" in g) return g.error;
        // raw_payload excluded — may contain upstream response data.
        // upstream_model excluded too: upstream model IDs are private
        // (AGENTS.md); admins see the public model only.
        const rows = await db
          .select({
            id: usageLogs.id,
            workspace_id: usageLogs.workspace_id,
            workspace_name: workspaces.name,
            key_prefix: apiKeys.key_prefix,
            provider: usageLogs.provider,
            public_model: usageLogs.public_model,
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
            api_key_id: usageLogs.api_key_id,
          })
          .from(usageLogs)
          .innerJoin(workspaces, eq(workspaces.id, usageLogs.workspace_id))
          // leftJoin (no deleted_at filter): soft-deleted keys keep their history.
          .leftJoin(apiKeys, eq(apiKeys.id, usageLogs.api_key_id))
          .orderBy(desc(usageLogs.created_at))
          .limit(200);
        // Actor identity: requests/usage_logs record no user, so the actor is
        // the KEY CREATOR from the key.create audit (earliest audit wins on
        // duplicates, like the payments initiator above) — clearly labeled
        // actor_source so it is never mistaken for the actual caller. The
        // workspace owner is never claimed. Historical keys without an audit
        // yield actor null (unknown). Batched queries, no N+1.
        const keyIds = [
          ...new Set(rows.map((r) => r.api_key_id).filter((v): v is string => v !== null)),
        ];
        const creators = new Map<
          string,
          { id: string; name: string | null; email: string | null } | null
        >();
        if (keyIds.length > 0) {
          const audits = await db
            .select({
              target: auditLog.target,
              actor_id: auditLog.actor_user_id,
              name: users.name,
              email: users.email,
            })
            .from(auditLog)
            .leftJoin(users, eq(users.id, auditLog.actor_user_id))
            .where(and(eq(auditLog.action, "key.create"), inArray(auditLog.target, keyIds)))
            .orderBy(auditLog.created_at, auditLog.id);
          for (const a of audits) {
            if (creators.has(a.target)) continue;
            creators.set(
              a.target,
              a.actor_id ? { id: a.actor_id, name: a.name, email: a.email } : null,
            );
          }
        }
        return json({
          data: rows.map(({ api_key_id, ...r }) => {
            const actor = api_key_id ? (creators.get(api_key_id) ?? null) : null;
            return { ...r, actor, actor_source: actor ? "key_creator" : null };
          }),
        });
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
        const key = env.CPA_ACCESS_KEY;
        if (!key) return jsonError(502, "CPA_UNCONFIGURED", "CPA_ACCESS_KEY is not set");
        let resp: Response;
        try {
          resp = await fetch(`${cpaBase(env)}/v1/models`, {
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
        // Same shared policy as signup/change-password (see auth.ts hooks).
        const pwProblems = checkPassword(password);
        if (pwProblems.length > 0) {
          return jsonError(
            400,
            "INVALID",
            `Password does not meet the requirements: ${pwProblems.join("; ")}`,
          );
        }
        if (!name || name.length > 80 || !EMAIL_RE.test(email) || email.length > 254) {
          return jsonError(400, "INVALID", "name (1..80) and a valid email are required");
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
            .values({
              user_id: created.user.id,
              created_at: Date.now(),
              added_by: g.session.user.id,
            })
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
        // Trust boundary: Zod strict parse. An ABSENT body stays legacy
        // (unconfirmed remove); anything present must be valid JSON matching
        // { confirm?: boolean, transfer_to?: string } — unknown keys and wrong
        // types are rejected instead of silently ignored.
        // - transfer_to: promote that member to owner of EVERY sole-owned
        //   workspace, then remove the user (workspaces retained).
        // - confirm: allow resolving sole-owned workspaces directly — empty
        //   ones are physically deleted, ones with any financial/history FK
        //   child are archived (retained, status 'suspended').
        let confirm = false;
        let transferTo: string | undefined;
        const rawBody = await request.text();
        if (rawBody.trim().length > 0) {
          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(rawBody);
          } catch {
            return jsonError(400, "INVALID", "Invalid JSON body");
          }
          const parsed = removeUserBodySchema.safeParse(parsedJson);
          if (!parsed.success) {
            return jsonError(
              400,
              "INVALID",
              "Invalid body: confirm must be boolean, transfer_to a non-empty string, no unknown keys",
            );
          }
          confirm = parsed.data.confirm === true;
          transferTo = parsed.data.transfer_to;
        }
        // All-or-nothing: every guard that can produce a 4xx is evaluated
        // BEFORE any mutation. The only code below the mutation line that can
        // leave the transaction is a throw (full rollback) or success.
        let violation: Response | undefined;
        const outcome: {
          deleted?: string[];
          archived?: string[];
          transferred?: { workspace_id: string; to: string }[];
        } = {};
        await db.transaction(async (tx) => {
          // Serialize user-scoped identity mutations against workspace
          // creation: the create route takes the same advisory lock, so a
          // workspace created for this user mid-removal cannot escape the
          // workspace-row locks below (its memberships FK-lock only its own
          // brand-new workspace row).
          await tx.execute(sql`select pg_advisory_xact_lock(19088, hashtext(${params.id}))`);
          // Serialize concurrent admin removals (cross-removal of two admins
          // would otherwise both observe count=2): one shared admin-set lock
          // before any admin authorization/count, then revalidate the actor.
          await tx.execute(sql`select pg_advisory_xact_lock(19089, 0)`);
          if (!(await isInstanceAdmin(tx, actorId))) {
            violation = jsonError(403, "FORBIDDEN", "Instance admin required");
            return;
          }
          // Lock the target user row first: a concurrent identity change
          // (e.g. another admin editing) serializes behind this removal.
          await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, params.id))
            .for("update");
          if (await isInstanceAdmin(tx, params.id)) {
            // Lock ALL admin rows in deterministic order: two concurrent
            // removals cannot both observe count=2 and leave zero admins.
            const adminRows = await tx
              .select({ user_id: instanceAdmins.user_id })
              .from(instanceAdmins)
              .orderBy(asc(instanceAdmins.user_id))
              .for("update");
            if (adminRows.length <= 1) {
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
            // Lock ALL wallets of the sole-owned workspaces (ordered), not
            // just funded ones: a zero-balance wallet must be locked too or a
            // concurrent topup could credit it between evaluation and delete.
            const lockedWallets = await tx
              .select({
                id: wallets.id,
                workspace_id: wallets.workspace_id,
                kind: wallets.kind,
                balance: wallets.balance,
                reserved: wallets.reserved,
              })
              .from(wallets)
              .where(
                inArray(
                  wallets.workspace_id,
                  sole.map((w) => w.id),
                ),
              )
              .orderBy(asc(wallets.id))
              .for("update");
            // HARD MONEY GUARD — validated before ANY mutation: a funded or
            // reserved wallet means the workspace holds customer money, so
            // nothing may be deleted or transferred around it.
            const fundedWallets = lockedWallets.filter((w) => w.balance > 0 || w.reserved > 0);
            const funded = new Set(fundedWallets.map((w) => w.workspace_id));
            if (funded.size > 0) {
              // Same locked transaction computed the snapshot: no second read,
              // no TOCTOU. Server-locked exact wallet figures so the admin UI
              // can link straight to the resolution routes without guessing.
              violation = conflict(
                "WORKSPACE_FUNDED",
                "Workspace wallet holds funds or reservations; money history cannot be deleted",
                {
                  workspaces: sole
                    .filter((w) => funded.has(w.id))
                    .map((w) => ({
                      id: w.id,
                      name: w.name,
                      wallets: fundedWallets
                        .filter((lw) => lw.workspace_id === w.id)
                        .map((lw) => ({
                          id: lw.id,
                          kind: lw.kind,
                          balance_vnd: Number(lw.balance),
                          reserved_vnd: Number(lw.reserved),
                          available_vnd: Number(lw.balance) - Number(lw.reserved),
                        })),
                    })),
                },
              );
              return;
            }
            // --- validation of ALL workspaces before any mutation ---
            if (transferTo) {
              if (transferTo === params.id) {
                violation = conflict(
                  "TRANSFER_TARGET_INVALID",
                  "Transfer target must be another member of the workspace",
                  { workspaces: sole },
                );
                return;
              }
              // Target must be an existing member of every sole-owned
              // workspace (same-workspace requirement; no cross-workspace
              // transfers). Non-owner members are promoted to owner. The
              // membership row is locked (same protocol members.ts uses) so a
              // concurrent member delete/demote serializes here instead of
              // leaving a promotion that affects zero rows.
              for (const ws of sole) {
                const membership = await tx
                  .select({ role: workspaceMembers.role })
                  .from(workspaceMembers)
                  .where(
                    and(
                      eq(workspaceMembers.workspace_id, ws.id),
                      eq(workspaceMembers.user_id, transferTo),
                    ),
                  )
                  .for("update")
                  .limit(1);
                if (!membership[0]) {
                  violation = conflict(
                    "TRANSFER_TARGET_INVALID",
                    "Transfer target must be an existing member of the workspace",
                    { workspaces: [ws] },
                  );
                  return;
                }
              }
            } else if (confirm) {
              for (const ws of sole) {
                const others = await tx
                  .select({ n: count() })
                  .from(workspaceMembers)
                  .where(
                    and(
                      eq(workspaceMembers.workspace_id, ws.id),
                      ne(workspaceMembers.user_id, params.id),
                    ),
                  );
                if (Number(others[0]?.n ?? 0) > 0) {
                  // Other members remain: never orphan them without an owner.
                  violation = conflict(
                    "SOLE_OWNER",
                    "User is the sole owner of workspaces; transfer ownership first",
                    { workspaces: [ws], needs_transfer: true },
                  );
                  return;
                }
              }
            } else {
              violation = conflict("SOLE_OWNER", "User is the sole owner of workspaces", {
                workspaces: sole,
              });
              return;
            }
            // --- mutations (validation passed for ALL workspaces) ---
            if (transferTo) {
              outcome.transferred = [];
              for (const ws of sole) {
                const promoted = await tx
                  .update(workspaceMembers)
                  .set({ role: "owner" })
                  .where(
                    and(
                      eq(workspaceMembers.workspace_id, ws.id),
                      eq(workspaceMembers.user_id, transferTo),
                    ),
                  )
                  .returning({ user_id: workspaceMembers.user_id });
                if (promoted.length !== 1) {
                  // Promotion affected zero rows: the membership vanished
                  // despite the lock — roll back rather than orphan the
                  // workspace ownerless.
                  throw new Error("sole-owner transfer promoted zero rows");
                }
                await writeAudit(tx, {
                  actorUserId: actorId,
                  workspaceId: ws.id,
                  action: "member.role_change",
                  target: transferTo,
                  detail: { to: "owner", source: "admin_sole_owner_transfer" },
                });
                outcome.transferred.push({ workspace_id: ws.id, to: transferTo });
              }
            } else {
              outcome.deleted = [];
              outcome.archived = [];
              for (const ws of sole) {
                // Try physical delete inside a savepoint: any remaining FK
                // child (api_keys, ledger history, payments, usage, requests,
                // …) rolls the savepoint back and the workspace is archived
                // instead (row retained, status 'suspended'). Money history is
                // never deleted — a wallet with ledger rows always fails the
                // wallet delete, which is exactly the archive trigger. Only
                // FK violations (23503) fall back to archive; any other error
                // propagates and rolls the WHOLE transaction back.
                try {
                  await tx.transaction(async (nested) => {
                    await nested
                      .update(auditLog)
                      .set({ workspace_id: null })
                      .where(eq(auditLog.workspace_id, ws.id));
                    await nested.delete(wallets).where(eq(wallets.workspace_id, ws.id));
                    await nested
                      .delete(workspaceMembers)
                      .where(eq(workspaceMembers.workspace_id, ws.id));
                    await nested.delete(workspaces).where(eq(workspaces.id, ws.id));
                  });
                  outcome.deleted.push(ws.id);
                } catch (e) {
                  // drizzle/bun-sql may wrap the PostgresError — walk the
                  // cause chain. Only FK violations archive; anything else
                  // propagates and rolls the whole transaction back.
                  if (!isFkViolation(e)) throw e;
                  await tx
                    .update(workspaces)
                    .set({ status: "suspended" })
                    .where(eq(workspaces.id, ws.id));
                  outcome.archived.push(ws.id);
                }
              }
            }
          } else if (transferTo) {
            violation = jsonError(
              400,
              "INVALID",
              "transfer_to requires the user to be the sole owner of a workspace",
            );
            return;
          }
          await removeUserIdentity(tx, params.id);
          // Audit INSIDE the transaction: an audit write failure rolls back
          // the entire removal (no un-audited identity destruction).
          await writeAudit(tx, {
            actorUserId: actorId,
            workspaceId: null,
            action: "user.remove",
            target: params.id,
            detail: Object.keys(outcome).length > 0 ? outcome : undefined,
          });
        });
        if (violation) return violation;
        return json({ removed: true, ...outcome });
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
        // payOS payments are credited ONLY by the verified webhook: an admin
        // 'complete' would credit without any verified provider confirmation.
        if (p.provider === "payos") {
          return json(
            {
              error: {
                code: "INVALID_STATE",
                message: "payOS payments complete only via the payOS webhook",
              },
            },
            409,
          );
        }
        if (String(p.status) === "expired") {
          return json(
            {
              error: {
                code: "INVALID_STATE",
                message: "timed-out payments require retained late-paid evidence and admin review",
              },
            },
            409,
          );
        }
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
          gateway_enabled: env.HBR_GATEWAY_ENABLED !== "0",
          usd_vnd_rate: Number(env.HBR_USD_VND_RATE) || 26000,
          payos_configured:
            !!env.PAYOS_CLIENT_ID && !!env.PAYOS_API_KEY && !!env.PAYOS_CHECKSUM_KEY,
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
