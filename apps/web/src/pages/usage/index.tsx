import { useEffect, useState } from "react";
import { PageHeader, EmptyState, ErrorState, ScrollPanel } from "../../components/page";
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
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Skeleton } from "../../components/ui/skeleton";
import { formatTokens, formatVnd, formatUsdFromVnd, useUsdVndRate } from "../../lib/format";
import { ApiError } from "../../lib/api";
import { useCurrentWorkspaceId } from "../../lib/workspace-queries";
import { useUsageSummary, successRateLabel } from "../logs/api";
import { metricSeries, type Metric } from "./charthelper";

/** Row shape from GET /usage-summary `by_model` (public IDs only). */
export interface PerModelRow {
  /** Public model ID; API may return numeric IDs for legacy rows. */
  public_model: string | number;
  requests: number;
  spend_vnd: number;
  tokens: number;
}

const PERIODS = [7, 30, 90] as const;

const METRICS: { id: Metric; label: string }[] = [
  { id: "requests", label: "Requests" },
  { id: "tokens", label: "Tokens" },
  { id: "cost", label: "Cost" },
  { id: "errors", label: "Errors" },
];

function formatMetric(vnd: number, metric: Metric, rate?: number): string {
  if (metric === "cost") return formatUsdFromVnd(vnd, rate) ?? formatVnd(vnd);
  if (metric === "tokens") return formatTokens(vnd);
  return vnd.toLocaleString("en-US");
}

/**
 * Daily bar chart, 240px tall, zero-filled UTC days; hover/focus shows the
 * formatted value. Y axis shows zero/mid/max gridlines with formatted labels.
 */
