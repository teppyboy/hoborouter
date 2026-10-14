// Member chat policy (migration 0025): workspace-scoped admin policy +
// self-service member access snapshot. PUT is the ONLY writer of
// workspaces.member_chat_* and NEVER touches member_chat_usage — historical
// period rows (and the live holds inside them) are never reset by a policy
// update. CSRF: strict exact-origin + JSON content-type, same protocol as the
// admin CPA panel (cookie session + cross-site POST protection).
import { Elysia, t } from "elysia";
import { type Db } from "@hoborouter/db";
import { and, eq } from "drizzle-orm";
import { workspaces, workspaceMembers } from "@hoborouter/db";
import { getMemberChatContext } from "@hoborouter/keys";
import type { MemberChatAccess, MemberChatPolicy } from "@hoborouter/shared";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireWsRole, writeAudit, jsonError } from "../authz";
import { memberChatDayEndMs } from "@hoborouter/keys";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/**
 * Strict positive safe integer VND (an enabled policy is ALWAYS explicitly
 * capped; the DB CHECK workspaces_member_chat_cap_required mirrors this).
 */
function parseDailyCap(raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) return undefined;
  return raw;
}

export const memberChatPolicyRoutes = (
  db: Db,
  auth: BetterAuthInstance,
  env: Record<string, string | undefined> = process.env,
) => {
  // The actual configured origin (never a permissive wildcard): cookie-session
  // mutations must come from this exact app origin with a JSON content type.
  const origin = new URL(env.BETTER_AUTH_URL || env.HBR_BASE_URL || "http://localhost:3000")
    .origin;

  return new Elysia({ name: "member-chat-policy" })
    .get(
      "/api/v1/workspaces/:id/member-chat-policy",
      {
        params: t.Object({ id: t.String() }),
        detail: {
          tags: ["Keys"],
          summary: "Get member chat policy",
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
            enabled: workspaces.member_chat_enabled,
            cap: workspaces.member_chat_daily_cap_vnd,
          })
          .from(workspaces)
          .where(eq(workspaces.id, params.id))
          .limit(1);
        if (!rows[0]) return jsonError(404, "NOT_FOUND", "Workspace not found");
        const body: MemberChatPolicy = {
          enabled: rows[0].enabled,
          // CHECK keeps NULL ⟺ disabled; normalize for the wire anyway.
          daily_cap_vnd: rows[0].enabled ? rows[0].cap : null,
        };
        return json(body);
      },
    )
    .put(
      "/api/v1/workspaces/:id/member-chat-policy",
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({
          enabled: t.Boolean(),
          daily_cap_vnd: t.Optional(t.Any()),
        }),
        detail: {
          tags: ["Keys"],
          summary: "Set member chat policy (never resets usage or holds)",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params, body }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const denied = await requireWsRole(db, params.id, userId, "admin");
        if (denied) return denied;
        // CSRF: exact configured origin + JSON-only body. A cross-site form or
        // no-cors fetch cannot produce either.
        if (request.headers.get("origin") !== origin)
          return jsonError(403, "FORBIDDEN", "Exact app Origin required");
        if (
          !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
            request.headers.get("content-type") || "",
          )
        )
          return jsonError(415, "INVALID", "JSON content type required");
        const enabled = body.enabled;
        const cap = parseDailyCap(body.daily_cap_vnd);
        // Explicit positive cap required to enable; disabled normalizes the
        // cap to NULL (an absent cap on disable is an implicit null).
        if (enabled && (cap === null || cap === undefined))
          return jsonError(
            400,
            "INVALID",
            "daily_cap_vnd must be a positive integer when enabling member chat",
          );
        const nextCap = enabled ? (cap as number) : null;
        // Workspace row lock: serialized with the reserve-path admission (which
        // locks the workspace row after api_keys) so a policy flip can never
        // interleave mid-admission. Only the two policy columns change —
        // member_chat_usage rows are historical and never reset.
        let notFound = false;
        await db.transaction(async (tx) => {
          const ws = await tx
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(eq(workspaces.id, params.id))
            .for("update")
            .limit(1);
          if (!ws[0]) {
            notFound = true;
            return;
          }
          await tx
            .update(workspaces)
            .set({ member_chat_enabled: enabled, member_chat_daily_cap_vnd: nextCap })
            .where(eq(workspaces.id, params.id));
          await writeAudit(tx, {
            actorUserId: userId,
            workspaceId: params.id,
            action: "member_chat.policy.update",
            target: params.id,
            detail: { enabled, daily_cap_vnd: nextCap },
          });
        });
        if (notFound) return jsonError(404, "NOT_FOUND", "Workspace not found");
        const policy: MemberChatPolicy = { enabled, daily_cap_vnd: nextCap };
        return json(policy);
      },
    )
    .get(
      "/api/v1/workspaces/:id/member-chat-access",
      {
        params: t.Object({ id: t.String() }),
        detail: {
          tags: ["Keys"],
          summary: "Member chat access snapshot (self)",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, params }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const membership = await db
          .select({ role: workspaceMembers.role })
          .from(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspace_id, params.id),
              eq(workspaceMembers.user_id, userId),
            ),
          )
          .limit(1);
        // Any workspace role (owner/admin/member) counts as an authorized
        // member; outsiders get the same 404 as an unknown workspace.
        if (!membership[0]) return jsonError(404, "NOT_FOUND", "Workspace not found");
        const ctx = await getMemberChatContext(db, {
          workspaceId: params.id,
          userId,
          now: Date.now(),
        });
        const body: MemberChatAccess = {
          role: membership[0].role,
          can_chat: ctx.enabled && ctx.isMember,
          daily_cap_vnd: ctx.capVnd,
          used_vnd: ctx.usedVnd,
          remaining_vnd: ctx.remainingVnd,
          resets_at: memberChatDayEndMs(Date.now()),
        };
        return json(body);
      },
    );
};
