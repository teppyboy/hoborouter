// Minimal structural type for the Better Auth instance surface the gateway
// uses (fetch handler + server-side session lookup). Avoids importing the
// highly-generic Auth<T> types into route signatures.
export interface AuthUser {
  id: string;
  email?: string;
}

export interface AuthSession {
  user: AuthUser;
  session: { id: string; userId: string };
}

/** Subset of the Better Auth $context used by admin user-edit routes. */
export interface BetterAuthPasswordContext {
  hash(password: string): Promise<string>;
}

export interface BetterAuthInstance {
  handler: (request: Request) => Promise<Response>;
  /**
   * Resolves to the Better Auth context (password hash etc.). Required by the
   * admin password-reset route; optional so mock-auth tests still satisfy this type.
   */
  $context?: Promise<{ password: BetterAuthPasswordContext }>;
  api: {
    getSession(args: { headers: Headers }): Promise<AuthSession | null>;
    /** Required by admin user-create; optional so mock-auth tests still satisfy this type. */
    signUpEmail?(args: {
      body: { email: string; password: string; name: string };
    }): Promise<{ user: { id: string; email: string; name: string } }>;
    /** Server-only password check used by the email-change route; throws on mismatch. */
    verifyPassword?(args: {
      body: { password: string };
      headers: Headers;
    }): Promise<{ status: boolean }>;
  };
}
