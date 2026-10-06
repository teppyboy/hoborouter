import type { ColumnDef } from "@tanstack/react-table";
import { CheckCircle2, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { DataTable, PageHeader } from "../../components/page";
import { formatDate, formatVnd } from "../../lib/format";
import { AdminGate, useAdminQuery } from "./shared";

interface AdminSystem {
  gateway_enabled: boolean;
  usd_vnd_rate: number;
  payos_configured: boolean;
  manual_payments: boolean;
  db: { wal: string };
  counts: { users: number; workspaces: number; models: number; requests: number };
}

interface AdminUsageLog {
  id: string;
  workspace_name: string;
  provider: string;
  public_model: string;
  input_tokens: number;
  output_tokens: number;
  status: string;
  charged_vnd: number;
  created_at: number;
}

function SystemCard() {
  const query = useAdminQuery<AdminSystem>(["admin", "system"], "/api/v1/admin/system");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">System</CardTitle>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : query.error ? (
          <p className="flex items-center gap-2 text-sm text-destructive">
            <XCircle className="size-4" />
            {query.error instanceof Error ? query.error.message : "Failed to load system info"}
          </p>
        ) : (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">Gateway</dt>
              <dd className="flex items-center gap-1.5">
                {query.data.gateway_enabled ? (
                  <>
                    <CheckCircle2 className="size-4" /> on
                  </>
                ) : (
                  <>
                    <XCircle className="size-4" /> off
                  </>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">USD/VND rate</dt>
              <dd className="font-mono text-xs">
                {query.data.usd_vnd_rate.toLocaleString("vi-VN")}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">PayOS</dt>
              <dd>
                <Badge variant={query.data.payos_configured ? "default" : "outline"}>
                  {query.data.payos_configured ? "configured" : "not configured"}
                </Badge>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Manual payments</dt>
              <dd>
                <Badge variant={query.data.manual_payments ? "secondary" : "outline"}>
                  {query.data.manual_payments ? "enabled" : "disabled"}
                </Badge>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">DB journal mode</dt>
              <dd className="font-mono text-xs">{query.data.db.wal}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Counts</dt>
              <dd className="break-words font-mono text-xs">
                users {query.data.counts.users} · workspaces {query.data.counts.workspaces} · models{" "}
                {query.data.counts.models} · requests {query.data.counts.requests}
              </dd>
            </div>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

const usageColumns: ColumnDef<AdminUsageLog, unknown>[] = [
  {
    accessorKey: "created_at",
    header: "Time",
    cell: (c) => (
      <span className="font-mono text-xs">{formatDate(new Date(c.getValue() as number))}</span>
    ),
  },
  { accessorKey: "workspace_name", header: "Workspace" },
  {
    accessorKey: "provider",
    header: "Provider",
    cell: (c) => <span className="font-mono text-xs">{c.getValue() as string}</span>,
  },
  {
    accessorKey: "public_model",
    header: "Model",
    cell: (c) => <span className="font-mono text-xs">{c.getValue() as string}</span>,
  },
  {
    accessorKey: "input_tokens",
    header: "Tokens in/out",
    cell: (c) => (
      <span className="font-mono text-xs">
        {c.row.original.input_tokens.toLocaleString()} /{" "}
        {c.row.original.output_tokens.toLocaleString()}
      </span>
    ),
  },
  {
    accessorKey: "charged_vnd",
    header: "Charged",
    cell: (c) => <span className="font-mono text-xs">{formatVnd(c.getValue<number>())}</span>,
  },
  { accessorKey: "status", header: "Status" },
];

function UsageLogsTable() {
  const query = useAdminQuery<{ data: AdminUsageLog[] }>(
    ["admin", "usage-logs"],
    "/api/v1/admin/usage-logs",
  );
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-medium">Usage logs</h2>
      {query.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : query.error ? (
        <p className="flex items-center gap-2 text-sm text-destructive">
          <XCircle className="size-4" />
          {query.error instanceof Error ? query.error.message : "Failed to load usage logs"}
        </p>
      ) : (
        <DataTable columns={usageColumns} data={query.data.data} empty="No usage logs" />
      )}
    </div>
  );
}

export default function AdminSystemPage() {
  return (
    <div className="space-y-4">
      <PageHeader title="System" description="Instance health and status." />
      <AdminGate query={useAdminQuery<unknown>(["admin", "system"], "/api/v1/admin/system")}>
        <SystemCard />
        <UsageLogsTable />
      </AdminGate>
    </div>
  );
}
