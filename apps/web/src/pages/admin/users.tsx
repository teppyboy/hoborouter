import type { ColumnDef } from "@tanstack/react-table";
import { CopyButton, DataTable, PageHeader } from "../../components/page";
import { Badge } from "../../components/ui/badge";
import { formatDate } from "../../lib/format";
import { AdminGate, useAdminQuery } from "./shared";

interface AdminUser {
  id: string;
  email: string;
  name: string;
  created_at: number;
  is_instance_admin: number;
  workspace_count: number;
}

const columns: ColumnDef<AdminUser, unknown>[] = [
  { accessorKey: "email", header: "Email" },
  { accessorKey: "name", header: "Name" },
  {
    accessorKey: "created_at",
    header: "Joined",
    cell: (c) => (
      <span className="font-mono text-xs">{formatDate(new Date(c.getValue() as number))}</span>
    ),
  },
  {
    accessorKey: "is_instance_admin",
    header: "Role",
    cell: (c) =>
      c.getValue() ? <Badge variant="default">admin</Badge> : <Badge variant="outline">user</Badge>,
  },
  { accessorKey: "workspace_count", header: "Workspaces" },
  {
    accessorKey: "id",
    header: "ID",
    cell: (c) => (
      <span className="flex items-center gap-1">
        <span className="font-mono text-xs">{(c.getValue() as string).slice(0, 8)}…</span>
        <CopyButton value={c.getValue() as string} label="Copy user ID" />
      </span>
    ),
  },
];

export default function AdminUsersPage() {
  const query = useAdminQuery<{ data: AdminUser[] }>(["admin", "users"], "/api/v1/admin/users");
  return (
    <div className="space-y-4">
      <PageHeader title="Users" description="Instance users." />
      <AdminGate query={query}>
        <DataTable columns={columns} data={query.data?.data ?? []} empty="No users" />
      </AdminGate>
    </div>
  );
}
