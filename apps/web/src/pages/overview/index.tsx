import { PageHeader, EmptyState, ErrorState } from "../../components/page";
import { Skeleton } from "../../components/ui/skeleton";
import { formatTokens, formatVnd, formatUsdFromVnd, useUsdVndRate } from "../../lib/format";
import { ApiError } from "../../lib/api";
import { useCurrentWorkspaceId } from "../../lib/workspace-queries";
import { formatStatusLabel } from "../../lib/display";
import { useUsageSummary } from "../logs/api";
import { metricSeries } from "../usage/charthelper";
import { BarSeries } from "../../components/chart/bar-series";
import { useLocaleEntry } from "../../lib/i18n/t";

// Overview chrome copy: inline LocaleEntry set (see lib/i18n/common.ts).
// Numbers, money formats and statuses stay server-formatted — words only.
const overviewCopy = {
  title: { en: "Overview", vi: "Tổng quan" },
  description: {
    en: "Last 30 days of activity for the selected workspace.",
    vi: "Hoạt động 30 ngày gần nhất của workspace đang chọn.",
  },
  requests: { en: "Requests", vi: "Request" },
  spend: { en: "Spend", vi: "Chi tiêu" },
  tokens: { en: "Tokens", vi: "Token" },
  successRate: { en: "Success rate", vi: "Tỷ lệ thành công" },
  spendPerDay: { en: "Spend per day (USD)", vi: "Chi tiêu mỗi ngày (USD)" },
  maxPerDay: { en: "max", vi: "tối đa" },
  perDay: { en: "/day", vi: "/ngày" },
  recentRequests: { en: "Recent requests", vi: "Request gần đây" },
  time: { en: "Time", vi: "Thời gian" },
  model: { en: "Model", vi: "Mô hình" },
  status: { en: "Status", vi: "Trạng thái" },
  cost: { en: "Cost", vi: "Chi phí" },
  summaryUnavailable: {
    en: "Usage summary endpoint not available yet",
    vi: "Chưa có endpoint tổng hợp mức sử dụng",
  },
  noRequests: { en: "No requests yet", vi: "Chưa có request nào" },
  logsUnavailable: {
    en: "Usage logs endpoint not available yet",
    vi: "Chưa có endpoint nhật ký mức sử dụng",
  },
  noUsage: { en: "No requests with usage", vi: "Không có request nào có mức sử dụng" },
  retry: { en: "Retry", vi: "Thử lại" },
  loading: { en: "Loading overview…", vi: "Đang tải tổng quan…" },
  // Visible only to screen readers: the sr-only data table in BarSeries is the
  // AT surface for the spend chart; this names its content.
  chartAria: {
    en: "Bar chart of daily spend over the last 30 days.",
    vi: "Biểu đồ cột chi tiêu mỗi ngày trong 30 ngày gần đây.",
  },
  dayCol: { en: "Day", vi: "Ngày" },
  successRateHint: {
    en: "Share of successful requests among eligible requests (requests with a model and token usage) in the last 30 days — not limited to the 10 recent rows below.",
    vi: "Tỷ lệ request thành công trong số các request đủ điều kiện (có mô hình và mức sử dụng token) trong 30 ngày gần đây — không chỉ giới hạn ở 10 request gần đây bên dưới.",
  },
} as const;

function StatTile({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    // min-w-0 + truncate: long VND amounts must never blow out the 2-col
    // mobile grid; the grid item clips instead of overflowing the viewport.
    <div className="min-w-0 rounded-md border border-border px-4 py-3">
      <p className="truncate text-xs text-muted-foreground" title={title}>
        {label}
      </p>
      <p className="mt-1 truncate font-mono text-lg tabular-nums sm:text-xl" title={value}>
        {value}
      </p>
    </div>
  );
}

function ChartFooter({
  data,
  maxValue,
  rate,
}: {
  data: { label: string; value: number }[];
  maxValue: number;
  rate?: number;
}) {
  const maxWord = useLocaleEntry(overviewCopy.maxPerDay);
  const perDay = useLocaleEntry(overviewCopy.perDay);
  return (
    <div className="mt-2 flex justify-between text-xs text-muted-foreground">
      <span>{data[0]?.label}</span>
      <span>
        {maxWord} {formatUsdFromVnd(maxValue, rate) ?? formatVnd(maxValue)}
        {perDay}
      </span>
      <span>{data.at(-1)?.label}</span>
    </div>
  );
}

