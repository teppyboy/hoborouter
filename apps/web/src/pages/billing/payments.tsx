import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { CreditCard } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { api } from "../../lib/api";
import { useCurrentWorkspaceId } from "../../lib/workspace-queries";
import { formatVnd, formatUsdFromVnd, useUsdVndRate, formatDate } from "../../lib/format";
import { formatProviderLabel, formatStatusLabel } from "../../lib/display";
import {
  PageHeader,
  EmptyState,
  ErrorState,
  DataTable,
  CopyButton,
  ScrollPanel,
} from "../../components/page";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { Badge } from "../../components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../components/ui/tabs";
import type { ColumnDef } from "@tanstack/react-table";
import { useT } from "../../lib/i18n/t";

// Payments page copy: inline LocaleEntry set (see lib/i18n/common.ts).
// Money amounts, provider names and API status values are never translated.
const paymentsCopy = {
  title: { en: "Payments", vi: "Thanh toán" },
  description: {
    en: "Top-up payment history and status.",
    vi: "Lịch sử và trạng thái thanh toán nạp tín dụng.",
  },
  noPayments: { en: "No payments yet", vi: "Chưa có thanh toán nào" },
  noPaymentsBody: {
    en: "Create a top-up on the Credits page.",
    vi: "Tạo lệnh nạp tại trang Tín dụng.",
  },
  goToCredits: { en: "Go to Credits", vi: "Đến trang Tín dụng" },
  paymentsSections: { en: "Payments sections", vi: "Phần thanh toán" },
  paymentStatus: { en: "Payment status", vi: "Trạng thái thanh toán" },
  history: { en: "History", vi: "Lịch sử" },
  time: { en: "Time", vi: "Thời gian" },
  amount: { en: "Amount", vi: "Số tiền" },
  provider: { en: "Provider", vi: "Nhà cung cấp" },
  status: { en: "Status", vi: "Trạng thái" },
  id: { en: "ID", vi: "ID" },
  copyPaymentId: { en: "Copy payment ID", vi: "Copy mã thanh toán" },
  paymentHistory: { en: "Payment history", vi: "Lịch sử thanh toán" },
  noPaymentsRows: { en: "No payments", vi: "Không có thanh toán" },
  providerPrefix: { en: "Provider", vi: "Nhà cung cấp" },
  order: { en: "order", vi: "mã đơn" },
  waitingPayos: { en: "Waiting for PayOS confirmation…", vi: "Đang chờ PayOS xác nhận…" },
  waitingAdmin: { en: "Waiting for admin confirmation…", vi: "Đang chờ quản trị viên xác nhận…" },
} as const;

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
  succeeded: "default",
  pending: "secondary",
  failed: "destructive",
  cancelled: "destructive",
  rejected: "destructive",
};

export default function BillingPaymentsPage() {
  const t = useT(paymentsCopy);
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

  const history = payments.isPending ? (
    <Skeleton className="h-40 w-full" />
  ) : payments.isError ? (
    <ErrorState message={payments.error.message} />
  ) : payments.data.data.length === 0 ? (
    <EmptyState icon={CreditCard} title={t("noPayments")} description={t("noPaymentsBody")}>
      <Button size="sm" onClick={() => void navigate({ href: "/billing/credits" })}>
        {t("goToCredits")}
      </Button>
    </EmptyState>
  ) : (
    <PaymentHistory payments={payments.data.data} rate={rate} />
  );

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />
      {selectedId && workspaceId ? (
        <PaymentsTabs
          status={<PaymentStatus workspaceId={workspaceId} paymentId={selectedId} />}
          history={history}
        />
      ) : (
        history
      )}
    </div>
  );
}

/**
 * When a specific payment is opened (`?payment=…`), its live status and the
 * full history live in separate tabs; status is the default so the just-created
 * payment's state is the first thing seen. Loading/error/empty states stay in
 * the shared `history` node, so every tab inherits them unchanged.
 */
export function PaymentsTabs({
  status,
  history,
}: {
  status: React.ReactNode;
  history: React.ReactNode;
}) {
  const t = useT(paymentsCopy);
  return (
    <Tabs defaultValue="status" className="min-w-0">
      <TabsList aria-label={t("paymentsSections")}>
        <TabsTrigger value="status">{t("paymentStatus")}</TabsTrigger>
        <TabsTrigger value="history">{t("history")}</TabsTrigger>
      </TabsList>

      <TabsContent value="status">{status}</TabsContent>
      <TabsContent value="history">{history}</TabsContent>
    </Tabs>
  );
}

/**
 * Payment history table. Extracted for render tests; the table scrolls inside
 * its panel so a long history never grows the page.
 */
export function PaymentHistory({ payments, rate }: { payments: Payment[]; rate?: number }) {
  const t = useT(paymentsCopy);
  const columns: ColumnDef<Payment>[] = [
    { accessorKey: "created_at", header: t("time"), cell: (c) => formatDate(c.getValue<string>()) },
    {
      accessorKey: "amount",
      header: t("amount"),
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
      header: t("provider"),
      cell: (c) => (
        <span className="font-mono text-xs">{formatProviderLabel(c.getValue<string>())}</span>
      ),
    },
    {
      accessorKey: "status",
      header: t("status"),
      cell: (c) => {
        const s = c.getValue<string>();
        return <Badge variant={STATUS_VARIANT[s] ?? "outline"}>{formatStatusLabel(s)}</Badge>;
      },
    },
    {
      accessorKey: "id",
      header: t("id"),
      cell: (c) => (
        <span className="flex items-center gap-1">
          <span className="font-mono text-xs">{c.getValue<string>().slice(0, 8)}…</span>
          <CopyButton value={c.getValue<string>()} label={t("copyPaymentId")} />
        </span>
      ),
    },
  ];

  return (
    <ScrollPanel label={t("paymentHistory")} stickyHeader>
      <DataTable columns={columns} data={payments} empty={t("noPaymentsRows")} />
    </ScrollPanel>
  );
}

function PaymentStatus({ workspaceId, paymentId }: { workspaceId: string; paymentId: string }) {
  const t = useT(paymentsCopy);
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
            <Badge variant={STATUS_VARIANT[p.status] ?? "outline"}>
              {formatStatusLabel(p.status)}
            </Badge>
            <span className="font-mono text-sm font-semibold">
              {formatUsdFromVnd(p.amount, rate) ?? formatVnd(p.amount)}
            </span>
            <span className="font-mono text-xs text-muted-foreground">{formatVnd(p.amount)}</span>
          </div>
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <span className="font-mono">{p.id}</span>
            <CopyButton value={p.id} label={t("copyPaymentId")} />
          </p>
          <p className="text-xs text-muted-foreground">
            {t("providerPrefix")}{" "}
            <span className="font-mono">{formatProviderLabel(p.provider)}</span> · {t("order")}{" "}
            <span className="font-mono">{p.provider_order_code}</span> · {formatDate(p.created_at)}
          </p>
          {p.status === "pending" && (
            <p className="text-xs text-muted-foreground">
              {p.provider === "payos" ? t("waitingPayos") : t("waitingAdmin")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
