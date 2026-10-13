// One-call UI test bootstrap composing the three load-order-sensitive helpers
// (see tests/README.md for the full contract):
// 1. isolateBetterAuthClientWindowManagers — before app modules load, so the
//    Better Auth client's window managers never touch real window listeners.
// 2. installSsrDom — faithful document for load-time Radix capture.
// 3. registerFaithfulApiMock — single process-global lib/api registration
//    (mock.module cannot be unregistered in Bun; first registration wins).
// Returns teardown for afterAll. Deliberately small: no global assertion
// weakening, no auto-mocking beyond the helpers themselves. The manager stubs
// and api mock registration are process-lifetime by design; teardown only
// restores the document, so each test file owns its own remaining cleanup.
import { isolateBetterAuthClientWindowManagers } from "./better-auth-client-isolation";
import { installSsrDom } from "./ssr-dom";
import { registerFaithfulApiMock } from "./faithful-api-mock";

export function bootstrapUiTest(): () => void {
  isolateBetterAuthClientWindowManagers();
  const restoreDocument = installSsrDom();
  registerFaithfulApiMock();
  return restoreDocument;
}
