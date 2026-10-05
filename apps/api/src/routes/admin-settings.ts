// Instance-level settings — instance-admin only. Currently exposes the
// global prompt-caching toggle (instance_settings.prompt_caching_enabled).
// PUT is audited as settings.update.
import { Elysia, t } from "elysia";
import { type Db } from "@hoborouter/db";
import { eq } from "drizzle-orm";
import { instanceSettings } from "@hoborouter/db";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireInstanceAdmin, writeAudit } from "../authz";
import { isFirstTopupBonusEnabled } from "@hoborouter/payments";
import {
  PAYMENT_TIMEOUT_MINUTES_KEY,
  PAYMENT_MAX_AMOUNT_VND_KEY,
  PAYMENT_USD_VND_RATE_KEY,
  MIN_PAYMENT_TIMEOUT_MINUTES,
  MAX_PAYMENT_TIMEOUT_MINUTES,
  parsePaymentTimeoutMinutes,
  parsePaymentMaxAmountVnd,
  parsePaymentUsdVndRate,
} from "@hoborouter/payments";

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

async function getPaymentTimeoutMinutes(db: Db): Promise<number> {
  return parsePaymentTimeoutMinutes(await getSettingValue(db, PAYMENT_TIMEOUT_MINUTES_KEY));
}

async function getPaymentMaxAmountVnd(db: Db): Promise<number> {
  return parsePaymentMaxAmountVnd(await getSettingValue(db, PAYMENT_MAX_AMOUNT_VND_KEY));
}

