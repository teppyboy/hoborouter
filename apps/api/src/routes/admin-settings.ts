// Instance-level settings — instance-admin only. Currently exposes the
// global prompt-caching toggle (instance_settings.prompt_caching_enabled).
// PUT is audited as settings.update.
import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireInstanceAdmin, writeAudit } from "../authz";

const KEY = "prompt_caching_enabled";

function getPromptCachingEnabled(db: Database): boolean {
  const row = db.prepare("SELECT value FROM instance_settings WHERE key = ?").get(KEY) as
    | { value: string }
    | undefined;
  return row ? row.value === "true" : true;
}

export const adminSettingsRoutes = (db: Database, auth: BetterAuthInstance) =>
  new Elysia({ name: "admin-settings" })
    .get(
      "/api/v1/admin/settings",
      {
        detail: {
          tags: ["Admin"],
          summary: "Get instance settings",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const denied = requireInstanceAdmin(db, gate.session.user.id);
        if (denied) return denied;
        return new Response(
          JSON.stringify({ prompt_caching_enabled: getPromptCachingEnabled(db) }),
          { headers: { "content-type": "application/json" } },
        );
      },
    )
    .put(
      "/api/v1/admin/settings",
      {
        body: t.Object({ prompt_caching_enabled: t.Boolean() }),
        detail: {
          tags: ["Admin"],
          summary: "Update instance settings",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, body }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const denied = requireInstanceAdmin(db, userId);
        if (denied) return denied;
        const before = getPromptCachingEnabled(db);
        db.prepare(
          "INSERT INTO instance_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        ).run(KEY, body.prompt_caching_enabled ? "true" : "false", Date.now());
        writeAudit(db, {
          actorUserId: userId,
          workspaceId: null,
          action: "settings.update",
          target: KEY,
          detail: { before, after: body.prompt_caching_enabled },
        });
        return new Response(
          JSON.stringify({ prompt_caching_enabled: body.prompt_caching_enabled }),
          { headers: { "content-type": "application/json" } },
        );
      },
    );
