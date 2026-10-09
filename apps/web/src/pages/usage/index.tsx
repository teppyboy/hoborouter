import { useEffect, useMemo, useState } from "react";
import { PageHeader, EmptyState, ErrorState, ScrollPanel } from "../../components/page";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Card, CardContent, CardHeader } from "../../components/ui/card";
import { Skeleton } from "../../components/ui/skeleton";
import { formatTokens, formatVnd, formatUsdFromVnd, useUsdVndRate } from "../../lib/format";
import { ApiError } from "../../lib/api";
import { useCurrentWorkspaceId } from "../../lib/workspace-queries";
import { useUsageSummary, successRateLabel } from "../logs/api";
import { metricSeries, type Metric } from "./charthelper";
import { BarSeries } from "../../components/chart/bar-series";
import { useT, useLocaleEntry, type LocaleEntry } from "../../lib/i18n/t";

// Usage page copy: inline LocaleEntry set (see lib/i18n/common.ts). Money,
// tokens and model ids are never translated.
const usageCopy = {
  requests: { en: "Requests", vi: "Requests" },
  tokens: { en: "Tokens", vi: "Token" },
  cost: { en: "Cost", vi: "Chi phí" },
  errors: { en: "Errors", vi: "Lỗi" },
  dataViews: { en: "Usage data views", vi: "Chế độ xem dữ liệu sử dụng" },
  chart: { en: "Chart", vi: "Biểu đồ" },
  perModel: { en: "Per model", vi: "Theo mô hình" },
  noRequests: { en: "No requests yet", vi: "Chưa có request nào" },
  perModelUsage: { en: "Per model usage", vi: "Sử dụng theo mô hình" },
  modelCol: { en: "Model", vi: "Mô hình" },
  requestsCol: { en: "Requests", vi: "Requests" },
  tokensCol: { en: "Tokens", vi: "Token" },
  tokenShare: { en: "Token share", vi: "Tỷ lệ token" },
  spend: { en: "Spend", vi: "Chi tiêu" },
  title: { en: "Usage", vi: "Mức sử dụng" },
  description: {
    en: "Requests, tokens and cost over the last {days} days.",
    vi: "Requests, token và chi phí trong {days} ngày qua.",
  },
  filterByModel: { en: "Filter by model", vi: "Lọc theo mô hình" },
  allModels: { en: "All models", vi: "Tất cả mô hình" },
  timePeriod: { en: "Time period", vi: "Khoảng thời gian" },
  endpointUnavailable: {
    en: "Usage summary endpoint not available yet",
    vi: "Chưa có endpoint tổng hợp mức sử dụng",
  },
  costUsd: { en: "Cost (USD)", vi: "Chi phí (USD)" },
  successRate: { en: "Success rate", vi: "Tỷ lệ thành công" },
  successRateCaption: {
    en: "Share of successful requests among eligible requests (requests with a model and token usage) in the selected period.",
    vi: "Tỷ lệ request thành công trong số các request đủ điều kiện (có mô hình và mức sử dụng token) trong kỳ đã chọn.",
  },
  chartMetric: { en: "Chart metric", vi: "Chỉ số biểu đồ" },
  // Chart accessibility: sr-only summary + data-table headers (EN/VI).
  chartAria: {
    en: "Bar chart of daily usage for the selected metric, filter and period.",
    vi: "Biểu đồ cột mức sử dụng mỗi ngày theo chỉ số, bộ lọc và kỳ đã chọn.",
  },
  dayCol: { en: "Day", vi: "Ngày" },
  valueCol: { en: "Value", vi: "Giá trị" },
  sortBy: { en: "Sort by {col}", vi: "Sắp xếp theo {col}" },
} as const;

const METRICS: { id: Metric; label: LocaleEntry }[] = [
  { id: "requests", label: usageCopy.requests },
  { id: "tokens", label: usageCopy.tokens },
  { id: "cost", label: usageCopy.cost },
  { id: "errors", label: usageCopy.errors },
];

/** Row shape from GET /usage-summary `by_model` (public IDs only). */
export interface PerModelRow {
  /** Public model ID; API may return numeric IDs for legacy rows. */
  public_model: string | number;
  requests: number;
  spend_vnd: number;
  tokens: number;
}

const PERIODS = [7, 30, 90] as const;

function formatMetric(vnd: number, metric: Metric, rate?: number): string {
  if (metric === "cost") return formatUsdFromVnd(vnd, rate) ?? formatVnd(vnd);
  if (metric === "tokens") return formatTokens(vnd);
  return vnd.toLocaleString("en-US");
}