export default function OverviewPage() {
  const workspaceId = useCurrentWorkspaceId();
  const summary = useUsageSummary(workspaceId);
  const rate = useUsdVndRate(workspaceId).data;
  // Hooks must run on every render — before any early return below.
  const requestsLabel = useLocaleEntry(overviewCopy.requests);
  const spendLabel = useLocaleEntry(overviewCopy.spend);
  const tokensLabel = useLocaleEntry(overviewCopy.tokens);
  const successRateLabel = useLocaleEntry(overviewCopy.successRate);
  const successRateHint = useLocaleEntry(overviewCopy.successRateHint);
  const loadingLabel = useLocaleEntry(overviewCopy.loading);
  const chartAria = useLocaleEntry(overviewCopy.chartAria);
  const dayLabel = useLocaleEntry(overviewCopy.dayCol);

  if (summary.isPending) {
    return (
      <div className="space-y-4">
        <OverviewHeader />
        {/* role=status announces the wait to screen readers even though the
            skeleton itself is silent. */}
        <div role="status">
          <span className="sr-only">{loadingLabel}</span>
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }
  if (summary.isError) {
    const err = summary.error as ApiError;
    return (
      <div className="space-y-4">
        <OverviewHeader />
        {err.status === 404 ? (
          <SummaryUnavailableState />
        ) : (
          <>
            <ErrorState message={err.message} />
            <RetryButton onClick={() => summary.refetch()} />
          </>
        )}
      </div>
    );
  }

  const t = summary.data.totals;
  // Success rate over visibility-gated rows only (same gate as RecentRequests):
  // missing model or zero token rows are excluded. Errors stay in financial
  // aggregates (spend/errors) — only the rate denominator/numerator is gated.
  // Older backend without visible counts: honest em dash, no fabricated rate.
  const successRate =
    t.visible_requests == null || t.visible_errors == null
      ? "—"
      : t.visible_requests > 0
        ? `${(((t.visible_requests - t.visible_errors) / t.visible_requests) * 100).toFixed(1)}%`
        : "—";

  // Zero-filled 30-day UTC spend series (shared helper; no divergent fill).
  const spendPoints = metricSeries(summary.data.daily, 30, "cost");

  return (
    <div className="space-y-4">
      <OverviewHeader />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={requestsLabel} value={String(t.requests)} />
        <StatTile
          label={spendLabel}
          value={formatUsdFromVnd(t.spend_vnd, rate) ?? formatVnd(t.spend_vnd)}
        />
        <StatTile label={tokensLabel} value={formatTokens(t.input_tokens + t.output_tokens)} />
        <StatTile label={successRateLabel} value={successRate} title={successRateHint} />
      </div>
      <div className="rounded-md border border-border p-4">
        <SpendPerDayLabel />
        {summary.data.daily.length === 0 ? (
          <NoRequestsState />
        ) : (
          <BarSeries
            points={spendPoints}
            formatValue={(v) => formatUsdFromVnd(v, rate) ?? formatVnd(v)}
            ariaLabel={chartAria}
            srSummary={chartAria}
            dateHeader={dayLabel}
            valueHeader={spendLabel}
            height={128}
          />
        )}
        <ChartFooter
          data={spendPoints}
          maxValue={Math.max(...spendPoints.map((p) => p.value))}
          rate={rate}
        />
      </div>
      <RecentRequests workspaceId={workspaceId} />
    </div>
  );
}

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { useRequestLogs } from "../logs/api";
import { visibleRows } from "../logs/filters";
import { formatDate } from "../../lib/format";

function OverviewHeader() {
  return (
    <PageHeader
      title={useLocaleEntry(overviewCopy.title)}
      description={useLocaleEntry(overviewCopy.description)}
    />
  );
}

function SummaryUnavailableState() {
  return <EmptyState title={useLocaleEntry(overviewCopy.summaryUnavailable)} />;
}

function SpendPerDayLabel() {
  return (
    <p className="mb-3 text-xs text-muted-foreground">{useLocaleEntry(overviewCopy.spendPerDay)}</p>
  );
}

function NoRequestsState() {
  return <EmptyState title={useLocaleEntry(overviewCopy.noRequests)} />;
}

function RecentRequestsLabel() {
  return (
    <p className="mb-2 text-xs text-muted-foreground">
      {useLocaleEntry(overviewCopy.recentRequests)}
    </p>
  );
}

function LogsUnavailableState() {
  return <EmptyState title={useLocaleEntry(overviewCopy.logsUnavailable)} />;
}

function NoUsageState() {
  return <EmptyState title={useLocaleEntry(overviewCopy.noUsage)} />;
}

/** Manual refetch for transient failures — the ErrorState alone is a dead end. */
function RetryButton({ onClick }: { onClick: () => void }) {
  const label = useLocaleEntry(overviewCopy.retry);
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
    >
      {label}
    </button>
  );
}

function RecentRequests({ workspaceId }: { workspaceId: string | null }) {
  const logs = useRequestLogs(workspaceId, 10);
  const rate = useUsdVndRate(workspaceId).data;
  // Hoisted: these JSX branches are conditional, so hooks can't live in JSX.
  const timeLabel = useLocaleEntry(overviewCopy.time);
  const modelLabel = useLocaleEntry(overviewCopy.model);
  const statusLabel = useLocaleEntry(overviewCopy.status);
  const tokensLabel = useLocaleEntry(overviewCopy.tokens);
  const costLabel = useLocaleEntry(overviewCopy.cost);
  const loadingLabel = useLocaleEntry(overviewCopy.loading);
  return (
    <div>
      <RecentRequestsLabel />
      {logs.isPending ? (
        <div role="status">
          <span className="sr-only">{loadingLabel}</span>
          <Skeleton className="h-40 w-full" />
        </div>
      ) : logs.isError ? (
        (logs.error as ApiError).status === 404 ? (
          <LogsUnavailableState />
        ) : (
          <>
            <ErrorState message={(logs.error as ApiError).message} />
            <RetryButton onClick={() => logs.refetch()} />
          </>
        )
      ) : visibleRows(logs.data).length === 0 ? (
        <NoUsageState />
      ) : (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{timeLabel}</TableHead>
                <TableHead>{modelLabel}</TableHead>
                <TableHead>{statusLabel}</TableHead>
                <TableHead className="text-right">{tokensLabel}</TableHead>
                <TableHead className="text-right">{costLabel}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRows(logs.data).map((r) => (
                <TableRow key={r.id}>
                  {/* whitespace-nowrap: a wrapped date reads as two rows on
                      mobile; the table wrapper scrolls horizontally instead. */}
                  <TableCell className="whitespace-nowrap font-mono text-xs">
                    {formatDate(new Date(r.created_at))}
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs">
                    {r.public_model}
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs">
                    {formatStatusLabel(r.status)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {formatTokens(r.input_tokens + r.output_tokens)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {formatUsdFromVnd(r.charged_vnd, rate) ?? formatVnd(r.charged_vnd)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
