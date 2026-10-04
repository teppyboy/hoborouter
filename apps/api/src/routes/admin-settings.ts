// Instance-level settings — instance-admin only. Currently exposes the
// global prompt-caching toggle (instance_settings.prompt_caching_enabled).
// PUT is audited as settings.update.
import { Elysia, t } from "elysia";
import { type Db } from "@hoborouter/db";
import { eq } from "drizzle-orm";
import { instanceSettings } from "@hoborouter/db";import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireInstanceAdmin, writeAudit } from "../authz";
import { isFirstTopupBonusEnabled } from "@hoborouter/payments";

const KEY = "prompt_caching_enabled";
const BONUS_ENABLED_KEY = "first_topup_bonus_enabled";
const BONUS_AMOUNT_KEY = "first_topup_bonus_amount_vnd";
// Default when the amount key is missing; invalid values mean "no bonus".
const DEFAULT_BONUS_AMOUNT = 20000;

async function getSettingValue(db: Db, key: string): Promise<string | null> {
  const rows = await db
    .select({ value: instanceSettings.value })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, key))
    .limit(1);
  return rows[0]?.value ?? null;
}

async function getPromptCachingEnabled(db: Db): Promise<boolean> {
  return (await getSettingValue(db, KEY)) === "false" ? false : true;
}

// Only the exact string "false" disables; missing/anything else = enabled.
// Reads the shared payments predicate so settlement cannot drift from here.
async function getFirstTopupBonusEnabled(db: Db): Promise<boolean> {
  return isFirstTopupBonusEnabled(await getSettingValue(db, BONUS_ENABLED_KEY));
}

// Positive safe integer, or null when invalid ("invalid means no bonus").
function parseBonusAmount(raw: string): number | null {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

async function getFirstTopupBonusAmount(db: Db): Promise<number | null> {
  const raw = await getSettingValue(db, BONUS_AMOUNT_KEY);
  if (raw === null) return DEFAULT_BONUS_AMOUNT;
  return parseBonusAmount(raw);
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
          JSON.stringify({
            prompt_caching_enabled: await getPromptCachingEnabled(db),
            first_topup_bonus_enabled: await getFirstTopupBonusEnabled(db),
            first_topup_bonus_amount_vnd: await getFirstTopupBonusAmount(db),
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    )
    .put(
      "/api/v1/admin/settings",
      {
        body: t.Object({
          prompt_caching_enabled: t.Optional(t.Boolean()),
          // Whitelisted first-topup-bonus keys; unknown keys fall through and
          // are ignored (only whitelisted keys are ever persisted).
          first_topup_bonus_enabled: t.Optional(t.Boolean()),
          first_topup_bonus_amount_vnd: t.Optional(t.Union([t.Integer(), t.String()])),
        }),
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

        const setSetting = async (key: string, value: string) => {
          await db
            .insert(instanceSettings)
            .values({ key, value, updated_at: Date.now() })
            .onConflictDoUpdate({
              target: instanceSettings.key,
              set: { value, updated_at: Date.now() },
            });
        };

        if (body.prompt_caching_enabled !== undefined) {
          const before = await getPromptCachingEnabled(db);
          await setSetting(KEY, body.prompt_caching_enabled ? "true" : "false");
          await writeAudit(db, {
            actorUserId: userId,
            workspaceId: null,
            action: "settings.update",
            target: KEY,
            detail: { before, after: body.prompt_caching_enabled },
          });
        }

        if (body.first_topup_bonus_enabled !== undefined) {
          const before = await getFirstTopupBonusEnabled(db);
          await setSetting(BONUS_ENABLED_KEY, body.first_topup_bonus_enabled ? "true" : "false");
          await writeAudit(db, {
            actorUserId: userId,
            workspaceId: null,
            action: "settings.update",
            target: BONUS_ENABLED_KEY,
            detail: { before, after: body.first_topup_bonus_enabled },
          });
        }

        if (body.first_topup_bonus_amount_vnd !== undefined) {
          // Accept an integer or a decimal-string of one; stored canonically
          // as a string (instance_settings is a KV of strings).
          const raw = body.first_topup_bonus_amount_vnd;
          const n = typeof raw === "string" ? parseBonusAmount(raw.trim()) : raw;
          if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) {
            return new Response(
              JSON.stringify({
                error: {
                  code: "INVALID",
                  message: "first_topup_bonus_amount_vnd must be a positive safe integer",
                },
              }),
              { status: 400, headers: { "content-type": "application/json" } },
            );
          }
          const before = await getFirstTopupBonusAmount(db);
          await setSetting(BONUS_AMOUNT_KEY, String(n));
          await writeAudit(db, {
            actorUserId: userId,
            workspaceId: null,
            action: "settings.update",
            target: BONUS_AMOUNT_KEY,
            detail: { before, after: n },
          });
          return new Response(
            JSON.stringify({
              prompt_caching_enabled: await getPromptCachingEnabled(db),
              first_topup_bonus_enabled: await getFirstTopupBonusEnabled(db),
              first_topup_bonus_amount_vnd: n,
            }),
            { headers: { "content-type": "application/json" } },
          );
        }

        return new Response(
          JSON.stringify({
            prompt_caching_enabled: body.prompt_caching_enabled ?? (await getPromptCachingEnabled(db)),
            first_topup_bonus_enabled: await getFirstTopupBonusEnabled(db),
            first_topup_bonus_amount_vnd: await getFirstTopupBonusAmount(db),
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    );
