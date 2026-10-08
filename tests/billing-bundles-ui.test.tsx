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
// Radix (Tabs/Dialog, pulled in by the billing page) captures document
// availability when its modules first load. Without any document the captured
// state breaks Radix event wiring for every later jsdom test sharing this bun
// process (e.g. billing-checkout-ui): tab activation and dialog mounts die
// silently. The shared fixture installs a faithful jsdom document; the
// previous value is restored after this file's tests.
import { afterAll } from "bun:test";
import { installSsrDom } from "./helpers/ssr-dom";
const restoreSsrDom = installSsrDom();
afterAll(() => {
  (globalThis as { window?: unknown }).window = REAL_WINDOW;
  restoreSsrDom();
});
const { BundleCards } = await import("../apps/web/src/pages/billing/bundles");
const { formatLedgerMemoLabel } = await import("../apps/web/src/lib/display");

function render(): string {
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
        selectedId={null}
        onSelect={() => {}}
      />
    </QueryClientProvider>,
  );
}

test("cards show name, price, credit and bonus", () => {
  const html = render();
  expect(html).toContain("Starter");
  expect(html).toContain("Value");
  expect(html).toContain("50.000");
  expect(html).toContain("100.000");
  expect(html).toContain("110.000 ₫ credit");
  expect(html).toContain("+ 10.000 ₫ bonus");
});

test("no bonus line for a zero-bonus bundle", () => {
  const html = render();
  const starter = html.indexOf("Starter");
  const value = html.indexOf("Value");
  const starterCard = html.slice(starter, value);
  expect(starterCard).not.toContain("bonus");
});

test("cards gate payment methods: provider choice lives in the checkout dialog only", () => {
  const html = render();
  expect(html).not.toContain("Payment method");
  expect(html).not.toContain("PayOS");
  expect(html).not.toContain("Manual transfer");
});

test("Select button and settle expectation present", () => {
  const html = render();
  expect(html).toContain("Select");
  expect(html).not.toContain(">Buy</button>");
  expect(html).toContain("status shows on the Payments page");
});

test("adjustment memo labels", () => {
  expect(formatLedgerMemoLabel("bundle bonus")).toBe("Bundle bonus");
  expect(formatLedgerMemoLabel("first topup bonus")).toBe("First top-up bonus");
  expect(formatLedgerMemoLabel("subscription credit")).toBe("Subscription credit");
  expect(formatLedgerMemoLabel("something else")).toBe("Something Else");
});
