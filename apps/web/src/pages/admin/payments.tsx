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
import { useT } from "../../lib/i18n/t";

// Admin payments copy: inline LocaleEntry set (see lib/i18n/common.ts).
const adminPaymentsCopy = {
  title: { en: "Payments", vi: "Thanh toán" },
  paymentsTable: { en: "Payments list", vi: "Danh sách thanh toán" },
  description: {
    en: "Top-up payments across workspaces.",
    vi: "Thanh toán nạp tín dụng trên mọi workspace.",
  },
  copyPaymentId: { en: "Copy payment ID", vi: "Copy mã thanh toán" },
  markPaid: { en: "Mark paid", vi: "Đánh dấu đã trả" },
  reject: { en: "Reject", vi: "Từ chối" },
  noPayments: { en: "No payments", vi: "Không có thanh toán" },
  confirmPaidTitle: { en: "Mark payment as paid?", vi: "Đánh dấu thanh toán là đã trả?" },
  confirmPaidBody: {
    en: "{amount} for workspace “{ws}”. This credits the workspace wallet and cannot be undone.",
    vi: "{amount} cho workspace “{ws}”. Thao tác này cộng vào ví workspace và không thể hoàn tác.",
  },
  cancel: { en: "Cancel", vi: "Huỷ" },
  confirming: { en: "Confirming…", vi: "Đang xác nhận…" },
  confirm: { en: "Confirm", vi: "Xác nhận" },
  rejectTitle: { en: "Reject payment?", vi: "Từ chối thanh toán?" },
  rejectBody: {
    en: "{amount} for workspace “{ws}”. The payment is marked rejected and no balance will be credited. This cannot be undone.",
    vi: "{amount} cho workspace “{ws}”. Thanh toán sẽ bị đánh dấu là từ chối và không cộng số dư. Không thể hoàn tác.",
  },
  rejecting: { en: "Rejecting…", vi: "Đang từ chối…" },
  paymentMarkedPaid: { en: "Payment marked paid", vi: "Đã đánh dấu thanh toán là đã trả" },
  completeFailed: { en: "Failed to complete payment", vi: "Xác nhận thanh toán thất bại" },
  paymentRejected: { en: "Payment rejected", vi: "Đã từ chối thanh toán" },
} as const;

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
  const t = useT(adminPaymentsCopy);
  const query = useAdminQuery<{ data: AdminPayment[] }>(
    ["admin", "payments"],
    "/api/v1/admin/payments",
  );
  return (
    <div className="space-y-4">
      <PageHeader title={t("title")} description={t("description")} />
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
  const t = useT(adminPaymentsCopy);
  const [fallbackSearch, setFallbackSearch] = useState("");
  const value = onSearchChange ? (search ?? "") : fallbackSearch;
  const setSearch = onSearchChange ?? setFallbackSearch;
  const queryClient = useQueryClient();
  const [toComplete, setToComplete] = useState<AdminPayment | null>(null);
  const [toReject, setToReject] = useState<AdminPayment | null>(null);

  const complete = useMutation({
    mutationFn: (id: string) => api(`/api/v1/admin/payments/${id}/complete`, { method: "POST" }),
    onSuccess: () => {
      toast(t("paymentMarkedPaid"));
      void queryClient.invalidateQueries({ queryKey: ["admin", "payments"] });
      setToComplete(null);
    },
    onError: (err) => toast(err instanceof ApiError ? err.message : t("completeFailed")),
  });

  const reject = useMutation({
    mutationFn: (id: string) => api(`/api/v1/admin/payments/${id}/reject`, { method: "POST" }),
    onSuccess: () => {
      toast(t("paymentRejected"));
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
          <CopyButton value={c.getValue() as string} label={t("copyPaymentId")} />
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
              {t("markPaid")}
            </Button>
            <Button size="sm" variant="destructive" onClick={() => setToReject(p)}>
              {t("reject")}
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
        empty={t("noPayments")}
        scroll={{ label: t("paymentsTable") }}
      />
      <Dialog open={toComplete !== null} onOpenChange={(open) => !open && setToComplete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("confirmPaidTitle")}</DialogTitle>
            <DialogDescription>
              {toComplete && (
                <>
                  {t("confirmPaidBody", {
                    amount: formatVnd(toComplete.amount),
                    ws: toComplete.workspace_name,
                  })}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToComplete(null)}>
              {t("cancel")}
            </Button>
            <Button
              disabled={complete.isPending}
              onClick={() => toComplete && complete.mutate(toComplete.id)}
            >
              {complete.isPending ? t("confirming") : t("confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={toReject !== null} onOpenChange={(open) => !open && setToReject(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("rejectTitle")}</DialogTitle>
            <DialogDescription>
              {toReject && (
                <>
                  {t("rejectBody", {
                    amount: formatVnd(toReject.amount),
                    ws: toReject.workspace_name,
                  })}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToReject(null)}>
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={reject.isPending}
              onClick={() => toReject && reject.mutate(toReject.id)}
            >
              {reject.isPending ? t("rejecting") : t("reject")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
