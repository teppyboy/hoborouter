// Account self-service: email change (password-verified), avatar upload /
// delete / serve. Avatar files live in HBR_AVATAR_DIR (default ./data/avatars).
import { Elysia, t } from "elysia";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { BetterAuthInstance } from "../auth-types";
import { requireSession, writeAudit, jsonError } from "../authz";
import { type Db, users } from "@hoborouter/db";
import { eq, sql } from "drizzle-orm";

const MAX_AVATAR_BYTES = 1_048_576;

const MIME_BY_EXT = {
  webp: "image/webp",
  jpg: "image/jpeg",
  png: "image/png",
} as const;
type Ext = keyof typeof MIME_BY_EXT;
const EXT_BY_MIME: Record<string, Ext> = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
};

/** Sniff real image type from magic bytes; client-supplied mime is untrusted. */
function magicExt(bytes: Uint8Array): Ext | null {
  if (bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
    bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 &&
    bytes[11] === 0x50) return "webp";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
    bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a &&
    bytes[7] === 0x0a) return "png";
  return null;
}

function avatarDir(): string {
  return process.env.HBR_AVATAR_DIR || join(process.cwd(), "data", "avatars");
}

function publicUser(u: { id: string; name: string; email: string; image: string | null }) {
  return { id: u.id, name: u.name, email: u.email, image: u.image };
}

async function getUser(db: Db, id: string) {
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email, image: users.image })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Persist avatar bytes for a user; returns the cache-busted public image URL. */
function storeAvatar(userId: string, ext: Ext, bytes: Uint8Array): string {
  const dir = avatarDir();
  mkdirSync(dir, { recursive: true });
  // Remove stale files from prior uploads with a different extension.
  for (const e of Object.keys(MIME_BY_EXT)) {
    const p = join(dir, `${userId}.${e}`);
    if (e !== ext && existsSync(p)) rmSync(p);
  }
  writeFileSync(join(dir, `${userId}.${ext}`), bytes);
  return `/api/v1/avatars/${userId}?v=${Date.now()}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const accountRoutes = (db: Db, auth: BetterAuthInstance) =>
  new Elysia({ name: "account" })
    .post(
      "/api/v1/account/email",
      {
        body: t.Object({ email: t.String(), currentPassword: t.String() }),
        detail: { tags: ["System"], summary: "Change account email", security: [{ cookieAuth: [] }] },
      },
      async ({ request, body }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const user = gate.session.user;
        const email = body.email.trim().toLowerCase();
        if (!EMAIL_RE.test(email)) return jsonError(400, "INVALID", "Invalid email");
        try {
          if (!auth.api.verifyPassword) throw new Error("verifyPassword unavailable");
          await auth.api.verifyPassword({
            body: { password: body.currentPassword },
            headers: request.headers,
          });
        } catch {
          return jsonError(403, "WRONG_PASSWORD", "Incorrect password");
        }
        const taken = await db
          .select({ id: users.id })
          .from(users)
          .where(sql`lower(${users.email}) = ${email}`)
          .limit(1);
        if (taken[0]) return jsonError(409, "EMAIL_TAKEN", "Email already in use");
        // Nobody verified the new address: reset verified-ness along with it.
        await db.update(users).set({ email, emailVerified: false }).where(eq(users.id, user.id));
        await writeAudit(db, {
          actorUserId: user.id,
          workspaceId: null,
          action: "user.email_change",
          target: user.id,
          detail: { to: email },
        });
        // Committed: notify the NEW address. Better Auth's server API mails
        // the signed verify link through the configured SMTP option; when SMTP
        // is off (or the send fails) this is a notification only — the change
        // and session stay valid, so any failure is swallowed here.
        if (auth.api.sendVerificationEmail) {
          try {
            await auth.api.sendVerificationEmail({
              body: { email },
              headers: request.headers,
            });
          } catch {
            // Delivery is best-effort; the committed change must not 500.
          }
        }
        const fresh = await getUser(db, user.id);
        return { user: publicUser(fresh!) };
      },
    )
    .post(
      "/api/v1/account/avatar",
      {
        detail: { tags: ["System"], summary: "Upload avatar", security: [{ cookieAuth: [] }] },
      },
      async ({ request }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const mime = (request.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
        if (!(mime in EXT_BY_MIME)) return jsonError(400, "INVALID_IMAGE", "Unsupported image type");
        // Size-limited BEFORE buffering (memory DoS guard): reject on declared
        // Content-Length, else stream-count and abort mid-read if over budget.
        const declaredLength = Number(request.headers.get("content-length"));
        if (Number.isSafeInteger(declaredLength) && declaredLength > MAX_AVATAR_BYTES) {
          return jsonError(413, "TOO_LARGE", "Avatar exceeds 1 MiB");
        }
        const bodyReader = request.body?.getReader();
        if (!bodyReader) return jsonError(400, "INVALID_IMAGE", "Empty body");
        let total = 0;
        const chunks: Uint8Array[] = [];
        for (;;) {
          const { done, value } = await bodyReader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_AVATAR_BYTES) {
            await bodyReader.cancel().catch(() => {});
            return jsonError(413, "TOO_LARGE", "Avatar exceeds 1 MiB");
          }
          chunks.push(value);
        }
        if (total === 0) return jsonError(400, "INVALID_IMAGE", "Empty body");
        const bytes = Buffer.concat(chunks);
        const ext = magicExt(bytes);
        if (!ext) return jsonError(400, "INVALID_IMAGE", "File is not a valid image");
        const image = storeAvatar(userId, ext, bytes);
        await db.update(users).set({ image }).where(eq(users.id, userId));
        return { user: publicUser((await getUser(db, userId))!) };
      },
    )
    .delete(
      "/api/v1/account/avatar",
      {
        detail: { tags: ["System"], summary: "Delete avatar", security: [{ cookieAuth: [] }] },
      },
      async ({ request }) => {
        const gate = await requireSession(auth, request);
        if ("error" in gate) return gate.error;
        const userId = gate.session.user.id;
        const dir = avatarDir();
        for (const e of Object.keys(MIME_BY_EXT)) {
          const p = join(dir, `${userId}.${e}`);
          if (existsSync(p)) rmSync(p);
        }
        await db.update(users).set({ image: null }).where(eq(users.id, userId));
        return { user: publicUser((await getUser(db, userId))!) };
      },
    )
    .get(
      "/api/v1/avatars/:userId",
      {
        params: t.Object({ userId: t.String() }),
        detail: { tags: ["System"], summary: "Serve avatar" },
      },
      ({ params }) => {
        // Path traversal guard: ids are Better Auth-generated [A-Za-z0-9].
        if (!/^[A-Za-z0-9]+$/.test(params.userId)) {
          return jsonError(400, "INVALID", "Invalid user id");
        }
        for (const [ext, mime] of Object.entries(MIME_BY_EXT)) {
          const p = join(avatarDir(), `${params.userId}.${ext}`);
          if (existsSync(p)) {
            return new Response(readFileSync(p), {
              headers: {
                "content-type": mime,
                "x-content-type-options": "nosniff",
                "cache-control": "public, max-age=86400",
              },
            });
          }
        }
        return jsonError(404, "NOT_FOUND", "Avatar not found");
      },
    );
