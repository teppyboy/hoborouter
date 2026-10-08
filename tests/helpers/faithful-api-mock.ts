// TEST-ONLY faithful network-layer mock (bun test harness; production
// lib/api is untouched). mock.module is process-global in Bun and outlives
// mock.restore(), so every test file that needs a mocked lib/api must share
// ONE registration whose exports are the genuine module: stable ApiError
// identity (later files do `instanceof ApiError` for error-code mapping) and
// an api() that reads globalThis.fetch live — passing the raw path string
// through, never a relative Request — so each file's fetch harness intercepts
// requests. First registration in the process wins; later calls are no-ops.
// Pure module: safe to import before any DOM/Radix setup.
import { mock } from "bun:test";

// Imported before any mock.module registration in this process, so this is
// the genuine module namespace (an import after registration would return
// the registered mock itself).
const realApiModule = await import("../../apps/web/src/lib/api");

let registered = false;

export function registerFaithfulApiMock(): void {
  if (registered) return;
  registered = true;
  mock.module("../../apps/web/src/lib/api", () => realApiModule);
}
