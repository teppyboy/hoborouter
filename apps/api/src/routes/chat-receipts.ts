// Per-request chat billing receipts (GET only). Read-only join requests ←
// usage_logs for one request id in the caller's workspace. Workspace members
// see only requests made with keys they own (chat receipts are tied to the
// assistant message request_id in their own conversations); workspace
// admins/owners see every request in the workspace (usage was already
// admin-visible). Other members' receipts are a plain 404 — no existence or
// cost leak. charged_vnd is the ACTUAL settled VND even for failed requests
// (full-hold settlement) — never recomputed, never forced to zero. Requests
// without a usage row are "pending" (money may still resolve); 404 only when
// the request itself is unknown to the workspace.
import { Elysia, t } from "elysia";
import type { Db } from "@hoborouter/db";
import { apiKeys, requests, usageLogs } from "@hoborouter/db";
import { and, eq } from "drizzle-orm";
import { requireSession, jsonError, wsRole } from "../authz";
import type { BetterAuthInstance } from "../auth-types";

export const chatReceiptsRoutes = (db: Db, auth: BetterAuthInstance) =>
  new Elysia({ name: "chat-receipts" })
    .get(
      "/api/v1/workspaces/:id/chat-receipts/:requestId",
      {
        params: t.Object({ id: t.String(), requestId: t.String() }),
        detail: { tags: ["Chats"], summary: "Get chat billing receipt" },
      },
      async ({ request, params }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const role = await wsRole(db, params.id, userId);
        if (!role) return jsonError(403, "FORBIDDEN", "Insufficient workspace role");
        const rows = await db
          .select({
            id: requests.id,
            status: requests.status,
            api_key_id: requests.api_key_id,
            created_at: requests.created_at,
            usage_id: usageLogs.id,
            public_model: usageLogs.public_model,
            charged_vnd: usageLogs.charged_vnd,
            failure: usageLogs.failure,
          })
          .from(requests)
          .leftJoin(usageLogs, eq(usageLogs.request_id, requests.id))
          .where(and(eq(requests.id, params.requestId), eq(requests.workspace_id, params.id)))
          .limit(1);
        const row = rows[0];
        if (!row) return jsonError(404, "NOT_FOUND", "Request not found");
        if (role === "member") {
          // Member visibility: only requests made with a key they own.
          let owner: string | null = null;
          if (row.api_key_id) {
            const keys = await db
              .select({ owner: apiKeys.owner_user_id })
              .from(apiKeys)
              .where(eq(apiKeys.id, row.api_key_id))
              .limit(1);
            owner = keys[0]?.owner ?? null;
          }
          if (owner !== userId) return jsonError(404, "NOT_FOUND", "Request not found");
        }
        const failed =
          row.usage_id !== null &&
          (row.failure !== null ||
            row.status === "upstream_error" ||
            row.status === "client_abort");
        return {
          request_id: row.id,
          status: row.usage_id === null ? "pending" : failed ? "failed" : "settled",
          // NULL while pending; actual settled VND otherwise (even failures).
          charged_vnd: row.charged_vnd ?? null,
          public_model: row.public_model ?? null,
          created_at: row.created_at,
        };
      },
    );
