import type { ColumnDef } from "@tanstack/react-table";
import { XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { DataTable, PageHeader, ScrollPanel } from "../../components/page";
import { formatDate, formatVnd } from "../../lib/format";
import { AdminGate, useAdminQuery } from "./shared";
import { useT } from "../../lib/i18n/t";

// Request log copy: inline LocaleEntry set (see lib/i18n/common.ts). The actor
// is the KEY CREATOR (server-resolved from key.create audits), never claimed
// as the actual caller, hence the explicit "Key creator" column label.
const requestLogCopy = {
  title: { en: "Request log", vi: "Nhật ký yêu cầu" },
  description: {
    en: "Recent model requests across the instance.",
    vi: "Các yêu cầu mô hình gần đây trên toàn instance.",
  },
  panel: { en: "Recent requests", vi: "Yêu cầu gần đây" },
  time: { en: "Time", vi: "Thời gian" },
  workspace: { en: "Workspace", vi: "Workspace" },
  keyCreator: { en: "Key creator", vi: "Người tạo khóa" },
  provider: { en: "Provider", vi: "Nhà cung cấp" },
  model: { en: "Model", vi: "Mô hình" },
  tokens: { en: "Tokens in/out", vi: "Token vào/ra" },
  charged: { en: "Charged", vi: "Đã tính phí" },
  status: { en: "Status", vi: "Trạng thái" },
  empty: { en: "No requests yet", vi: "Chưa có yêu cầu nào" },
  loadError: { en: "Failed to load request log", vi: "Không thể tải nhật ký yêu cầu" },
} as const;

interface AdminUsageLog {
  id: string;
  workspace_name: string;
  key_prefix: string | null;
  provider: string;
  public_model: string;
  input_tokens: number;
  output_tokens: number;
  status: string;
  charged_vnd: number;
  created_at: number;
  actor: { id: string; name: string | null; email: string | null } | null;
  actor_source: "key_creator" | null;
}

const columns = (
  t: (k: keyof typeof requestLogCopy) => string,
): ColumnDef<AdminUsageLog, unknown>[] => [
  {
    accessorKey: "created_at",
    header: t("time"),
    cell: (c) => (
      <span className="font-mono text-xs">{formatDate(new Date(c.getValue() as number))}</span>
    ),
  },
  { accessorKey: "workspace_name", header: t("workspace") },
  {
    accessorKey: "actor",
    header: t("keyCreator"),
    cell: (c) => {
      const actor = c.getValue<AdminUsageLog["actor"]>();
      return <span className="text-xs text-muted-foreground">{actor?.email ?? "—"}</span>;
    },
  },
  {
    accessorKey: "provider",
    header: t("provider"),
    cell: (c) => <span className="font-mono text-xs">{c.getValue() as string}</span>,
  },
  {
    accessorKey: "public_model",
    header: t("model"),
    cell: (c) => <span className="font-mono text-xs">{c.getValue() as string}</span>,
  },
  {
    accessorKey: "input_tokens",
    header: t("tokens"),
    cell: (c) => (
      <span className="font-mono text-xs">
        {c.row.original.input_tokens.toLocaleString()} /{" "}
        {c.row.original.output_tokens.toLocaleString()}
      </span>
    ),
  },
  {
    accessorKey: "charged_vnd",
    header: t("charged"),
    cell: (c) => <span className="font-mono text-xs">{formatVnd(c.getValue<number>())}</span>,
  },
  { accessorKey: "status", header: t("status") },
];

function RequestLogCard() {
  const t = useT(requestLogCopy);
  const query = useAdminQuery<{ data: AdminUsageLog[] }>(
    ["admin", "usage-logs"],
    "/api/v1/admin/usage-logs",
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{t("panel")}</CardTitle>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : query.error ? (
          <p className="flex items-center gap-2 text-sm text-destructive">
            <XCircle className="size-4" />
            {query.error instanceof Error ? query.error.message : t("loadError")}
          </p>
        ) : (
          // Internally scrolling: 200 rows never grow the page.
          <ScrollPanel label={t("panel")} stickyHeader>
            <DataTable columns={columns(t)} data={query.data.data} empty={t("empty")} />
          </ScrollPanel>
        )}
      </CardContent>
    </Card>
  );
}

export default function AdminRequestLogPage() {
  const t = useT(requestLogCopy);
  return (
    <div className="space-y-4">
      <PageHeader title={t("title")} description={t("description")} />
      <AdminGate
        query={useAdminQuery<unknown>(["admin", "usage-logs"], "/api/v1/admin/usage-logs")}
      >
        <RequestLogCard />
      </AdminGate>
    </div>
  );
}
