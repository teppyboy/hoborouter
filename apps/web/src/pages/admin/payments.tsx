import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
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
import { formatProviderLabel, formatStatusLabel } from "../../lib/display";
import { ApiError, api } from "../../lib/api";
import { AdminGate, useAdminQuery } from "./shared";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  paid: "default",
  completed: "default",
  pending: "secondary",
  failed: "destructive",
  cancelled: "destructive",
  rejected: "destructive",
};

export interface AdminPayment {
  id: string;
  workspace_id: string;
  workspace_name: string;
  amount: number;
  status: string;
  provider: string;
  provider_order_code: string;
  created_at: number;
  expires_at: number | null;
  /** Actual creator, resolved server-side from the payment.create audit entry. */
  initiator: { id: string; name: string | null; email: string | null } | null;
}

/** One-line, truncating cell content. The table row is whitespace-nowrap. */
const truncate = "block max-w-full truncate";

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

export function PaymentsTable({
  payments,
  search,
  onSearchChange,
}: {
  payments: AdminPayment[];
  /** Optional controlled search; falls back to internal state. */
  search?: string;
  onSearchChange?: (v: string) => void;
}) {
  const [fallbackSearch, setFallbackSearch] = useState("");
  const value = onSearchChange ? (search ?? "") : fallbackSearch;
  const setSearch = onSearchChange ?? setFallbackSearch;
  const queryClient = useQueryClient();
  const [toComplete, setToComplete] = useState<AdminPayment | null>(null);
  const [toReject, setToReject] = useState<AdminPayment | null>(null);

  const complete = useMutation({
    mutationFn: (id: string) => api(`/api/v1/admin/payments/${id}/complete`, { method: "POST" }),
    onSuccess: () => {
      toast("Payment marked paid");
      void queryClient.invalidateQueries({ queryKey: ["admin", "payments"] });
      setToComplete(null);
    },
    onError: (err) => toast(err instanceof ApiError ? err.message : "Failed to complete payment"),
  });

  const reject = useMutation({
    mutationFn: (id: string) => api(`/api/v1/admin/payments/${id}/reject`, { method: "POST" }),
    onSuccess: () => {
      toast("Payment rejected");
      void queryClient.invalidateQueries({ queryKey: ["admin", "payments"] });
      // Customer-facing history lives under ["payments", workspaceId] per workspace.
      void queryClient.invalidateQueries({ queryKey: ["payments"] });
      // Mounted payment detail (billing/payments.tsx uses ["payment", workspaceId, paymentId]).
      void queryClient.invalidateQueries({ queryKey: ["payment"] });
      setToReject(null);
    },
    onError: (err) =>
      toast(
        err instanceof ApiError && err.code === "INVALID_STATE"
          ? "This payment is no longer pending — it was already processed. Refresh to update."
          : err instanceof ApiError
            ? err.message
            : "Failed to reject payment",
      ),
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
      id: "user",
      // Sorting/search must match the email string, not the initiator object.
      accessorFn: (row) => row.initiator?.email ?? "",
      header: "User",
      cell: (c) => {
        const email = c.getValue<string>();
        if (!email) return <span className={`${truncate} font-mono text-muted-foreground`}>—</span>;
        const ini = c.row.original.initiator;
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className={`${truncate} text-xs`}>
                {email}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <div className="space-y-0.5">
                <div>{ini?.name ?? "—"}</div>
                <div>{email}</div>
                <div className="font-mono text-muted-foreground">{ini?.id ?? "—"}</div>
              </div>
            </TooltipContent>
          </Tooltip>
        );
      },
    },
    {
      accessorKey: "amount",
      header: "Amount",
      cell: (c) => <span className="font-mono text-xs">{formatVnd(c.getValue<number>())}</span>,
    },
    {
      accessorKey: "provider",
      header: "Provider",
      cell: (c) => (
        <span className="font-mono text-xs">{formatProviderLabel(c.getValue() as string)}</span>
      ),
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: (c) => {
        const s = c.getValue<string>();
        return <Badge variant={STATUS_VARIANT[s] ?? "outline"}>{formatStatusLabel(s)}</Badge>;
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
          <span className="flex flex-wrap items-center gap-1">
            <Button size="sm" variant="outline" onClick={() => setToComplete(p)}>
              Mark paid
            </Button>
            <Button size="sm" variant="destructive" onClick={() => setToReject(p)}>
              Reject
            </Button>
          </span>
        );
      },
    },
  ];

  return (
    <>
      <DataTable
        columns={columns}
        data={payments}
        globalFilter={value}
        onGlobalFilterChange={setSearch}
        empty="No payments"
      />
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
      <Dialog open={toReject !== null} onOpenChange={(open) => !open && setToReject(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject payment?</DialogTitle>
            <DialogDescription>
              {toReject && (
                <>
                  {formatVnd(toReject.amount)} for workspace “{toReject.workspace_name}”. The
                  payment is marked rejected and no balance will be credited. This cannot be undone.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToReject(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={reject.isPending}
              onClick={() => toReject && reject.mutate(toReject.id)}
            >
              {reject.isPending ? "Rejecting…" : "Reject"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
