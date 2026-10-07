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
import { afterAll } from "bun:test";
afterAll(() => {
  (globalThis as { window?: unknown }).window = REAL_WINDOW;
});
const { ThroughputProductCards, ThroughputAllowanceStatus, THROUGHPUT_ALLOWANCE_DISCLAIMER } =
  await import("../apps/web/src/pages/billing/bundles");

function renderCards(payosAvailable: boolean): string {
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
        payosAvailable={payosAvailable}
        onNavigate={() => {}}
      />
    </QueryClientProvider>,
  );
}

test("cards show name, price, admission cap and duration", () => {
  const html = renderCards(false);
  expect(html).toContain("Turbo 30");
  expect(html).toContain("150.000");
  expect(html).toContain("30 requests/minute");
  expect(html).toContain("7 days");
  expect(html).toContain("Buy");
});

test("disclaimer states gateway admission limit, never capacity or priority", () => {
  expect(THROUGHPUT_ALLOWANCE_DISCLAIMER).toContain("gateway admission limit");
  expect(THROUGHPUT_ALLOWANCE_DISCLAIMER).toContain("not a provider-capacity guarantee");
  expect(THROUGHPUT_ALLOWANCE_DISCLAIMER).toContain("not a priority promise");
  expect(THROUGHPUT_ALLOWANCE_DISCLAIMER).toContain("no wallet credit");
  const html = renderCards(false);
  expect(html).toContain("gateway admission limit");
  // Negated phrasing must stay negated: the disclaimer contains the full
  // "not a provider-capacity guarantee" / "not a priority promise" strings.
  expect(html).toContain("not a provider-capacity guarantee");
  expect(html).toContain("not a priority promise");
});

test("PayOS advertised: provider choice shown; manual default", () => {
  const html = renderCards(true);
  expect(html).toContain("Payment method");
  expect(html).toContain("PayOS");
  expect(html).toContain('checked="" value="manual"');
  expect(html).not.toContain('checked="" value="payos"');
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
