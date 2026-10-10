// Better Auth instance on Drizzle over Bun SQL (Postgres).
// Adapter + dialect declared HERE (that's why @better-auth/cli generate needs
// no adapter/dialect flags). The user table is the `users` table — alias
// singular `user` model key to the canonical `users` export (REQUIRED:
// drizzleAdapter looks up schema["user"], canonical export key is `users`).
import { APIError, betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { captcha } from "better-auth/plugins";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { checkPassword } from "@hoborouter/shared";
import type { Db } from "@hoborouter/db";
import { bootstrapFirstInstanceAdmin } from "./instance-admin";
import { socialProvidersOption } from "./oauth-config";
import {
  emailVerificationEnabled,
  sendVerificationEmail as smtpSendVerificationEmail,
} from "./email";
import { schema, instanceAdmins } from "@hoborouter/db";
import type { ResolvedConfig } from "./config/schema";

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

/**
 * Pin the post-verification redirect to the public SPA page when the caller
 * didn't choose one. The link itself stays Better Auth's signed
 * /api/auth/verify-email URL (token untouched, verified by the API route).
 */
const withVerifyEmailCallback = (url: string): string => {
  try {
    const u = new URL(url);
    const cb = u.searchParams.get("callbackURL");
    if (cb === null || cb === "/") u.searchParams.set("callbackURL", "/verify-email");
    return u.toString();
  } catch {
    return url;
  }
};

/** Build a Better Auth instance over an existing drizzle/pg Db. `cfg` (the
 *  resolved startup config, apps/api/src/config/schema ResolvedConfig) is
 *  optional: omitted = direct-test/env-only callers read process.env exactly
 *  as before; present = every in-scope value comes from the merged record so
 *  YAML-provided values flow without process.env access. NODE_ENV stays a
 *  runtime env-only selector in both modes. */
export function createAuth(db: Db, cfg?: ResolvedConfig) {
  const env: Record<string, string | undefined> = cfg?.env ?? process.env;
  const baseURL = env.BETTER_AUTH_URL || env.HBR_BASE_URL || "http://localhost:3000";
  if (process.env.NODE_ENV === "production" && !(env.BETTER_AUTH_URL || env.HBR_BASE_URL)) {
    throw new Error("BETTER_AUTH_URL (or HBR_BASE_URL) is required when NODE_ENV=production");
  }
  const secret = env.BETTER_AUTH_SECRET || env.AUTH_SECRET;
  if (process.env.NODE_ENV === "production" && (!secret || secret.length < 32)) {
    throw new Error(
      "BETTER_AUTH_SECRET (or AUTH_SECRET) of at least 32 characters is required when NODE_ENV=production",
    );
  }
  // Dev/test: browsers treat 127.0.0.1 and localhost as different origins, so
  // trust the loopback-swapped baseURL too; prod trusts only the baseURL origin.
  const nodeEnv = process.env.NODE_ENV;
  const trustedOrigins: string[] =
    nodeEnv === "development" || nodeEnv === "test"
      ? [swappedLoopback(baseURL)].filter((o): o is string => o !== null)
      : [];
  if (env.HBR_TRUSTED_ORIGINS) {
    trustedOrigins.push(
      ...env.HBR_TRUSTED_ORIGINS.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }
  return betterAuth({
    baseURL,
    trustedOrigins,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { ...schema, user: schema.users },
    }),
    user: { modelName: "users" },
    // OAuth sign-in (Google/Discord/GitHub) only when BOTH credentials for a
    // provider are configured. Nothing here changes linking semantics: Better
    // Auth's safe defaults apply (implicit linking requires a VERIFIED provider
    // email AND a verified local user; allowDifferentEmails stays false), so an
    // unverified OAuth identity can never silently take over an account.
    // Admin bootstrap still flows through the email-matched user.create.after
    // hook above — provider identity grants no privilege by itself.
    socialProviders: socialProvidersOption(env),
    databaseHooks: {
      user: {
        create: {
          after: async (user, ctx) => {
            // OAuth-created detection for BOTH admin-grant paths below: a
            // Better Auth social callback creates the user at /callback/:provider
            // (or /sign-in/social); password/email signup never hits these paths.
            const path = typeof ctx?.path === "string" ? ctx.path : "";
            const oauthCreated = path.startsWith("/callback/") || path === "/sign-in/social";
            // Production bootstrap: the configured email becomes instance admin
            // in ANY environment, but only while the instance has zero admins.
            const bootstrapEmail = env.HBR_BOOTSTRAP_INSTANCE_ADMIN_EMAIL;
            if (
              bootstrapEmail &&
              typeof user.email === "string" &&
              user.email.toLowerCase() === bootstrapEmail.toLowerCase()
            ) {
              // Provider-aware gate: OAuth-created users may only bootstrap the
              // instance admin from a VERIFIED provider email. An unverified
              // email claim from any provider can never grant instance admin
              // (no email-only takeover via a spoofed provider identity).
              // Password signup keeps the plain email-match behavior: the
              // bootstrap email is a deployment-only value known to the
              // operator, who provisions it through the existing path.
              if (oauthCreated && user.emailVerified !== true) {
                console.warn(
                  "[auth] OAuth signup matched the configured bootstrap email but the provider email is not verified; instance admin grant skipped",
                );
              } else {
                await bootstrapFirstInstanceAdmin(db, user.email);
              }
            }
            // Dev/test-only convenience: auto-grant instance admin to the
            // configured bootstrap email at signup. Production never lands here.
            // Same provider-aware gate as the production bootstrap above: an
            // unverified OAuth email claim can never grant instance admin,
            // even in dev/test (same attack, same answer). Password signup
            // keeps the plain email-match dev convenience.
            const adminEmail = env.HBR_DEV_ADMIN_EMAIL;
            const nodeEnv = process.env.NODE_ENV;
            if (
              (nodeEnv === "development" || nodeEnv === "test") &&
              adminEmail &&
              typeof user.email === "string" &&
              user.email.toLowerCase() === adminEmail.toLowerCase()
            ) {
              if (oauthCreated && user.emailVerified !== true) {
                console.warn(
                  "[auth] Dev/test OAuth signup matched HBR_DEV_ADMIN_EMAIL but the provider email is not verified; instance admin grant skipped",
                );
              } else {
                await db
                  .insert(instanceAdmins)
                  .values({ user_id: user.id, created_at: Date.now(), added_by: null })
                  .onConflictDoNothing();
              }
            }
          },
        },
      },
    },
    emailAndPassword: { enabled: true },
    // OPTIONAL email verification (SMTP_HOST + HBR_EMAIL_FROM required):
    // requireEmailVerification stays unset — an unverified email NEVER blocks
    // sign-in or hides features; verification is a notification, not a gate.
    // Delivery failures are logged (SmtpError messages never carry tokens or
    // credentials) and never fail signup/resend; the user can always retry
    // via POST /api/auth/send-verification-email (Better Auth rate-limits it
    // to 3/60s and answers identically for unknown/verified addresses).
    ...(emailVerificationEnabled()
      ? {
          emailVerification: {
            sendOnSignUp: true,
            sendVerificationEmail: async ({
              user,
              url,
            }: {
              user: { email: string };
              url: string;
            }) => {
              try {
                await smtpSendVerificationEmail({
                  to: user.email,
                  url: withVerifyEmailCallback(url),
                });
              } catch (err) {
                console.error(
                  `[email] verification email not delivered (recipient redacted): ${
                    err instanceof Error ? err.message : "unknown error"
                  }`,
                );
              }
            },
          },
          // Real Better Auth rate rules (in-memory, per IP+path): built-in
          // special rules already cap /send-verification-email at 3/60s and
          // sign-in/sign-up at 3/10s; this just switches them on outside prod.
          rateLimit: { enabled: true },
        }
      : {}),
    // Password policy is enforced server-side at every password-SET path
    // Better Auth owns: signup + change-password. Admin create/reset enforce
    // the same policy in their own routes (admin-extra / admin-user-edit).
    // Existing passwords are never re-checked: sign-in must keep working.
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email" && ctx.path !== "/change-password") return;
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const password = ctx.path === "/sign-up/email" ? body.password : body.newPassword;
        if (typeof password !== "string") return;
        const unmet = checkPassword(password);
        if (unmet.length > 0) {
          throw new APIError("BAD_REQUEST", {
            message: `Password does not meet the requirements: ${unmet.join("; ")}`,
          });
        }
      }),
    },
    // Turnstile protection for /sign-in/email + /sign-up/email: only when a
    // secret key is configured; reads the `x-captcha-response` request header.
    plugins: env.TURNSTILE_SECRET_KEY
      ? [
          captcha({
            provider: "cloudflare-turnstile",
            secretKey: env.TURNSTILE_SECRET_KEY,
          }),
        ]
      : [],
  });
}
