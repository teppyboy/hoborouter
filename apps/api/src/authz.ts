// Task 3B authz: session resolution + role checks per api-boundaries.md §2.
// Instance admin is checked ONLY against instance_admins — never implied by
// workspace roles and never granting any workspace role.
import type { Db, Tx } from "@hoborouter/db";
import type { BetterAuthInstance } from "./auth-types";
import { and, eq } from "drizzle-orm";
import { workspaceMembers, instanceAdmins, auditLog } from "@hoborouter/db";

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

export async function wsRole(db: Db | Tx, workspaceId: string, userId: string): Promise<WsRole | null> {
  const row = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspace_id, workspaceId),
        eq(workspaceMembers.user_id, userId),
      ),
    )
    .limit(1);
  return row[0]?.role ?? null;
}

export async function isInstanceAdmin(db: Db | Tx, userId: string): Promise<boolean> {
  const row = await db
    .select({ one: instanceAdmins.user_id })
    .from(instanceAdmins)
    .where(eq(instanceAdmins.user_id, userId))
    .limit(1);
  return !!row[0];
}

const ROLE_RANK: Record<WsRole, number> = { member: 1, admin: 2, owner: 3 };

/** Membership + minimum-role guard for ws-scoped routes. Instance admins get nothing here. */
export async function requireWsRole(db: Db | Tx, workspaceId: string, userId: string, min: WsRole) {
  const role = await wsRole(db, workspaceId, userId);
  if (!role || ROLE_RANK[role] < ROLE_RANK[min]) {
    return jsonError(403, "FORBIDDEN", "Insufficient workspace role");
  }
  return null;
}

export async function requireInstanceAdmin(db: Db | Tx, userId: string) {
  if (!(await isInstanceAdmin(db, userId))) {
    return jsonError(403, "FORBIDDEN", "Instance admin required");
  }
  return null;
}

export async function writeAudit(
  db: Db | Tx,
  opts: {
    actorUserId: string | null;
    workspaceId: string | null;
    action: string;
    target: string;
    detail?: unknown;
  },
) {
  await db.insert(auditLog).values({
    id: crypto.randomUUID(),
    actor_user_id: opts.actorUserId,
    workspace_id: opts.workspaceId,
    action: opts.action,
    target: opts.target,
    detail: opts.detail === undefined ? null : opts.detail,
    created_at: Date.now(),
  });
}
