// Logout ordering contract: no request may fire against the dead cookie.
// Cancel in-flight queries, sign out, then navigate. The navigation must be a
// FULL document navigation (window.location.assign), which discards the whole
// query cache: clearing or invalidating the cache in-place instead re-fires
// active observers whose `enabled` still reads the stale Better Auth session
// snapshot, sending dead-cookie requests (401 console noise on logout).
import type { QueryClient } from "@tanstack/react-query";

export async function signOutAndReset(
  queryClient: QueryClient,
  signOut: () => Promise<unknown>,
  navigate: () => void,
): Promise<void> {
  // Must be awaited: fire-and-forget cancellation lets signOut clear the auth
  // cookie while an in-flight query is still running, so the request lands
  // against the dead session (401 on logout).
  await queryClient.cancelQueries();
  await signOut();
  navigate();
}
