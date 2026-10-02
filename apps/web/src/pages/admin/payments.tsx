import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CopyButton, DataTable, PageHeader } from "../../components/page";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { formatDate, formatVnd } from "../../lib/format";
import { ApiError, api } from "../../lib/api";
import { AdminGate, useAdminQuery } from "./shared";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  paid: "default",
  completed: "default",
  pending: "secondary",
  failed: "destructive",
  cancelled: "destructive",
};

interface AdminPayment {
  id: string;
  workspace_id: string;
  workspace_name: string;
  amount: number;
  status: string;
  provider: string;
  provider_order_code: string;
  created_at: number;
  expires_at: number | null;
}

export default function AdminPaymentsPage() {
  const query = useAdminQuery<{ data: AdminPayment[] }>(
    ["admin", "payments"],
    "/api/v1/admin/payments",
  );
  return (
    <div className="space-y-4">
      <PageHeader title="Payments" description="Top-up payments across workspaces." />
      <AdminGate query={query}>
        <PaymentsTable payments={query.data?.data ?? []} />
      </AdminGate>
    </div>
  );
}

function PaymentsTable({ payments }: { payments: AdminPayment[] }) {
  const queryClient = useQueryClient();
  const [toComplete, setToComplete] = useState<AdminPayment | null>(null);

  const complete = useMutation({
    mutationFn: (id: string) => api(`/api/v1/admin/payments/${id}/complete`, { method: "POST" }),
    onSuccess: () => {
      toast("Payment marked paid");
      void queryClient.invalidateQueries({ queryKey: ["admin", "payments"] });
      setToComplete(null);
    },
    onError: (err) => toast(err instanceof ApiError ? err.message : "Failed to complete payment"),
  });

  const columns: ColumnDef<AdminPayment, unknown>[] = [
    {
      accessorKey: "created_at",
      header: "Time",
      cell: (c) => (
        <span className="font-mono text-xs">{formatDate(new Date(c.getValue() as number))}</span>
      ),
    },
    { accessorKey: "workspace_name", header: "Workspace" },
    {
      accessorKey: "amount",
      header: "Amount",
      cell: (c) => <span className="font-mono text-xs">{formatVnd(c.getValue<number>())}</span>,
    },
    {
      accessorKey: "provider",
      header: "Provider",
      cell: (c) => <span className="font-mono text-xs">{c.getValue() as string}</span>,
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: (c) => {
        const s = c.getValue<string>();
        return <Badge variant={STATUS_VARIANT[s] ?? "outline"}>{s}</Badge>;
      },
    },
    {
      accessorKey: "id",
      header: "ID",
      cell: (c) => (
        <span className="flex items-center gap-1">
          <span className="font-mono text-xs">{(c.getValue() as string).slice(0, 8)}…</span>
          <CopyButton value={c.getValue() as string} label="Copy payment ID" />
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      cell: (c) => {
        const p = c.row.original;
        if (p.status !== "pending") return null;
        return (
          <Button size="sm" variant="outline" onClick={() => setToComplete(p)}>
            Mark paid
          </Button>
        );
      },
    },
  ];

  return (
    <>
      <DataTable columns={columns} data={payments} empty="No payments" />
      <Dialog open={toComplete !== null} onOpenChange={(open) => !open && setToComplete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark payment as paid?</DialogTitle>
            <DialogDescription>
              {toComplete && (
                <>
                  {formatVnd(toComplete.amount)} for workspace “{toComplete.workspace_name}”. This
                  credits the workspace wallet and cannot be undone.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToComplete(null)}>
              Cancel
            </Button>
            <Button
              disabled={complete.isPending}
              onClick={() => toComplete && complete.mutate(toComplete.id)}
            >
              {complete.isPending ? "Confirming…" : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
