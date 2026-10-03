// PayOS top-up UI contract: when the backend advertises PayOS the form offers
// an accessible provider choice with Manual preselected (manual is the default
// and fallback); without PayOS the choice disappears entirely and the form is
// manual-only. No provider state or fake success exists in static markup —
// status verification belongs to the backend-polled Payments page.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// lib/auth runs createAuthClient (window.location.origin) at module load;
// stub a minimal window so the SSR render test can import the page.
(globalThis as { window?: unknown }).window ??= { location: { origin: "http://localhost" } };
const { TopUpForm } = await import("../apps/web/src/pages/billing/credits");

function render(payosAvailable: boolean): string {
  const qc = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <TopUpForm
        workspaceId="ws_1"
        payosAvailable={payosAvailable}
        rate={undefined}
        onNavigate={() => {}}
      />
    </QueryClientProvider>,
  );
}

test("PayOS advertised: provider choice shown, Manual checked by default", () => {
  const html = render(true);
  expect(html).toContain("Payment method");
  expect(html).toContain("PayOS");
  expect(html).toContain("Manual transfer");
  expect(html).toContain('checked="" value="manual"');
  expect(html).not.toContain('checked="" value="payos"');
  // Manual is the active choice, so the button keeps the manual action label.
  expect(html).toContain("Create payment");
});

test("PayOS not advertised: manual-only form, no provider choice", () => {
  const html = render(false);
  expect(html).not.toContain("Payment method");
  expect(html).not.toContain("PayOS");
  expect(html).toContain("Create payment");
});

test("PayOS option sets expectations: redirect, server-verified status", () => {
  const html = render(true);
  expect(html).toContain("you will be redirected there");
  expect(html).toContain("updates from the server");
});
