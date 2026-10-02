// Audit read per route matrix: workspace admin/owner read own-ws rows
// (requires ?workspace_id=); instance admin reads globally (no filter → all).
// Rows are enriched server-side (no N+1): actor user, workspace, and a
// human target_label/target_type derived from the action prefix.
import { Elysia } from "elysia";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireWsRole, requireInstanceAdmin, isInstanceAdmin } from "../authz";
import { and, desc, eq, inArray, like, sql, type SQL } from "drizzle-orm";
import { type Db, users, workspaces, apiKeys, payments, models, auditLog } from "@hoborouter/db";

interface AuditRow {
  id: string;
  actor_user_id: string | null;
  workspace_id: string | null;
  action: string;
  target: string | null;
  detail: unknown;
  created_at: number;
}

const SECRET_KEY_RE = /(secret|password|token|hash|api_key|cpa)/i;

/** Redact any detail field that looks like a secret (never render key material). */
function sanitizeDetail(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>))
    out[k] = SECRET_KEY_RE.test(k) ? "[redacted]" : v;
  return out;
}

/** Resolve human labels for all rows in a handful of batched IN queries. */
async function enrich(rows: AuditRow[], db: Db) {
  const actorIds = new Set<string>();
  const wsIds = new Set<string>();
  const keyIds = new Set<string>();
  const payIds = new Set<string>();
  const modelIds = new Set<string>();
  const userIds = new Set<string>(); // member.* targets

  for (const r of rows) {
    if (r.actor_user_id) actorIds.add(r.actor_user_id);
    if (r.workspace_id) wsIds.add(r.workspace_id);
    const t = r.target;
    if (!t) continue;
    if (r.action.startsWith("workspace.")) wsIds.add(t);
    else if (r.action.startsWith("key.")) keyIds.add(t);
    else if (r.action.startsWith("payment.")) payIds.add(t);
    else if (
      r.action.startsWith("catalog.model.") ||
      r.action.startsWith("catalog.mapping.") ||
      r.action.startsWith("catalog.price.") ||
      r.action.startsWith("model.")
    )
      modelIds.add(t);
    else if (r.action.startsWith("member.")) userIds.add(t);
  }

  const byId = <T extends { id: string }>(rows: T[]): Map<string, T> =>
    new Map(rows.map((r) => [r.id, r]));
  const lookup = async <T extends { id: string }>(
    q: (ids: string[]) => Promise<T[]>,
    ids: Set<string>,
  ): Promise<Map<string, T>> => (ids.size === 0 ? new Map() : byId(await q([...ids])));

  const actors = await lookup(
    (ids) =>
      db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(inArray(users.id, ids)),
    new Set([...actorIds, ...userIds]),
  );
  const workspacesById = await lookup(
    (ids) =>
      db
        .select({ id: workspaces.id, name: workspaces.name })
        .from(workspaces)
        .where(inArray(workspaces.id, ids)),
    wsIds,
  );
  const keys = await lookup(
    (ids) =>
      db
        .select({ id: apiKeys.id, name: apiKeys.name, key_prefix: apiKeys.key_prefix })
        .from(apiKeys)
        .where(inArray(apiKeys.id, ids)),
    keyIds,
  );
  const paymentsById = await lookup(
    (ids) =>
      db
        .select({
          id: payments.id,
          amount: payments.amount,
          provider: payments.provider,
          status: payments.status,
        })
        .from(payments)
        .where(inArray(payments.id, ids)),
    payIds,
  );
  const modelsById = await lookup(
    (ids) =>
      db.select({ id: models.id, public_id: models.public_id }).from(models).where(inArray(models.id, ids)),
    modelIds,
  );

  return {
    actors,
    workspaces: workspacesById,
    keys,
    payments: paymentsById,
    models: modelsById,
  };
}

const MODEL_PREFIXES = ["catalog.model.", "catalog.mapping.", "catalog.price.", "model."];

