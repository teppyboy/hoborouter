// Instance-level settings — instance-admin only. Currently exposes the
// global prompt-caching toggle (instance_settings.prompt_caching_enabled).
// PUT is audited as settings.update.
import { Elysia, t } from "elysia";
import { type Db } from "@hoborouter/db";
import { eq } from "drizzle-orm";
import { instanceSettings } from "@hoborouter/db";import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireInstanceAdmin, writeAudit } from "../authz";

const KEY = "prompt_caching_enabled";

async function getPromptCachingEnabled(db: Db): Promise<boolean> {
  const rows = await db
    .select({ value: instanceSettings.value })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, KEY))
    .limit(1);
  return rows[0] ? rows[0].value === "true" : true;
}

export const adminSettingsRoutes = (db: Db, auth: BetterAuthInstance) =>
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
        const denied = await requireInstanceAdmin(db, gate.session.user.id);
        if (denied) return denied;
        return new Response(
          JSON.stringify({ prompt_caching_enabled: await getPromptCachingEnabled(db) }),
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
        const denied = await requireInstanceAdmin(db, userId);
        if (denied) return denied;
        const before = await getPromptCachingEnabled(db);
        await db
          .insert(instanceSettings)
          .values({ key: KEY, value: body.prompt_caching_enabled ? "true" : "false", updated_at: Date.now() })
          .onConflictDoUpdate({
            target: instanceSettings.key,
            set: { value: body.prompt_caching_enabled ? "true" : "false", updated_at: Date.now() },
          });
        await writeAudit(db, {
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
