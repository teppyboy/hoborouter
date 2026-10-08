// Subscription UI contract (SSR): plan cards show price and per-period credit
// (Subscribe/Renew wording lives in the checkout dialog, not on the card); the
// Credits subscription card shows balance, period end, per-minute limit and
// the forfeit note; expired ledger memo gets its human label. Static markup
// fires no requests.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// lib/auth runs createAuthClient (window.location.origin) at module load;
// stub a minimal window so the SSR render test can import the pages.
(globalThis as { window?: unknown }).window ??= { location: { origin: "http://localhost" } };
// Radix (pulled in by the billing page) captures document availability when
// its modules first load; without any document the captured state breaks
// Radix event wiring for later jsdom tests sharing this bun process
// (billing-checkout-ui). The shared fixture installs a faithful jsdom
// document; the previous value is restored after this file's tests.
import { afterAll } from "bun:test";
import { installSsrDom } from "./helpers/ssr-dom";
const restoreSsrDom = installSsrDom();
afterAll(restoreSsrDom);
const { PlanCards } = await import("../apps/web/src/pages/billing/bundles");
const { SubscriptionCard } = await import("../apps/web/src/pages/billing/credits");
const { formatLedgerMemoLabel } = await import("../apps/web/src/lib/display");

const plan = {
  id: "p1",
  name: "Pro",
  price_vnd: 200_000,
  credit_per_period_vnd: 250_000,
  period_days: 30,
  rate_limit_per_minute: 15,
};

function renderPlans(): string {
  const qc = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <PlanCards plans={[plan]} workspaceId="ws_1" selectedId={null} onSelect={() => {}} />
    </QueryClientProvider>,
  );
}

function renderSubscriptionCard(): string {
  const qc = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <SubscriptionCard
        subscription={{
          balance: 250_000,
          available: 230_000,
          period_end: Date.parse("2030-02-01T00:00:00Z"),
          plan_name: "Pro",
          rate_limit_per_minute: 15,
          expired: false,
        }}
        rate={undefined}
      />
    </QueryClientProvider>,
  );
}

test("plan card shows name, price, per-period credit and the rate limit", () => {
  const html = renderPlans();
  expect(html).toContain("Pro");
  expect(html).toContain("200.000");
  expect(html).toContain("250.000 ₫ credit / 30 days");
  expect(html).toContain("15 requests per minute");
});

test("card button selects, it never subscribes directly; dialog owns Subscribe/Renew", () => {
  const html = renderPlans();
  expect(html).toContain("Select");
  expect(html).not.toContain("Subscribe");
  expect(html).not.toContain(">Renew</button>");
});

test("subscription card shows balance, period end, rate limit and the forfeit note", () => {
  const html = renderSubscriptionCard();
  expect(html).toContain("Subscription credit");
  expect(html).toContain("Pro");
  expect(html).toContain("250.000");
  expect(html).toContain("2030"); // formatDate(period_end) (vi-VN medium date)
  expect(html).toContain("15 requests per minute");
  expect(html).toContain(
    "Unused subscription credit is lost when the period ends without a renewal.",
  );
});

test("expired subscription memo label", () => {
  expect(formatLedgerMemoLabel("subscription expired")).toBe("Subscription expired");
  expect(formatLedgerMemoLabel("subscription credit")).toBe("Subscription credit");
});
