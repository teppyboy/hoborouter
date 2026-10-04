import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Package as PackageIcon, RefreshCw as RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "../../lib/api";
import { useCurrentWorkspaceId } from "../../lib/workspace-queries";
import { formatVnd } from "../../lib/format";
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
}

interface Plan {
  id: string;
  name: string;
  price_vnd: number;
  credit_per_period_vnd: number;
  period_days: number;
  rate_limit_per_minute?: number;
}

export interface SubscriptionInfo {
  balance: number;
  available: number;
  period_end: number;
  plan_name: string;
  rate_limit_per_minute: number;
  expired: boolean;
}

export default function BillingBundlesPage() {
  const workspaceId = useCurrentWorkspaceId();
  const navigate = useNavigate();

  const bundles = useQuery({
    queryKey: ["bundles"],
    queryFn: () => api<{ data: Bundle[] }>("/api/v1/bundles"),
  });

  const plans = useQuery({
    queryKey: ["subscription-plans"],
    queryFn: () => api<{ data: Plan[] }>("/api/v1/subscription-plans"),
  });

  // Renew vs Subscribe label: an active, unexpired subscription renews;
  // anything else starts a new subscription.
  const wallet = useQuery({
    queryKey: ["wallet", workspaceId],
    queryFn: () =>
      api<{ subscription?: SubscriptionInfo | null }>(
        `/api/v1/workspaces/${workspaceId}/wallet`,
      ),
    enabled: !!workspaceId,
  });
  const subscribed =
    !!wallet.data?.subscription && !wallet.data.subscription.expired;

  // Same provider-availability pattern as the Credits top-up: the backend
  // gates PayOS on its credentials; manual is the default and the fallback.
  const methods = useQuery({
    queryKey: ["payment-methods"],
    queryFn: () => api<{ manual: boolean; payos: boolean }>("/api/v1/payment-methods"),
    staleTime: 60_000,
    retry: false,
  });
  const payosAvailable = methods.data?.payos === true;

  return (
    <div className="space-y-6">
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
          onNavigate={(href) => void navigate({ href })}
        />
      )}

      <PageHeader
        title="Subscription plans"
        description="A plan credits the subscription balance each period; the gateway spends it first while the period is active."
      />
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
          onNavigate={(href) => void navigate({ href })}
        />
      )}
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
  onNavigate,
}: {
  bundles: Bundle[];
  workspaceId: string | undefined;
  payosAvailable: boolean;
  onNavigate: (href: string) => void;
}) {
  const queryClient = useQueryClient();

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
                <p className="font-mono text-xl font-semibold">{formatVnd(bundle.price_vnd)}</p>
              </div>
              <div className="text-sm">
                <p className="font-mono">{formatVnd(bundle.credit_vnd)} credit</p>
                {bundle.bonus_vnd > 0 && (
                  <p className="font-mono text-xs text-emerald-600 dark:text-emerald-400">
                    + {formatVnd(bundle.bonus_vnd)} bonus
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
  onNavigate,
}: {
  plans: Plan[];
  workspaceId: string | undefined;
  payosAvailable: boolean;
  subscribed: boolean;
  onNavigate: (href: string) => void;
}) {
  const queryClient = useQueryClient();

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
                <p className="font-mono text-xl font-semibold">{formatVnd(plan.price_vnd)}</p>
              </div>
              <div className="text-sm">
                <p className="font-mono">{formatVnd(plan.credit_per_period_vnd)} credit / {plan.period_days} days</p>
                {!!plan.rate_limit_per_minute && (
                  <p className="text-xs text-muted-foreground">
                    Up to {plan.rate_limit_per_minute} requests per minute on subscription credit
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
