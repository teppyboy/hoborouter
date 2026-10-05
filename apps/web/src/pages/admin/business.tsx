// Admin business dashboard (BMC blocks 6/7/9) — read-only view over
// GET /api/v1/admin/business. Honest-money labels: realized gross margin is
// NOT cash profit; cash receipts are succeeded payments by paid day (not
// ledger credits); refunds are separate; provisional margins are flagged.
// Native date inputs, plain tables — no chart or date-picker dependencies.
import { useState } from "react";
import { PageHeader, EmptyState } from "../../components/page";
import { Input } from "../../components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { AdminGate, useAdminQuery } from "./shared";

/** Money aggregate from the API: exact decimal string. */
export type MoneyString = string;

export interface BusinessRange {
  from: string;
  to: string;
  from_ms: number;
  to_ms: number;
  days: number;
}

export interface UsageBucket {
  day?: string;
  public_model?: string;
  workspace_id?: string;
  workspace_name?: string;
  requests: number;
  charged_vnd: MoneyString;
  upstream_cost_usd_micro: MoneyString;
  upstream_cost_vnd: MoneyString;
  upstream_missing_fx_usd_micro: MoneyString;
  margin_incomplete_requests: number;
  realized_gross_margin_vnd: MoneyString;
  margin_provisional: boolean;
}

export interface BusinessReport {
  range: BusinessRange;
  totals: {
    requests: number;
    charged_vnd: MoneyString;
    upstream_cost_usd_micro: MoneyString;
    upstream_cost_vnd: MoneyString;
    upstream_missing_fx_usd_micro: MoneyString;
    upstream_missing_cost_requests: number;
    realized_gross_margin_vnd: MoneyString;
    margin_provisional: boolean;
    refund_vnd: MoneyString;
    cash_receipts_vnd: MoneyString;
    cash_topups_vnd: MoneyString;
    bundle_sales_vnd: MoneyString;
    subscription_sales_vnd: MoneyString;
    cash_receipts_fallback_rows: number;
    prepaid_liability_vnd: MoneyString;
    subscription_credit_vnd: MoneyString;
  };
  active_paying_users: number;
  daily: UsageBucket[];
  by_model: UsageBucket[];
  by_workspace: UsageBucket[];
}

const vndFormat = new Intl.NumberFormat("vi-VN", {
  style: "decimal",
  maximumFractionDigits: 0,
});

/** Format exact VND aggregates without converting them through an unsafe Number. */
const money = (v: MoneyString | number | null | undefined) =>
  v == null ? "—" : `${vndFormat.format(BigInt(String(v)))} ₫`;

/** USD micro -> cents, rounded half away from zero with integer arithmetic. */
const usdFromMicro = (v: MoneyString) => {
  const micros = BigInt(v);
  const negative = micros < 0n;
  const absolute = negative ? -micros : micros;
  let cents = absolute / 10_000n;
  if (absolute % 10_000n >= 5_000n) cents += 1n;
  const dollars = cents / 100n;
  const remainder = (cents % 100n).toString().padStart(2, "0");
  return `${negative && cents !== 0n ? "-" : ""}$${dollars}.${remainder}`;
};

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-semibold" title={hint}>
        {value}
      </p>
    </div>
  );
}

