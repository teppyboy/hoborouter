// Narrow regression for the consolidated UI test bootstrap: installs the
// Better Auth window-manager stubs, a faithful document, and the lib/api
// mock registration, and teardown restores the document without leaving the
// stubs dangling. See tests/helpers/bootstrap.ts for the load-order contract.
import { afterAll, describe, expect, it } from "bun:test";
import { bootstrapUiTest } from "./helpers/bootstrap";

const g = globalThis as Record<symbol, unknown>;
const MANAGER_KEYS = [
  "better-auth:broadcast-channel",
  "better-auth:focus-manager",
  "better-auth:online-manager",
] as const;

describe("bootstrapUiTest", () => {
  // Only this file's document is restored; stubs/mock registration are
  // process-lifetime by design (bun mock.module cannot be unregistered).
  const restore = bootstrapUiTest();
  afterAll(restore);

  it("installs listener-free Better Auth manager stubs", () => {
    for (const key of MANAGER_KEYS) {
      const stub = g[Symbol.for(key)];
      expect(typeof stub).toBe("object");
      expect(typeof (stub as { subscribe: unknown }).subscribe).toBe("function");
    }
  });

  it("provides a document while active", () => {
    expect(typeof globalThis.document).toBe("object");
  });

  it("restore() removes the document again", () => {
    restore();
    expect(globalThis.document).toBeUndefined();
  });
});
