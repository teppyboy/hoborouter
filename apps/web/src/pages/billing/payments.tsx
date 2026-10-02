import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { toast } from "sonner";
import { api, ApiError } from "../../lib/api";
import { useCurrentWorkspaceId } from "../../lib/workspace-queries";
import { formatVnd, formatDate } from "../../lib/format";
import { PageHeader, EmptyState, ErrorState, DataTable, CopyButton } from "../../components/page";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { Badge } from "../../components/ui/badge";
import type { ColumnDef } from "@tanstack/react-table";

interface Payment {
  id: string;
  provider: string;
  amount: number;
  status: string;
  created_at: number | string;
  provider_order_code: string;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  paid: "default",
  pending: "secondary",
  failed: "destructive",
  cancelled: "destructive",
};

export default function BillingPaymentsPage() {
  const workspaceId = useCurrentWorkspaceId();
  const location = useLocation();
  // Router has no validateSearch on this route — read the param from the URL.
  const [selectedId] = useState(() => new URLSearchParams(location.search).get("payment"));

  const payments = useQuery({
    queryKey: ["payments", workspaceId],
    queryFn: () => api<{ data: Payment[] }>(`/api/v1/workspaces/${workspaceId}/payments?limit=50`),
    enabled: !!workspaceId,
  });

  const columns: ColumnDef<Payment>[] = [
    { accessorKey: "created_at", header: "Time", cell: (c) => formatDate(c.getValue<string>()) },
    { accessorKey: "amount", header: "Amount", cell: (c) => <span className="font-mono text-xs">{formatVnd(c.getValue<number>())}</span> },
    { accessorKey: "provider", header: "Provider", cell: (c) => <span className="font-mono text-xs">{c.getValue<string>()}</span> },
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
          <span className="font-mono text-xs">{c.getValue<string>().slice(0, 8)}…</span>
          <CopyButton value={c.getValue<string>()} label="Copy payment ID" />
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payments"
        description="Top-up payment history and status."
      />
      {selectedId && workspaceId ? <PaymentStatus workspaceId={workspaceId} paymentId={selectedId} /> : null}

      {payments.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : payments.isError ? (
        <ErrorState message={payments.error.message} />
      ) : payments.data.data.length === 0 ? (
        <EmptyState title="No payments yet" description="Create a top-up on the Credits page." />
      ) : (
        <DataTable columns={columns} data={payments.data.data} empty="No payments" />
      )}
    </div>
  );
}

function PaymentStatus({ workspaceId, paymentId }: { workspaceId: string; paymentId: string }) {
  const queryClient = useQueryClient();
  const [devCompleteHidden, setDevCompleteHidden] = useState(false);

  const payment = useQuery({
    queryKey: ["payment", workspaceId, paymentId],
    queryFn: () => api<Payment>(`/api/v1/workspaces/${workspaceId}/payments/${paymentId}`),
    refetchInterval: (q) => (q.state.data?.status === "pending" ? 3000 : false),
  });

  const devComplete = useMutation({
    mutationFn: () =>
      api<{ success: boolean; outcome: string }>(`/api/v1/dev/payments/${paymentId}/complete`, {
        method: "POST",
      }),
    onSuccess: () => {
      toast("Payment marked complete");
      void queryClient.invalidateQueries({ queryKey: ["payment", workspaceId, paymentId] });
      void queryClient.invalidateQueries({ queryKey: ["payments", workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ["wallet", workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ["ledger", workspaceId] });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 404) {
        setDevCompleteHidden(true); // dev endpoint disabled
      } else {
        toast(err instanceof ApiError ? err.message : "Failed to complete payment");
      }
    },
  });

  if (payment.isPending) return <Skeleton className="h-32 w-full" />;
  if (payment.isError) return <ErrorState message={payment.error.message} />;

  const p = payment.data;
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Badge variant={STATUS_VARIANT[p.status] ?? "outline"}>{p.status}</Badge>
            <span className="font-mono text-sm font-semibold">{formatVnd(p.amount)}</span>
          </div>
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <span className="font-mono">{p.id}</span>
            <CopyButton value={p.id} label="Copy payment ID" />
          </p>
          <p className="text-xs text-muted-foreground">
            Provider <span className="font-mono">{p.provider}</span> · order{" "}
            <span className="font-mono">{p.provider_order_code}</span> · {formatDate(p.created_at)}
          </p>
          {p.status === "pending" && (
            <p className="text-xs text-muted-foreground">Waiting for admin confirmation…</p>
          )}
        </div>
        {p.status === "pending" && !devCompleteHidden && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => devComplete.mutate()}
            disabled={devComplete.isPending}
          >
            {devComplete.isPending ? "Completing…" : "Complete (dev)"}
          </Button>
        )}
      </div>
    </div>
  );
}
