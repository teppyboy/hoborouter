// Instance-admin support/channel settings (BMC P1-3). Deliberately a separate
// module + route (/api/v1/admin/support-settings) so the existing
// GET/PUT /api/v1/admin/settings exact response contract is untouched.
// Trust boundary: only the whitelisted keys below are ever persisted; the WHOLE
// body is validated BEFORE any write (no partial persistence); every change is
// audited as settings.update. URLs must be HTTPS (no javascript:/data:/http:,
// no userinfo, no control characters); email is strictly validated.
import { Elysia, t } from "elysia";
import { type Db } from "@hoborouter/db";
import { instanceSettings } from "@hoborouter/db";
import { eq } from "drizzle-orm";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, requireInstanceAdmin, writeAudit } from "../authz";

// Setting keys (instance_settings is a KV of strings).
const KEYS = [
  "display_name",
  "support_email",
  "support_telegram",
  "support_facebook",
  "support_threads",
] as const;
type Key = (typeof KEYS)[number];

// Strict email shape: no whitespace/control characters, one @, non-empty local
// part, dot-separated alphanumeric labels, 2+ letter TLD.
export const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
// RFC 5321 upper bound for a full email address.
export const EMAIL_MAX = 254;

export const hasControlChars = (s: string) => /[\u0000-\u001f\u007f]/.test(s);

export function validateEmail(raw: string): string | null {
  const v = raw.trim();
  if (!v || v.length > EMAIL_MAX || hasControlChars(v) || !EMAIL_RE.test(v)) return null;
  return v;
}

// Public display channels: HTTPS-only absolute URL, no embedded credentials.
function validateHttpsUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v || hasControlChars(v)) return null;
  // Reject protocol-relative ("//host") and backslash tricks outright: the
  // WHATWG parser folds "\\" into "/" for special schemes, so a raw string
  // with backslashes or no scheme must never be stored or rendered.
  if (v.includes("\\") || v.startsWith("//")) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (!u.hostname || !u.hostname.includes(".")) return null;
  return u.toString();
}

function validateDisplayName(raw: string): string | null {
  const v = raw.trim();
  if (!v || v.length > 100 || hasControlChars(v)) return null;
  return v;
}

const VALIDATORS: Record<Key, (raw: string) => string | null> = {
  display_name: validateDisplayName,
  support_email: validateEmail,
  support_telegram: validateHttpsUrl,
  support_facebook: validateHttpsUrl,
  support_threads: validateHttpsUrl,
};

type SupportShape = {
  display_name: string | null;
  support: {
    email: string | null;
    telegram: string | null;
    facebook: string | null;
    threads: string | null;
  };
};

async function readShape(db: Db): Promise<SupportShape> {
  const rows = await db
    .select({ key: instanceSettings.key, value: instanceSettings.value })
    .from(instanceSettings);
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    display_name: map.get("display_name") ?? null,
    support: {
      email: map.get("support_email") ?? null,
      telegram: map.get("support_telegram") ?? null,
      facebook: map.get("support_facebook") ?? null,
      threads: map.get("support_threads") ?? null,
    },
  };
}

const invalid = (message: string) =>
  new Response(JSON.stringify({ error: { code: "INVALID", message } }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });

const strOrNull = t.Optional(t.Union([t.String(), t.Null()]));

export const supportSettingsRoutes = (db: Db, auth: BetterAuthInstance) =>
  new Elysia({ name: "support-settings" })
    .get(
      "/api/v1/admin/support-settings",
      {
        detail: {
          tags: ["Admin"],
          summary: "Get support/channel settings",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const denied = await requireInstanceAdmin(db, gate.session.user.id);
        if (denied) return denied;
        return readShape(db);
      },
    )
    .put(
      "/api/v1/admin/support-settings",
      {
        // Whitelisted keys only; anything else is rejected by the schema.
        body: t.Object({
          display_name: strOrNull,
          support_email: strOrNull,
          support_telegram: strOrNull,
          support_facebook: strOrNull,
          support_threads: strOrNull,
        }),
        detail: {
          tags: ["Admin"],
          summary: "Update support/channel settings",
          security: [{ cookieAuth: [] }],
        },
      },
      async ({ request, body }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const denied = await requireInstanceAdmin(db, userId);
        if (denied) return denied;

        // Validate the ENTIRE body before persisting anything: null clears,
        // a string must pass its validator — no partial writes on mixed input.
        const updates = new Map<Key, string | null>();
        for (const key of KEYS) {
          const raw = body[key];
          if (raw === undefined) continue;
          if (raw === null) {
            updates.set(key, null);
            continue;
          }
          const valid = VALIDATORS[key](raw);
          if (valid === null) {
            return invalid(
              key === "support_email"
                ? "support_email must be a valid email address"
                : key === "display_name"
                  ? "display_name must be a non-empty string without control characters"
                  : `${key} must be an HTTPS URL without credentials`,
            );
          }
          updates.set(key, valid);
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
        // back together, so a partial audit trail is impossible.
        await db.transaction(async (tx) => {
          for (const [key, value] of updates) {
            const before =
              (
                await tx
                  .select({ value: instanceSettings.value })
                  .from(instanceSettings)
                  .where(eq(instanceSettings.key, key))
                  .limit(1)
              )[0]?.value ?? null;
            if (value === null) {
              await tx.delete(instanceSettings).where(eq(instanceSettings.key, key));
            } else {
              await setSetting(tx, key, value);
            }
            await writeAudit(tx, {
              actorUserId: userId,
              workspaceId: null,
              action: "settings.update",
              target: key,
              detail: { before, after: value },
            });
          }
        });

        return readShape(db);
      },
    );
