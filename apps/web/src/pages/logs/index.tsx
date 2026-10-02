import * as React from "react";
import { useState } from "react";
import { PageHeader, EmptyState, ErrorState, CopyButton } from "../../components/page";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { Skeleton } from "../../components/ui/skeleton";
import { Sheet, SheetContent } from "../../components/ui/sheet";
import { formatDate, formatTokens, formatVnd, formatUsdFromVnd, useUsdVndRate } from "../../lib/format";
import { ApiError } from "../../lib/api";
import { useCurrentWorkspaceId } from "../../lib/workspace-queries";
import { useRequestLogs, type UsageLogRow } from "./api";

function StatusBadge({ status }: { status: string }) {
  const isError = status !== "ok";
  return (
    <span
      className={
        "inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-xs " +
        (isError ? "border-destructive/50 text-destructive" : "border-border text-muted-foreground")
      }
    >
      {status}
    </span>
  );
}

function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border py-2 last:border-b-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-right font-mono text-sm break-all">{children}</span>
    </div>
  );
}

export default function LogsPage() {
  const workspaceId = useCurrentWorkspaceId();
  const query = useRequestLogs(workspaceId);
  const rate = useUsdVndRate(workspaceId).data;
  const [selected, setSelected] = useState<UsageLogRow | null>(null);
  const [filter, setFilter] = useState("");

  if (query.isPending) {
    return (
      <div className="space-y-4">
        <PageHeader title="Logs" description="Request logs for the selected workspace." />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (query.isError) {
    const err = query.error as ApiError;
    return (
      <div className="space-y-4">
        <PageHeader title="Logs" description="Request logs for the selected workspace." />
        {err.status === 404 ? (
          <EmptyState title="Usage logs endpoint not available yet" />
        ) : (
          <ErrorState message={err.message} />
        )}
      </div>
    );
  }

  const rows = query.data.filter((r) =>
    filter === ""
      ? true
      : `${r.public_model} ${r.status} ${r.provider} ${r.request_id} ${r.key_prefix ?? ""}`
          .toLowerCase()
          .includes(filter.toLowerCase()),
  );

  return (
    <div className="space-y-4">
      <PageHeader title="Logs" description="Request logs for the selected workspace." />
      {query.data.length === 0 ? (
        <EmptyState
          title="No requests yet"
          description="Usage logs will appear here once requests are made."
        />
      ) : (
        <div className="space-y-2">
          <input
            className="h-8 w-64 rounded-md border border-border bg-transparent px-2 text-sm outline-none"
            placeholder="Search…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Latency</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6}>
                      <EmptyState title="No matching requests" />
                    </TableCell>
                  </TableRow>
                )}
                {rows.map((r) => (
                  <TableRow key={r.id} className="cursor-pointer" onClick={() => setSelected(r)}>
                    <TableCell className="font-mono text-xs">
                      {formatDate(new Date(r.created_at))}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{r.public_model}</TableCell>
                    <TableCell>
                      <StatusBadge status={r.status} />
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {formatTokens(r.input_tokens + r.output_tokens)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {formatUsdFromVnd(r.charged_vnd, rate) ?? formatVnd(r.charged_vnd)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {r.latency_ms} ms
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
      <Sheet open={selected != null} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent>
          <div className="flex items-center justify-between gap-2 border-b border-border pb-3">
            <span className="font-mono text-sm break-all">{selected?.request_id}</span>
            {selected && <CopyButton value={selected.request_id} />}
          </div>
          {selected && (
            <div className="pt-2">
              <DetailField label="Status">
                <StatusBadge status={selected.status} />
              </DetailField>
              {selected.failure && <DetailField label="Failure">{selected.failure}</DetailField>}
              <DetailField label="Model">{selected.public_model}</DetailField>
              <DetailField label="Provider">{selected.provider}</DetailField>
              <DetailField label="Key prefix">{selected.key_prefix ?? "—"}</DetailField>
              <DetailField label="Input tokens">{selected.input_tokens}</DetailField>
              <DetailField label="Cached input tokens">{selected.cached_input_tokens}</DetailField>
              <DetailField label="Reasoning tokens">{selected.reasoning_tokens}</DetailField>
              <DetailField label="Output tokens">{selected.output_tokens}</DetailField>
              <DetailField label="Cost">
                {formatUsdFromVnd(selected.charged_vnd, rate) ?? formatVnd(selected.charged_vnd)}
              </DetailField>
              <DetailField label="Duration">{selected.latency_ms} ms</DetailField>
              <DetailField label="Time to first token">
                {selected.ttft_ms != null ? `${selected.ttft_ms} ms` : "—"}
              </DetailField>
              <DetailField label="Created">{formatDate(new Date(selected.created_at))}</DetailField>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
