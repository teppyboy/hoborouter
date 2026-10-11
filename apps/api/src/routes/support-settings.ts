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

// Control-character gate without a control-character regex class (Biome's
// eslint(no-control-regex) rejects \u0000-\u001f patterns): explicit code-unit
// comparison keeps the EXACT original range — C0 controls (0x00–0x1f) and DEL
// (0x7f). No Unicode-classification widening: astral/surrogate code units are
// all > 0x7f and fall through untouched. `allowMessaging` preserves the
// multiline message carve-out (tab, LF, CR only).
export const hasControlChars = (s: string, allowMessaging = false): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (allowMessaging && (c === 0x09 || c === 0x0a || c === 0x0d)) continue;
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
};

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
    custom: SupportCustomLink[];
  };
};

// Admin-curated extra channels, stored as ONE KV string (`support_custom`, a
// JSON array) — no schema migration needed. Publicly rendered after the fixed
// channels, so every entry is re-validated with the same URL rules plus a
// bounded plain-text label.
// No entry-count cap: the hard limit is the total serialized size of the
// stored array (below). Effective payload bound: the stored KV value and the
// public-catalog render of it never exceed 16384 UTF-8 bytes; a minimal valid
// entry ({"label":"a","url":"https://a.bc"}) serializes to ~34 bytes, so the
// bound admits at most ~480 entries while per-entry label (<=30 chars) and
// HTTPS/credential rules still apply.
export const SUPPORT_CUSTOM_MAX_BYTES = 16_384;
export const SUPPORT_CUSTOM_LABEL_MAX = 30;
export type SupportCustomLink = { label: string; url: string };

/** Null for anything that is not a well-formed, byte-bounded custom-link array. */
function validateCustomLinks(raw: unknown): SupportCustomLink[] | null {
  if (!Array.isArray(raw)) return null;
  // Fail fast before per-entry work: bounding the raw serialization bounds the
  // validation loop itself. Canonicalization can still GROW a URL
  // (percent-encoding), so the stored value is re-bounded below — this check
  // is a cheap early rejection, not the security bound.
  if (Buffer.byteLength(JSON.stringify(raw), "utf8") > SUPPORT_CUSTOM_MAX_BYTES) return null;
  const out: SupportCustomLink[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const { label, url } = item as Record<string, unknown>;
    if (typeof label !== "string" || typeof url !== "string") return null;
    const l = label.trim();
    if (!l || l.length > SUPPORT_CUSTOM_LABEL_MAX || hasControlChars(l)) return null;
    const u = validateHttpsUrl(url);
    if (u === null) return null;
    out.push({ label: l, url: u });
  }
  // Strict total bound on the STORED value: the KV string below is exactly
  // JSON.stringify(out), so both storage and the rendered public payload stay
  // within SUPPORT_CUSTOM_MAX_BYTES regardless of encoding growth.
  if (Buffer.byteLength(JSON.stringify(out), "utf8") > SUPPORT_CUSTOM_MAX_BYTES) return null;
  return out;
}

/** Stored KV string -> rendered array; anything unusable renders as none. */
export function parseStoredCustomLinks(raw: string | null | undefined): SupportCustomLink[] {
  if (!raw) return [];
  try {
    return validateCustomLinks(JSON.parse(raw) as unknown) ?? [];
  } catch {
    return [];
  }
}

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
      custom: parseStoredCustomLinks(map.get("support_custom")),
    },
  };
}

const invalid = (message: string) =>
  new Response(JSON.stringify({ error: { code: "INVALID", message } }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });

const strOrNull = t.Optional(t.Union([t.String(), t.Null()]));
// Pass-through at the schema level: every custom-link rule (shape, bounds,
// label, URL) is enforced in the handler so malformed input gets the route's
// uniform 400 INVALID, not a 422 schema rejection.
const supportCustom = t.Optional(t.Any());

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
          support_custom: supportCustom,
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

        // Custom links are a structured key (null clears, array replaces) and
        // follow the same validate-everything-before-write rule.
        let customUpdate: SupportCustomLink[] | null | undefined;
        if ("support_custom" in body) {
          if (body.support_custom === null) customUpdate = null;
          else {
            const links = validateCustomLinks(body.support_custom);
            if (links === null) {
              return invalid(
                "support_custom must be an array of { label, url } objects with a non-empty label (max 30 characters) and an HTTPS URL without credentials, totaling at most 16384 bytes as stored JSON",
              );
            }
            customUpdate = links;
          }
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
          if (customUpdate !== undefined) {
            const beforeRaw =
              (
                await tx
                  .select({ value: instanceSettings.value })
                  .from(instanceSettings)
                  .where(eq(instanceSettings.key, "support_custom"))
                  .limit(1)
              )[0]?.value ?? null;
            if (customUpdate === null) {
              await tx.delete(instanceSettings).where(eq(instanceSettings.key, "support_custom"));
            } else {
              await setSetting(tx, "support_custom", JSON.stringify(customUpdate));
            }
            await writeAudit(tx, {
              actorUserId: userId,
              workspaceId: null,
              action: "settings.update",
              target: "support_custom",
              detail: {
                before: beforeRaw === null ? null : parseStoredCustomLinks(beforeRaw),
                after: customUpdate,
              },
            });
          }
        });

        return readShape(db);
      },
    );
