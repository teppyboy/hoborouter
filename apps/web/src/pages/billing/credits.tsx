import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Wallet as WalletIcon } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "../../lib/api";
import { useCurrentWorkspaceId } from "../../lib/workspace-queries";
import { formatVnd, formatUsdFromVnd, formatDate } from "../../lib/format";
import { PageHeader, EmptyState, ErrorState, DataTable } from "../../components/page";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Skeleton } from "../../components/ui/skeleton";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../../components/ui/form";
import type { ColumnDef } from "@tanstack/react-table";

interface Wallet {
  currency: string;
  balance: number;
  reserved: number;
  available: number;
  usd_vnd_rate?: number;
}

interface LedgerEntry {
  id: string;
  created_at: number | string;
  direction: number | string;
  kind: string;
  amount: number;
  balance_after: number;
  memo: string | null;
  payment_id: string | null;
  request_id: string | null;
}

const schema = z.object({
  amount: z.coerce
    .number()
    .int("Must be a whole number of VND")
    .min(10_000, "Minimum top-up is 10.000 ₫"),
});
type Values = z.infer<typeof schema>;

const PRESETS = [50_000, 100_000, 200_000, 500_000];

export default function BillingCreditsPage() {
  const workspaceId = useCurrentWorkspaceId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const form = useForm<z.input<typeof schema>, unknown, Values>({
    resolver: zodResolver(schema),
    defaultValues: { amount: 100_000 },
  });

  const wallet = useQuery({
    queryKey: ["wallet", workspaceId],
    queryFn: () => api<Wallet>(`/api/v1/workspaces/${workspaceId}/wallet`),
    enabled: !!workspaceId,
  });

  // FX rate for USD display; undefined (older backend) -> VND fallback.
  const rate = wallet.data?.usd_vnd_rate;

  const ledger = useQuery({
    queryKey: ["ledger", workspaceId],
    queryFn: () =>
      api<{ data: LedgerEntry[] }>(`/api/v1/workspaces/${workspaceId}/ledger?limit=50`),
    enabled: !!workspaceId,
  });

  const amount = Number(form.watch("amount")) || 0;
  const usdEquiv = amount > 0 ? formatUsdFromVnd(amount, rate) : null;

  const topUp = useMutation({
    mutationFn: (values: Values) =>
      api<{ id: string; status: string; checkout_url: string }>(
        `/api/v1/workspaces/${workspaceId}/payments`,
        { method: "POST", body: JSON.stringify({ amount: values.amount }) },
      ),
    onSuccess: async (payment) => {
      toast("Payment created — waiting for admin confirmation");
      void queryClient.invalidateQueries({ queryKey: ["payments", workspaceId] });
      // Mock checkout_url is a webhook, not a page — show status view instead.
      void navigate({ href: `/billing/payments?payment=${payment.id}` });
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : "Top-up failed";
      form.setError("amount", { message });
    },
  });

  const columns: ColumnDef<LedgerEntry>[] = [
    { accessorKey: "created_at", header: "Time", cell: (c) => formatDate(c.getValue<string>()) },
    {
      accessorKey: "kind",
      header: "Kind",
      cell: (c) => <span className="font-mono text-xs">{c.getValue<string>()}</span>,
    },
    {
      accessorKey: "amount",
      header: "Amount",
      cell: (c) => {
        const v = c.getValue<number>();
        const usd = formatUsdFromVnd(v, rate);
        return (
          <span className="font-mono text-xs">
            {v < 0 ? `-${usd ?? formatVnd(-v)}` : (usd ?? formatVnd(v))}
            {usd != null && v !== 0 && (
              <span className="ml-1 text-muted-foreground">{formatVnd(v)}</span>
            )}
          </span>
        );
      },
    },
    {
      accessorKey: "balance_after",
      header: "Balance after",
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
      accessorKey: "request_id",
      header: "Request",
      cell: (c) => c.getValue<string | null>() ?? "—",
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Credits"
        description="Wallet balance, top-ups and the append-only credit ledger."
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          {wallet.isPending ? (
            <Skeleton className="h-24 w-full" />
          ) : wallet.isError ? (
            <ErrorState message={wallet.error.message} />
          ) : (
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label="Balance" value={wallet.data.balance} rate={rate} big />
              <StatCard label="Reserved" value={wallet.data.reserved} rate={rate} />
              <StatCard label="Available" value={wallet.data.available} rate={rate} />
            </div>
          )}

          <h2 className="text-sm font-semibold">Ledger</h2>
          {ledger.isPending ? (
            <Skeleton className="h-40 w-full" />
          ) : ledger.isError ? (
            <ErrorState message={ledger.error.message} />
          ) : ledger.data.data.length === 0 ? (
            <EmptyState
              icon={WalletIcon}
              title="No ledger entries yet"
              description="Not available yet — entries appear after the first top-up or usage."
            />
          ) : (
            <DataTable columns={columns} data={ledger.data.data} empty="No ledger entries" />
          )}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Top up</CardTitle>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit((v: Values) => topUp.mutateAsync(v))}
                className="space-y-4"
              >
                <FormField
                  control={form.control}
                  name="amount"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Amount (VND)</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={10_000}
                          step={1_000}
                          className="font-mono"
                          {...field}
                          value={field.value == null ? "" : Number(field.value)}
                        />
                      </FormControl>
                      <FormMessage />
                      <p className="font-mono text-xs text-muted-foreground">
                        {usdEquiv ? `≈ ${usdEquiv}` : ""}
                      </p>
                    </FormItem>
                  )}
                />
                <div className="flex flex-wrap gap-2">
                  {PRESETS.map((p) => (
                    <Button
                      key={p}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="font-mono"
                      onClick={() => form.setValue("amount", p, { shouldValidate: true })}
                    >
                      {formatVnd(p)}
                    </Button>
                  ))}
                </div>
                <Button type="submit" className="w-full" disabled={topUp.isPending}>
                  {topUp.isPending ? "Creating payment…" : "Create payment"}
                </Button>
                <p className="text-xs text-muted-foreground">
                  Payment completes when the provider confirms; status shows on the Payments page.
                </p>
              </form>
            </Form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  rate,
  big,
}: {
  label: string;
  value: number;
  rate: number | undefined;
  big?: boolean;
}) {
  const usd = formatUsdFromVnd(value, rate);
  return (
    <div className="rounded-lg border border-border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 font-mono font-semibold ${big ? "text-2xl" : "text-lg"}`}>
        {usd ?? formatVnd(value)}
      </p>
      {usd != null && <p className="text-xs text-muted-foreground">≈ {formatVnd(value)}</p>}
    </div>
  );
}
