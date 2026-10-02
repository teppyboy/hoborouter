// Audit read per route matrix: workspace admin/owner read own-ws rows
// (requires ?workspace_id=); instance admin reads globally (no filter → all).
// Rows are enriched server-side (no N+1): actor user, workspace, and a
// human target_label/target_type derived from the action prefix.
import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireWsRole, requireInstanceAdmin, isInstanceAdmin } from "../authz";

interface AuditRow {
  id: string;
  actor_user_id: string | null;
  workspace_id: string | null;
  action: string;
  target: string | null;
  detail: string | null;
  created_at: number;
}

interface ActorInfo {
  id: string;
  name: string | null;
  email: string | null;
}

const SECRET_KEY_RE = /(secret|password|token|hash|api_key|cpa)/i;

/** Redact any detail field that looks like a secret (never render key material). */
function sanitizeDetail(raw: string | null): string | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>))
      out[k] = SECRET_KEY_RE.test(k) ? "[redacted]" : v;
    return JSON.stringify(out);
  }
  return raw;
}

function placeholderList(n: number): string {
  return new Array(n).fill("?").join(",");
}

function mapById<T>(rows: T[], key: keyof T): Map<string, T> {
  const m = new Map<string, T>();
  for (const r of rows) m.set(r[key] as string, r);
  return m;
}

/** Resolve human labels for all rows in a handful of batched IN queries. */
function enrich(rows: AuditRow[], db: Database) {
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

  const lookup = <T>(sql: string, ids: Set<string>, key: keyof T): Map<string, T> => {
    if (ids.size === 0) return new Map();
    return mapById(
      db.prepare(`${sql} WHERE id IN (${placeholderList(ids.size)})`).all(...ids) as T[],
      key,
    );
  };

  const actors = lookup<ActorInfo & { id: string }>(
    "SELECT id, name, email FROM users",
    new Set([...actorIds, ...userIds]),
    "id",
  );
  const workspaces = lookup<{ id: string; name: string }>(
    "SELECT id, name FROM workspaces",
    wsIds,
    "id",
  );
  const keys = lookup<{ id: string; name: string; key_prefix: string }>(
    "SELECT id, name, key_prefix FROM api_keys",
    keyIds,
    "id",
  );
  const payments = lookup<{ id: string; amount: number; provider: string; status: string }>(
    "SELECT id, amount, provider, status FROM payments",
    payIds,
    "id",
  );
  const models = lookup<{ id: string; public_id: string }>(
    "SELECT id, public_id FROM models",
    modelIds,
    "id",
  );

  return { actors, workspaces, keys, payments, models };
}

const MODEL_PREFIXES = ["catalog.model.", "catalog.mapping.", "catalog.price.", "model."];

function vnd(amount: number): string {
  return `${amount.toLocaleString("vi-VN")} ₫`;
}

function targetInfo(
  r: AuditRow,
  e: ReturnType<typeof enrich>,
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

export const auditRoutes = (db: Database, auth: BetterAuthInstance) =>
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
    const conds: string[] = [];
    const params: (string | number)[] = [];
    if (before) {
      conds.push("created_at < ?");
      params.push(Number(before) || 0);
    }
    if (action) {
      conds.push("action LIKE ?");
      params.push(`${action}%`);
    }
    const where = conds.length ? ` AND ${conds.join(" AND ")}` : "";
    const sql = `SELECT id, actor_user_id, workspace_id, action, target, detail, created_at FROM audit_log WHERE${
      wsId ? " workspace_id = ?" : " 1=1"
    }${where} ORDER BY created_at DESC LIMIT ${limit}`;

    let rows: AuditRow[];
    if (wsId) {
      // Instance admin may read any scope; otherwise admin/owner of that ws.
      if (!isInstanceAdmin(db, userId)) {
        const denied = requireWsRole(db, wsId, userId, "admin");
        if (denied) return denied;
      }
      rows = db.prepare(sql).all(wsId, ...params) as AuditRow[];
    } else {
      const denied = requireInstanceAdmin(db, userId);
      if (denied) return denied;
      rows = db.prepare(sql).all(...params) as AuditRow[];
    }

    const e = enrich(rows, db);
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
