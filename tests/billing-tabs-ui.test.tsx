// Tabbed, internally-scrolling billing/usage panels: the tabs are accessible
// (role=tablist, aria-selected, labelled panels) and only the active tab's
// rows render, so long histories scroll inside their panel instead of growing
// the page. Static SSR render — no network, mirrors credits-payos-ui.test.tsx.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// lib/auth runs createAuthClient (window.location.origin) at module load;
// stub a minimal window so the SSR render test can import the pages.
(globalThis as { window?: unknown }).window ??= { location: { origin: "http://localhost" } };

const credits = await import("../apps/web/src/pages/billing/credits");
const { LedgerTabs } = credits;
const { PaymentHistory, PaymentsTabs } = await import("../apps/web/src/pages/billing/payments");
const { PerModelTable, UsageDataTabs } = await import("../apps/web/src/pages/usage");
const { ScrollPanel } = await import("../apps/web/src/components/page");

type LedgerEntry = import("../apps/web/src/pages/billing/credits").LedgerEntry;
type LedgerColumns = import("../apps/web/src/pages/billing/credits").LedgerColumns;

const ledgerColumns: LedgerColumns = [
  { accessorKey: "kind", header: "Kind" },
  { accessorKey: "amount", header: "Amount" },
];

function entry(over: Partial<LedgerEntry>): LedgerEntry {
  return {
    id: "le_1",
    created_at: 1_700_000_000_000,
    direction: "debit",
    kind: "settle",
    amount: 12000,
    balance_after: 88000,
    memo: null,
    payment_id: null,
    request_id: "req_1",
    ...over,
  };
}

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(node);
}

// ---------- Credits: ledger tabs ----------

test("Ledger tabs expose three labelled, count-annotated tabs", () => {
  const html = render(
    <LedgerTabs
      columns={ledgerColumns}
      sections={{
        usage: [entry({ request_id: "req_usage" })],
        topups: [entry({ kind: "topup", direction: "credit", request_id: null })],
        adjustments: [],
      }}
    />,
  );
  expect(html).toContain('role="tablist"');
  expect(html).toContain("Usage deductions (1)");
  expect(html).toContain("Top-up history (1)");
  expect(html).toContain("Adjustments &amp; refunds (0)");
});

test("Default tab is Usage deductions and inactive tabs render no rows", () => {
  const html = render(
    <LedgerTabs
      columns={ledgerColumns}
      sections={{
        usage: [entry({ request_id: "req_usage" })],
        topups: [entry({ kind: "topup", direction: "credit", amount: 50000 })],
        adjustments: [],
      }}
    />,
  );
  expect(html).toContain("settle");
  expect(html).toContain("12000");
  // Radix unmounts inactive panels: top-up rows must not be in the markup.
  expect(html).not.toContain("50000");
});

test("Empty active section keeps its per-section empty message", () => {
  const html = render(
    <LedgerTabs columns={ledgerColumns} sections={{ usage: [], topups: [], adjustments: [] }} />,
  );
  expect(html).toContain("No usage yet — deductions appear after the first request.");
});

test("Ledger rows scroll inside a labelled scrollable region", () => {
  const html = render(
    <LedgerTabs
      columns={ledgerColumns}
      sections={{
        usage: [entry({ request_id: "req_usage" })],
        topups: [],
        adjustments: [],
      }}
    />,
  );
  expect(html).toMatch(/role="region" aria-label="Usage deductions"/);
  // Keyboard-scrollable region (WCAG 2.1.1) — scrollable without a mouse.
  expect(html).toMatch(/aria-label="Usage deductions"[^>]*tabindex="0"/);
});

// ---------- Payments ----------

function payment(over: Record<string, unknown>) {
  return {
    id: "pay_abcdef123456",
    provider: "manual",
    amount: 100000,
    status: "pending",
    created_at: 1_700_000_000_000,
    provider_order_code: "PO123",
    ...over,
  };
}

test("Payment history renders rows inside a labelled scrollable region", () => {
  const html = render(<PaymentHistory payments={[payment({})]} rate={undefined} />);
  expect(html).toMatch(/role="region" aria-label="Payment history"/);
  expect(html).toMatch(/aria-label="Payment history"[^>]*tabindex="0"/);
  expect(html).toContain("pay_abcd");
});

test("Empty payment history keeps the empty state", () => {
  const html = render(<PaymentHistory payments={[]} rate={undefined} />);
  expect(html).toContain("No payments");
});

test("Payments tabs separate status from history; status is the default", () => {
  const html = render(<PaymentsTabs status={<p>STATUS_PANEL</p>} history={<p>HISTORY_PANEL</p>} />);
  expect(html).toContain('role="tablist"');
  expect(html).toContain("Payment status");
  expect(html).toContain("History");
  expect(html).toContain("STATUS_PANEL");
  expect(html).not.toContain("HISTORY_PANEL");
});

// ---------- Usage ----------

test("Per model table renders rows inside a labelled scrollable region", () => {
  const html = render(
    <PerModelTable
      rate={undefined}
      totalTokens={900}
      byModel={[{ public_model: "gpt-test", requests: 3, spend_vnd: 1200, tokens: 900 }]}
    />,
  );
  expect(html).toMatch(/role="region" aria-label="Per model usage"/);
  expect(html).toMatch(/aria-label="Per model usage"[^>]*tabindex="0"/);
  expect(html).toContain("gpt-test");
  expect(html).toContain("100.0%");
});

test("Empty per model table keeps the empty state", () => {
  const html = render(<PerModelTable rate={undefined} totalTokens={0} byModel={[]} />);
  expect(html).toContain("No requests yet");
});

test("Usage data tabs split chart from per-model; chart is the default", () => {
  const html = render(<UsageDataTabs chart={<p>CHART_PANEL</p>} perModel={<p>MODEL_PANEL</p>} />);
  expect(html).toContain('role="tablist"');
  expect(html).toContain("Chart");
  expect(html).toContain("Per model");
  expect(html).toContain("CHART_PANEL");
  expect(html).not.toContain("MODEL_PANEL");
});

test("ScrollPanel is a keyboard-scrollable labelled region", () => {
  const html = render(<ScrollPanel label="Anything">x</ScrollPanel>);
  expect(html).toMatch(/role="region" aria-label="Anything"[^>]*tabindex="0"/);
});