/**
 * KPI summary strip: one compact bordered row instead of four cards — the
 * numbers are the content, no nested-card chrome around each value.
 */
function SummaryStrip({ items }: { items: { label: string; value: string; caption?: string }[] }) {
  return (
    <div
      role="group"
      aria-label={items.map((i) => i.label).join(", ")}
      className="grid grid-cols-2 divide-x divide-border rounded-md border border-border lg:grid-cols-4"
    >
      {items.map((i) => (
        <div key={i.label} className="min-w-0 px-4 py-3" title={i.caption}>
          <p className="truncate text-xs text-muted-foreground">{i.label}</p>
          <p className="mt-0.5 truncate font-mono text-lg tabular-nums">{i.value}</p>
        </div>
      ))}
    </div>
  );
}

/** Locale-aware label for a chart metric tab. */
function MetricLabel({ label }: { label: LocaleEntry }) {
  return <>{useLocaleEntry(label)}</>;
}

/**
 * Chart and Per-model views live in separate tabs so the per-model table can
 * grow without pushing the chart (or the page) down; only the active tab's
 * content renders. Filters stay in the page header, above the tabs.
 */
export function UsageDataTabs({
  chart,
  perModel,
}: {
  chart: React.ReactNode;
  perModel: React.ReactNode;
}) {
  const t = useT(usageCopy);
  return (
    <Tabs defaultValue="chart" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <TabsList aria-label={t("dataViews")}>
        <TabsTrigger value="chart">{t("chart")}</TabsTrigger>
        <TabsTrigger value="per-model">{t("perModel")}</TabsTrigger>
      </TabsList>
      <TabsContent value="chart">{chart}</TabsContent>
      <TabsContent
        value="per-model"
        className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
      >
        {perModel}
      </TabsContent>
    </Tabs>
  );
}

/**
 * Per-model usage table, sortable on every column (TanStack Table). The
 * default order is the API's spend-desc order — sorting is client-side view
 * state only, data is never recomputed. Long model lists scroll inside their
 * panel instead of growing the page.
 */
