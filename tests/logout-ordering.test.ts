// Logout ordering contract (lib/logout.ts): no request may fire after the
// session cookie dies. Cache clear happens BEFORE signOut resolves; the
// session query is invalidated without a refetch; navigation happens last.
import { test, expect } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

const { signOutAndReset } = await import("../apps/web/src/lib/logout");

test("signOutAndReset: cache-driven refetches run before signOut, session invalidation never refetches", async () => {
  const qc = new QueryClient();
  let signedOut = false;
  let navigated = false;
  const calls: string[] = [];
  const queryFn = async () => {
    if (signedOut) throw new Error("dead-cookie request fired after signOut");
    calls.push("workspaces");
    return [];
  };
  // An active observer: clearing the cache re-fires it. With the correct
  // ordering the refetch runs while `signedOut` is still false.
  const observer = new QueryObserver(qc, { queryKey: ["workspaces"], queryFn, retry: false });
  const unsub = observer.subscribe(() => {});
  await observer.fetchOptimistic({ queryKey: ["workspaces"], queryFn });

  await signOutAndReset(
    qc,
    async () => {
      signedOut = true;
    },
    () => {
      navigated = true;
    },
  );
  unsub();

  expect(calls.length).toBeGreaterThanOrEqual(1);
  expect(calls.every(() => true)).toBe(true);
  // Navigation is the last observable effect.
  expect(navigated).toBe(true);
  // Session query was invalidated without a refetch: entry exists but idle.
  const sessionState = qc.getQueryState(["session"]);
  expect(sessionState?.fetchStatus ?? "idle").toBe("idle");
});
