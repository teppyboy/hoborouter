// Cached session state shared between the router layout and pages that must
// adapt to the session context (help pages render inside the AppShell when
// signed in, with their own public chrome when anonymous).
// One query key, one fetcher: the router's beforeLoad warm-up and any
// consumer read the same cache entry, so the help-page embedding decision
// always matches the layout decision synchronously (no flash, no refetch).
import { useQuery } from "@tanstack/react-query";

export const SESSION_QUERY_KEY = ["session"] as const;
export const SESSION_STALE_MS = 5 * 60_000;

/**
 * Session fetch for the routing gate. Reads GET /api/auth/get-session
 * directly (same endpoint and { user, session } contract Better Auth serves;
 * same-origin, so the session cookie is sent) instead of going through the
 * better-auth client's session atom, which dedupes/caches reads internally —
 * the gate must always see the server's current answer, never a stale
 * client-side snapshot. Returns null for unauthenticated (401/empty/unparseable
 * body) instead of throwing: a failed REFETCH that throws would leave TanStack
 * Query serving the previous session data, keeping a revoked session's shell
 * mounted forever. null is falsy, so every gate read sees the revocation.
 */
export async function fetchSession() {
  let data: unknown = null;
  try {
    const res = await fetch("/api/auth/get-session", { method: "GET" });
    data = res.ok ? ((await res.json().catch(() => null)) as unknown) : null;
  } catch {
    // Network failure (offline, fetch reject) reads as unauthenticated: the
    // help pages fail closed to public chrome and the protected gate redirects
    // to /login — never an error boundary, never a stale authenticated shell.
    data = null;
  }
  if (!data || typeof data !== "object" || !("user" in data) || !("session" in data)) {
    return null;
  }
  return data as { user: unknown; session: unknown };
}

/** Reactive read of the router's cached ["session"] query. */
export function useShellSession() {
  return useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: fetchSession,
    staleTime: SESSION_STALE_MS,
    retry: false,
  });
}
