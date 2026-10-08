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
import { capabilityLabel } from "../../lib/capabilities";
import { useLocaleEntry, type LocaleEntry } from "../../lib/i18n/t";
import { useLocaleStore } from "../../lib/i18n/locale";

// Chrome copy set for the pricing body; money VALUES stay server-formatted
// (VND/USD invariants) — only the words around them are translated.
const priceLabels = {
  input: { en: "Input / 1M tokens", vi: "Input / 1M token" },
  output: { en: "Output / 1M tokens", vi: "Output / 1M token" },
  cached: { en: "Cached input / 1M tokens", vi: "Input cache / 1M token" },
  reasoning: { en: "Reasoning / 1M tokens", vi: "Reasoning / 1M token" },
} as const;
const vndEstimate: LocaleEntry = { en: "(VND estimate)", vi: "(ước tính VND)" };
const creditWord: LocaleEntry = { en: "credit", vi: "tín dụng" };
const daysWord: LocaleEntry = { en: "days", vi: "ngày" };
const vndGrant: LocaleEntry = { en: "fixed at creation", vi: "cố định khi tạo" };
const requestsPerMinute: LocaleEntry = { en: "requests per minute", vi: "request mỗi phút" };
const modelsHeading: LocaleEntry = { en: "Models", vi: "Mô hình" };
const plansHeading: LocaleEntry = { en: "Subscription plans", vi: "Gói đăng ký" };
const pricingTitle: LocaleEntry = { en: "Pricing", vi: "Bảng giá" };
const pricingDescription: LocaleEntry = {
  en: "Live per-model prices in VND per 1M tokens, converted at the current instance rate. Top up credits by QR (PayOS) or manual confirmation.",
  vi: "Giá từng mô hình tính theo VND / 1M token, quy đổi theo tỷ giá hiện tại của instance. Nạp tín dụng bằng QR (PayOS) hoặc xác nhận thủ công.",
};
const catalogError: LocaleEntry = {
  en: "Could not load the model catalog. Please try again later.",
  vi: "Không tải được danh mục mô hình. Vui lòng thử lại sau.",
};
const plansError: LocaleEntry = {
  en: "Could not load subscription plans. Please try again later.",
  vi: "Không tải được các gói đăng ký. Vui lòng thử lại sau.",
};
const noModels: LocaleEntry = {
  en: "No models published yet.",
  vi: "Chưa có mô hình nào được xuất bản.",
};
const noPlans: LocaleEntry = {
  en: "No subscription plans available right now.",
  vi: "Hiện chưa có gói đăng ký nào.",
};
import {
  usePublicCatalog,
  usePublicInstance,
  usePublicPlans,
  type PublicCatalogModel,
  type PublicInstance,
  type PublicSubscriptionPlan,
} from "../../lib/public-queries";

function ModelPriceRow({ label, value }: { label: LocaleEntry; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground">{useLocaleEntry(label)}</span>
      <span className="font-mono text-sm">{formatVnd(value)}</span>
    </div>
  );
}

function ModelCard({ model }: { model: PublicCatalogModel }) {
  const p = model.price_vnd_per_1m;
  const locale = useLocaleStore((s) => s.locale);
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
                {capabilityLabel(c, locale)}
              </Badge>
            ))}
          </div>
        )}
        <div className="space-y-1 border-t border-border pt-3">
          <ModelPriceRow label={priceLabels.input} value={p.input} />
          <ModelPriceRow label={priceLabels.output} value={p.output} />
          <ModelPriceRow label={priceLabels.cached} value={p.cached_input} />
          <ModelPriceRow label={priceLabels.reasoning} value={p.reasoning} />
        </div>
      </CardContent>
    </Card>
  );
}

// Authored USD catalog text; the same decimal syntax the formatter enforces.
const isUsdPriceText = (t: string | null | undefined): t is string =>
  typeof t === "string" && /^\d+(\.\d{1,2})?$/.test(t);

function PlanCard({ plan }: { plan: PublicSubscriptionPlan }) {
  const vndEstimateText = useLocaleEntry(vndEstimate);
  const creditText = useLocaleEntry(creditWord);
  const daysText = useLocaleEntry(daysWord);
  const vndGrantText = useLocaleEntry(vndGrant);
  const rateLimitText = useLocaleEntry(requestsPerMinute);
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
            ≈ {formatVnd(plan.price_vnd)} {vndEstimateText}
          </div>
        )}
        <div className="text-muted-foreground">
          {authoredCredit
            ? `${formatUsdAmountText(plan.credit_per_period_usd!)} ${creditText}`
            : `${formatVnd(plan.credit_per_period_vnd)} ${creditText}`}{" "}
          / {plan.period_days} {daysText}
          {authoredCredit && (
            <span className="block">
              VND grant {formatVnd(plan.credit_per_period_vnd)} {vndGrantText}
            </span>
          )}
        </div>
        {plan.rate_limit_per_minute != null && (
          <div className="text-muted-foreground">
            {plan.rate_limit_per_minute} {rateLimitText}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PricingHeader() {
  return (
    <PageHeader
      title={useLocaleEntry(pricingTitle)}
      description={useLocaleEntry(pricingDescription)}
    />
  );
}

function ModelsHeading() {
  return <h2 className="text-lg font-semibold">{useLocaleEntry(modelsHeading)}</h2>;
}

function PlansHeading() {
  return <h2 className="text-lg font-semibold">{useLocaleEntry(plansHeading)}</h2>;
}

function CatalogErrorState() {
  return <ErrorState message={useLocaleEntry(catalogError)} />;
}

function PlansErrorState() {
  return <ErrorState message={useLocaleEntry(plansError)} />;
}

function NoModelsState() {
  return <EmptyState title={useLocaleEntry(noModels)} />;
}

function NoPlansState() {
  return <EmptyState title={useLocaleEntry(noPlans)} />;
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
        <PricingHeader />

        <section className="space-y-4">
          <ModelsHeading />
          {modelsState === "loading" && (
            <div className="grid gap-4 sm:grid-cols-2" aria-busy="true">
              <Skeleton className="h-48" />
              <Skeleton className="h-48" />
            </div>
          )}
          {modelsState === "error" && <CatalogErrorState />}
          {modelsState === "ready" && models && models.length === 0 && <NoModelsState />}
          {modelsState === "ready" && models && models.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2">
              {models.map((m) => (
                <ModelCard key={m.public_id} model={m} />
              ))}
            </div>
          )}
        </section>

        <section className="space-y-4">
          <PlansHeading />
          {plansState === "loading" && (
            <div className="grid gap-4 sm:grid-cols-2" aria-busy="true">
              <Skeleton className="h-32" />
              <Skeleton className="h-32" />
            </div>
          )}
          {plansState === "error" && <PlansErrorState />}
          {plansState === "ready" && plans && plans.length === 0 && <NoPlansState />}
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
