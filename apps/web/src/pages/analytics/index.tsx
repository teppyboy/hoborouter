import { useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { PageHeader, EmptyState, ErrorState } from "../../components/page";
import { Activity } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { ApiError, api } from "../../lib/api";
import { formatTokens, formatVnd } from "../../lib/format";
import { useCurrentWorkspaceId } from "../../lib/workspace-queries";
import { useT } from "../../lib/i18n/t";

// Analytics page (OpenRouter parity plan Task 6): workspace-authorized
// activity rollup over GET /api/v1/analytics/activity. Exact server contract
// (apps/api/src/routes/analytics.ts): { data: [{ group, requests,
// input_tokens, output_tokens, charged_vnd, cache_hit_rate }], next_cursor }.
// Public dimensions only (day / public_model / key_prefix) — the API rejects
// everything else, and the page renders nothing private by construction.
export interface ActivityRow {
  /** Dimension value; null means "no attribution" (e.g. usage without a key). */
  group: string | null;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  charged_vnd: number;
  /** 0..1 or null when the group has no input tokens. */
  cache_hit_rate: number | null;
}
export interface ActivityResponse {
  data: ActivityRow[];
  next_cursor: string | null;
}

type GroupBy = "day" | "public_model" | "key_prefix";
const GROUP_BY_OPTIONS: GroupBy[] = ["day", "public_model", "key_prefix"];
const PAGE_LIMIT = 100;

const analyticsCopy = {
  title: { en: "Analytics", vi: "Phân tích" },
  description: {
    en: "Workspace activity rollups: requests, tokens, spend and cache hit rate.",
    vi: "Tổng hợp hoạt động workspace: request, token, chi tiêu và tỷ lệ cache.",
  },
  groupBy: { en: "Group by", vi: "Nhóm theo" },
  groupDay: { en: "Day (UTC)", vi: "Ngày (UTC)" },
  groupModel: { en: "Model", vi: "Mô hình" },
  groupKey: { en: "API key prefix", vi: "Tiền tố khoá API" },
  groupCol: { en: "Group", vi: "Nhóm" },
  requestsCol: { en: "Requests", vi: "Requests" },
  inputCol: { en: "Input tokens", vi: "Token vào" },
  outputCol: { en: "Output tokens", vi: "Token ra" },
  chargedCol: { en: "Charged (VND)", vi: "Đã tính (VND)" },
  cacheCol: { en: "Cache hit rate", vi: "Tỷ lệ cache trúng" },
  noneAvailable: { en: "No usage in this period yet", vi: "Chưa có mức sử dụng trong kỳ này" },
  endpointUnavailable: {
    en: "Analytics endpoint not available yet.",
    vi: "Chưa có endpoint phân tích.",
  },
  loadMore: { en: "Load more", vi: "Tải thêm" },
  noWorkspace: {
    en: "Choose a workspace to see its usage analytics.",
    vi: "Chọn một workspace để xem phân tích mức sử dụng.",
  },
} as const;

const groupLabelCopy: Record<GroupBy, { en: string; vi: string }> = {
  day: analyticsCopy.groupDay,
  public_model: analyticsCopy.groupModel,
  key_prefix: analyticsCopy.groupKey,
};

/** null groups render as an em dash: "no attribution" is a legitimate state. */
function groupLabel(group: string | null): string {
  return group ?? "—";
}

function cacheRateLabel(rate: number | null): string {
  return rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;
}

export default function AnalyticsPage() {
  const t = useT(analyticsCopy);
  const workspaceId = useCurrentWorkspaceId();
  const [groupBy, setGroupBy] = useState<GroupBy>("day");

  const q = useInfiniteQuery({
    queryKey: ["analytics-activity", workspaceId, groupBy],
    enabled: workspaceId != null,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api<ActivityResponse>(
        `/api/v1/analytics/activity?workspace_id=${encodeURIComponent(workspaceId ?? "")}` +
          `&group_by=${groupBy}&limit=${PAGE_LIMIT}` +
          (pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""),
        { signal },
      ),
    getNextPageParam: (last) => last.next_cursor,
    staleTime: 30_000,
    retry: (count, err) => {
      const status = (err as { status?: number }).status;
      // 404 = endpoint not integrated yet; 401/403 = auth states. Neither is
      // transient: retrying only adds dead-cookie noise.
      return status !== 404 && status !== 401 && status !== 403 && count < 2;
    },
  });

  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.data) ?? [], [q.data]);
  const endpointMissing = q.error instanceof ApiError && q.error.status === 404;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <PageHeader title={t("title")} description={t("description")} />
      <div className="flex flex-wrap items-center gap-2">
        <Select value={groupBy} onValueChange={(v) => setGroupBy(v as GroupBy)}>
          <SelectTrigger aria-label={t("groupBy")} className="h-8 w-48">
            <SelectValue placeholder={t("groupBy")} />
          </SelectTrigger>
          <SelectContent>
            {GROUP_BY_OPTIONS.map((g) => (
              <SelectItem key={g} value={g}>
                {t(groupLabelCopy[g].en as Parameters<typeof t>[0])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {workspaceId == null ? (
        <EmptyState icon={Activity} title={t("noWorkspace")} />
      ) : q.isPending ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : q.isError ? (
        endpointMissing ? (
          <EmptyState icon={Activity} title={t("endpointUnavailable")} />
        ) : (
          <ErrorState message={(q.error as Error).message} />
        )
      ) : rows.length === 0 ? (
        <EmptyState icon={Activity} title={t("noneAvailable")} />
      ) : (
        <>
          <div className="flex min-h-0 flex-col rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("groupCol")}</TableHead>
                  <TableHead className="text-right">{t("requestsCol")}</TableHead>
                  <TableHead className="text-right">{t("inputCol")}</TableHead>
                  <TableHead className="text-right">{t("outputCol")}</TableHead>
                  <TableHead className="text-right">{t("chargedCol")}</TableHead>
                  <TableHead className="text-right">{t("cacheCol")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, i) => (
                  <TableRow key={`${String(r.group)}-${i}`}>
                    <TableCell className="font-mono text-sm">{groupLabel(r.group)}</TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {r.requests.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {formatTokens(r.input_tokens)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {formatTokens(r.output_tokens)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {formatVnd(r.charged_vnd)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {cacheRateLabel(r.cache_hit_rate)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {q.hasNextPage && (
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => void q.fetchNextPage()}
              disabled={q.isFetchingNextPage}
            >
              {q.isFetchingNextPage ? "…" : t("loadMore")}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
