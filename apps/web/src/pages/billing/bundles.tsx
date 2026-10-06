import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Package as PackageIcon, RefreshCw as RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "../../lib/api";
import { useCurrentWorkspaceId } from "../../lib/workspace-queries";
import {
  formatVnd,
  formatUsdFromVnd,
  formatUsdAmountText,
  formatDate,
  useUsdVndRate,
} from "../../lib/format";
import { PageHeader, EmptyState, ErrorState } from "../../components/page";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Skeleton } from "../../components/ui/skeleton";

interface Bundle {
  id: string;
  name: string;
  price_vnd: number;
  credit_vnd: number;
  bonus_vnd: number;
  /** Authored exact USD price text; null on legacy VND rows. */
  price_usd?: string | null;
  credit_usd?: string | null;
  bonus_usd?: string | null;
}

interface Plan {
  id: string;
  name: string;
  price_vnd: number;
  credit_per_period_vnd: number;
  period_days: number;
  rate_limit_per_minute?: number;
  /** Authored exact USD price text; null on legacy VND rows. */
  price_usd?: string | null;
  credit_per_period_usd?: string | null;
}

export interface SubscriptionInfo {
  balance: number;
  available: number;
  period_end: number;
  plan_name: string;
  rate_limit_per_minute: number;
  expired: boolean;
  /** Cancel marker (decision b): informational, credit stays till period_end. */
  canceled?: boolean;
}

/**
 * Display currency for the billing sections. USD is canonical when the
 * backend FX rate is known; VND is the fallback (older backend) and the
 * ledger truth. Conversion is DISPLAY-ONLY: purchases always charge the
 * server-side VND price and no converted amount is ever sent back.
 */
export type DisplayCurrency = "USD" | "VND";

const hasRate = (rate: number | undefined): boolean =>
  typeof rate === "number" && Number.isFinite(rate) && rate > 0;

const USD_TEXT = /^\d+(\.\d{1,2})?$/;
const isUsdText = (t: string | null | undefined): t is string =>
  typeof t === "string" && USD_TEXT.test(t);

/**
 * Canonical display FX for the billing pages: the catalog envelope rate
 * (present on member catalog GETs without any wallet round-trip) wins; the
 * wallet rate is only the fallback for older backends.
 */
export function catalogEnvelopeRate(
  bundles?: { usd_vnd_rate?: number } | null,
  plans?: { usd_vnd_rate?: number } | null,
  walletRate?: number,
): number | undefined {
  const envelope = bundles?.usd_vnd_rate ?? plans?.usd_vnd_rate;
  if (hasRate(envelope)) return envelope;
  return hasRate(walletRate) ? walletRate : undefined;
}

/**
 * Seamless USD⇄VND toggle. Renders nothing without a backend rate: VND-only
 * display is the behavior-preserving fallback.
 */
export function CurrencyToggle({
  currency,
  rate,
  onChange,
  usdAvailable = false,
}: {
  currency: DisplayCurrency;
  rate: number | undefined;
  onChange: (c: DisplayCurrency) => void;
  /** Authored-USD rows show exact USD text without any FX rate. */
  usdAvailable?: boolean;
}) {
  if (!hasRate(rate) && !usdAvailable) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => onChange(currency === "USD" ? "VND" : "USD")}
    >
      {currency === "USD" ? "Show VND" : "Show USD"}
    </Button>
  );
}

/**
 * One money amount in the selected display currency. The primary line is the
 * selected currency; the other currency renders as a small secondary line so
 * the exact integer-VND ledger amount stays visible in USD mode too.
 */
export function Amount({
  vnd,
  currency,
  rate,
  testId,
  className = "",
}: {
  vnd: number;
  currency: DisplayCurrency;
  rate: number | undefined;
  testId?: string;
  className?: string;
}) {
  const usd = formatUsdFromVnd(vnd, rate);
  const showUsd = currency === "USD" && usd !== null;
  const primary = showUsd ? usd! : formatVnd(vnd);
  const secondary = hasRate(rate) ? (showUsd ? formatVnd(vnd) : usd) : null;
  return (
    <div className="min-w-0">
      <p data-testid={testId} className={className}>
        {primary}
      </p>
      {secondary !== null && <p className="text-xs text-muted-foreground">= {secondary}</p>}
    </div>
  );
}

