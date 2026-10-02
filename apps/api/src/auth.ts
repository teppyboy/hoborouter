// Task 3A: Better Auth instance on Drizzle/bun:sqlite.
// Adapter + dialect declared HERE (that's why @better-auth/cli generate needs
// no adapter/dialect flags). The user table is the Task 2 `users` table —
// alias singular `user` model key to the canonical `users` export (REQUIRED:
// drizzleAdapter looks up schema["user"], canonical export key is `users`).
import { Database } from "bun:sqlite";
import { betterAuth } from "better-auth";
import { captcha } from "better-auth/plugins";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createDb, schema } from "@hoborouter/db";

/** Swap localhost<->127.0.0.1 host of an origin string; null if not one of them. */
const swappedLoopback = (origin: string): string | null => {
  try {
    const u = new URL(origin);
    if (u.hostname === "localhost") u.hostname = "127.0.0.1";
    else if (u.hostname === "127.0.0.1") u.hostname = "localhost";
    else return null;
    return u.origin;
  } catch {
    return null;
  }
};

/** Build a Better Auth instance over an existing bun:sqlite Database. */
export function createAuth(db: Database) {
  const baseURL =
    process.env.BETTER_AUTH_URL || process.env.HBR_BASE_URL || "http://localhost:3000";
  if (
    process.env.NODE_ENV === "production" &&
    !(process.env.BETTER_AUTH_URL || process.env.HBR_BASE_URL)
  ) {
    throw new Error("BETTER_AUTH_URL (or HBR_BASE_URL) is required when NODE_ENV=production");
  }
  const secret = process.env.BETTER_AUTH_SECRET || process.env.AUTH_SECRET;
  if (process.env.NODE_ENV === "production" && (!secret || secret.length < 32)) {
    throw new Error(
      "BETTER_AUTH_SECRET (or AUTH_SECRET) of at least 32 characters is required when NODE_ENV=production",
    );
  }
  // Dev/test: browsers treat 127.0.0.1 and localhost as different origins, so
  // trust the loopback-swapped baseURL too; prod trusts only the baseURL origin.
  const env = process.env.NODE_ENV;
  const trustedOrigins: string[] =
    env === "development" || env === "test"
      ? [swappedLoopback(baseURL)].filter((o): o is string => o !== null)
      : [];
  if (process.env.HBR_TRUSTED_ORIGINS) {
    trustedOrigins.push(
      ...process.env.HBR_TRUSTED_ORIGINS.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }
  return betterAuth({
    baseURL,
    trustedOrigins,
    database: drizzleAdapter(drizzle(db, { schema }), {
      provider: "sqlite",
      schema: { ...schema, user: schema.users },
    }),
    user: { modelName: "users" },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            // Dev/test-only convenience: auto-grant instance admin to the
            // configured bootstrap email at signup. Production never lands here.
            const adminEmail = process.env.HBR_DEV_ADMIN_EMAIL;
            const env = process.env.NODE_ENV;
            if (
              (env === "development" || env === "test") &&
              adminEmail &&
              typeof user.email === "string" &&
              user.email.toLowerCase() === adminEmail.toLowerCase()
            ) {
              db.prepare(
                "INSERT OR IGNORE INTO instance_admins (user_id, created_at, added_by) VALUES (?, ?, NULL)",
              ).run(user.id, Date.now());
            }
          },
        },
      },
    },
    emailAndPassword: { enabled: true },
    // Turnstile protection for /sign-in/email + /sign-up/email: only when a
    // secret key is configured; reads the `x-captcha-response` request header.
    plugins: process.env.TURNSTILE_SECRET_KEY
      ? [
          captcha({
            provider: "cloudflare-turnstile",
            secretKey: process.env.TURNSTILE_SECRET_KEY,
          }),
        ]
      : [],
  });
}

// Default instance used by the app and by `@better-auth/cli generate`
// (override the target DB file with HBR_DB_PATH; defaults to in-memory).
const defaultDb = createDb(process.env.HBR_DB_PATH || ":memory:");
export const auth = createAuth(defaultDb);
