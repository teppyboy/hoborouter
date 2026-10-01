import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  // Same origin; Elysia mounts Better Auth at /api/auth.
  baseURL: window.location.origin,
  basePath: "/api/auth",
});

export const { signIn, signUp, signOut, useSession } = authClient;