/**
 * One card price in the selected display currency. Authored-USD rows lead
 * with the exact `price_usd` text (no FX needed) and pair it with the
 * server's current `price_vnd` quote, labeled as an estimate because the
 * checkout owns a transaction-time FX snapshot. Legacy VND rows keep the
 * wallet-rate conversion display.
 */
export function CardPrice({
  priceVnd,
  priceUsd,
  currency,
  rate,
  testId,
  className = "",
}: {
  priceVnd: number;
  priceUsd?: string | null;
  currency: DisplayCurrency;
  rate: number | undefined;
  testId?: string;
  className?: string;
}) {
  if (isUsdText(priceUsd)) {
    const usd = formatUsdAmountText(priceUsd);
    return (
      <div className="min-w-0">
        <p data-testid={testId} className={className}>
          {currency === "USD" ? usd : formatVnd(priceVnd)}
        </p>
        <p className="text-xs text-muted-foreground">
          = {currency === "USD" ? formatVnd(priceVnd) : usd}
        </p>
        <p className="text-xs text-muted-foreground">
          VND estimate; the final amount is fixed when the payment is created.
        </p>
      </div>
    );
  }
  return (
    <Amount vnd={priceVnd} currency={currency} rate={rate} testId={testId} className={className} />
  );
}

export default function BillingBundlesPage() {
  const workspaceId = useCurrentWorkspaceId();
  const navigate = useNavigate();

  const bundles = useQuery({
    queryKey: ["bundles"],
    queryFn: () => api<{ data: Bundle[]; usd_vnd_rate?: number }>("/api/v1/bundles"),
  });

  const plans = useQuery({
    queryKey: ["subscription-plans"],
    queryFn: () => api<{ data: Plan[]; usd_vnd_rate?: number }>("/api/v1/subscription-plans"),
  });

  // Renew vs Subscribe label: an active, unexpired subscription renews;
  // anything else starts a new subscription.
  const wallet = useQuery({
    queryKey: ["wallet", workspaceId],
    queryFn: () =>
      api<{ subscription?: SubscriptionInfo | null }>(`/api/v1/workspaces/${workspaceId}/wallet`),
    enabled: !!workspaceId,
  });
  const subscribed = !!wallet.data?.subscription && !wallet.data.subscription.expired;

  // Same provider-availability pattern as the Credits top-up: the backend
  // gates PayOS on its credentials; manual is the default and the fallback.
  const methods = useQuery({
    queryKey: ["payment-methods"],
    queryFn: () => api<{ manual: boolean; payos: boolean }>("/api/v1/payment-methods"),
    staleTime: 60_000,
    retry: false,
  });
  const payosAvailable = methods.data?.payos === true;

  // FX rate for the USD-canonical display: the catalog envelope rate wins
  // (no wallet round-trip needed); the wallet rate is the older-backend
  // fallback. USD-authored rows display exact USD text even without either.
  const walletRate = useUsdVndRate(workspaceId).data;
  const rate = catalogEnvelopeRate(bundles.data, plans.data, walletRate);

  return (
    <div className="space-y-6">
      <section aria-label="Credit bundles" className="space-y-4">
        <PageHeader
          title="Credit bundles"
          description="Buy credit in fixed bundles; credit lands in the wallet once the payment settles."
        />

        {bundles.isPending ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <Skeleton className="h-44 w-full" />
            <Skeleton className="h-44 w-full" />
            <Skeleton className="h-44 w-full" />
          </div>
        ) : bundles.isError ? (
          <ErrorState message={bundles.error.message} />
        ) : bundles.data.data.length === 0 ? (
          <EmptyState
            icon={PackageIcon}
            title="No bundles available"
            description="No credit bundles are on sale right now — check back later."
          />
        ) : (
          <BundleCards
            bundles={bundles.data.data}
            workspaceId={workspaceId ?? undefined}
            payosAvailable={payosAvailable}
            rate={rate}
            onNavigate={(href) => void navigate({ href })}
          />
        )}
      </section>

      <section aria-label="Subscription plans" className="space-y-4">
        <PageHeader
          title="Subscription plans"
          description="A plan credits the subscription balance each period; the gateway spends it first while the period is active."
        />
        {wallet.data?.subscription && workspaceId ? (
          <SubscriptionStatusCard
            subscription={wallet.data.subscription}
            workspaceId={workspaceId}
            rate={rate}
          />
        ) : null}
        {plans.isPending ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <Skeleton className="h-44 w-full" />
            <Skeleton className="h-44 w-full" />
          </div>
        ) : plans.isError ? (
          <ErrorState message={plans.error.message} />
        ) : plans.data.data.length === 0 ? (
          <EmptyState
            icon={RefreshCwIcon}
            title="No plans available"
            description="No subscription plans are on sale right now — check back later."
          />
        ) : (
          <PlanCards
            plans={plans.data.data}
            workspaceId={workspaceId ?? undefined}
            payosAvailable={payosAvailable}
            subscribed={subscribed}
            rate={rate}
            onNavigate={(href) => void navigate({ href })}
          />
        )}
      </section>
    </div>
  );
}

