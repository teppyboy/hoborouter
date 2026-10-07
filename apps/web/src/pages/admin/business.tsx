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
import { useT } from "../../lib/i18n/t";

// Business report copy: inline LocaleEntry set (see lib/i18n/common.ts).
// Money aggregates, dates and identifiers are never translated.
const businessCopy = {
  requests: { en: "Requests", vi: "Requests" },
  usageRevenue: { en: "Usage revenue (charged, stored)", vi: "Doanh thu sử dụng (đã tính, lưu trữ)" },
  upstreamVnd: { en: "Upstream cost (VND)", vi: "Chi phí upstream (VND)" },
  upstreamVndHint: {
    en: "Each request converted with its own stored FX rate — never today's rate.",
    vi: "Mỗi request quy đổi bằng tỷ giá lưu trữ riêng của nó — không bao giờ dùng tỷ giá hôm nay.",
  },
  upstreamUsd: { en: "Upstream cost (USD)", vi: "Chi phí upstream (USD)" },
  upstreamUsdHint: {
    en: "Stored upstream_cost_usd_micro, summed exactly (API value is a decimal string).",
    vi: "Giá trị upstream_cost_usd_micro đã lưu, cộng chính xác (API trả về chuỗi thập phân).",
  },
  margin: { en: "Realized gross margin", vi: "Biên lợi nhuận gộp thực hiện" },
  marginHint: {
    en: "Charged usage − upstream cost at each request's stored FX rate. Not cash profit.",
    vi: "Doanh thu sử dụng − chi phí upstream theo tỷ giá lưu trữ từng request. Không phải lợi nhuận tiền mặt.",
  },
  marginProvisional: { en: "Realized gross margin", vi: "Biên lợi nhuận gộp thực hiện" },
  activePaying: { en: "Active paying users", vi: "Người dùng trả phí đang hoạt động" },
  cashReceipts: { en: "Cash receipts (paid day)", vi: "Tiền thu (ngày trả)" },
  cashHint: {
    en: "SUCCEEDED payments only, bucketed by paid day (payment event time). Top-ups {topups}, bundles {bundles}, subscriptions {subs}. Not ledger credits — promos, bundle bonuses and subscription grants also write credits.",
    vi: "Chỉ thanh toán SUCCEEDED, nhóm theo ngày trả (thời điểm sự kiện thanh toán). Nạp {topups}, gói tín dụng {bundles}, đăng ký {subs}. Không phải bút toán ghi có — khuyến mãi, thưởng gói và cấp tín dụng đăng ký cũng ghi có.",
  },
  refunds: { en: "Refunds (separate)", vi: "Hoàn tiền (riêng)" },
  refundsHint: {
    en: "Usage revenue is reported gross and never netted against refunds.",
    vi: "Doanh thu sử dụng báo theo tổng và không bao giờ trừ vào hoàn tiền.",
  },
  prepaid: { en: "Prepaid liability (snapshot)", vi: "Nợ trả trước (snapshot)" },
  prepaidHint: {
    en: "Unspent topup wallet credit right now — cash received but not yet consumed. Current snapshot, not a range total.",
    vi: "Tín dụng ví nạp chưa dùng tại thời điểm hiện tại — đã nhận tiền nhưng chưa tiêu. Snapshot hiện tại, không phải tổng theo khoảng.",
  },
  subCredit: { en: "Subscription credit (snapshot)", vi: "Tín dụng đăng ký (snapshot)" },
  subCreditHint: {
    en: "Granted subscription credit outstanding. A grant, not cash.",
    vi: "Tín dụng đăng ký đã cấp còn outstanding. Là cấp phát, không phải tiền mặt.",
  },
  provisionalNote: {
    en: "* Margin is provisional: {n} charged request(s) have no stored upstream cost, and {micro} USD-micro of cost has no stored FX rate (reported raw, never converted at today's rate). Unknown cost is not treated as zero.",
    vi: "* Biên lợi nhuận là tạm thời: {n} request đã tính phí không có chi phí upstream lưu trữ, và {micro} USD-micro chi phí không có tỷ giá lưu trữ (báo nguyên giá trị, không quy đổi theo tỷ giá hôm nay). Chi phí không xác định không được coi là 0.",
  },
  fallbackNote: {
    en: "{n} receipt(s) have no payment event and fall back to the order-creation day.",
    vi: "{n} khoản thu không có sự kiện thanh toán và tính về ngày tạo đơn.",
  },
  marginDefinition: {
    en: "Realized gross margin = charged usage revenue (stored charged_vnd, never recomputed from current prices) minus upstream cost converted per request at its own stored FX rate. It is NOT cash profit: no infra, support or payment costs; refunds are separate and usage revenue is gross, never netted. Soft-hidden requests stay in these totals.",
    vi: "Biên lợi nhuận gộp thực hiện = doanh thu sử dụng đã tính (charged_vnd lưu trữ, không bao giờ tính lại theo giá hiện tại) trừ chi phí upstream quy đổi theo tỷ giá lưu trữ riêng từng request. KHÔNG phải lợi nhuận tiền mặt: không gồm chi phí hạ tầng, hỗ trợ hay thanh toán; hoàn tiền riêng và doanh thu sử dụng là tổng, không bao giờ trừ lẫn. Request ẩn mềm vẫn nằm trong các tổng này.",
  },
  chargedVnd: { en: "Charged (VND)", vi: "Đã tính phí (VND)" },
  noUsage: { en: "No usage in this period", vi: "Không có sử dụng trong kỳ này" },
  dailyBreakdown: { en: "Daily breakdown", vi: "Chi tiết theo ngày" },
  byModel: { en: "Breakdown by model", vi: "Chi tiết theo mô hình" },
  byWorkspace: { en: "Breakdown by workspace", vi: "Chi tiết theo workspace" },
  dayUtc: { en: "Day (UTC)", vi: "Ngày (UTC)" },
  modelCol: { en: "Model", vi: "Mô hình" },
  workspaceCol: { en: "Workspace", vi: "Workspace" },
  title: { en: "Business", vi: "Kinh doanh" },
  description: {
    en: "Read-only financial report: usage revenue, upstream cost, realized gross margin, cash receipts. Margin is not cash profit.",
    vi: "Báo cáo tài chính chỉ-đọc: doanh thu sử dụng, chi phí upstream, biên lợi nhuận gộp thực hiện, tiền thu. Biên lợi nhuận không phải lợi nhuận tiền mặt.",
  },
  fromLabel: { en: "From (UTC, inclusive)", vi: "Từ (UTC, bao gồm)" },
  toLabel: { en: "To (UTC, exclusive)", vi: "Đến (UTC, không bao gồm)" },
  emptyRange: {
    en: "Empty = last 30 days. Max 366 days.",
    vi: "Để trống = 30 ngày qua. Tối đa 366 ngày.",
  },
  noReportData: { en: "No report data", vi: "Không có dữ liệu báo cáo" },
  provisionalTitle: {
    en: "Provisional: some charged requests in this row have no stored upstream cost or FX rate — their cost is unknown, not zero",
    vi: "Tạm thời: một số request đã tính phí trong dòng này không có chi phí upstream hoặc tỷ giá lưu trữ — chi phí của chúng không xác định, không phải 0",
  },
} as const;

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
  const tr = useT(businessCopy);
  return (
    <div className="rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{firstHeader}</TableHead>
            <TableHead className="text-right">{tr("requests")}</TableHead>
            <TableHead className="text-right">{tr("chargedVnd")}</TableHead>
            <TableHead className="text-right">{tr("upstreamVnd")}</TableHead>
            <TableHead className="text-right">{tr("margin")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground">
                {tr("noUsage")}
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
                    <span title={tr("provisionalTitle")}>
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
  const tr = useT(businessCopy);
  const t = data.totals;
  const empty = t.requests === 0;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <StatTile label={tr("requests")} value={String(t.requests)} />
        <StatTile label={tr("usageRevenue")} value={money(t.charged_vnd)} />
        <StatTile
          label={tr("upstreamVnd")}
          value={money(t.upstream_cost_vnd)}
          hint={tr("upstreamVndHint")}
        />
        <StatTile
          label={tr("upstreamUsd")}
          value={usdFromMicro(t.upstream_cost_usd_micro)}
          hint={tr("upstreamUsdHint")}
        />
        <StatTile
          label={tr("margin")}
          value={money(t.realized_gross_margin_vnd) + (t.margin_provisional ? "*" : "")}
          hint={tr("marginHint")}
        />
        <StatTile label={tr("activePaying")} value={String(data.active_paying_users)} />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label={tr("cashReceipts")}
          value={money(t.cash_receipts_vnd)}
          hint={tr("cashHint", {
            topups: money(t.cash_topups_vnd),
            bundles: money(t.bundle_sales_vnd),
            subs: money(t.subscription_sales_vnd),
          })}
        />
        <StatTile
          label={tr("refunds")}
          value={money(t.refund_vnd)}
          hint={tr("refundsHint")}
        />
        <StatTile
          label={tr("prepaid")}
          value={money(t.prepaid_liability_vnd)}
          hint={tr("prepaidHint")}
        />
        <StatTile
          label={tr("subCredit")}
          value={money(t.subscription_credit_vnd)}
          hint={tr("subCreditHint")}
        />
      </div>

      {t.upstream_missing_cost_requests > 0 || t.upstream_missing_fx_usd_micro !== "0" ? (
        <p className="text-xs text-muted-foreground">
          {tr("provisionalNote", {
            n: t.upstream_missing_cost_requests,
            micro: t.upstream_missing_fx_usd_micro,
          })}
        </p>
      ) : null}
      {t.cash_receipts_fallback_rows > 0 ? (
        <p className="text-xs text-muted-foreground">
          {tr("fallbackNote", { n: t.cash_receipts_fallback_rows })}
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        {tr("marginDefinition")}
      </p>

      {empty ? <EmptyState title={tr("noUsage")} /> : null}

      <UsageTable
        caption={tr("dailyBreakdown")}
        firstHeader={tr("dayUtc")}
        firstCell={(r) => r.day ?? ""}
        rows={data.daily}
      />
      <UsageTable
        caption={tr("byModel")}
        firstHeader={tr("modelCol")}
        firstCell={(r) => r.public_model ?? ""}
        rows={data.by_model}
      />
      <UsageTable
        caption={tr("byWorkspace")}
        firstHeader={tr("workspaceCol")}
        firstCell={(r) => r.workspace_name ?? r.workspace_id ?? ""}
        rows={data.by_workspace}
      />
    </div>
  );
}

export default function AdminBusinessPage() {
  const tr = useT(businessCopy);
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
        title={tr("title")}
        description={tr("description")}
      />
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-muted-foreground">
          {tr("fromLabel")}
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="text-xs text-muted-foreground">
          {tr("toLabel")}
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <span className="text-xs text-muted-foreground">{tr("emptyRange")}</span>
      </div>
      <AdminGate query={query}>
        {query.data ? (
          <BusinessReportView data={query.data} />
        ) : (
          <EmptyState title={tr("noReportData")} />
        )}
      </AdminGate>
    </div>
  );
}
