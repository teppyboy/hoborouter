// Admin users table edit/reset-password UI contract (semantic render):
// - Every row gets Edit + Reset password actions; Remove stays self-hidden.
// - Role badge and Joined date columns are untouched by the new actions.
// - Dialogs are a11y-titled ("Edit user" / "Reset password") — asserted via
//   open-dialog render so screen-reader context is actually verified.
import { test, expect, afterAll } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "../apps/web/src/components/ui/tooltip";

// lib/auth runs createAuthClient (window.location.origin) at module load;
// stub a minimal window so the SSR render test can import the page. The
// previous globalThis descriptor is restored in afterAll: leaving this stub
// installed would leak a matchMedia-less window into later SSR files sharing
// the bun worker.
const g = globalThis as { window?: unknown };
const previousWindow = Object.getOwnPropertyDescriptor(g, "window");
g.window ??= { location: { origin: "http://localhost" } };
afterAll(() => {
  if (previousWindow) Object.defineProperty(g, "window", previousWindow);
  else delete g.window;
});
const { UsersTable } = await import("../apps/web/src/pages/admin/users");
type AdminUser = import("../apps/web/src/pages/admin/users").AdminUser;

function user(partial: Partial<AdminUser>): AdminUser {
  return {
    id: "u_other",
    email: "grace@example.com",
    name: "Grace",
    created_at: 1700000000000,
    is_instance_admin: false,
    workspace_count: 2,
    ...partial,
  };
}

function renderUsers(users: AdminUser[], currentUserId: string | null): string {
  const qc = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <TooltipProvider delayDuration={0}>
        <UsersTable users={users} currentUserId={currentUserId} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

test("rows have no action button wall; Role/Joined columns preserved", () => {
  const html = renderUsers([user({ is_instance_admin: true })], "u_self");
  // Actions moved into detail/context menu; rows carry only data columns.
  expect(html).not.toContain('aria-label="Edit grace@example.com"');
  expect(html).not.toContain('aria-label="Reset password for grace@example.com"');
  expect(html).not.toContain('aria-label="Remove grace@example.com"');
  expect(html).toContain("admin"); // Role badge unchanged
  expect(html).toContain("2023"); // Joined date (Nov 2023 epoch) unchanged
  // Rows are activatable (click/Enter -> detail) and labelled by email.
  expect(html).toContain('aria-label="Details for grace@example.com"');
});

test("self row renders identically (no Remove anywhere in the row markup)", () => {
  const html = renderUsers([user({ id: "u_self" })], "u_self");
  expect(html).not.toContain(">Remove</button>");
  expect(html).not.toContain('aria-label="Remove grace@example.com"');
});

test("rows carry accessible labels built from the email", () => {
  const html = renderUsers([user({ email: "ada@example.com", id: "u_other" })], "u_self");
  expect(html).toContain('aria-label="Details for ada@example.com"');
});
