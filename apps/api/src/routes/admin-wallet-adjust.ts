// Admin wallet adjustment + user wallet context (FROZEN against the admin UI
// consumer apps/web/src/pages/admin/users.tsx):
// - POST /api/v1/admin/workspaces/:workspaceId/wallet/adjust
//     { delta, reason, idempotencyKey } -> AdjustReceipt (JSON body directly)
//     Explicit TOPUP wallet resolution per workspace (no user->wallet
//     inference; subscription wallets are unreachable). All money movement is
//     owned by adjustWalletBalance's SINGLE transaction; a replayed
//     (actor, idempotency_key) returns the ORIGINAL receipt, a mismatched
//     replay is 409 IDEMPOTENCY_MISMATCH. No route-level audit: the domain
//     transaction already writes the admin audit row (a failed audit rolls
//     back the money — auditing here instead would create unaudited/no-op
//     divergence).
// - GET /api/v1/admin/users/:userId/context
//     -> { memberships: [{workspaceId, workspaceName, role}],
//          wallets: [{workspaceId, kind: "topup", balance, reserved}] }
//     Read-only: a GET never mutates balances and never exposes subscription
//     wallets or other users.
// app.ts registration is the integration owner's lane; this module only
// exports the plugin.
import { Elysia, t } from "elysia";
import { and, eq } from "drizzle-orm";
import type { Db } from "@hoborouter/db";
import { users, wallets, workspaceMembers, workspaces } from "@hoborouter/db";
import { adjustWalletBalance, WalletError, type WalletErrorCode } from "@hoborouter/wallet";
import type { BetterAuthInstance } from "../auth-types";
import { jsonError, requireInstanceAdmin, requireSession } from "../authz";

/** Mounted plugin instance (already routable; .handle() works in tests). */
export type AdminWalletAdjustApp = ReturnType<typeof adminWalletAdjustRoutes>;

/** Domain error -> HTTP status/code mapping (mismatch is always 409). */
function walletErrorResponse(e: WalletError) {
  const map: Record<WalletErrorCode, [number, string]> = {
    invalid: [400, "INVALID"],
    not_found: [404, "NOT_FOUND"],
    ownership: [409, "OWNERSHIP"],
    conflict: [409, "CONFLICT"],
    terminal: [409, "TERMINAL"],
    insufficient: [409, "INSUFFICIENT"],
    overflow: [409, "OVERFLOW"],
    idempotency_mismatch: [409, "IDEMPOTENCY_MISMATCH"],
  };
  const [status, code] = map[e.code] ?? [500, "INTERNAL"];
  return jsonError(status === 500 ? 500 : status, code, e.message);
}

async function guard(db: Db, auth: BetterAuthInstance, request: Request) {
  const gate = await requireSession(auth, request);
  if ("error" in gate) return { error: gate.error } as const;
  const denied = await requireInstanceAdmin(db, gate.session.user.id);
  if (denied) return { error: denied } as const;
  return { session: gate.session } as const;
}

/** Explicit topup-wallet resolution: UNIQUE(workspace, kind='topup'). */
async function resolveTopupWallet(db: Db, workspaceId: string): Promise<string | null> {
  const rows = await db
    .select({ id: wallets.id })
    .from(wallets)
    .where(and(eq(wallets.workspace_id, workspaceId), eq(wallets.kind, "topup")))
    .limit(1);
  return rows[0]?.id ?? null;
}

export const adminWalletAdjustRoutes = (db: Db, auth: BetterAuthInstance) =>
  new Elysia({ name: "admin-wallet-adjust" })
    .post(
      "/api/v1/admin/workspaces/:workspaceId/wallet/adjust",
      {
        body: t.Object({
          delta: t.Integer(),
          reason: t.String({ minLength: 1, maxLength: 500 }),
          idempotencyKey: t.String({ minLength: 16, maxLength: 128 }),
        }),
        detail: {
          tags: ["Admin"],
          summary: "Adjust a workspace topup wallet balance",
          description:
            "Instance-admin-only. Signed non-zero VND delta on the workspace's topup wallet. Idempotent per (admin actor, idempotencyKey): a replay returns the original receipt; a different payload under the same key is 409 IDEMPOTENCY_MISMATCH.",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => {
        const g = await guard(db, auth, request);
        if ("error" in g) return g.error;
        const walletId = await resolveTopupWallet(db, params.workspaceId);
        if (!walletId)
          return jsonError(404, "NOT_FOUND", `No topup wallet for workspace ${params.workspaceId}`);
        try {
          const receipt = await adjustWalletBalance(db, {
            actorUserId: g.session.user.id,
            idempotencyKey: body.idempotencyKey,
            workspaceId: params.workspaceId,
            walletId,
            delta: body.delta,
            reason: body.reason,
          });
          // UI contract: the receipt IS the response body.
          return new Response(JSON.stringify(receipt), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        } catch (e) {
          if (e instanceof WalletError) return walletErrorResponse(e);
          throw e;
        }
      },
    )
    .get(
      "/api/v1/admin/users/:userId/context",
      {
        detail: {
          tags: ["Admin"],
          summary: "Membership + topup wallet context for the admin UI",
          description:
            "Instance-admin-only. Returns the target user's workspace memberships and every topup wallet snapshot (kind/balance/reserved) as SEPARATE arrays. Read-only: never mutates balances, never exposes subscription wallets or other users.",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
        const g = await guard(db, auth, request);
        if ("error" in g) return g.error;
        const target = (
          await db.select({ id: users.id }).from(users).where(eq(users.id, params.userId)).limit(1)
        )[0];
        if (!target) return jsonError(404, "NOT_FOUND", "User not found");
        const memberships = await db
          .select({
            workspaceId: workspaceMembers.workspace_id,
            workspaceName: workspaces.name,
            role: workspaceMembers.role,
          })
          .from(workspaceMembers)
          .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspace_id))
          .where(eq(workspaceMembers.user_id, params.userId));
        const walletsRows = await db
          .select({
            workspaceId: wallets.workspace_id,
            kind: wallets.kind,
            balance: wallets.balance,
            reserved: wallets.reserved,
          })
          .from(wallets)
          .where(eq(wallets.kind, "topup"));
        // Only topup wallets of workspaces the user belongs to — same set the
        // UI's per-workspace wallet picker resolves against.
        const memberWs = new Set(memberships.map((m) => m.workspaceId));
        const topupWallets = walletsRows
          .filter((w) => memberWs.has(w.workspaceId))
          .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
        return new Response(
          JSON.stringify({
            memberships: memberships.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
            wallets: topupWallets,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
