import * as React from "react";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  PageHeader,
  EmptyState,
  ErrorState,
  CopyButton,
} from "../../components/page";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { Skeleton } from "../../components/ui/skeleton";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "../../components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { useIsAdmin } from "../../components/app-shell";
import { formatDate, formatTokens, formatUsdFromVnd, formatVnd, useUsdVndRate } from "../../lib/format";
import { formatStatusLabel, formatProviderLabel } from "../../lib/display";
import { ApiError, api } from "../../lib/api";
import { useCurrentWorkspaceId } from "../../lib/workspace-queries";
import { useRequestLogs, type UsageLogRow } from "./api";
import { applyLogFilters, paginateLogs, visibleRows, LOG_PAGE_SIZE, type LogFilters } from "./filters";

function formatDuration(ms: number | null | undefined): string {
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? `${ms} ms` : "—";
}

function StatusBadge({ status }: { status: string }) {
  const isError = status !== "ok";
  return (
    <span
      className={
        "inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-xs " +
        (isError ? "border-destructive/50 text-destructive" : "border-border text-muted-foreground")
      }
    >
      {formatStatusLabel(status)}
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

/**
 * Instance-admin-only destructive action on a request log: soft-deletes the
 * underlying request (hides it from customer views, keeps billing records).
 */
function RemoveLogButton({
  requestId,
  onRemoved,
}: {
  requestId: string;
  onRemoved: () => void;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const remove = useMutation({
    mutationFn: () => api(`/api/v1/admin/requests/${requestId}`, { method: "DELETE" }),
    onSuccess: () => {
      toast("Log removed", {
        description: "Hides this log from users. Billing records are kept.",
      });
      void qc.invalidateQueries({ queryKey: ["usage-logs"] });
      void qc.invalidateQueries({ queryKey: ["usage-summary"] });
      setOpen(false);
      onRemoved();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Remove failed"),
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <div className="pt-4">
        <Button
          variant="destructive"
          size="sm"
          className="gap-1.5"
          onClick={() => setOpen(true)}
          aria-label="Remove log"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Remove log
        </Button>
      </div>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove log</DialogTitle>
          <DialogDescription>
            Hides this log from users. Billing records are kept.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={remove.isPending}
            onClick={() => void remove.mutateAsync().catch(() => undefined)}
          >
            {remove.isPending ? "Removing…" : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FilterSelect({
  value,
  onChange,
  placeholder,
  options,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  options: string[];
  label: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className="h-8 w-[140px] text-xs">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All {label.toLowerCase()}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            {o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export default function LogsPage() {
  const workspaceId = useCurrentWorkspaceId();
  const query = useRequestLogs(workspaceId);
  const rate = useUsdVndRate(workspaceId).data;
  const [selected, setSelected] = useState<UsageLogRow | null>(null);
  const isAdmin = useIsAdmin();
  const [page, setPage] = useState(0);
  const [filters, setFilters] = useState<LogFilters>({
    search: "",
    model: "all",
    status: "all",
    key: "all",
  });

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

  const visible = visibleRows(query.data);
  const models = Array.from(new Set(visible.map((r) => r.public_model))).sort();
  const keys = Array.from(
    new Set(visible.map((r) => r.key_prefix ?? "—")),
  ).sort();
  const filtered = applyLogFilters(visible, filters);
  const hiddenCount = query.data.length - visible.length;
  const { page: safePage, pageCount, slice } = paginateLogs(filtered, page);
  const rangeStart = filtered.length === 0 ? 0 : safePage * LOG_PAGE_SIZE + 1;
  const rangeEnd = Math.min((safePage + 1) * LOG_PAGE_SIZE, filtered.length);

  const setFilter = (patch: Partial<LogFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(0);
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Logs" description="Request logs for the selected workspace." />
      {query.data.length === 0 ? (
        <EmptyState
          title="No requests yet"
          description="Usage logs will appear here once requests are made."
        />
      ) : visible.length === 0 ? (
        <EmptyState
          title="No requests with usage"
          description="All loaded requests were hidden because they have no model or no token usage."
        />
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="h-8 w-56 text-sm"
              placeholder="Search request, model, key…"
              aria-label="Search logs"
              value={filters.search}
              onChange={(e) => setFilter({ search: e.target.value })}
            />
            <FilterSelect
              label="Models"
              placeholder="All models"
              value={filters.model}
              onChange={(v) => setFilter({ model: v })}
              options={models}
            />
            <Select
              value={filters.status}
              onValueChange={(v) => setFilter({ status: v })}
            >
              <SelectTrigger aria-label="Statuses" className="h-8 w-[120px] text-xs">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="ok">Succeeded</SelectItem>
                <SelectItem value="error">Error</SelectItem>
              </SelectContent>
            </Select>
            <FilterSelect
              label="Keys"
              placeholder="All keys"
              value={filters.key}
              onChange={(v) => setFilter({ key: v })}
              options={keys}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={() => query.refetch()}
              disabled={query.isFetching}
              aria-label="Refresh logs"
            >
              <RefreshCw className={"h-3.5 w-3.5" + (query.isFetching ? " animate-spin" : "")} />
              Refresh
            </Button>
          </div>
          <div className="rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Request</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead className="hidden md:table-cell">Key</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead
                    className="hidden text-right md:table-cell"
                    title="Time to first token (streaming requests only)"
                  >
                    TTFT
                  </TableHead>
                  <TableHead className="hidden text-right md:table-cell">Latency</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {slice.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={9}>
                      <EmptyState title="No matching requests" />
                    </TableCell>
                  </TableRow>
                )}
                {slice.map((r) => {
                  const cost =
                    formatUsdFromVnd(r.charged_vnd, rate) ?? formatVnd(r.charged_vnd);
                  return (
                    <TableRow
                      key={r.id}
                      tabIndex={0}
                      role="button"
                      aria-label={`Open request ${r.request_id}`}
                      className="cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                      onClick={(e) => {
                        // Only open the drawer for the row itself, not for
                        // interactive descendants (copy button etc.).
                        const target = e.target as HTMLElement;
                        if (target.closest("button, a, input, select, textarea")) return;
                        setSelected(r);
                      }}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return; // row-level keys only
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelected(r);
                        }
                      }}
                    >
                      <TableCell className="font-mono text-xs whitespace-nowrap">
                        {formatDate(new Date(r.created_at))}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        <span className="flex items-center gap-1">
                          <span title={r.request_id}>{r.request_id.slice(0, 8)}</span>
                          <span
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => e.stopPropagation()}
                          >
                            <CopyButton value={r.request_id} label="Copy request ID" />
                          </span>
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{r.public_model}</TableCell>
                      <TableCell className="hidden font-mono text-xs md:table-cell">{r.key_prefix ?? "—"}</TableCell>
                      <TableCell className="text-right font-mono text-xs whitespace-nowrap">
                        {formatTokens(r.input_tokens)} → {formatTokens(r.output_tokens)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">{cost}</TableCell>
                      <TableCell>
                        <StatusBadge status={r.status} />
                      </TableCell>
                      <TableCell
                        className="hidden whitespace-nowrap text-right font-mono text-xs md:table-cell"
                        title="Time to first token (streaming requests only)"
                      >
                        {formatDuration(r.ttft_ms)}
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap text-right font-mono text-xs md:table-cell">
                        {formatDuration(r.latency_ms)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              Showing {rangeStart}–{rangeEnd} of {filtered.length} loaded requests
              {hiddenCount > 0 && ` — ${hiddenCount} hidden (no model or no token usage)`}
            </span>
            <span className="flex flex-wrap gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={safePage === 0}
                onClick={() => setPage(safePage - 1)}
                aria-label="Previous page"
              >
                Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={safePage >= pageCount - 1}
                onClick={() => setPage(safePage + 1)}
                aria-label="Next page"
              >
                Next
              </Button>
            </span>
          </div>
        </div>
      )}
      <Sheet open={selected != null} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent>
          <SheetTitle className="font-mono text-sm break-all">{selected?.request_id}</SheetTitle>
          <SheetDescription className="sr-only">
            Request usage details
          </SheetDescription>
          {selected && (
            <div className="pb-3 border-b border-border">
              <CopyButton value={selected.request_id} label="Copy request ID" />
            </div>
          )}
          {selected && (
            <div className="pt-2">
              <DetailField label="Status">
                <StatusBadge status={selected.status} />
              </DetailField>
              {selected.failure && <DetailField label="Failure">{selected.failure}</DetailField>}
              <DetailField label="Model">{selected.public_model}</DetailField>
              <DetailField label="Provider">{formatProviderLabel(selected.provider)}</DetailField>
              <DetailField label="Key prefix">{selected.key_prefix ?? "—"}</DetailField>
              <DetailField label="Input tokens">{selected.input_tokens}</DetailField>
              <DetailField label="Cached input tokens">{selected.cached_input_tokens}</DetailField>
              <DetailField label="Reasoning tokens">{selected.reasoning_tokens}</DetailField>
              <DetailField label="Output tokens">{selected.output_tokens}</DetailField>
              <DetailField label="Cost">
                {formatUsdFromVnd(selected.charged_vnd, rate) ?? formatVnd(selected.charged_vnd)}
              </DetailField>
              <DetailField label="Duration">{formatDuration(selected.latency_ms)}</DetailField>
              <DetailField label="Time to first token">
                {formatDuration(selected.ttft_ms)}
              </DetailField>
              <DetailField label="Created">{formatDate(new Date(selected.created_at))}</DetailField>
            </div>
          )}
          {selected && isAdmin === true && (
            <RemoveLogButton
              requestId={selected.request_id}
              onRemoved={() => setSelected(null)}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
