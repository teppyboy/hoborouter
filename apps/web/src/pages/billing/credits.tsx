import { useState } from "react";
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
import { formatLedgerKindLabel, formatLedgerMemoLabel } from "../../lib/display";
import { partitionLedger, signedLedgerAmount } from "./ledger-display";
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
  direction: "debit" | "credit";
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

  // Provider availability comes from the backend, which gates PayOS on its
  // credentials; the endpoint exposes booleans only. Manual is the default and
  // the fallback: any load failure here just hides the choice.
  const methods = useQuery({
    queryKey: ["payment-methods"],
    queryFn: () => api<{ manual: boolean; payos: boolean }>("/api/v1/payment-methods"),
    staleTime: 60_000,
    retry: false,
  });
  const payosAvailable = methods.data?.payos === true;

  // Canonical ledger rows carry a positive amount; the sign comes from
  // `direction` and is applied exactly once via signedLedgerAmount.
  const columns: ColumnDef<LedgerEntry>[] = [
    { accessorKey: "created_at", header: "Time", cell: (c) => formatDate(c.getValue<string>()) },
    {
      accessorKey: "kind",
      header: "Kind",
      cell: (c) => {
        // Adjustment memos name the bonus source (bundle bonus, first topup
        // bonus); show the human label next to the kind so the rows are
        // self-explanatory.
        const kind = c.getValue<string>();
        const memo =
          c.row.original.kind === "adjustment" && c.row.original.memo
            ? formatLedgerMemoLabel(c.row.original.memo)
            : null;
        return (
          <span className="font-mono text-xs">
            {memo ? `${formatLedgerKindLabel(kind)} — ${memo}` : formatLedgerKindLabel(kind)}
          </span>
        );
      },
    },
    {
      accessorKey: "amount",
      header: "Amount",
      cell: (c) => {
        const signed = signedLedgerAmount(c.row.original);
        // Both formatters render the sign themselves (formatUsdFromVnd keeps
        // '-', formatVnd keeps '-' via Intl); never re-add it manually.
        const usd = formatUsdFromVnd(signed, rate);
        return (
          <span className="font-mono text-xs">
            {usd ?? formatVnd(signed)}
            {usd != null && signed !== 0 && (
              <span className="ml-1 text-muted-foreground">{formatVnd(signed)}</span>
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
      cell: (c) => {
        const requestId = c.getValue<string | null>();
        if (requestId == null) return "—";
        return (
          <span className="font-mono text-xs" title={requestId}>
            {requestId}
          </span>
        );
      },
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
            (() => {
              const sections = partitionLedger(ledger.data.data);
              return (
                <>
                  <LedgerSection
                    title="Usage deductions"
                    entries={sections.usage}
                    columns={columns}
                    empty="No usage yet — deductions appear after the first request."
                  />
                  <LedgerSection
                    title="Top-up history"
                    entries={sections.topups}
                    columns={columns}
                    empty="No top-ups yet."
                  />
                  <LedgerSection
                    title="Adjustments & refunds"
                    entries={sections.adjustments}
                    columns={columns}
                    empty="No adjustments or refunds."
                  />
                </>
              );
            })()
          )}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Top up</CardTitle>
          </CardHeader>
          <CardContent>
            {workspaceId ? (
              <TopUpForm
                workspaceId={workspaceId}
                payosAvailable={payosAvailable}
                rate={rate}
                onNavigate={(href) => void navigate({ href })}
              />
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/**
 * Top-up form. Extracted for render tests; all API access goes through the
 * mutation, so static rendering fires nothing.
 */
export function TopUpForm({
  workspaceId,
  payosAvailable,
  rate,
  onNavigate,
}: {
  workspaceId: string;
  payosAvailable: boolean;
  rate: number | undefined;
  onNavigate: (href: string) => void;
}) {
  const queryClient = useQueryClient();
  const form = useForm<z.input<typeof schema>, unknown, Values>({
    resolver: zodResolver(schema),
    defaultValues: { amount: 100_000 },
  });

  const amount = Number(form.watch("amount")) || 0;
  const usdEquiv = amount > 0 ? formatUsdFromVnd(amount, rate) : null;

  // Manual stays the default; the choice collapses back to manual whenever
  // the backend stops advertising PayOS.
  const [providerChoice, setProviderChoice] = useState<"manual" | "payos">("manual");
  const provider = payosAvailable && providerChoice === "payos" ? "payos" : "manual";

  const topUp = useMutation({
    // provider is sent only for PayOS, so the manual request body is byte
    // identical to the pre-PayOS shape.
    mutationFn: (values: Values) =>
      api<{ id: string; status: string; checkout_url: string }>(
        `/api/v1/workspaces/${workspaceId}/payments`,
        {
          method: "POST",
          body: JSON.stringify(
            provider === "payos" ? { amount: values.amount, provider } : { amount: values.amount },
          ),
        },
      ),
    onSuccess: async (payment) => {
      void queryClient.invalidateQueries({ queryKey: ["payments", workspaceId] });
      // PayOS hands back an absolute provider checkout URL: the only correct
      // action is a full browser redirect — no fake success, status is later
      // shown by the Payments page polling the backend. A relative path (the
      // manual response) stays an in-app navigation. Status is never read
      // from query parameters.
      if (!payment.checkout_url.startsWith("/")) {
        toast("Redirecting to PayOS checkout…");
        window.location.assign(payment.checkout_url);
        return;
      }
      toast("Payment created — waiting for admin confirmation");
      onNavigate(`/billing/payments?payment=${payment.id}`);
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : "Top-up failed";
      form.setError("amount", { message });
    },
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit((v: Values) => topUp.mutateAsync(v))} className="space-y-4">
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
        {payosAvailable && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Payment method</legend>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="payment-provider"
                value="manual"
                checked={provider === "manual"}
                onChange={() => setProviderChoice("manual")}
                className="mt-1"
              />
              <span>
                Manual transfer
                <span className="block text-xs text-muted-foreground">
                  Create a pending payment; an admin confirms it out-of-band.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="payment-provider"
                value="payos"
                checked={provider === "payos"}
                onChange={() => setProviderChoice("payos")}
                className="mt-1"
              />
              <span>
                PayOS
                <span className="block text-xs text-muted-foreground">
                  Pay by bank app or QR at PayOS; you will be redirected there and the payment
                  status here updates from the server.
                </span>
              </span>
            </label>
          </fieldset>
        )}
        <Button type="submit" className="w-full" disabled={topUp.isPending}>
          {topUp.isPending
            ? "Creating payment…"
            : provider === "payos"
              ? "Continue to PayOS"
              : "Create payment"}
        </Button>
        <p className="text-xs text-muted-foreground">
          Payment completes when the provider confirms; status shows on the Payments page.
        </p>
      </form>
    </Form>
  );
}

function LedgerSection({
  title,
  entries,
  columns,
  empty,
}: {
  title: string;
  entries: LedgerEntry[];
  columns: ColumnDef<LedgerEntry>[];
  empty: string;
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium text-muted-foreground">
        {title} ({entries.length})
      </h3>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <DataTable columns={columns} data={entries} empty={empty} />
      )}
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
