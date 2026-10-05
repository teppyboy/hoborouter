// Business report display contract (admin/business.tsx): honest-money labels —
// realized gross margin explicitly NOT cash profit, refunds separate (usage
// gross, never netted), cash receipts from SUCCEEDED payments by paid day (not
// ledger credits), provisional-margin flagging when stored cost/FX is missing,
// exact-string money aggregates rendered with VND formatting, genuine empty
// state. Pure-props render — no network, no QueryClient.
import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BusinessReportView, type BusinessReport } from "../apps/web/src/pages/admin/business";

const bucket = (over: Partial<BusinessReport["daily"][number]>) => ({
  requests: 1,
  charged_vnd: "1000",
  upstream_cost_usd_micro: "0",
  upstream_cost_vnd: "0",
  upstream_missing_fx_usd_micro: "0",
  margin_incomplete_requests: 0,
  realized_gross_margin_vnd: "1000",
  margin_provisional: false,
  ...over,
});

const report = (over?: Partial<BusinessReport>): BusinessReport => ({
  range: {
    from: "2026-02-01",
    to: "2026-02-05",
    from_ms: 1_769_904_000_000,
    to_ms: 1_770_249_600_000,
    days: 4,
  },
  totals: {
    requests: 7,
    charged_vnd: "149550",
    upstream_cost_usd_micro: "5223456",
    upstream_cost_vnd: "133587",
    upstream_missing_fx_usd_micro: "100000",
    upstream_missing_cost_requests: 1,
    realized_gross_margin_vnd: "15963",
    margin_provisional: true,
    refund_vnd: "2500",
    cash_receipts_vnd: "350000",
    cash_topups_vnd: "50000",
    bundle_sales_vnd: "100000",
    subscription_sales_vnd: "200000",
    cash_receipts_fallback_rows: 0,
    prepaid_liability_vnd: "65000",
    subscription_credit_vnd: "8000",
  },
  active_paying_users: 3,
  daily: [
    bucket({
      day: "2026-02-01",
      requests: 5,
      charged_vnd: "49800",
      upstream_cost_vnd: "41087",
      realized_gross_margin_vnd: "8713",
      margin_incomplete_requests: 1,
      margin_provisional: true,
      upstream_missing_fx_usd_micro: "100000",
    }),
    bucket({ day: "2026-02-02", charged_vnd: "68750", realized_gross_margin_vnd: "6250" }),
  ],
  by_model: [
    bucket({ public_model: "model-a", charged_vnd: "130250", realized_gross_margin_vnd: "9663" }),
    bucket({
      public_model: "model-c",
      charged_vnd: "5000",
      upstream_cost_vnd: "0",
      realized_gross_margin_vnd: "5000",
      margin_incomplete_requests: 1,
      margin_provisional: true,
    }),
  ],
  by_workspace: [
    bucket({
      workspace_id: "ws-a",
      workspace_name: "Acme",
      charged_vnd: "80800",
      realized_gross_margin_vnd: "9713",
      margin_incomplete_requests: 1,
      margin_provisional: true,
    }),
  ],
  ...over,
});

const render = (data: BusinessReport) => renderToStaticMarkup(<BusinessReportView data={data} />);

test("margin is labeled realized gross margin and explicitly not cash profit", () => {
  const html = render(report());
  expect(html).toContain("Realized gross margin");
  expect(html).toContain("NOT cash profit");
});

test("money aggregates render from exact decimal strings as VND", () => {
  const html = render(report());
  expect(html).toContain("149.550 ₫"); // charged
  expect(html).toContain("133.587 ₫"); // upstream cost VND
  expect(html).toContain("15.963 ₫"); // margin
  expect(html).toContain("$5.22"); // upstream USD from micro
});

test("above-safe-integer aggregates preserve the final digit and negative margin", () => {
  const html = render(
    report({
      totals: {
        ...report().totals,
        charged_vnd: "9007199254740993",
        upstream_cost_vnd: "9007199254740992",
        upstream_cost_usd_micro: "9007199254740993500000",
        realized_gross_margin_vnd: "-9007199254740993",
      },
    }),
  );
  expect(html).toContain("9.007.199.254.740.993 ₫");
  expect(html).toContain("9.007.199.254.740.992 ₫");
  expect(html).toContain("-9.007.199.254.740.993 ₫");
  expect(html).toContain("$9007199254740993.50");
});

test("USD micro aggregates round half-cent boundaries exactly, including negatives", () => {
  const positive = render(
    report({ totals: { ...report().totals, upstream_cost_usd_micro: "15000" } }),
  );
  const negative = render(
    report({ totals: { ...report().totals, upstream_cost_usd_micro: "-15000" } }),
  );
  const below = render(
    report({ totals: { ...report().totals, upstream_cost_usd_micro: "14999" } }),
  );
  expect(positive).toContain("$0.02");
  expect(negative).toContain("-$0.02");
  expect(below).toContain("$0.01");
});

test("cash receipts carry the paid-day and not-ledger-credits caveats; refunds separate", () => {
  const html = render(report());
  expect(html).toContain("Cash receipts (paid day)");
  expect(html).toContain("SUCCEEDED payments only");
  expect(html).toContain("Not ledger credits");
  expect(html).toContain("Refunds (separate)");
  expect(html).toContain("never netted");
});

test("provisional margin flagged per row and in totals; unknown cost never treated as zero", () => {
  const html = render(report());
  // Provisional marker on the daily row, the model row, and the workspace row.
  expect((html.match(/Provisional:/g) ?? []).length).toBe(3);
  expect(html).toContain("no stored upstream cost or FX rate");
  expect(html).toContain("Unknown cost is not treated as zero");
});

test("liability snapshots are labeled as grants/snapshots, not cash", () => {
  const html = render(report());
  expect(html).toContain("Prepaid liability (snapshot)");
  expect(html).toContain("Subscription credit (snapshot)");
  expect(html).toContain("A grant, not cash");
});

test("breakdown tables render real fields, including workspace names", () => {
  const html = render(report());
  expect(html).toContain("Day (UTC)");
  expect(html).toContain("Model");
  expect(html).toContain("Workspace");
  expect(html).toContain("2026-02-01");
  expect(html).toContain("model-a");
  expect(html).toContain("Acme");
});

test("genuine empty state: zero usage shows the empty message, no fabricated rows", () => {
  const data = report({
    totals: { ...report().totals, requests: 0 },
    daily: [],
    by_model: [],
    by_workspace: [],
  });
  const html = render(data);
  expect(html).toContain("No usage in this period");
  expect(html).not.toContain("model-a");
});