function vnd(amount: number): string {
  return `${amount.toLocaleString("vi-VN")} ₫`;
}

function targetInfo(
  r: AuditRow,
  e: Awaited<ReturnType<typeof enrich>>,
): { type: string | null; label: string | null; meta: Record<string, unknown> | null } {
  const t = r.target;
  if (!t) return { type: null, label: null, meta: null };
  if (r.action.startsWith("workspace.")) {
    const ws = e.workspaces.get(t);
    return { type: "workspace", label: ws?.name ?? null, meta: ws ? { id: t } : null };
  }
  if (r.action.startsWith("key.")) {
    const k = e.keys.get(t);
    if (!k) return { type: "api key", label: null, meta: null };
    return { type: "api key", label: k.name, meta: { id: t, prefix: k.key_prefix } };
  }
  if (r.action.startsWith("payment.")) {
    const p = e.payments.get(t);
    if (!p) return { type: "payment", label: null, meta: null };
    return {
      type: "payment",
      label: `${vnd(p.amount)} ${p.provider} top-up`,
      meta: { id: t, amount: p.amount, provider: p.provider, status: p.status },
    };
  }
  if (MODEL_PREFIXES.some((p) => r.action.startsWith(p))) {
    const m = e.models.get(t);
    return { type: "model", label: m?.public_id ?? null, meta: m ? { id: t } : null };
  }
  if (r.action.startsWith("member.")) {
    const u = e.actors.get(t);
    if (!u) return { type: "member", label: null, meta: null };
    return {
      type: "member",
      label: u.name || u.email || null,
      meta: { id: t, email: u.email },
    };
  }
  return { type: null, label: null, meta: null };
}

export const auditRoutes = (db: Db, auth: BetterAuthInstance) =>
  new Elysia({ name: "audit" }).get("/api/v1/audit", async (ctx) => {
    const request: Request = ctx.request;
    const q = new URL(request.url).searchParams;
    const wsId = q.get("workspace_id");
    const gate = await requireSession(auth, request);
    if ("error" in gate) return gate.error;
    const userId = gate.session.user.id;

    // Optional filters: action prefix, cursor pagination (created_at < before).
    const limit = Math.min(Math.max(Number(q.get("limit")) || 100, 1), 200);
    const before = q.get("before");
    const action = q.get("action");
    const filters: SQL[] = [];
    if (before) filters.push(sql`${auditLog.created_at} < ${Number(before) || 0}`);
    if (action) filters.push(like(auditLog.action, `${action}%`));
    if (wsId) filters.push(eq(auditLog.workspace_id, wsId));
    const where = filters.length ? and(...filters) : undefined;

    let rows: AuditRow[];
    if (wsId) {
      // Instance admin may read any scope; otherwise admin/owner of that ws.
      if (!(await isInstanceAdmin(db, userId))) {
        const denied = await requireWsRole(db, wsId, userId, "admin");
        if (denied) return denied;
      }
    } else {
      const denied = await requireInstanceAdmin(db, userId);
      if (denied) return denied;
    }
    rows = await db
      .select({
        id: auditLog.id,
        actor_user_id: auditLog.actor_user_id,
        workspace_id: auditLog.workspace_id,
        action: auditLog.action,
        target: auditLog.target,
        detail: auditLog.detail,
        created_at: auditLog.created_at,
      })
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.created_at))
      .limit(limit);

    const e = await enrich(rows, db);
    return rows.map((r) => {
      const ti = targetInfo(r, e);
      const actor = r.actor_user_id ? e.actors.get(r.actor_user_id) : undefined;
      const ws = r.workspace_id ? e.workspaces.get(r.workspace_id) : undefined;
      return {
        ...r,
        detail: sanitizeDetail(r.detail),
        actor: actor ? { id: actor.id, name: actor.name, email: actor.email } : null,
        workspace: ws ? { id: ws.id, name: ws.name } : null,
        target_label: ti.label,
        target_type: ti.type,
        target_meta: ti.meta,
      };
    });
  });
