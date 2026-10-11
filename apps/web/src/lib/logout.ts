// Logout ordering contract: every cache-driven refetch must happen while the
// session cookie is still valid. Clearing or invalidating queries AFTER the
// cookie dies re-fires active observers whose `enabled` still reads the stale
// Better Auth session snapshot, sending dead-cookie requests (401 console
// noise on logout). So: cancel in-flight work and drop the cache first, then
// sign out; the session query is invalidated without a refetch because the
// login screen re-reads it fresh via the routing gate.
import type { QueryClient } from "@tanstack/react-query";
import { SESSION_QUERY_KEY } from "./session";

export async function signOutAndReset(
  queryClient: QueryClient,
  signOut: () => Promise<unknown>,
  navigate: () => void,
): Promise<void> {
  void queryClient.cancelQueries();
  queryClient.clear();
  await signOut();
  void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY, refetchType: "none" });
  navigate();
}