function DailyChart({
  daily,
  days,
  metric,
  rate,
}: {
  daily: { day: string; requests: number; tokens: number; spend_vnd: number; errors: number }[];
  days: number;
  metric: Metric;
  rate?: number;
}) {
  const series = metricSeries(daily, days, metric);
  const max = Math.max(...series.map((d) => d.value), 1);
  const fmt = (v: number) => formatMetric(v, metric, rate);
  return (
    <div className="flex gap-2">
      <div
        aria-hidden="true"
        className="flex h-[240px] w-14 shrink-0 flex-col justify-between py-0 text-right font-mono text-[10px] text-muted-foreground"
      >
        <span>{fmt(max)}</span>
        <span>{fmt(max / 2)}</span>
        <span>{fmt(0)}</span>
      </div>
      <div
        role="group"
        aria-label={`Daily ${metric} over the last ${days} days`}
        className="relative min-w-0 flex-1"
      >
        <div
          aria-hidden="true"
          className="absolute inset-0 flex h-[240px] flex-col justify-between"
        >
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-px w-full bg-border" />
          ))}
        </div>
        <div className="flex h-[240px] items-end gap-1">
          {series.map((d) => (
            <button
              key={d.label}
              type="button"
              tabIndex={0}
              aria-label={`${d.label}: ${fmt(d.value)}`}
              className="group relative flex h-full min-w-0 flex-1 cursor-default items-end rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div
                className={`mx-auto w-full max-w-3 rounded-sm ${
                  d.value > 0 ? "bg-foreground/70 group-hover:bg-foreground" : "bg-foreground/10"
                }`}
                style={{ height: d.value > 0 ? `${Math.max((d.value / max) * 100, 2)}%` : "2px" }}
              />
              <span className="pointer-events-none absolute -top-6 left-1/2 z-10 hidden max-w-[90vw] -translate-x-1/2 truncate whitespace-nowrap rounded border border-border bg-background px-1.5 py-0.5 font-mono text-xs group-hover:block group-focus-visible:block">
                {d.label}: {fmt(d.value)}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function KpiCard({ title, value, caption }: { title: string; value: string; caption?: string }) {
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-xs font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="font-mono text-2xl" title={caption}>
          {value}
        </p>
      </CardContent>
    </Card>
  );
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
  return (
    <Tabs defaultValue="chart" className="min-w-0">
      <TabsList aria-label="Usage data views">
        <TabsTrigger value="chart">Chart</TabsTrigger>
        <TabsTrigger value="per-model">Per model</TabsTrigger>
      </TabsList>
      <TabsContent value="chart">{chart}</TabsContent>
      <TabsContent value="per-model">{perModel}</TabsContent>
    </Tabs>
  );
}

/**
 * Per-model usage table. Extracted for render tests; long model lists scroll
 * inside their panel instead of growing the page.
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
  if (byModel.length === 0) return <EmptyState title="No requests yet" />;
  return (
    <ScrollPanel label="Per model usage" stickyHeader>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Model</TableHead>
            <TableHead className="text-right">Requests</TableHead>
            <TableHead className="text-right">Tokens</TableHead>
            <TableHead className="text-right">Token share</TableHead>
            <TableHead className="text-right">Spend</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {byModel.map((m) => {
            const tokens = m.tokens;
            const share = totalTokens > 0 ? ((tokens / totalTokens) * 100).toFixed(1) + "%" : "—";
            return (
              <TableRow key={String(m.public_model)}>
                <TableCell className="font-mono text-xs">{String(m.public_model)}</TableCell>
                <TableCell className="text-right font-mono text-xs">
                  {m.requests.toLocaleString("en-US")}
                </TableCell>
                <TableCell className="text-right font-mono text-xs">
                  {formatTokens(tokens)}
                </TableCell>
                <TableCell className="text-right font-mono text-xs">
                  <div className="flex items-center justify-end gap-2">
                    <div
                      className="hidden h-1.5 w-16 overflow-hidden rounded-sm bg-muted sm:block"
                      aria-hidden="true"
                    >
                      <div
                        className="h-full bg-foreground/60"
                        style={{
                          width: `${totalTokens > 0 ? Math.min((tokens / totalTokens) * 100, 100) : 0}%`,
                        }}
                      />
                    </div>
                    {share}
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono text-xs">
                  {formatUsdFromVnd(m.spend_vnd, rate) ?? formatVnd(m.spend_vnd)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </ScrollPanel>
  );
}

export default function UsagePage() {
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
      title="Usage"
      description={`Requests, tokens and cost over the last ${days} days.`}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger className="h-8 w-44" aria-label="Filter by model">
              <SelectValue placeholder="All models" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All models</SelectItem>
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
            aria-label="Time period"
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
          <EmptyState title="Usage summary endpoint not available yet" />
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
    <div className="space-y-4">
      {header}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard title="Requests" value={totals.requests.toLocaleString("en-US")} />
        <KpiCard title="Tokens" value={formatTokens(totalTokens)} />
        <KpiCard
          title="Cost (USD)"
          value={formatUsdFromVnd(totals.spend_vnd, rate) ?? formatVnd(totals.spend_vnd)}
        />
        <KpiCard
          title="Success rate"
          value={successRate}
          caption="Share of successful requests among eligible requests (requests with a model and token usage) in the selected period."
        />
      </div>

      <UsageDataTabs
        chart={
          <Card>
            <CardHeader className="pb-0">
              <Tabs value={metric} onValueChange={(v) => setMetric(v as Metric)}>
                <TabsList aria-label="Chart metric">
                  {METRICS.map((m) => (
                    <TabsTrigger key={m.id} value={m.id} className="text-xs">
                      {m.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </CardHeader>
            <CardContent>
              {daily.length === 0 ? (
                <EmptyState title="No requests yet" />
              ) : (
                <>
                  <DailyChart daily={daily} days={days} metric={metric} rate={rate} />
                  <div className="mt-2 flex justify-between pl-16 text-xs text-muted-foreground">
                    <span>{metricSeries(daily, days, metric)[0]?.label}</span>
                    <span>{metricSeries(daily, days, metric).at(-1)?.label}</span>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        }
        perModel={<PerModelTable byModel={by_model} totalTokens={totalTokens} rate={rate} />}
      />
    </div>
  );
}
