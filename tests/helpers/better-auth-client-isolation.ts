/**
 * Test-harness isolation for Better Auth's client-side window managers.
 *
 * The session atom (apps/web/src/lib/auth → better-auth client) installs
 * window/document listeners through three globalThis singletons keyed by
 * Symbol.for ("better-auth:broadcast-channel", "better-auth:focus-manager",
 * "better-auth:online-manager") and removes them again in cleanup(). Nanostores
 * delays that unmount cleanup by STORE_UNMOUNT_DELAY (1000ms) after the last
 * subscriber disappears, so in a bun worker a UI test file that deletes
 * globalThis.window in afterAll leaves the cleanup to fire after the teardown:
 * `window.removeEventListener` then throws an unhandled
 * "ReferenceError: window is not defined" between test files (the v0.11.1
 * ui-job failure).
 *
 * Seeding the three singletons with listener-free stubs before the client's
 * session atom first mounts makes setup/cleanup window-free and deterministic.
 * The atom's fetch and $sessionSignal behavior are untouched — tests still
 * observe session state through the fetch stubs they install. Call this at
 * module load of any UI test file that renders AppShell/useSession, before the
 * app modules are imported.
 */
const MANAGER_KEYS = [
  "better-auth:broadcast-channel",
  "better-auth:focus-manager",
  "better-auth:online-manager",
] as const;

const noop = () => {};

interface ListenerManagerStub {
  subscribe: (listener: () => void) => () => void;
  setup: () => () => void;
}

export function isolateBetterAuthClientWindowManagers(): void {
  const g = globalThis as Record<symbol, unknown>;
  for (const key of MANAGER_KEYS) {
    const symbol = Symbol.for(key);
    if (key === "better-auth:broadcast-channel") {
      const stub: ListenerManagerStub & { post: (message: unknown) => void } = {
        subscribe: () => noop,
        post: noop,
        setup: () => noop,
      };
      g[symbol] = stub;
    } else if (key === "better-auth:focus-manager") {
      const stub: ListenerManagerStub & { setFocused: (focused: boolean) => void } = {
        subscribe: () => noop,
        setFocused: noop,
        setup: () => noop,
      };
      g[symbol] = stub;
    } else {
      const stub: ListenerManagerStub & {
        isOnline: boolean;
        setOnline: (online: boolean) => void;
      } = {
        isOnline: true,
        subscribe: () => noop,
        setOnline: noop,
        setup: () => noop,
      };
      g[symbol] = stub;
    }
  }
}
