import { useState, type FormEvent } from "react";
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
import { partitionLedger, signedLedgerAmount, formatLedgerSourceLabel } from "./ledger-display";
import type { LedgerSections } from "./ledger-display";
import { PageHeader, EmptyState, ErrorState, DataTable, ScrollPanel } from "../../components/page";
import RedeemPromo from "../../components/redeem-promo";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../components/ui/tabs";
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
  subscription?: SubscriptionInfo | null;
}

interface SubscriptionInfo {
  balance: number;
  available: number;
  period_end: number;
  plan_name: string;
  rate_limit_per_minute: number;
  expired: boolean;
}

export interface LedgerEntry {
  id: string;
  created_at: number | string;
  direction: "debit" | "credit";
  kind: string;
  amount: number;
  balance_after: number;
  memo: string | null;
  payment_id: string | null;
  request_id: string | null;
  /** Source wallet of the row (topup | subscription); older backends may omit it. */
  wallet_kind?: string;
}

const schema = z.object({
  amount: z.coerce
    .number()
    .int("Must be a whole number of VND")
    .min(10_000, "Minimum top-up is 10.000 ₫"),
});
type Values = z.infer<typeof schema>;

/** Display-safe payment limits from GET /api/v1/payment-config (hints only — the server enforces the real limits). */
export interface PaymentConfig {
  timeout_minutes: number;
  max_amount_vnd: number;
  usd_vnd_rate: number;
}

/** Union sent to POST payments; USD input stays a string end to end. */
type TopUpPayload = { currency: "VND"; amount: number } | { currency: "USD"; usdAmount: string };

// USD input validation without numeric parsing: plain digits, at most 2
// decimals, at least one nonzero digit. The exact cents→VND conversion happens
// only on the server (BigInt cents at the configured rate).
const USD_INPUT_RE = /^\d+(\.\d{1,2})?$/;
function validateUsdInput(text: string): string | null {
  const t = text.trim();
  if (t === "") return "Enter a USD amount";
  if (!USD_INPUT_RE.test(t)) return "USD amount must be a number with at most 2 decimals";
  if (!/[1-9]/.test(t)) return "USD amount must be greater than zero";
  return null;
}

