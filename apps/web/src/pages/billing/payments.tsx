import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { CreditCard } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { api } from "../../lib/api";
import { useCurrentWorkspaceId } from "../../lib/workspace-queries";
import { formatVnd, formatUsdFromVnd, useUsdVndRate, formatDate } from "../../lib/format";
import { formatProviderLabel, formatStatusLabel } from "../../lib/display";
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
  rejected: "destructive",
};

export default function BillingPaymentsPage() {
  const workspaceId = useCurrentWorkspaceId();
  const location = useLocation();
  const navigate = useNavigate();
  // Router has no validateSearch on this route — read the param from the URL.
  const [selectedId] = useState(() => new URLSearchParams(location.search).get("payment"));

  const payments = useQuery({
    queryKey: ["payments", workspaceId],
    queryFn: () => api<{ data: Payment[] }>(`/api/v1/workspaces/${workspaceId}/payments?limit=50`),
    enabled: !!workspaceId,
  });

  const rate = useUsdVndRate(workspaceId).data;

  const columns: ColumnDef<Payment>[] = [
    { accessorKey: "created_at", header: "Time", cell: (c) => formatDate(c.getValue<string>()) },
    {
      accessorKey: "amount",
      header: "Amount",
      cell: (c) => {
        const v = c.getValue<number>();
        const usd = formatUsdFromVnd(v, rate);
        return (
          <span className="font-mono text-xs">
            {usd ?? formatVnd(v)}
            {usd != null && v !== 0 && (
              <span className="ml-1 text-muted-foreground">{formatVnd(v)}</span>
            )}
          </span>
        );
      },
    },
    {
      accessorKey: "provider",
      header: "Provider",
      cell: (c) => <span className="font-mono text-xs">{formatProviderLabel(c.getValue<string>())}</span>,
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
          <span className="font-mono text-xs">{c.getValue<string>().slice(0, 8)}…</span>
          <CopyButton value={c.getValue<string>()} label="Copy payment ID" />
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="Payments" description="Top-up payment history and status." />
      {selectedId && workspaceId ? (
        <PaymentStatus workspaceId={workspaceId} paymentId={selectedId} />
      ) : null}

      {payments.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : payments.isError ? (
        <ErrorState message={payments.error.message} />
      ) : payments.data.data.length === 0 ? (
        <EmptyState
          icon={CreditCard}
          title="No payments yet"
          description="Create a top-up on the Credits page."
        >
          <Button size="sm" onClick={() => void navigate({ href: "/billing/credits" })}>
            Go to Credits
          </Button>
        </EmptyState>
      ) : (
        <DataTable columns={columns} data={payments.data.data} empty="No payments" />
      )}
    </div>
  );
}

function PaymentStatus({ workspaceId, paymentId }: { workspaceId: string; paymentId: string }) {
  const payment = useQuery({
    queryKey: ["payment", workspaceId, paymentId],
    queryFn: () => api<Payment>(`/api/v1/workspaces/${workspaceId}/payments/${paymentId}`),
    refetchInterval: (q) => (q.state.data?.status === "pending" ? 3000 : false),
  });

  const rate = useUsdVndRate(workspaceId).data;

  if (payment.isPending) return <Skeleton className="h-32 w-full" />;
  if (payment.isError) return <ErrorState message={payment.error.message} />;

  const p = payment.data;
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Badge variant={STATUS_VARIANT[p.status] ?? "outline"}>{formatStatusLabel(p.status)}</Badge>
            <span className="font-mono text-sm font-semibold">
              {formatUsdFromVnd(p.amount, rate) ?? formatVnd(p.amount)}
            </span>
            <span className="font-mono text-xs text-muted-foreground">{formatVnd(p.amount)}</span>
          </div>
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <span className="font-mono">{p.id}</span>
            <CopyButton value={p.id} label="Copy payment ID" />
          </p>
          <p className="text-xs text-muted-foreground">
            Provider <span className="font-mono">{formatProviderLabel(p.provider)}</span> · order{" "}
            <span className="font-mono">{p.provider_order_code}</span> · {formatDate(p.created_at)}
          </p>
          {p.status === "pending" && (
            <p className="text-xs text-muted-foreground">Waiting for admin confirmation…</p>
          )}
        </div>
      </div>
    </div>
  );
}