export function PerModelTable({
  byModel,
  totalTokens,
  rate,
}: {
  byModel: PerModelRow[];
  totalTokens: number;
  rate?: number;
}) {
  const t = useT(usageCopy);
  const [sorting, setSorting] = useState<SortingState>([]);

  const data = useMemo(
    () =>
      byModel.map((m) => ({
        model: String(m.public_model),
        requests: m.requests,
        tokens: m.tokens,
        share: totalTokens > 0 ? m.tokens / totalTokens : null,
        spendVnd: m.spend_vnd,
      })),
    [byModel, totalTokens],
  );

  const columns = useMemo<ColumnDef<(typeof data)[number]>[]>(
    () => [
      { id: "model", accessorKey: "model", header: t("modelCol"), sortDescFirst: false },
      { id: "requests", accessorKey: "requests", header: t("requestsCol"), sortDescFirst: true },
      { id: "tokens", accessorKey: "tokens", header: t("tokensCol"), sortDescFirst: true },
      {
        id: "share",
        accessorFn: (r) => r.share ?? -1,
        header: t("tokenShare"),
        sortDescFirst: true,
      },
      { id: "spend", accessorFn: (r) => r.spendVnd, header: t("spend"), sortDescFirst: true },
    ],
    [t],
  );

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  if (byModel.length === 0) return <EmptyState title={t("noRequests")} />;

  const cell = (id: string, row: (typeof data)[number]) => {
    switch (id) {
      case "requests":
        return row.requests.toLocaleString("en-US");
      case "tokens":
        return formatTokens(row.tokens);
      case "share":
        return row.share == null ? "\u2014" : (row.share * 100).toFixed(1) + "%";
      case "spend":
        return formatUsdFromVnd(row.spendVnd, rate) ?? formatVnd(row.spendVnd);
      default:
        return row.model;
    }
  };

  const sortIcon = (dir: false | "asc" | "desc") =>
    dir === "asc" ? (
      <ArrowUp className="size-3" aria-hidden />
    ) : dir === "desc" ? (
      <ArrowDown className="size-3" aria-hidden />
    ) : (
      <ArrowUpDown className="size-3 opacity-40" aria-hidden />
    );

  return (
    <ScrollPanel label={t("perModelUsage")} stickyHeader fill>
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((hg) => (
            <TableRow key={hg.id}>
              {hg.headers.map((h) => (
                <TableHead key={h.id} className={h.column.id === "model" ? "" : "text-right"}>
                  <button
                    type="button"
                    onClick={h.column.getToggleSortingHandler()}
                    aria-label={t("sortBy").replace("{col}", h.column.columnDef.header as string)}
                    className="inline-flex items-center gap-1 hover:text-foreground"
                  >
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    {sortIcon(h.column.getIsSorted())}
                  </button>
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id}>
              {row.getVisibleCells().map((c) => (
                <TableCell
                  key={c.id}
                  className={(c.column.id === "model" ? "" : "text-right ") + "font-mono text-xs"}
                >
                  {cell(c.column.id, row.original)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ScrollPanel>
  );
}

export default function UsagePage() {
  const t = useT(usageCopy);
  const workspaceId = useCurrentWorkspaceId();
  const [days, setDays] = useState(30);
  const [model, setModel] = useState("all");

  // Workspace switch: drop a stale model filter so the filtered query can't mix workspaces.
  useEffect(() => {
    setModel("all");
  }, [workspaceId]);
  const [metric, setMetric] = useState<Metric>("requests");

  // Unfiltered query supplies the model options; filtered query supplies totals/chart/table.
  const optionsQuery = useUsageSummary(workspaceId, days);
  const filteredModel = model === "all" ? undefined : model;
  const query = useUsageSummary(workspaceId, days, filteredModel);
  const rate = useUsdVndRate(workspaceId).data;

  const header = (
    <PageHeader
      title={t("title")}
      description={t("description", { days })}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger className="h-8 w-44" aria-label={t("filterByModel")}>
              <SelectValue placeholder={t("allModels")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("allModels")}</SelectItem>
              {(optionsQuery.data?.by_model ?? [])
                .map((m) => String(m.public_model))
                .filter((m) => m.length > 0)
                .map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <div
            role="group"
            aria-label={t("timePeriod")}
            className="flex items-center gap-1 rounded-md border border-border p-0.5"
          >
            {PERIODS.map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                aria-pressed={days === d}
                className={
                  "rounded-sm px-2 py-0.5 font-mono text-xs " +
                  (days === d
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground")
                }
              >
                {d}d
              </button>
            ))}
          </div>
        </div>
      }
    />
  );

  if (query.isPending) {
    return (
      <div className="space-y-4">
        {header}
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (query.isError) {
    const err = query.error as ApiError;
    return (
      <div className="space-y-4">
        {header}
        {err.status === 404 ? (
          <EmptyState title={t("endpointUnavailable")} />
        ) : (
          <ErrorState message={err.message} />
        )}
      </div>
    );
  }

  const { totals, daily, by_model } = query.data;
  // Success rate over visibility-gated rows, identical to Overview.
  // Older backend without visible counts: honest em dash, no fabricated rate.
  const successRate = successRateLabel(totals.visible_requests, totals.visible_errors);
  const totalTokens = totals.input_tokens + totals.output_tokens;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {header}

      <SummaryStrip
        items={[
          { label: t("requests"), value: totals.requests.toLocaleString("en-US") },
          { label: t("tokens"), value: formatTokens(totalTokens) },
          {
            label: t("costUsd"),
            value: formatUsdFromVnd(totals.spend_vnd, rate) ?? formatVnd(totals.spend_vnd),
          },
          { label: t("successRate"), value: successRate, caption: t("successRateCaption") },
        ]}
      />

      <UsageDataTabs
        chart={
          <Card>
            <CardHeader className="pb-0">
              <Tabs value={metric} onValueChange={(v) => setMetric(v as Metric)}>
                <TabsList aria-label={t("chartMetric")}>
                  {METRICS.map((m) => (
                    <TabsTrigger key={m.id} value={m.id} className="text-xs">
                      <MetricLabel label={m.label} />
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </CardHeader>
            <CardContent>
              {daily.length === 0 ? (
                <EmptyState title={t("noRequests")} />
              ) : (
                <BarSeries
                  points={metricSeries(daily, days, metric)}
                  formatValue={(v) => formatMetric(v, metric, rate)}
                  ariaLabel={t("chartAria")}
                  srSummary={t("chartAria")}
                  dateHeader={t("dayCol")}
                  valueHeader={t("valueCol")}
                  height={240}
                />
              )}
            </CardContent>
          </Card>
        }
        perModel={<PerModelTable byModel={by_model} totalTokens={totalTokens} rate={rate} />}
      />
    </div>
  );
}
