import * as React from "react";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, EmptyState, ErrorState, CopyButton } from "../../components/page";
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
import {
  formatDate,
  formatTokens,
  formatUsdFromVnd,
  formatVnd,
  useUsdVndRate,
} from "../../lib/format";
import { formatStatusLabel, formatProviderLabel } from "../../lib/display";
import { ApiError, api } from "../../lib/api";
import { useCurrentWorkspaceId } from "../../lib/workspace-queries";
import { useRequestLogs, type UsageLogRow } from "./api";
import { useT } from "../../lib/i18n/t";
import {
  applyLogFilters,
  paginateLogs,
  visibleRows,
  LOG_PAGE_SIZE,
  type LogFilters,
} from "./filters";

// Logs page copy: inline LocaleEntry set (see lib/i18n/common.ts). Request
// IDs, model ids, token counts and money values are never translated.
const logsCopy = {
  title: { en: "Logs", vi: "Nhật ký" },
  description: {
    en: "Request logs for the selected workspace.",
    vi: "Nhật ký request của workspace đã chọn.",
  },
  endpointUnavailable: {
    en: "Usage logs endpoint not available yet",
    vi: "Chưa có endpoint nhật ký mức sử dụng",
  },
  noRequests: { en: "No requests yet", vi: "Chưa có request nào" },
  noRequestsDesc: {
    en: "Usage logs will appear here once requests are made.",
    vi: "Nhật ký sử dụng sẽ xuất hiện khi có request.",
  },
  noUsageRequests: { en: "No requests with usage", vi: "Không có request nào có mức sử dụng" },
  noUsageDesc: {
    en: "All loaded requests were hidden because they have no model or no token usage.",
    vi: "Mọi request đã tải bị ẩn vì không có mô hình hoặc không dùng token.",
  },
  searchPlaceholder: { en: "Search request, model, key…", vi: "Tìm request, mô hình, key…" },
  searchLogs: { en: "Search logs", vi: "Tìm nhật ký" },
  modelsLabel: { en: "Models", vi: "Mô hình" },
  allModels: { en: "All models", vi: "Tất cả mô hình" },
  statuses: { en: "Statuses", vi: "Trạng thái" },
  allStatuses: { en: "All statuses", vi: "Tất cả trạng thái" },
  succeeded: { en: "Succeeded", vi: "Thành công" },
  error: { en: "Error", vi: "Lỗi" },
  keysLabel: { en: "Keys", vi: "Key" },
  allKeys: { en: "All keys", vi: "Tất cả key" },
  allFilterSuffix: { en: "All", vi: "Tất cả" },
  refreshLogs: { en: "Refresh logs", vi: "Làm mới nhật ký" },
  refresh: { en: "Refresh", vi: "Làm mới" },
  time: { en: "Time", vi: "Thời gian" },
  request: { en: "Request", vi: "Request" },
  model: { en: "Model", vi: "Mô hình" },
  key: { en: "Key", vi: "Key" },
  tokens: { en: "Tokens", vi: "Token" },
  cost: { en: "Cost", vi: "Chi phí" },
  status: { en: "Status", vi: "Trạng thái" },
  ttft: {
    en: "Time to first token (streaming requests only)",
    vi: "Thời gian tới token đầu (chỉ request streaming)",
  },
  latency: { en: "Latency", vi: "Độ trễ" },
  noMatching: { en: "No matching requests", vi: "Không có request khớp" },
  openRequest: { en: "Open request {id}", vi: "Mở request {id}" },
  copyRequestId: { en: "Copy request ID", vi: "Copy request ID" },
  showing: {
    en: "Showing {start}–{end} of {total} loaded requests",
    vi: "Hiển thị {start}–{end} trong {total} request đã tải",
  },
  hidden: {
    en: " — {n} hidden (no model or no token usage)",
    vi: " — {n} bị ẩn (không có mô hình hoặc không dùng token)",
  },
  prev: { en: "Prev", vi: "Trước" },
  next: { en: "Next", vi: "Sau" },
  previousPage: { en: "Previous page", vi: "Trang trước" },
  nextPage: { en: "Next page", vi: "Trang sau" },
  detailsTitle: { en: "Request usage details", vi: "Chi tiết sử dụng của request" },
  failure: { en: "Failure", vi: "Lỗi" },
  provider: { en: "Provider", vi: "Nhà cung cấp" },
  keyPrefix: { en: "Key prefix", vi: "Tiền tố key" },
  inputTokens: { en: "Input tokens", vi: "Token đầu vào" },
  cachedInputTokens: { en: "Cached input tokens", vi: "Token đầu vào cache" },
  reasoningTokens: { en: "Reasoning tokens", vi: "Token suy luận" },
  outputTokens: { en: "Output tokens", vi: "Token đầu ra" },
  duration: { en: "Duration", vi: "Thời lượng" },
  timeToFirstToken: { en: "Time to first token", vi: "Thời gian tới token đầu" },
  created: { en: "Created", vi: "Thời gian tạo" },
  removeLog: { en: "Remove log", vi: "Xoá nhật ký" },
  removeLogDesc: {
    en: "Hides this log from users. Billing records are kept.",
    vi: "Ẩn nhật ký này khỏi người dùng. Bản ghi thanh toán được giữ lại.",
  },
  removing: { en: "Removing…", vi: "Đang xoá…" },
  remove: { en: "Remove", vi: "Xoá" },
  logRemoved: { en: "Log removed", vi: "Đã xoá nhật ký" },
  removeFailed: { en: "Remove failed", vi: "Xoá thất bại" },
  cancel: { en: "Cancel", vi: "Huỷ" },
} as const;

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
function RemoveLogButton({ requestId, onRemoved }: { requestId: string; onRemoved: () => void }) {
  const t = useT(logsCopy);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const remove = useMutation({
    mutationFn: () => api(`/api/v1/admin/requests/${requestId}`, { method: "DELETE" }),
    onSuccess: () => {
      toast(t("logRemoved"), {
        description: t("removeLogDesc"),
      });
      void qc.invalidateQueries({ queryKey: ["usage-logs"] });
      void qc.invalidateQueries({ queryKey: ["usage-summary"] });
      setOpen(false);
      onRemoved();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t("removeFailed")),
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <div className="pt-4">
        <Button
          variant="destructive"
          size="sm"
          className="gap-1.5"
          onClick={() => setOpen(true)}
          aria-label={t("removeLog")}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t("removeLog")}
        </Button>
      </div>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("removeLog")}</DialogTitle>
          <DialogDescription>{t("removeLogDesc")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            {t("cancel")}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={remove.isPending}
            onClick={() => void remove.mutateAsync().catch(() => undefined)}
          >
            {remove.isPending ? t("removing") : t("remove")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AllOption({ label }: { label: string }) {
  const t = useT(logsCopy);
  return (
    <SelectItem value="all">
      {t("allFilterSuffix")} {label.toLowerCase()}
    </SelectItem>
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
        <AllOption label={label} />
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
  const t = useT(logsCopy);
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
        <PageHeader title={t("title")} description={t("description")} />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (query.isError) {
    const err = query.error as ApiError;
    return (
      <div className="space-y-4">
        <PageHeader title={t("title")} description={t("description")} />
        {err.status === 404 ? (
          <EmptyState title={t("endpointUnavailable")} />
        ) : (
          <ErrorState message={err.message} />
        )}
      </div>
    );
  }

  const visible = visibleRows(query.data);
  const models = Array.from(new Set(visible.map((r) => r.public_model))).sort();
  const keys = Array.from(new Set(visible.map((r) => r.key_prefix ?? "—"))).sort();
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
      <PageHeader title={t("title")} description={t("description")} />
      {query.data.length === 0 ? (
        <EmptyState title={t("noRequests")} description={t("noRequestsDesc")} />
      ) : visible.length === 0 ? (
        <EmptyState title={t("noUsageRequests")} description={t("noUsageDesc")} />
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="h-8 w-56 text-sm"
              placeholder={t("searchPlaceholder")}
              aria-label={t("searchLogs")}
              value={filters.search}
              onChange={(e) => setFilter({ search: e.target.value })}
            />
            <FilterSelect
              label={t("modelsLabel")}
              placeholder={t("allModels")}
              value={filters.model}
              onChange={(v) => setFilter({ model: v })}
              options={models}
            />
            <Select value={filters.status} onValueChange={(v) => setFilter({ status: v })}>
              <SelectTrigger aria-label={t("statuses")} className="h-8 w-[120px] text-xs">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("allStatuses")}</SelectItem>
                <SelectItem value="ok">{t("succeeded")}</SelectItem>
                <SelectItem value="error">{t("error")}</SelectItem>
              </SelectContent>
            </Select>
            <FilterSelect
              label={t("keysLabel")}
              placeholder={t("allKeys")}
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
              aria-label={t("refreshLogs")}
            >
              <RefreshCw className={"h-3.5 w-3.5" + (query.isFetching ? " animate-spin" : "")} />
              {t("refresh")}
            </Button>
          </div>
          <div className="rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("time")}</TableHead>
                  <TableHead>{t("request")}</TableHead>
                  <TableHead>{t("model")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("key")}</TableHead>
                  <TableHead className="text-right">{t("tokens")}</TableHead>
                  <TableHead className="text-right">{t("cost")}</TableHead>
                  <TableHead>{t("status")}</TableHead>
                  <TableHead className="hidden text-right md:table-cell" title={t("ttft")}>
                    TTFT
                  </TableHead>
                  <TableHead className="hidden text-right md:table-cell">{t("latency")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {slice.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={9}>
                      <EmptyState title={t("noMatching")} />
                    </TableCell>
                  </TableRow>
                )}
                {slice.map((r) => {
                  const cost = formatUsdFromVnd(r.charged_vnd, rate) ?? formatVnd(r.charged_vnd);
                  return (
                    <TableRow
                      key={r.id}
                      tabIndex={0}
                      role="button"
                      aria-label={t("openRequest", { id: r.request_id })}
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
                            <CopyButton value={r.request_id} label={t("copyRequestId")} />
                          </span>
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{r.public_model}</TableCell>
                      <TableCell className="hidden font-mono text-xs md:table-cell">
                        {r.key_prefix ?? "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs whitespace-nowrap">
                        {formatTokens(r.input_tokens)} → {formatTokens(r.output_tokens)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">{cost}</TableCell>
                      <TableCell>
                        <StatusBadge status={r.status} />
                      </TableCell>
                      <TableCell
                        className="hidden whitespace-nowrap text-right font-mono text-xs md:table-cell"
                        title={t("ttft")}
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
              {t("showing", { start: rangeStart, end: rangeEnd, total: filtered.length })}
              {hiddenCount > 0 && t("hidden", { n: hiddenCount })}
            </span>
            <span className="flex flex-wrap gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={safePage === 0}
                onClick={() => setPage(safePage - 1)}
                aria-label={t("previousPage")}
              >
                {t("prev")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={safePage >= pageCount - 1}
                onClick={() => setPage(safePage + 1)}
                aria-label={t("nextPage")}
              >
                {t("next")}
              </Button>
            </span>
          </div>
        </div>
      )}
      <Sheet open={selected != null} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent>
          <SheetTitle className="font-mono text-sm break-all">{selected?.request_id}</SheetTitle>
          <SheetDescription className="sr-only">{t("detailsTitle")}</SheetDescription>
          {selected && (
            <div className="pb-3 border-b border-border">
              <CopyButton value={selected.request_id} label={t("copyRequestId")} />
            </div>
          )}
          {selected && (
            <div className="pt-2">
              <DetailField label={t("status")}>
                <StatusBadge status={selected.status} />
              </DetailField>
              {selected.failure && (
                <DetailField label={t("failure")}>{selected.failure}</DetailField>
              )}
              <DetailField label={t("model")}>{selected.public_model}</DetailField>
              <DetailField label={t("provider")}>
                {formatProviderLabel(selected.provider)}
              </DetailField>
              <DetailField label={t("keyPrefix")}>{selected.key_prefix ?? "—"}</DetailField>
              <DetailField label={t("inputTokens")}>{selected.input_tokens}</DetailField>
              <DetailField label={t("cachedInputTokens")}>
                {selected.cached_input_tokens}
              </DetailField>
              <DetailField label={t("reasoningTokens")}>{selected.reasoning_tokens}</DetailField>
              <DetailField label={t("outputTokens")}>{selected.output_tokens}</DetailField>
              <DetailField label={t("cost")}>
                {formatUsdFromVnd(selected.charged_vnd, rate) ?? formatVnd(selected.charged_vnd)}
              </DetailField>
              <DetailField label={t("duration")}>{formatDuration(selected.latency_ms)}</DetailField>
              <DetailField label={t("timeToFirstToken")}>
                {formatDuration(selected.ttft_ms)}
              </DetailField>
              <DetailField label={t("created")}>
                {formatDate(new Date(selected.created_at))}
              </DetailField>
            </div>
          )}
          {selected && isAdmin === true && (
            <RemoveLogButton requestId={selected.request_id} onRemoved={() => setSelected(null)} />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
