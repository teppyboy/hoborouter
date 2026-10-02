import type { ColumnDef } from "@tanstack/react-table";
import { CheckCircle2, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { DataTable, PageHeader } from "../../components/page";
import { formatDate, formatVnd } from "../../lib/format";
import { AdminGate, type AuditRow, useAdminQuery } from "./shared";

interface CpaHealth {
  status: string;
}

interface AdminSystem {
  gateway_enabled: boolean;
  usd_vnd_rate: number;
  payos_configured: boolean;
  dev_payments: boolean;
  db: { wal: string };
  counts: { users: number; workspaces: number; models: number; requests: number };
}

interface CpaModel {
  id: string;
  owned_by: string | null;
  mapped: boolean;
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
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
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
              <dt className="text-muted-foreground">Dev payments</dt>
              <dd>
                <Badge variant={query.data.dev_payments ? "secondary" : "outline"}>
                  {query.data.dev_payments ? "enabled" : "disabled"}
                </Badge>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">DB journal mode</dt>
              <dd className="font-mono text-xs">{query.data.db.wal}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Counts</dt>
              <dd className="font-mono text-xs">
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

function CpaHealthCard() {
  const query = useAdminQuery<CpaHealth>(["admin", "cpa-health"], "/api/v1/admin/cpa/health");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">CPA health</CardTitle>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <p className="text-sm text-muted-foreground">Checking…</p>
        ) : query.error ? (
          <p className="flex items-center gap-2 text-sm text-destructive">
            <XCircle className="size-4" />
            {query.error instanceof Error ? query.error.message : "Unreachable"}
          </p>
        ) : (
          <p className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="size-4" /> {query.data.status}
            <Badge variant="outline">ok</Badge>
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function CpaModelsTable() {
  const query = useAdminQuery<{ data: CpaModel[] }>(
    ["admin", "cpa-models"],
    "/api/v1/admin/cpa/models",
  );
  const columns: ColumnDef<CpaModel, unknown>[] = [
    {
      accessorKey: "id",
      header: "Model",
      cell: (c) => <span className="font-mono text-xs">{c.getValue() as string}</span>,
    },
    {
      accessorKey: "owned_by",
      header: "Owned by",
      cell: (c) => (
        <span className="font-mono text-xs">{(c.getValue() as string | null) ?? "—"}</span>
      ),
    },
    {
      accessorKey: "mapped",
      header: "Mapped",
      cell: (c) =>
        c.getValue() ? (
          <Badge variant="default">mapped</Badge>
        ) : (
          <Badge variant="outline">unmapped</Badge>
        ),
    },
  ];
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-medium">CPA models</h2>
      {query.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : query.error ? (
        <p className="flex items-center gap-2 text-sm text-destructive">
          <XCircle className="size-4" />
          {query.error instanceof Error ? query.error.message : "CPA unreachable"}
        </p>
      ) : (
        <DataTable columns={columns} data={query.data.data} empty="No CPA models" />
      )}
    </div>
  );
}

const auditColumns: ColumnDef<AuditRow, unknown>[] = [
  {
    accessorKey: "created_at",
    header: "Time",
    cell: (c) => (
      <span className="font-mono text-xs">{formatDate(new Date(c.getValue() as number))}</span>
    ),
  },
  {
    accessorKey: "action",
    header: "Action",
    cell: (c) => <span className="font-mono text-xs">{c.getValue() as string}</span>,
  },
  {
    accessorKey: "actor_user_id",
    header: "Actor",
    cell: (c) => (
      <span className="font-mono text-xs">
        {(c.getValue() as string | null)?.slice(0, 8) ?? "—"}
      </span>
    ),
  },
  {
    accessorKey: "target",
    header: "Target",
    cell: (c) => (
      <span className="font-mono text-xs">
        {(c.getValue() as string | null)?.slice(0, 8) ?? "—"}
      </span>
    ),
  },
  {
    accessorKey: "detail",
    header: "Detail",
    enableSorting: false,
    cell: (c) => {
      const raw = c.getValue() as string | null;
      if (!raw) return <span className="font-mono text-xs text-muted-foreground">—</span>;
      let text = raw;
      try {
        text = JSON.stringify(JSON.parse(raw));
      } catch {
        // P2: detail may not be valid JSON — render raw string
      }
      return <span className="font-mono text-xs text-muted-foreground">{text}</span>;
    },
  },
];

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
  const query = useAdminQuery<AuditRow[]>(["admin", "audit"], "/api/v1/audit");
  return (
    <div className="space-y-4">
      <PageHeader title="System" description="Instance health and audit log." />
      <AdminGate query={query}>
        <SystemCard />
        <CpaHealthCard />
        <CpaModelsTable />
        <UsageLogsTable />
        <h2 className="text-sm font-medium">Audit log</h2>
        <DataTable columns={auditColumns} data={query.data ?? []} empty="No audit entries" />
      </AdminGate>
    </div>
  );
}
