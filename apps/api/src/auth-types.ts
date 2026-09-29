// Minimal structural type for the Better Auth instance surface the gateway
// uses (fetch handler + server-side session lookup). Avoids importing the
// highly-generic Auth<T> types into route signatures.
export interface AuthUser {
  id: string;
}

export interface AuthSession {
  user: AuthUser;
  session: { id: string; userId: string };
}

export interface BetterAuthInstance {
  handler: (request: Request) => Promise<Response>;
  api: {
    getSession(args: { headers: Headers }): Promise<AuthSession | null>;
  };
}