function UsageTable({
  caption,
  firstHeader,
  firstCell,
  rows,
}: {
  caption: string;
  firstHeader: string;
  firstCell: (r: UsageBucket) => string;
  rows: UsageBucket[];
}) {
  return (
    <div className="rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{firstHeader}</TableHead>
            <TableHead className="text-right">Requests</TableHead>
            <TableHead className="text-right">Charged (VND)</TableHead>
            <TableHead className="text-right">Upstream cost (VND)</TableHead>
            <TableHead className="text-right">Realized gross margin</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground">
                No usage in this period
              </TableCell>
            </TableRow>
          ) : (
            rows.map((r) => (
              <TableRow key={r.day ?? r.public_model ?? r.workspace_id}>
                <TableCell className="font-mono text-xs">{firstCell(r)}</TableCell>
                <TableCell className="text-right">{r.requests}</TableCell>
                <TableCell className="text-right">{money(r.charged_vnd)}</TableCell>
                <TableCell className="text-right">{money(r.upstream_cost_vnd)}</TableCell>
                <TableCell className="text-right">
                  {money(r.realized_gross_margin_vnd)}
                  {r.margin_provisional ? (
                    <span title="Provisional: some charged requests in this row have no stored upstream cost or FX rate — their cost is unknown, not zero">
                      *
                    </span>
                  ) : null}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      <p className="sr-only">{caption}</p>
    </div>
  );
}

/**
 * Presentational report view (pure props — no fetching), so display behavior
 * is testable without network. Definitions are shown on the page because the
 * numbers are easy to misread as cash profit.
 */
export function BusinessReportView({ data }: { data: BusinessReport }) {
  const t = data.totals;
  const empty = t.requests === 0;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <StatTile label="Requests" value={String(t.requests)} />
        <StatTile label="Usage revenue (charged, stored)" value={money(t.charged_vnd)} />
        <StatTile
          label="Upstream cost (VND)"
          value={money(t.upstream_cost_vnd)}
          hint="Each request converted with its own stored FX rate — never today's rate."
        />
        <StatTile
          label="Upstream cost (USD)"
          value={usdFromMicro(t.upstream_cost_usd_micro)}
          hint="Stored upstream_cost_usd_micro, summed exactly (API value is a decimal string)."
        />
        <StatTile
          label="Realized gross margin"
          value={money(t.realized_gross_margin_vnd) + (t.margin_provisional ? "*" : "")}
          hint="Charged usage − upstream cost at each request's stored FX rate. Not cash profit."
        />
        <StatTile label="Active paying users" value={String(data.active_paying_users)} />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Cash receipts (paid day)"
          value={money(t.cash_receipts_vnd)}
          hint={`SUCCEEDED payments only, bucketed by paid day (payment event time). Top-ups ${money(t.cash_topups_vnd)}, bundles ${money(t.bundle_sales_vnd)}, subscriptions ${money(t.subscription_sales_vnd)}. Not ledger credits — promos, bundle bonuses and subscription grants also write credits.`}
        />
        <StatTile
          label="Refunds (separate)"
          value={money(t.refund_vnd)}
          hint="Usage revenue is reported gross and never netted against refunds."
        />
        <StatTile
          label="Prepaid liability (snapshot)"
          value={money(t.prepaid_liability_vnd)}
          hint="Unspent topup wallet credit right now — cash received but not yet consumed. Current snapshot, not a range total."
        />
        <StatTile
          label="Subscription credit (snapshot)"
          value={money(t.subscription_credit_vnd)}
          hint="Granted subscription credit outstanding. A grant, not cash."
        />
      </div>

      {t.upstream_missing_cost_requests > 0 || t.upstream_missing_fx_usd_micro !== "0" ? (
        <p className="text-xs text-muted-foreground">
          * Margin is provisional: {t.upstream_missing_cost_requests} charged request(s) have no
          stored upstream cost, and {t.upstream_missing_fx_usd_micro} USD-micro of cost has no
          stored FX rate (reported raw, never converted at today&apos;s rate). Unknown cost is not
          treated as zero.
        </p>
      ) : null}
      {t.cash_receipts_fallback_rows > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t.cash_receipts_fallback_rows} receipt(s) have no payment event and fall back to the
          order-creation day.
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Realized gross margin = charged usage revenue (stored <code>charged_vnd</code>, never
        recomputed from current prices) minus upstream cost converted per request at its own stored
        FX rate. It is NOT cash profit: no infra, support or payment costs; refunds are separate and
        usage revenue is gross, never netted. Soft-hidden requests stay in these totals.
      </p>

      {empty ? <EmptyState title="No usage in this period" /> : null}

      <UsageTable
        caption="Daily breakdown"
        firstHeader="Day (UTC)"
        firstCell={(r) => r.day ?? ""}
        rows={data.daily}
      />
      <UsageTable
        caption="Breakdown by model"
        firstHeader="Model"
        firstCell={(r) => r.public_model ?? ""}
        rows={data.by_model}
      />
      <UsageTable
        caption="Breakdown by workspace"
        firstHeader="Workspace"
        firstCell={(r) => r.workspace_name ?? r.workspace_id ?? ""}
        rows={data.by_workspace}
      />
    </div>
  );
}

export default function AdminBusinessPage() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const qs = params.toString();
  const query = useAdminQuery<BusinessReport>(
    ["admin", "business", from, to],
    `/api/v1/admin/business${qs ? `?${qs}` : ""}`,
  );
  return (
    <div className="space-y-4">
      <PageHeader
        title="Business"
        description="Read-only financial report: usage revenue, upstream cost, realized gross margin, cash receipts. Margin is not cash profit."
      />
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-muted-foreground">
          From (UTC, inclusive)
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="text-xs text-muted-foreground">
          To (UTC, exclusive)
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <span className="text-xs text-muted-foreground">Empty = last 30 days. Max 366 days.</span>
      </div>
      <AdminGate query={query}>
        {query.data ? (
          <BusinessReportView data={query.data} />
        ) : (
          <EmptyState title="No report data" />
        )}
      </AdminGate>
    </div>
  );
}