export type LedgerColumns = ColumnDef<LedgerEntry>[];

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

  // Display-safe limits for cap/timeout hints and the approximate USD→VND
  // readback; a load failure just hides the hints (the server still enforces).
  const paymentConfig = useQuery({
    queryKey: ["payment-config"],
    queryFn: () => api<PaymentConfig>("/api/v1/payment-config"),
    staleTime: 60_000,
    retry: false,
  });

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
      accessorKey: "wallet_kind",
      header: "Source",
      // balance_after (and amount) belong to this row's source wallet, never
      // an aggregate across wallets — the column makes that explicit.
      cell: (c) => (
        <span className="font-mono text-xs">
          {formatLedgerSourceLabel(c.getValue<string | undefined>())}
        </span>
      ),
    },
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
          {wallet.data?.subscription ? (
            <SubscriptionCard subscription={wallet.data.subscription} rate={rate} />
          ) : null}
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
            <LedgerTabs columns={columns} sections={partitionLedger(ledger.data.data)} />
          )}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Top up</CardTitle>
          </CardHeader>
          <CardContent>
            {workspaceId ? (
              <>
                <TopUpForm
                  workspaceId={workspaceId}
                  payosAvailable={payosAvailable}
                  rate={rate}
                  paymentConfig={paymentConfig.data ?? null}
                  onNavigate={(href) => void navigate({ href })}
                />
                <RedeemPromo workspaceId={workspaceId} />
              </>
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
  paymentConfig,
  onNavigate,
}: {
  workspaceId: string;
  payosAvailable: boolean;
  rate: number | undefined;
  /** Display-safe payment limits (null while loading / on load error). */
  paymentConfig?: PaymentConfig | null;
  onNavigate: (href: string) => void;
}) {
  const queryClient = useQueryClient();
  const form = useForm<z.input<typeof schema>, unknown, Values>({
    resolver: zodResolver(schema),
    defaultValues: { amount: 100_000 },
  });

  const amount = Number(form.watch("amount")) || 0;
  const usdEquiv = amount > 0 ? formatUsdFromVnd(amount, rate) : null;

  // VND is the default and the behavior-preserving path; USD input is a raw
  // string sent as usd_amount — no client money conversion anywhere.
  const [currency, setCurrency] = useState<"VND" | "USD">("VND");
  const [usdText, setUsdText] = useState("");
  const [usdError, setUsdError] = useState<string | null>(null);
  const usdProblem = validateUsdInput(usdText);

  // Approximate VND readback for the USD input, using ONLY the configured
  // rate; display-only, never sent — the server computes the exact credit.
  const configRate = paymentConfig?.usd_vnd_rate;
  const usdApproxVnd =
    currency === "USD" && usdProblem === null && configRate !== undefined && configRate > 0
      ? Math.round(Number(usdText.trim()) * configRate)
      : null;

  // Manual stays the default; the choice collapses back to manual whenever
  // the backend stops advertising PayOS.
  const [providerChoice, setProviderChoice] = useState<"manual" | "payos">("manual");
  const provider = payosAvailable && providerChoice === "payos" ? "payos" : "manual";

  const topUp = useMutation({
    // provider is sent only for PayOS, so the manual bodies keep their
    // pre-existing shapes byte-identical: {amount} for VND, {usd_amount} for USD.
    mutationFn: (payload: TopUpPayload) =>
      api<{ id: string; status: string; checkout_url: string }>(
        `/api/v1/workspaces/${workspaceId}/payments`,
        {
          method: "POST",
          body: JSON.stringify(
            payload.currency === "USD"
              ? provider === "payos"
                ? { usd_amount: payload.usdAmount, provider }
                : { usd_amount: payload.usdAmount }
              : provider === "payos"
                ? { amount: payload.amount, provider }
                : { amount: payload.amount },
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
    onError: (err, payload) => {
      const message = err instanceof ApiError ? err.message : "Top-up failed";
      // Server errors stay visible next to whichever input produced them.
      if (payload.currency === "USD") setUsdError(message);
      else form.setError("amount", { message });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (currency === "USD") {
      const problem = validateUsdInput(usdText);
      if (problem !== null) {
        setUsdError(problem);
        return;
      }
      setUsdError(null);
      topUp.mutate({ currency: "USD", usdAmount: usdText.trim() });
      return;
    }
    void form.handleSubmit((v: Values) => topUp.mutate({ currency: "VND", amount: v.amount }))(e);
  };

  return (
    <Form {...form}>
      <form onSubmit={submit} className="space-y-4">
        <div className="flex gap-1" role="group" aria-label="Top-up currency">
          {(["VND", "USD"] as const).map((c) => (
            <Button
              key={c}
              type="button"
              size="sm"
              variant={currency === c ? "default" : "outline"}
              onClick={() => {
                setCurrency(c);
                setUsdError(null);
              }}
            >
              {c}
            </Button>
          ))}
        </div>
        {currency === "VND" ? (
          <>
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
          </>
        ) : (
          <>
            <FormItem>
              <FormLabel htmlFor="topup_usd_amount">Amount (USD)</FormLabel>
              <FormControl>
                <Input
                  id="topup_usd_amount"
                  value={usdText}
                  onChange={(e) => {
                    setUsdText(e.target.value);
                    setUsdError(null);
                  }}
                  inputMode="decimal"
                  placeholder="5.00"
                  aria-invalid={usdError !== null || (usdText.trim() !== "" && usdProblem !== null)}
                  className={
                    usdError !== null || (usdText.trim() !== "" && usdProblem !== null)
                      ? "border-destructive"
                      : undefined
                  }
                />
              </FormControl>
              <FormMessage>{usdError ?? undefined}</FormMessage>
              <p className="font-mono text-xs text-muted-foreground">
                {usdApproxVnd !== null
                  ? `≈ ${formatVnd(usdApproxVnd)} (approximate — the server calculates the exact credit)`
                  : ""}
              </p>
            </FormItem>
          </>
        )}
        {paymentConfig && (
          <p className="text-xs text-muted-foreground">
            Max top-up {formatVnd(paymentConfig.max_amount_vnd)} · pending payments expire after{" "}
            {paymentConfig.timeout_minutes} minutes.
          </p>
        )}
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

/**
 * Subscription credit card. Extracted for render tests; display-only.
 */
export function SubscriptionCard({
  subscription,
  rate,
}: {
  subscription: SubscriptionInfo;
  rate: number | undefined;
}) {
  const usd = formatUsdFromVnd(subscription.balance, rate);
  return (
    <div className="min-w-0 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold">Subscription credit</p>
        <p className="text-xs text-muted-foreground">{subscription.plan_name}</p>
      </div>
      <p
        className={`mt-1 font-mono text-2xl font-semibold ${subscription.expired ? "text-muted-foreground" : ""}`}
      >
        {usd ?? formatVnd(subscription.balance)}
      </p>
      <p className="mt-1 text-sm">
        Period ends <span className="font-mono">{formatDate(subscription.period_end)}</span>
        {subscription.expired ? " (expired)" : ""}
      </p>
      <p className="text-sm text-muted-foreground">
        {subscription.rate_limit_per_minute} requests per minute
      </p>
      <p className="mt-2 text-xs text-muted-foreground">
        Unused subscription credit is lost when the period ends without a renewal.
      </p>
    </div>
  );
}

/**
 * Tabbed ledger: Usage deductions / Top-up history / Adjustments & refunds.
 * Only the active tab's rows render, so the page height stays bounded while
 * each tab's table scrolls inside its own panel.
 */
export function LedgerTabs({
  sections,
  columns,
}: {
  sections: LedgerSections<LedgerEntry>;
  columns: LedgerColumns;
}) {
  const tabs = [
    {
      id: "usage",
      title: "Usage deductions",
      entries: sections.usage,
      empty: "No usage yet — deductions appear after the first request.",
    },
    {
      id: "topups",
      title: "Top-up history",
      entries: sections.topups,
      empty: "No top-ups yet.",
    },
    {
      id: "adjustments",
      title: "Adjustments & refunds",
      entries: sections.adjustments,
      empty: "No adjustments or refunds.",
    },
  ];
  return (
    <Tabs defaultValue="usage" className="min-w-0">
      <TabsList aria-label="Ledger sections" className="h-auto max-w-full flex-wrap">
        {tabs.map((t) => (
          <TabsTrigger key={t.id} value={t.id}>
            {t.title} ({t.entries.length})
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((t) => (
        <TabsContent key={t.id} value={t.id}>
          <ScrollPanel label={t.title} stickyHeader>
            {t.entries.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">{t.empty}</p>
            ) : (
              <DataTable columns={columns} data={t.entries} empty={t.empty} />
            )}
          </ScrollPanel>
        </TabsContent>
      ))}
    </Tabs>
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