/**
 * Bundle cards + shared provider choice. Extracted for render tests; the
 * purchase goes through the mutation, so static rendering fires nothing.
 */
export function BundleCards({
  bundles,
  workspaceId,
  payosAvailable,
  rate,
  onNavigate,
}: {
  bundles: Bundle[];
  workspaceId: string | undefined;
  payosAvailable: boolean;
  /** Backend FX rate; undefined (older backend) keeps VND-only display. */
  rate?: number;
  onNavigate: (href: string) => void;
}) {
  const queryClient = useQueryClient();

  // USD is the canonical display currency; without a rate the section stays
  // VND-only (behavior-preserving fallback).
  const [currency, setCurrency] = useState<DisplayCurrency>("USD");

  // One provider choice shared by all cards, identical semantics to the
  // top-up form: manual default, collapses back to manual when the backend
  // stops advertising PayOS.
  const [providerChoice, setProviderChoice] = useState<"manual" | "payos">("manual");
  const provider = payosAvailable && providerChoice === "payos" ? "payos" : "manual";

  const buy = useMutation({
    // Body is empty for manual so the request matches the plain manual
    // purchase shape; provider is sent only for PayOS.
    mutationFn: (bundleId: string) =>
      api<{ id: string; status: string; checkout_url: string }>(
        `/api/v1/workspaces/${workspaceId}/bundles/${bundleId}/purchase`,
        {
          method: "POST",
          body: JSON.stringify(provider === "payos" ? { provider } : {}),
        },
      ),
    onSuccess: async (payment) => {
      void queryClient.invalidateQueries({ queryKey: ["payments", workspaceId] });
      // Same redirect rule as the top-up: an absolute checkout URL must be a
      // full browser navigation; a relative path (manual) stays in-app.
      // Status is never read from query parameters.
      if (!payment.checkout_url.startsWith("/")) {
        toast("Redirecting to PayOS checkout…");
        window.location.assign(payment.checkout_url);
        return;
      }
      toast("Payment created — waiting for admin confirmation");
      onNavigate(`/billing/payments?payment=${payment.id}`);
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Purchase failed");
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {payosAvailable && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Payment method</legend>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="bundle-payment-provider"
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
                name="bundle-payment-provider"
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
        <CurrencyToggle
          currency={currency}
          rate={rate}
          onChange={setCurrency}
          usdAvailable={bundles.some((b) => isUsdText(b.price_usd))}
        />
      </div>

      {/* min-w-0 on cards: nothing may force the page wider than 375px. */}
      <div className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {bundles.map((bundle) => (
          <Card key={bundle.id} className="flex min-w-0 flex-col">
            <CardHeader>
              <CardTitle className="text-base">{bundle.name}</CardTitle>
            </CardHeader>
            <CardContent className="flex min-w-0 flex-1 flex-col gap-3">
              <div>
                <p className="text-xs text-muted-foreground">Price</p>
                <CardPrice
                  priceVnd={bundle.price_vnd}
                  priceUsd={bundle.price_usd}
                  currency={currency}
                  rate={rate}
                  testId={`price-${bundle.id}`}
                  className="font-mono text-xl font-semibold"
                />
              </div>
              <div className="text-sm">
                <p className="font-mono">
                  {currency === "USD" && hasRate(rate)
                    ? `${formatUsdFromVnd(bundle.credit_vnd, rate)} credit`
                    : `${formatVnd(bundle.credit_vnd)} credit`}
                </p>
                {bundle.bonus_vnd > 0 && (
                  <p className="font-mono text-xs text-emerald-600 dark:text-emerald-400">
                    {currency === "USD" && hasRate(rate)
                      ? `+${formatUsdFromVnd(bundle.bonus_vnd, rate)} bonus`
                      : `+ ${formatVnd(bundle.bonus_vnd)} bonus`}
                  </p>
                )}
                {isUsdText(bundle.price_usd) && (
                  <p className="text-xs text-muted-foreground">
                    Credit is a fixed VND amount set at creation; USD shows the current-rate
                    equivalent.
                  </p>
                )}
              </div>
              <Button
                className="mt-auto w-full"
                disabled={!workspaceId || buy.isPending}
                onClick={() => buy.mutate(bundle.id)}
              >
                {buy.isPending ? "Creating payment…" : "Buy"}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        Payment completes when the provider confirms; status shows on the Payments page.
      </p>
    </div>
  );
}

/**
 * Subscription plan cards + shared provider choice, mirroring BundleCards.
 * Extracted for render tests; static rendering fires nothing. The button
 * label is Subscribe normally and Renew while the workspace has an active,
 * unexpired subscription (a settled plan payment renews the period).
 */
export function PlanCards({
  plans,
  workspaceId,
  payosAvailable,
  subscribed,
  rate,
  onNavigate,
}: {
  plans: Plan[];
  workspaceId: string | undefined;
  payosAvailable: boolean;
  subscribed: boolean;
  /** Backend FX rate; undefined (older backend) keeps VND-only display. */
  rate?: number;
  onNavigate: (href: string) => void;
}) {
  const queryClient = useQueryClient();

  // USD canonical display, same rules as BundleCards.
  const [currency, setCurrency] = useState<DisplayCurrency>("USD");

  const [providerChoice, setProviderChoice] = useState<"manual" | "payos">("manual");
  const provider = payosAvailable && providerChoice === "payos" ? "payos" : "manual";

  const buy = useMutation({
    mutationFn: (planId: string) =>
      api<{ id: string; status: string; checkout_url: string }>(
        `/api/v1/workspaces/${workspaceId}/subscription-plans/${planId}/purchase`,
        {
          method: "POST",
          body: JSON.stringify(provider === "payos" ? { provider } : {}),
        },
      ),
    onSuccess: async (payment) => {
      void queryClient.invalidateQueries({ queryKey: ["payments", workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ["wallet", workspaceId] });
      // Same redirect rule as the bundle purchase: absolute URL = provider
      // checkout, relative path (manual) stays in-app.
      if (!payment.checkout_url.startsWith("/")) {
        toast("Redirecting to PayOS checkout…");
        window.location.assign(payment.checkout_url);
        return;
      }
      toast("Payment created — waiting for admin confirmation");
      onNavigate(`/billing/payments?payment=${payment.id}`);
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Purchase failed");
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {payosAvailable && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Payment method</legend>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="plan-payment-provider"
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
                name="plan-payment-provider"
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
        <CurrencyToggle
          currency={currency}
          rate={rate}
          onChange={setCurrency}
          usdAvailable={plans.some((p) => isUsdText(p.price_usd))}
        />
      </div>

      {/* min-w-0 on cards: nothing may force the page wider than 375px. */}
      <div className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {plans.map((plan) => (
          <Card key={plan.id} className="flex min-w-0 flex-col">
            <CardHeader>
              <CardTitle className="text-base">{plan.name}</CardTitle>
            </CardHeader>
            <CardContent className="flex min-w-0 flex-1 flex-col gap-3">
              <div>
                <p className="text-xs text-muted-foreground">Price</p>
                <CardPrice
                  priceVnd={plan.price_vnd}
                  priceUsd={plan.price_usd}
                  currency={currency}
                  rate={rate}
                  testId={`price-${plan.id}`}
                  className="font-mono text-xl font-semibold"
                />
              </div>
              <div className="text-sm">
                <p className="font-mono">
                  {currency === "USD" && hasRate(rate)
                    ? `${formatUsdFromVnd(plan.credit_per_period_vnd, rate)} credit / ${plan.period_days} days`
                    : `${formatVnd(plan.credit_per_period_vnd)} credit / ${plan.period_days} days`}
                </p>
                {!!plan.rate_limit_per_minute && (
                  <p className="text-xs text-muted-foreground">
                    Up to {plan.rate_limit_per_minute} requests per minute on subscription credit
                  </p>
                )}
                {isUsdText(plan.price_usd) && (
                  <p className="text-xs text-muted-foreground">
                    Credit is a fixed VND amount set at creation; USD shows the current-rate
                    equivalent.
                  </p>
                )}
              </div>
              <Button
                className="mt-auto w-full"
                disabled={!workspaceId || buy.isPending}
                onClick={() => buy.mutate(plan.id)}
              >
                {buy.isPending ? "Creating payment…" : subscribed ? "Renew" : "Subscribe"}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        Payment completes when the provider confirms; status shows on the Payments page.
      </p>
    </div>
  );
}

/**
 * Active-subscription status for the Subscriptions section (decision b): the
 * cancel button stops renewal only — no refund, no forfeit; credit stays
 * usable until period_end and the existing lazy expiry applies afterwards.
 * Static rendering fires nothing; cancel goes through the mutation.
 */
export function SubscriptionStatusCard({
  subscription,
  workspaceId,
  rate,
}: {
  subscription: SubscriptionInfo;
  workspaceId: string;
  rate: number | undefined;
}) {
  const queryClient = useQueryClient();
  const [currency, setCurrency] = useState<DisplayCurrency>("USD");

  const cancel = useMutation({
    mutationFn: () =>
      api<{ id: string; status: string; period_end: number }>(
        `/api/v1/workspaces/${workspaceId}/subscription`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["wallet", workspaceId] });
      toast("Subscription canceled — credit stays usable until the period ends");
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Cancel failed");
    },
  });

  const usd = formatUsdFromVnd(subscription.balance, rate);
  return (
    <div className="min-w-0 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold">Your subscription</p>
        <p className="text-xs text-muted-foreground">{subscription.plan_name}</p>
      </div>
      <Amount
        vnd={subscription.balance}
        currency={currency}
        rate={rate}
        testId="subscription-balance"
        className={`mt-1 font-mono text-2xl font-semibold ${subscription.expired ? "text-muted-foreground" : ""}`}
      />
      <p className="mt-1 text-sm">
        Period ends <span className="font-mono">{formatDate(subscription.period_end)}</span>
        {subscription.expired ? " (expired)" : ""}
        {subscription.canceled && !subscription.expired ? " (canceled — will not renew)" : ""}
      </p>
      <p className="text-sm text-muted-foreground">
        {subscription.rate_limit_per_minute} requests per minute
      </p>
      {!subscription.expired && (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Button
            variant="destructive"
            size="sm"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            {cancel.isPending ? "Canceling…" : "Cancel subscription"}
          </Button>
          <CurrencyToggle currency={currency} rate={rate} onChange={setCurrency} />
        </div>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        Canceling stops renewal only (will not renew): credit stays usable until the period ends,
        then unused credit is forfeited. {usd !== null ? "Shown in USD from the VND ledger." : ""}
      </p>
    </div>
  );
}
