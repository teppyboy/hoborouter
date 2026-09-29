// Task 3B authz: session resolution + role checks per api-boundaries.md §2.
// Instance admin is checked ONLY against instance_admins — never implied by
// workspace roles and never granting any workspace role.
import type { Database } from "bun:sqlite";
import type { BetterAuthInstance } from "./auth-types";

export type WsRole = "owner" | "admin" | "member";

export function jsonError(status: number, code: string, message: string) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Resolve the Better Auth session from the request cookie. */
export async function getSession(auth: BetterAuthInstance, request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  return session ?? null;
}

/** 401 guard. Returns the session or a 401 Response. */
export async function requireSession(auth: BetterAuthInstance, request: Request) {
  const session = await getSession(auth, request);
  if (!session)
    return { error: jsonError(401, "UNAUTHORIZED", "Authentication required") } as const;
  return { session } as const;
}

export function wsRole(db: Database, workspaceId: string, userId: string): WsRole | null {
  const row = db
    .prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
    .get(workspaceId, userId) as { role: WsRole } | undefined;
  return row?.role ?? null;
}

export function isInstanceAdmin(db: Database, userId: string): boolean {
  return !!db.prepare("SELECT 1 FROM instance_admins WHERE user_id = ?").get(userId);
}

const ROLE_RANK: Record<WsRole, number> = { member: 1, admin: 2, owner: 3 };

/** Membership + minimum-role guard for ws-scoped routes. Instance admins get nothing here. */
export function requireWsRole(db: Database, workspaceId: string, userId: string, min: WsRole) {
  const role = wsRole(db, workspaceId, userId);
  if (!role || ROLE_RANK[role] < ROLE_RANK[min]) {
    return jsonError(403, "FORBIDDEN", "Insufficient workspace role");
  }
  return null;
}

export function requireInstanceAdmin(db: Database, userId: string) {
  if (!isInstanceAdmin(db, userId)) {
    return jsonError(403, "FORBIDDEN", "Instance admin required");
  }
  return null;
}

export function writeAudit(
  db: Database,
  opts: {
    actorUserId: string | null;
    workspaceId: string | null;
    action: string;
    target: string;
    detail?: unknown;
  },
) {
  db.prepare(
    "INSERT INTO audit_log (id, actor_user_id, workspace_id, action, target, detail, created_at) VALUES (?,?,?,?,?,?,?)",
  ).run(
    crypto.randomUUID(),
    opts.actorUserId,
    opts.workspaceId,
    opts.action,
    opts.target,
    opts.detail === undefined ? null : JSON.stringify(opts.detail),
    Date.now(),
  );
}
