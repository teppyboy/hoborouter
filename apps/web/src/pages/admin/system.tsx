import type { ColumnDef } from "@tanstack/react-table";
import { CheckCircle2, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { DataTable, PageHeader } from "../../components/page";
import { formatDate } from "../../lib/format";
import { AdminGate, type AuditRow, useAdminQuery } from "./shared";

interface CpaHealth {
  status: string;
}

function CpaHealthCard() {
  const query = useAdminQuery<CpaHealth>(["admin", "cpa-health"], "/api/admin/cpa/health");
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

const auditColumns: ColumnDef<AuditRow, unknown>[] = [
  {
    accessorKey: "created_at",
    header: "Time",
    cell: (c) => <span className="font-mono text-xs">{formatDate(new Date(c.getValue() as number))}</span>,
  },
  { accessorKey: "action", header: "Action", cell: (c) => <span className="font-mono text-xs">{c.getValue() as string}</span> },
  {
    accessorKey: "actor_user_id",
    header: "Actor",
    cell: (c) => <span className="font-mono text-xs">{(c.getValue() as string | null)?.slice(0, 8) ?? "—"}</span>,
  },
  { accessorKey: "target", header: "Target", cell: (c) => <span className="font-mono text-xs">{(c.getValue() as string | null)?.slice(0, 8) ?? "—"}</span> },
  {
    accessorKey: "detail",
    header: "Detail",
    enableSorting: false,
    cell: (c) => (
      <span className="font-mono text-xs text-muted-foreground">
        {(c.getValue() as string | null) ? JSON.stringify(JSON.parse(c.getValue() as string)) : "—"}
      </span>
    ),
  },
];

export default function AdminSystemPage() {
  const query = useAdminQuery<AuditRow[]>(["admin", "audit"], "/api/audit");
  return (
    <div className="space-y-4">
      <PageHeader title="System" description="Instance health and audit log." />
      <AdminGate query={query}>
        <CpaHealthCard />
        <h2 className="text-sm font-medium">Audit log</h2>
        <DataTable columns={auditColumns} data={query.data ?? []} empty="No audit entries" />
      </AdminGate>
    </div>
  );
}
