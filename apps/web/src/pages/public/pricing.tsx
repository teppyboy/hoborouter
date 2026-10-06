// Public pricing page: live published-model prices (VND per 1M tokens,
// converted server-side with the billing rate + markup) and active
// subscription plans. Everything renders from fetched data — loading, error
// and empty states only; never hardcoded example prices.
import { PageHeader, EmptyState, ErrorState } from "../../components/page";
import { PublicLayout } from "../../components/public-layout";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Skeleton } from "../../components/ui/skeleton";
import { formatVnd, formatTokens, formatUsdAmountText } from "../../lib/format";
import { formatProviderLabel } from "../../lib/display";
import {
  usePublicCatalog,
  usePublicInstance,
  usePublicPlans,
  type PublicCatalogModel,
  type PublicInstance,
  type PublicSubscriptionPlan,
} from "../../lib/public-queries";

function ModelPriceRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-sm">{formatVnd(value)}</span>
    </div>
  );
}

function ModelCard({ model }: { model: PublicCatalogModel }) {
  const p = model.price_vnd_per_1m;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-mono text-sm">{model.public_id}</CardTitle>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{model.display_name}</span>
          <span>·</span>
          <span>{formatProviderLabel(model.provider)}</span>
          <span>·</span>
          <span>{formatTokens(model.context_window)} token context</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {model.description && <p className="text-sm text-muted-foreground">{model.description}</p>}
        {model.capabilities.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {model.capabilities.map((c) => (
              <Badge key={c} variant="secondary" className="font-mono text-xs">
                {c}
              </Badge>
            ))}
          </div>
        )}
        <div className="space-y-1 border-t border-border pt-3">
          <ModelPriceRow label="Input / 1M tokens" value={p.input} />
          <ModelPriceRow label="Output / 1M tokens" value={p.output} />
          <ModelPriceRow label="Cached input / 1M tokens" value={p.cached_input} />
          <ModelPriceRow label="Reasoning / 1M tokens" value={p.reasoning} />
        </div>
      </CardContent>
    </Card>
  );
}

// Authored USD catalog text; the same decimal syntax the formatter enforces.
const isUsdPriceText = (t: string | null | undefined): t is string =>
  typeof t === "string" && /^\d+(\.\d{1,2})?$/.test(t);

function PlanCard({ plan }: { plan: PublicSubscriptionPlan }) {
  // Each money field renders its OWN metadata: authored-USD price leads with
  // the exact text and keeps the VND quote as the server estimate; authored
  // per-period credit renders its exact USD text (never rate-recomputed)
  // with the frozen VND grant as secondary; legacy rows keep the pure-VND
  // display. Model token prices are untouched (server-converted VND per 1M).
  const authored = isUsdPriceText(plan.price_usd);
  const authoredCredit = isUsdPriceText(plan.credit_per_period_usd);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{plan.name}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        <div className="font-mono text-lg">
          {isUsdPriceText(plan.price_usd)
            ? formatUsdAmountText(plan.price_usd)
            : formatVnd(plan.price_vnd)}
        </div>
        {authored && (
          <div className="text-xs text-muted-foreground">
            ≈ {formatVnd(plan.price_vnd)} (VND estimate)
          </div>
        )}
        <div className="text-muted-foreground">
          {authoredCredit
            ? `${formatUsdAmountText(plan.credit_per_period_usd!)} credit`
            : `${formatVnd(plan.credit_per_period_vnd)} credit`}{" "}
          / {plan.period_days} days
          {authoredCredit && (
            <span className="block">
              VND grant {formatVnd(plan.credit_per_period_vnd)} fixed at creation
            </span>
          )}
        </div>
        {plan.rate_limit_per_minute != null && (
          <div className="text-muted-foreground">
            {plan.rate_limit_per_minute} requests per minute
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export type FetchState = "loading" | "error" | "ready";

export function Pricing({
  instance,
  models,
  modelsState,
  plans,
  plansState,
}: {
  instance?: PublicInstance | null;
  models: PublicCatalogModel[] | null;
  modelsState: FetchState;
  plans: PublicSubscriptionPlan[] | null;
  plansState: FetchState;
}) {
  return (
    <PublicLayout instance={instance}>
      <div className="space-y-8 py-6">
        <PageHeader
          title="Pricing"
          description="Live per-model prices in VND per 1M tokens, converted at the current instance rate. Top up credits by QR (PayOS) or manual confirmation."
        />

        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Models</h2>
          {modelsState === "loading" && (
            <div className="grid gap-4 sm:grid-cols-2" aria-busy="true">
              <Skeleton className="h-48" />
              <Skeleton className="h-48" />
            </div>
          )}
          {modelsState === "error" && (
            <ErrorState message="Could not load the model catalog. Please try again later." />
          )}
          {modelsState === "ready" && models && models.length === 0 && (
            <EmptyState title="No models published yet." />
          )}
          {modelsState === "ready" && models && models.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2">
              {models.map((m) => (
                <ModelCard key={m.public_id} model={m} />
              ))}
            </div>
          )}
        </section>

        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Subscription plans</h2>
          {plansState === "loading" && (
            <div className="grid gap-4 sm:grid-cols-2" aria-busy="true">
              <Skeleton className="h-32" />
              <Skeleton className="h-32" />
            </div>
          )}
          {plansState === "error" && (
            <ErrorState message="Could not load subscription plans. Please try again later." />
          )}
          {plansState === "ready" && plans && plans.length === 0 && (
            <EmptyState title="No subscription plans available right now." />
          )}
          {plansState === "ready" && plans && plans.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {plans.map((p) => (
                <PlanCard key={p.id} plan={p} />
              ))}
            </div>
          )}
        </section>
      </div>
    </PublicLayout>
  );
}

export default function PricingPage() {
  const instance = usePublicInstance();
  const catalog = usePublicCatalog();
  const plans = usePublicPlans();
  const state = (q: { isLoading: boolean; isError: boolean }): FetchState =>
    q.isLoading ? "loading" : q.isError ? "error" : "ready";
  return (
    <Pricing
      instance={instance.data ?? null}
      models={catalog.data?.data ?? null}
      modelsState={state(catalog)}
      plans={plans.data?.data ?? null}
      plansState={state(plans)}
    />
  );
}