async function getPaymentUsdVndRate(db: Db): Promise<number> {
  return parsePaymentUsdVndRate(await getSettingValue(db, PAYMENT_USD_VND_RATE_KEY));
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
            payment_timeout_minutes: await getPaymentTimeoutMinutes(db),
            payment_max_amount_vnd: await getPaymentMaxAmountVnd(db),
            payment_usd_vnd_rate: await getPaymentUsdVndRate(db),
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
          // Payment controls: timeout bounds 1..1440 minutes; max amount and
          // USD FX rate are positive safe integers.
          payment_timeout_minutes: t.Optional(t.Union([t.Integer(), t.String()])),
          payment_max_amount_vnd: t.Optional(t.Union([t.Integer(), t.String()])),
          payment_usd_vnd_rate: t.Optional(t.Union([t.Integer(), t.String()])),
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

        // Trust boundary: validate the ENTIRE body before persisting anything.
        // A mixed valid/invalid PUT (e.g. valid prompt_caching + invalid bonus
        // amount) must fail with NO keys written (no partial persistence).
        let bonusAmount: number | null = null;
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
          bonusAmount = n;
        }

        // Trust boundary: validate the ENTIRE body before persisting anything
        // (no partial persistence on mixed valid/invalid PUTs).
        const invalid = (message: string) =>
          new Response(JSON.stringify({ error: { code: "INVALID", message } }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        const asInt = (raw: number | string): number | null => {
          const n = typeof raw === "string" ? Number(raw.trim()) : raw;
          return typeof n === "number" && Number.isSafeInteger(n) ? n : null;
        };
        let timeoutMinutes: number | null = null;
        if (body.payment_timeout_minutes !== undefined) {
          const n = asInt(body.payment_timeout_minutes);
          if (n === null || n < MIN_PAYMENT_TIMEOUT_MINUTES || n > MAX_PAYMENT_TIMEOUT_MINUTES) {
            return invalid(
              `payment_timeout_minutes must be an integer between ${MIN_PAYMENT_TIMEOUT_MINUTES} and ${MAX_PAYMENT_TIMEOUT_MINUTES}`,
            );
          }
          timeoutMinutes = n;
        }
        let maxAmountVnd: number | null = null;
        if (body.payment_max_amount_vnd !== undefined) {
          const n = asInt(body.payment_max_amount_vnd);
          if (n === null || n <= 0) {
            return invalid("payment_max_amount_vnd must be a positive safe integer");
          }
          maxAmountVnd = n;
        }
        let usdVndRate: number | null = null;
        if (body.payment_usd_vnd_rate !== undefined) {
          const n = asInt(body.payment_usd_vnd_rate);
          if (n === null || n <= 0) {
            return invalid("payment_usd_vnd_rate must be a positive safe integer");
          }
          usdVndRate = n;
        }

        const setSetting = async (
          tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
          key: string,
          value: string,
        ) => {
          await tx
            .insert(instanceSettings)
            .values({ key, value, updated_at: Date.now() })
            .onConflictDoUpdate({
              target: instanceSettings.key,
              set: { value, updated_at: Date.now() },
            });
        };

        // One transaction: settings writes + their audit rows commit or roll
        // back together (same guarantee as support-settings PUT) — a mid-PUT
        // failure can never leave a key persisted without its audit row.
        await db.transaction(async (tx) => {
          if (body.prompt_caching_enabled !== undefined) {
            const before = await getPromptCachingEnabled(db);
            await setSetting(tx, KEY, body.prompt_caching_enabled ? "true" : "false");
            await writeAudit(tx, {
              actorUserId: userId,
              workspaceId: null,
              action: "settings.update",
              target: KEY,
              detail: { before, after: body.prompt_caching_enabled },
            });
          }

          if (body.first_topup_bonus_enabled !== undefined) {
            const before = await getFirstTopupBonusEnabled(db);
            await setSetting(
              tx,
              BONUS_ENABLED_KEY,
              body.first_topup_bonus_enabled ? "true" : "false",
            );
            await writeAudit(tx, {
              actorUserId: userId,
              workspaceId: null,
              action: "settings.update",
              target: BONUS_ENABLED_KEY,
              detail: { before, after: body.first_topup_bonus_enabled },
            });
          }

          if (bonusAmount !== null) {
            const before = await getFirstTopupBonusAmount(db);
            await setSetting(tx, BONUS_AMOUNT_KEY, String(bonusAmount));
            await writeAudit(tx, {
              actorUserId: userId,
              workspaceId: null,
              action: "settings.update",
              target: BONUS_AMOUNT_KEY,
              detail: { before, after: bonusAmount },
            });
          }

          if (timeoutMinutes !== null) {
            const before = await getPaymentTimeoutMinutes(db);
            await setSetting(tx, PAYMENT_TIMEOUT_MINUTES_KEY, String(timeoutMinutes));
            await writeAudit(tx, {
              actorUserId: userId,
              workspaceId: null,
              action: "settings.update",
              target: PAYMENT_TIMEOUT_MINUTES_KEY,
              detail: { before, after: timeoutMinutes },
            });
          }

          if (maxAmountVnd !== null) {
            const before = await getPaymentMaxAmountVnd(db);
            await setSetting(tx, PAYMENT_MAX_AMOUNT_VND_KEY, String(maxAmountVnd));
            await writeAudit(tx, {
              actorUserId: userId,
              workspaceId: null,
              action: "settings.update",
              target: PAYMENT_MAX_AMOUNT_VND_KEY,
              detail: { before, after: maxAmountVnd },
            });
          }

          if (usdVndRate !== null) {
            const before = await getPaymentUsdVndRate(db);
            await setSetting(tx, PAYMENT_USD_VND_RATE_KEY, String(usdVndRate));
            await writeAudit(tx, {
              actorUserId: userId,
              workspaceId: null,
              action: "settings.update",
              target: PAYMENT_USD_VND_RATE_KEY,
              detail: { before, after: usdVndRate },
            });
          }
        });

        return new Response(
          JSON.stringify({
            prompt_caching_enabled:
              body.prompt_caching_enabled ?? (await getPromptCachingEnabled(db)),
            first_topup_bonus_enabled: await getFirstTopupBonusEnabled(db),
            first_topup_bonus_amount_vnd:
              bonusAmount !== null ? bonusAmount : await getFirstTopupBonusAmount(db),
            payment_timeout_minutes:
              timeoutMinutes !== null ? timeoutMinutes : await getPaymentTimeoutMinutes(db),
            payment_max_amount_vnd:
              maxAmountVnd !== null ? maxAmountVnd : await getPaymentMaxAmountVnd(db),
            payment_usd_vnd_rate: usdVndRate !== null ? usdVndRate : await getPaymentUsdVndRate(db),
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    );
