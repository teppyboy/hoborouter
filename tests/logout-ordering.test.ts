// Logout ordering contract (lib/logout.ts): no request may fire after the
// session cookie dies. signOutAndReset cancels in-flight queries, signs out,
// then navigates — it must never clear or invalidate the cache in-place
// (that re-fires active observers with a dead cookie).
import { test, expect } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

const { signOutAndReset } = await import("../apps/web/src/lib/logout");

test("signOutAndReset: no query refetch fires after signOut, navigation is last", async () => {
  const qc = new QueryClient();
  let signedOut = false;
  let navigated = false;
  const calls: string[] = [];
  const queryFn = async () => {
    if (signedOut) throw new Error("dead-cookie request fired after signOut");
    calls.push("workspaces");
    return [];
  };
  // An active observer stays mounted across the whole logout: it must never
  // be re-fired by cache manipulation.
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

  // Only the pre-existing fetch ran; logout itself triggered zero refetches.
  expect(calls).toEqual(["workspaces"]);
  expect(navigated).toBe(true);
});

test("signOutAndReset awaits cancelQueries: in-flight query aborted before signOut", async () => {
  const qc = new QueryClient();
  const events: string[] = [];
  const observer = new QueryObserver(qc, {
    queryKey: ["slow"],
    retry: false,
    queryFn: ({ signal }) =>
      new Promise((_res, rej) => {
        signal.addEventListener("abort", () => {
          events.push("aborted");
          rej(signal.reason);
        });
      }),
  });
  const unsub = observer.subscribe(() => {});
  observer
    .fetchOptimistic({
      queryKey: ["slow"],
      retry: false,
      queryFn: ({ signal }) =>
        new Promise((_res, rej) => {
          signal.addEventListener("abort", () => rej(signal.reason));
        }),
    })
    .catch(() => {});

  await signOutAndReset(
    qc,
    async () => {
      events.push("signOut");
    },
    () => {
      events.push("navigate");
    },
  );
  unsub();

  // The in-flight request must be aborted BEFORE the cookie dies.
  expect(events[0]).toBe("aborted");
  expect(events).toEqual(["aborted", "signOut", "navigate"]);
});
