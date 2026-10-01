import { PageHeader, EmptyState, ErrorState } from "../../components/page";
import { Skeleton } from "../../components/ui/skeleton";
import { formatTokens, formatVnd } from "../../lib/format";
import { ApiError } from "../../lib/api";
import { useCurrentWorkspaceId } from "../../lib/workspace-queries";
import { useUsageSummary } from "../logs/api";

function StatTile({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-md border border-border px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-xl tabular-nums">{value}</p>
    </div>
  );
}

/** Simple inline CSS bar chart: one bar per day, height scaled to max. */
function BarChart({
  data,
}: {
  data: { label: string; value: number }[];
}) {
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="flex h-32 items-end gap-1">
      {data.map((d) => (
        <div key={d.label} className="group relative flex-1">
          <div
            className="w-full rounded-sm bg-foreground/70 group-hover:bg-foreground"
            style={{ height: `${Math.max((d.value / max) * 100, d.value > 0 ? 2 : 0)}%` }}
          />
          <span className="pointer-events-none absolute -top-6 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded border border-border bg-background px-1.5 py-0.5 font-mono text-xs group-hover:block">
            {d.label}: {d.value}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function OverviewPage() {
  const workspaceId = useCurrentWorkspaceId();
  const summary = useUsageSummary(workspaceId);

  if (summary.isPending) {
    return (
      <div className="space-y-4">
        <PageHeader title="Overview" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (summary.isError) {
    const err = summary.error as ApiError;
    return (
      <div className="space-y-4">
        <PageHeader title="Overview" />
        {err.status === 404 ? (
          <EmptyState title="Usage summary endpoint not available yet" />
        ) : (
          <ErrorState message={err.message} />
        )}
      </div>
    );
  }

  const t = summary.data.totals;
  const errorRate = t.requests > 0 ? `${((t.errors / t.requests) * 100).toFixed(1)}%` : "0%";

  return (
    <div className="space-y-4">
      <PageHeader
        title="Overview"
        description="Last 30 days of activity for the selected workspace."
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Requests" value={String(t.requests)} />
        <StatTile label="Spend" value={formatVnd(t.spend_vnd)} />
        <StatTile label="Tokens" value={formatTokens(t.input_tokens + t.output_tokens)} />
        <StatTile label="Error rate" value={errorRate} />
      </div>
      <div className="rounded-md border border-border p-4">
        <p className="mb-3 text-xs text-muted-foreground">Spend per day (VND)</p>
        {summary.data.daily.length === 0 ? (
          <EmptyState title="No requests yet" />
        ) : (
          <BarChart
            data={summary.data.daily.map((d) => ({ label: d.day, value: d.spend_vnd }))}
          />
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
import { formatDate } from "../../lib/format";

function RecentRequests({ workspaceId }: { workspaceId: string | null }) {
  const logs = useRequestLogs(workspaceId, 10);
  return (
    <div>
      <p className="mb-2 text-xs text-muted-foreground">Recent requests</p>
      {logs.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : logs.isError ? (
        (logs.error as ApiError).status === 404 ? (
          <EmptyState title="Usage logs endpoint not available yet" />
        ) : (
          <ErrorState message={(logs.error as ApiError).message} />
        )
      ) : logs.data.length === 0 ? (
        <EmptyState title="No requests yet" />
      ) : (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.data.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">
                    {formatDate(new Date(r.created_at))}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.public_model}</TableCell>
                  <TableCell className="font-mono text-xs">{r.status}</TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {formatTokens(r.input_tokens + r.output_tokens)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {formatVnd(r.charged_vnd)}
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
