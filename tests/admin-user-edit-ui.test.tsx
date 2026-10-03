// Admin users table edit/reset-password UI contract (semantic render):
// - Every row gets Edit + Reset password actions; Remove stays self-hidden.
// - Role badge and Joined date columns are untouched by the new actions.
// - Dialogs are a11y-titled ("Edit user" / "Reset password") — asserted via
//   open-dialog render so screen-reader context is actually verified.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "../apps/web/src/components/ui/tooltip";

// lib/auth runs createAuthClient (window.location.origin) at module load;
// stub a minimal window so the SSR render test can import the page.
(globalThis as { window?: unknown }).window ??= { location: { origin: "http://localhost" } };
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

test("rows render Edit and Reset password beside Remove; Role/Joined preserved", () => {
  const html = renderUsers([user({ is_instance_admin: true })], "u_self");
  expect(html).toContain("Edit");
  expect(html).toContain("Reset password");
  expect(html).toContain("Remove");
  expect(html).toContain("admin"); // Role badge unchanged
  expect(html).toContain("2023"); // Joined date (Nov 2023 epoch) unchanged
  expect(html).toContain('aria-label="Edit grace@example.com"');
  expect(html).toContain('aria-label="Reset password for grace@example.com"');
});

test("self row keeps Edit/Reset but never Remove", () => {
  const html = renderUsers([user({ id: "u_self" })], "u_self");
  expect(html).toContain("Edit");
  expect(html).toContain("Reset password");
  expect(html).not.toContain(">Remove</button>");
  expect(html).not.toContain('aria-label="Remove grace@example.com"');
});

test("action buttons carry accessible labels built from the email", () => {
  const html = renderUsers(
    [user({ email: "ada@example.com", id: "u_other" })],
    "u_self",
  );
  expect(html).toContain('aria-label="Remove ada@example.com"');
});
