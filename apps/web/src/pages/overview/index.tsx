import { PageHeader, EmptyState, ErrorState } from "../../components/page";
import { Skeleton } from "../../components/ui/skeleton";
import { formatTokens, formatVnd, formatUsdFromVnd, useUsdVndRate } from "../../lib/format";
import { ApiError } from "../../lib/api";
import { useCurrentWorkspaceId } from "../../lib/workspace-queries";
import { formatStatusLabel } from "../../lib/display";
import { useUsageSummary } from "../logs/api";
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
} as const;

function StatTile({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="rounded-md border border-border px-4 py-3">
      <p className="text-xs text-muted-foreground" title={title}>
        {label}
      </p>
      <p className="mt-1 font-mono text-xl tabular-nums">{value}</p>
    </div>
  );
}

/** Fill a fixed 30-day (UTC) window; missing days are real zero-spend days. */
function fillDaily30(daily: { day: string; spend_vnd: number }[]) {
  const byDay = new Map(daily.map((d) => [d.day, d.spend_vnd]));
  const out: { label: string; value: number }[] = [];
  const fmt = (t: number) => new Date(t).toISOString().slice(0, 10);
  const now = Date.now();
  for (let i = 29; i >= 0; i--) {
    const day = fmt(now - i * 86400000);
    out.push({ label: day, value: byDay.get(day) ?? 0 });
  }
  return out;
}

/** Simple inline CSS bar chart: one bar per day, height scaled to max. */
function BarChart({ data, rate }: { data: { label: string; value: number }[]; rate?: number }) {
  const max = Math.max(...data.map((d) => d.value), 1);
  const maxValue = Math.max(...data.map((d) => d.value));
  return (
    <div>
      <div className="flex h-32 items-end gap-1">
        {data.map((d) => (
          <div key={d.label} className="group relative flex h-full min-w-0 flex-1 items-end">
            <div
              className={`mx-auto w-full max-w-3 rounded-sm ${
                d.value > 0 ? "bg-foreground/70 group-hover:bg-foreground" : "bg-foreground/10"
              }`}
              style={{
                height: d.value > 0 ? `${Math.max((d.value / max) * 100, 2)}%` : "2px",
              }}
            />
            <span className="pointer-events-none absolute -top-6 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded border border-border bg-background px-1.5 py-0.5 font-mono text-xs group-hover:block">
              {d.label}: {formatUsdFromVnd(d.value, rate) ?? formatVnd(d.value)}
            </span>
          </div>
        ))}
      </div>
      <ChartFooter data={data} maxValue={maxValue} rate={rate} />
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

  if (summary.isPending) {
    return (
      <div className="space-y-4">
        <OverviewHeader />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (summary.isError) {
    const err = summary.error as ApiError;
    return (
      <div className="space-y-4">
        <OverviewHeader />
        {err.status === 404 ? <SummaryUnavailableState /> : <ErrorState message={err.message} />}
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

  return (
    <div className="space-y-4">
      <OverviewHeader />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={useLocaleEntry(overviewCopy.requests)} value={String(t.requests)} />
        <StatTile
          label={useLocaleEntry(overviewCopy.spend)}
          value={formatUsdFromVnd(t.spend_vnd, rate) ?? formatVnd(t.spend_vnd)}
        />
        <StatTile
          label={useLocaleEntry(overviewCopy.tokens)}
          value={formatTokens(t.input_tokens + t.output_tokens)}
        />
        <StatTile
          label={useLocaleEntry(overviewCopy.successRate)}
          value={successRate}
          title="Share of successful requests among eligible requests (requests with a model and token usage) in the last 30 days — not limited to the 10 recent rows below."
        />
      </div>
      <div className="rounded-md border border-border p-4">
        <SpendPerDayLabel />
        {summary.data.daily.length === 0 ? (
          <NoRequestsState />
        ) : (
          <BarChart data={fillDaily30(summary.data.daily)} rate={rate} />
        )}
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

function RecentRequests({ workspaceId }: { workspaceId: string | null }) {
  const logs = useRequestLogs(workspaceId, 10);
  const rate = useUsdVndRate(workspaceId).data;
  return (
    <div>
      <RecentRequestsLabel />
      {logs.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : logs.isError ? (
        (logs.error as ApiError).status === 404 ? (
          <LogsUnavailableState />
        ) : (
          <ErrorState message={(logs.error as ApiError).message} />
        )
      ) : visibleRows(logs.data).length === 0 ? (
        <NoUsageState />
      ) : (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{useLocaleEntry(overviewCopy.time)}</TableHead>
                <TableHead>{useLocaleEntry(overviewCopy.model)}</TableHead>
                <TableHead>{useLocaleEntry(overviewCopy.status)}</TableHead>
                <TableHead className="text-right">{useLocaleEntry(overviewCopy.tokens)}</TableHead>
                <TableHead className="text-right">{useLocaleEntry(overviewCopy.cost)}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRows(logs.data).map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">
                    {formatDate(new Date(r.created_at))}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.public_model}</TableCell>
                  <TableCell className="font-mono text-xs">{formatStatusLabel(r.status)}</TableCell>
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
