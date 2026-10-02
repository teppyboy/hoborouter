import { useState } from "react";
import { PageHeader, EmptyState, ErrorState } from "../../components/page";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { Skeleton } from "../../components/ui/skeleton";
import { formatTokens, formatVnd, formatUsdFromVnd, useUsdVndRate } from "../../lib/format";
import { ApiError } from "../../lib/api";
import { useCurrentWorkspaceId } from "../../lib/workspace-queries";
import { useUsageSummary } from "../logs/api";

export default function UsagePage() {
  const workspaceId = useCurrentWorkspaceId();
  const [days, setDays] = useState(30);
  const query = useUsageSummary(workspaceId, days);
  const rate = useUsdVndRate(workspaceId).data;

  if (query.isPending) {
    return (
      <div className="space-y-4">
        <PageHeader title="Usage" description="Per-day and per-model breakdown." />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (query.isError) {
    const err = query.error as ApiError;
    return (
      <div className="space-y-4">
        <PageHeader title="Usage" description="Per-day and per-model breakdown." />
        {err.status === 404 ? (
          <EmptyState title="Usage summary endpoint not available yet" />
        ) : (
          <ErrorState message={err.message} />
        )}
      </div>
    );
  }

  const { daily, by_model } = query.data;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Usage"
        description="Per-day and per-model breakdown."
        actions={
          <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
            {[7, 30, 90].map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
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
        }
      />

      <section>
        <p className="mb-2 text-xs text-muted-foreground">Per day</p>
        {daily.length === 0 ? (
          <EmptyState title="No requests yet" />
        ) : (
          <div className="rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Day</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="text-right">Spend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {daily.map((d) => (
                  <TableRow key={d.day}>
                    <TableCell className="font-mono text-xs">{d.day}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{d.requests}</TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {formatTokens(d.tokens)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {formatUsdFromVnd(d.spend_vnd, rate) ?? formatVnd(d.spend_vnd)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section>
        <p className="mb-2 text-xs text-muted-foreground">Per model</p>
        {by_model.length === 0 ? (
          <EmptyState title="No requests yet" />
        ) : (
          <div className="rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="text-right">Spend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {by_model.map((m) => (
                  <TableRow key={String(m.public_model)}>
                    <TableCell className="font-mono text-xs">{m.public_model}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{m.requests}</TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {formatTokens(m.tokens)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {formatUsdFromVnd(m.spend_vnd, rate) ?? formatVnd(m.spend_vnd)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}
