// Throughput allowance UI contract (SSR): product cards show price, admission
// cap and duration; the disclaimer always states the product is a gateway
// admission limit and NEVER a provider-capacity guarantee or priority
// promise; the status card shows the purchased window without claiming more.
// Static markup fires no requests — purchase behavior belongs to the API.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// lib/auth runs createAuthClient (window.location.origin) at module load;
// stub a minimal window so the SSR render test can import the page (same
// pattern as billing-bundles-ui.test.tsx).
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
// Radix (pulled in by the billing page) captures document availability when
// its modules first load; without any document the captured state breaks
// Radix event wiring for later jsdom tests sharing this bun process
// (billing-checkout-ui). The shared fixture installs a faithful jsdom
// document; the previous value is restored after this file's tests.
import { afterAll } from "bun:test";
import { installSsrDom } from "./helpers/ssr-dom";
const restoreSsrDom = installSsrDom();
afterAll(() => {
  (globalThis as { window?: unknown }).window = REAL_WINDOW;
  restoreSsrDom();
});
const { ThroughputProductCards, ThroughputAllowanceStatus, THROUGHPUT_ALLOWANCE_DISCLAIMER } =
  await import("../apps/web/src/pages/billing/bundles");

function renderCards(): string {
  const qc = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ThroughputProductCards
        products={[
          {
            id: "tp1",
            name: "Turbo 30",
            price_vnd: 150_000,
            requests_per_minute: 30,
            duration_days: 7,
          },
        ]}
        workspaceId="ws_1"
        selectedId={null}
        onSelect={() => {}}
      />
    </QueryClientProvider>,
  );
}

test("cards show name, price, admission cap and duration", () => {
  const html = renderCards();
  expect(html).toContain("Turbo 30");
  expect(html).toContain("150.000");
  expect(html).toContain("30 requests/minute");
  expect(html).toContain("7 days");
  expect(html).toContain("Select");
});

test("disclaimer states gateway admission limit, never capacity or priority", () => {
  expect(THROUGHPUT_ALLOWANCE_DISCLAIMER).toContain("gateway admission limit");
  expect(THROUGHPUT_ALLOWANCE_DISCLAIMER).toContain("not a provider-capacity guarantee");
  expect(THROUGHPUT_ALLOWANCE_DISCLAIMER).toContain("not a priority promise");
  expect(THROUGHPUT_ALLOWANCE_DISCLAIMER).toContain("no wallet credit");
  const html = renderCards();
  expect(html).toContain("gateway admission limit");
  // Negated phrasing must stay negated: the disclaimer contains the full
  // "not a provider-capacity guarantee" / "not a priority promise" strings.
  expect(html).toContain("not a provider-capacity guarantee");
  expect(html).toContain("not a priority promise");
});

test("payment methods stay behind product selection (checkout dialog)", () => {
  const html = renderCards();
  expect(html).not.toContain("Payment method");
  expect(html).not.toContain("PayOS");
  expect(html).not.toContain("Manual transfer");
});

test("status card shows the admission cap and window, grants nothing else", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ThroughputAllowanceStatus
        allowance={{
          requests_per_minute: 30,
          starts_at: 1_700_000_000_000,
          ends_at: 1_700_604_800_000,
          status: "active",
          limiting: true,
        }}
      />
    </QueryClientProvider>,
  );
  expect(html).toContain("30 requests/minute");
  expect(html).toContain("gateway admission cap");
  expect(html).toContain("Limiting");
  expect(html).toContain("grants no wallet credit");
});
