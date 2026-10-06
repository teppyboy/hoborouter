// Bundle purchase UI contract (SSR): bundle cards always show price, credit
// and bonus; the shared provider choice mirrors the top-up form (Manual
// preselected by default, PayOS radio only when the backend advertises it).
// Static markup fires no requests — purchase behavior belongs to the API.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// lib/auth runs createAuthClient (window.location.origin) at module load;
// stub a minimal window so the SSR render test can import the page. The stub
// includes matchMedia so a later test file in the same bun process (globalThis
// leakage across files) that renders ThemeToggle under this window does not
// crash; the previous value is restored after this file's tests.
const REAL_WINDOW = (globalThis as { window?: unknown }).window;
(globalThis as { window?: unknown }).window ??= {
  location: { origin: "http://localhost" },
  matchMedia: () => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }),
};
import { afterAll } from "bun:test";
afterAll(() => {
  (globalThis as { window?: unknown }).window = REAL_WINDOW;
});
const { BundleCards } = await import("../apps/web/src/pages/billing/bundles");
const { formatLedgerMemoLabel } = await import("../apps/web/src/lib/display");

function render(payosAvailable: boolean): string {
  const qc = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <BundleCards
        bundles={[
          {
            id: "b1",
            name: "Starter",
            price_vnd: 50_000,
            credit_vnd: 50_000,
            bonus_vnd: 0,
          },
          {
            id: "b2",
            name: "Value",
            price_vnd: 100_000,
            credit_vnd: 110_000,
            bonus_vnd: 10_000,
          },
        ]}
        workspaceId="ws_1"
        payosAvailable={payosAvailable}
        onNavigate={() => {}}
      />
    </QueryClientProvider>,
  );
}

test("cards show name, price, credit and bonus", () => {
  const html = render(false);
  expect(html).toContain("Starter");
  expect(html).toContain("Value");
  expect(html).toContain("50.000");
  expect(html).toContain("100.000");
  expect(html).toContain("110.000 ₫ credit");
  expect(html).toContain("+ 10.000 ₫ bonus");
});

test("no bonus line for a zero-bonus bundle", () => {
  const html = render(false);
  const starter = html.indexOf("Starter");
  const value = html.indexOf("Value");
  const starterCard = html.slice(starter, value);
  expect(starterCard).not.toContain("bonus");
});

test("PayOS advertised: provider choice shown, Manual checked by default", () => {
  const html = render(true);
  expect(html).toContain("Payment method");
  expect(html).toContain("PayOS");
  expect(html).toContain("Manual transfer");
  expect(html).toContain('checked="" value="manual"');
  expect(html).not.toContain('checked="" value="payos"');
});

test("PayOS not advertised: manual-only, no provider choice", () => {
  const html = render(false);
  expect(html).not.toContain("Payment method");
  expect(html).not.toContain("PayOS");
});

test("Buy button and settle expectation present", () => {
  const html = render(false);
  expect(html).toContain("Buy");
  expect(html).toContain("status shows on the Payments page");
});

test("adjustment memo labels", () => {
  expect(formatLedgerMemoLabel("bundle bonus")).toBe("Bundle bonus");
  expect(formatLedgerMemoLabel("first topup bonus")).toBe("First top-up bonus");
  expect(formatLedgerMemoLabel("subscription credit")).toBe("Subscription credit");
  expect(formatLedgerMemoLabel("something else")).toBe("Something Else");
});
