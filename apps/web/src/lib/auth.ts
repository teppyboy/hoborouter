import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  // Same origin; Elysia mounts Better Auth at /api/auth.
  baseURL: window.location.origin,
  basePath: "/api/auth",
});

export const { signIn, signUp, signOut, useSession } = authClient;

export interface SessionUser {
  id?: string;
  email?: string | null;
  emailVerified?: boolean;
  name?: string | null;
  image?: string | null;
}

/**
 * Resend the verification email for an address. Better Auth answers
 * identically for unknown/verified addresses (no account enumeration) and
 * rate-limits resends, so the caller only needs the coarse ok/rateLimited
 * split. The signed link lands on the public /verify-email SPA page.
 */
export async function resendVerification(
  email: string,
): Promise<{ ok: boolean; rateLimited: boolean }> {
  try {
    const { error } = await authClient.sendVerificationEmail({
      email,
      callbackURL: window.location.origin + "/verify-email",
    });
    return { ok: !error, rateLimited: error?.status === 429 };
  } catch {
    return { ok: false, rateLimited: false };
  }
}
