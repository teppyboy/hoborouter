import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Package as PackageIcon, RefreshCw as RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "../../lib/api";
import { useT } from "../../lib/i18n/t";

// Billing bundles/plans copy: inline LocaleEntry set (see lib/i18n/common.ts).
// Money values, plan/bundle names and API data are never translated.
const bundlesCopy = {
  creditBundles: { en: "Credit bundles", vi: "Gói tín dụng" },
  creditBundlesDesc: {
    en: "Buy credit in fixed bundles; credit lands in the wallet once the payment settles.",
    vi: "Mua tín dụng theo gói cố định; tín dụng vào ví sau khi thanh toán được đối soát.",
  },
  subscriptionPlans: { en: "Subscription plans", vi: "Gói đăng ký" },
  subscriptionPlansDesc: {
    en: "A plan credits the subscription balance each period; the gateway spends it first while the period is active.",
    vi: "Gói đăng ký nạp vào số dư đăng ký mỗi kỳ; gateway ưu tiên dùng phần này khi kỳ còn hiệu lực.",
  },
  noBundles: { en: "No bundles available", vi: "Không có gói tín dụng nào" },
  noBundlesBody: {
    en: "No credit bundles are on sale right now — check back later.",
    vi: "Hiện không có gói tín dụng nào đang bán — vui lòng quay lại sau.",
  },
  noPlans: { en: "No plans available", vi: "Không có gói đăng ký nào" },
  noPlansBody: {
    en: "No subscription plans are on sale right now — check back later.",
    vi: "Hiện không có gói đăng ký nào đang bán — vui lòng quay lại sau.",
  },
  paymentMethod: { en: "Payment method", vi: "Phương thức thanh toán" },
  manualTransfer: { en: "Manual transfer", vi: "Chuyển khoản thủ công" },
  manualTransferBody: {
    en: "Create a pending payment; an admin confirms it out-of-band.",
    vi: "Tạo thanh toán chờ; quản trị viên sẽ xác nhận riêng.",
  },
  payosBody: {
    en: "Pay by bank app or QR at PayOS; you will be redirected there and the payment status here updates from the server.",
    vi: "Thanh toán bằng ứng dụng ngân hàng hoặc QR tại PayOS; bạn sẽ được chuyển đến đó và trạng thái thanh toán tại đây cập nhật từ server.",
  },
  price: { en: "Price", vi: "Giá" },
  credit: { en: "credit", vi: "tín dụng" },
  bonus: { en: "bonus", vi: "thưởng" },
  creditExactUsd: {
    en: "Credit is the exact authored USD amount; the VND grant is fixed at creation.",
    vi: "Tín dụng là đúng số USD đã khai báo; khoản VND được cố định lúc tạo.",
  },
  creditFixedVnd: {
    en: "Credit is a fixed VND amount set at creation; USD shows the current-rate equivalent.",
    vi: "Tín dụng là số VND cố định từ lúc tạo; USD hiển thị quy đổi theo tỷ giá hiện tại.",
  },
  vndEstimate: {
    en: "VND estimate; the final amount is fixed when the payment is created.",
    vi: "Ước tính VND; số tiền cuối cùng được cố định khi tạo thanh toán.",
  },
  creditPerPeriod: { en: "{grant} credit / {days} days", vi: "{grant} tín dụng / {days} ngày" },
  upToRate: {
    en: "Up to {n} requests per minute on subscription credit",
    vi: "Tối đa {n} request mỗi phút bằng tín dụng đăng ký",
  },
  buy: { en: "Buy", vi: "Mua" },
  subscribe: { en: "Subscribe", vi: "Đăng ký" },
  renew: { en: "Renew", vi: "Gia hạn" },
  creating: { en: "Creating payment…", vi: "Đang tạo thanh toán…" },
  completesWhen: {
    en: "Payment completes when the provider confirms; status shows on the Payments page.",
    vi: "Thanh toán hoàn tất khi nhà cung cấp xác nhận; trạng thái hiển thị tại trang Thanh toán.",
  },
  payosRedirect: { en: "Redirecting to PayOS checkout…", vi: "Đang chuyển tới trang thanh toán PayOS…" },
  paymentCreated: {
    en: "Payment created — waiting for admin confirmation",
    vi: "Đã tạo thanh toán — đang chờ quản trị viên xác nhận",
  },
  purchaseFailed: { en: "Purchase failed", vi: "Mua thất bại" },
  yourSubscription: { en: "Your subscription", vi: "Gói đăng ký của bạn" },
  periodEnds: { en: "Period ends", vi: "Kỳ kết thúc" },
  expired: { en: "(expired)", vi: "(hết hạn)" },
  canceledNoRenew: { en: "(canceled — will not renew)", vi: "(đã huỷ — sẽ không gia hạn)" },
  reqPerMinute: { en: "{n} requests per minute", vi: "{n} request mỗi phút" },
  canceling: { en: "Canceling…", vi: "Đang huỷ…" },
  renewing: { en: "Renewing…", vi: "Đang gia hạn…" },
  cancelSubscription: { en: "Cancel subscription", vi: "Huỷ gói đăng ký" },
  cancelToast: {
    en: "Subscription canceled — credit stays usable until the period ends",
    vi: "Đã huỷ gói đăng ký — tín dụng dùng được đến khi kỳ kết thúc",
  },
  renewToast: {
    en: "Subscription renewed — renewal re-enabled for the next period",
    vi: "Đã gia hạn gói đăng ký — đã bật lại gia hạn cho kỳ tiếp theo",
  },
  cancelFailed: { en: "Cancel failed", vi: "Huỷ thất bại" },
  renewFailed: { en: "Renew failed", vi: "Gia hạn thất bại" },
  expiredForfeit: {
    en: "The period has ended; unused credit is forfeited. Paying for a plan again starts a new period.",
    vi: "Kỳ đã kết thúc; tín dụng chưa dùng sẽ mất. Thanh toán gói mới sẽ bắt đầu kỳ mới.",
  },
  canceledBody: {
    en: "Renew re-enables renewal (no charge now): the next plan payment renews the period. Credit stays usable until the period ends, then unused credit is forfeited.",
    vi: "Gia hạn sẽ bật lại việc gia hạn (không tốn phí bây giờ): lần thanh toán gói tiếp theo sẽ gia hạn kỳ. Tín dụng dùng được đến khi kỳ kết thúc, sau đó tín dụng chưa dùng sẽ mất.",
  },
  cancelingBody: {
    en: "Canceling stops renewal only (will not renew): credit stays usable until the period ends, then unused credit is forfeited.",
    vi: "Huỷ chỉ dừng việc gia hạn (sẽ không gia hạn): tín dụng dùng được đến khi kỳ kết thúc, sau đó tín dụng chưa dùng sẽ mất.",
  },
  shownUsd: { en: "Shown in USD from the VND ledger.", vi: "Hiển thị USD từ sổ VND." },
  showVnd: { en: "Show VND", vi: "Xem VND" },
  showUsd: { en: "Show USD", vi: "Xem USD" },
} as const;
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
  const t = useT(bundlesCopy);
  if (!hasRate(rate) && !usdAvailable) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => onChange(currency === "USD" ? "VND" : "USD")}
    >
      {currency === "USD" ? t("showVnd") : t("showUsd")}
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
 * One grant amount in the selected display currency. Own metadata wins: an
 * authored `*_usd` text renders verbatim (never a rate-recomputed
 * reinterpretation of it); only legacy VND-authored grants use the rate
 * conversion, and the frozen integer VND grant is the fallback everywhere.
 */
function grantText(
  usd: string | null | undefined,
  vnd: number,
  currency: DisplayCurrency,
  rate: number | undefined,
): string {
  if (currency === "USD") {
    if (isUsdText(usd)) return formatUsdAmountText(usd);
    if (hasRate(rate)) {
      const converted = formatUsdFromVnd(vnd, rate);
      if (converted !== null) return converted;
    }
  }
  return formatVnd(vnd);
}

/**
 * Bonus line: shown for an authored positive USD bonus even when the frozen
 * `bonus_vnd` is 0; a legacy VND bonus only exists when `bonus_vnd > 0`.
 * Authored USD text wins over conversion in USD mode; VND mode keeps the
 * integer VND grant, falling back to the authored USD text when no VND
 * equivalent was ever derived.
 */
function bonusText(
  usd: string | null | undefined,
  vnd: number,
  currency: DisplayCurrency,
  rate: number | undefined,
  bonusWord: string,
): string | null {
  const authored = isUsdText(usd) && Number(usd) > 0;
  if (!authored && vnd <= 0) return null;
  if (authored && (currency === "USD" || vnd <= 0))
    return `+${formatUsdAmountText(usd!)} ${bonusWord}`;
  if (currency === "USD" && hasRate(rate)) return `+${formatUsdFromVnd(vnd, rate)} ${bonusWord}`;
  return `+ ${formatVnd(vnd)} ${bonusWord}`;
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
  const t = useT(bundlesCopy);
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
        <p className="text-xs text-muted-foreground">{t("vndEstimate")}</p>
      </div>
    );
  }
  return (
    <Amount vnd={priceVnd} currency={currency} rate={rate} testId={testId} className={className} />
  );
}

export default function BillingBundlesPage() {
  const t = useT(bundlesCopy);
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
      <section aria-label={t("creditBundles")} className="space-y-4">
        <PageHeader
          title={t("creditBundles")}
          description={t("creditBundlesDesc")}
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
            title={t("noBundles")}
            description={t("noBundlesBody")}
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

      <section aria-label={t("subscriptionPlans")} className="space-y-4">
        <PageHeader
          title={t("subscriptionPlans")}
          description={t("subscriptionPlansDesc")}
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
            title={t("noPlans")}
            description={t("noPlansBody")}
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
  const t = useT(bundlesCopy);
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
    onSuccess: async (payment: { id: string; status: string; checkout_url: string }) => {
      void queryClient.invalidateQueries({ queryKey: ["payments", workspaceId] });
      // Same redirect rule as the top-up: an absolute checkout URL must be a
      // full browser navigation; a relative path (manual) stays in-app.
      // Status is never read from query parameters.
      if (!payment.checkout_url.startsWith("/")) {
        toast(t("payosRedirect"));
        window.location.assign(payment.checkout_url);
        return;
      }
      toast(t("paymentCreated"));
      onNavigate(`/billing/payments?payment=${payment.id}`);
    },
    onError: (err: unknown) => {
      toast.error(err instanceof ApiError ? err.message : t("purchaseFailed"));
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {payosAvailable && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("paymentMethod")}</legend>
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
                {t("manualTransfer")}
                <span className="block text-xs text-muted-foreground">
                  {t("manualTransferBody")}
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
                  {t("payosBody")}
                </span>
              </span>
            </label>
          </fieldset>
        )}
        <CurrencyToggle
          currency={currency}
          rate={rate}
          onChange={setCurrency}
          usdAvailable={bundles.some(
            (b) => isUsdText(b.price_usd) || isUsdText(b.credit_usd) || isUsdText(b.bonus_usd),
          )}
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
                <p className="text-xs text-muted-foreground">{t("price")}</p>
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
                  {grantText(bundle.credit_usd, bundle.credit_vnd, currency, rate)} {t("credit")}
                </p>
                {(() => {
                  const bonus = bonusText(bundle.bonus_usd, bundle.bonus_vnd, currency, rate, t("bonus"));
                  return bonus ? (
                    <p className="font-mono text-xs text-emerald-600 dark:text-emerald-400">
                      {bonus}
                    </p>
                  ) : null;
                })()}
                {isUsdText(bundle.credit_usd) ? (
                  <p className="text-xs text-muted-foreground">{t("creditExactUsd")}</p>
                ) : isUsdText(bundle.price_usd) ? (
                  <p className="text-xs text-muted-foreground">{t("creditFixedVnd")}</p>
                ) : null}
              </div>
              <Button
                className="mt-auto w-full"
                disabled={!workspaceId || buy.isPending}
                onClick={() => buy.mutate(bundle.id)}
              >
                {buy.isPending ? t("creating") : t("buy")}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">{t("completesWhen")}</p>
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
  const t = useT(bundlesCopy);
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
    onSuccess: async (payment: { id: string; status: string; checkout_url: string }) => {
      void queryClient.invalidateQueries({ queryKey: ["payments", workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ["wallet", workspaceId] });
      // Same redirect rule as the bundle purchase: absolute URL = provider
      // checkout, relative path (manual) stays in-app.
      if (!payment.checkout_url.startsWith("/")) {
        toast(t("payosRedirect"));
        window.location.assign(payment.checkout_url);
        return;
      }
      toast(t("paymentCreated"));
      onNavigate(`/billing/payments?payment=${payment.id}`);
    },
    onError: (err: unknown) => {
      toast.error(err instanceof ApiError ? err.message : t("purchaseFailed"));
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {payosAvailable && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("paymentMethod")}</legend>
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
                {t("manualTransfer")}
                <span className="block text-xs text-muted-foreground">
                  {t("manualTransferBody")}
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
                  {t("payosBody")}
                </span>
              </span>
            </label>
          </fieldset>
        )}
        <CurrencyToggle
          currency={currency}
          rate={rate}
          onChange={setCurrency}
          usdAvailable={plans.some(
            (p) => isUsdText(p.price_usd) || isUsdText(p.credit_per_period_usd),
          )}
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
                <p className="text-xs text-muted-foreground">{t("price")}</p>
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
                  {t("creditPerPeriod", {
                    grant: grantText(
                      plan.credit_per_period_usd,
                      plan.credit_per_period_vnd,
                      currency,
                      rate,
                    ),
                    days: plan.period_days,
                  })}
                </p>
                {!!plan.rate_limit_per_minute && (
                  <p className="text-xs text-muted-foreground">
                    {t("upToRate", { n: plan.rate_limit_per_minute })}
                  </p>
                )}
                {isUsdText(plan.credit_per_period_usd) ? (
                  <p className="text-xs text-muted-foreground">{t("creditExactUsd")}</p>
                ) : isUsdText(plan.price_usd) ? (
                  <p className="text-xs text-muted-foreground">{t("creditFixedVnd")}</p>
                ) : null}
              </div>
              <Button
                className="mt-auto w-full"
                disabled={!workspaceId || buy.isPending}
                onClick={() => buy.mutate(plan.id)}
              >
                {buy.isPending ? t("creating") : subscribed ? t("renew") : t("subscribe")}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">{t("completesWhen")}</p>
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
  const t = useT(bundlesCopy);
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
      toast(t("cancelToast"));
    },
    onError: (err: unknown) => {
      toast.error(err instanceof ApiError ? err.message : t("cancelFailed"));
    },
  });

  // Renew (undo cancel): clears the cancel marker so the subscription
  // re-enters the normal renewal path. No money moves here — no refund, no
  // credit, no new charge; the current period is untouched.
  const renew = useMutation({
    mutationFn: () =>
      api<{ id: string; status: string; period_end: number }>(
        `/api/v1/workspaces/${workspaceId}/subscription`,
        { method: "PUT" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["wallet", workspaceId] });
      toast(t("renewToast"));
    },
    onError: (err: unknown) => {
      toast.error(err instanceof ApiError ? err.message : t("renewFailed"));
    },
  });

  const usd = formatUsdFromVnd(subscription.balance, rate);
  return (
    <div className="min-w-0 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold">{t("yourSubscription")}</p>
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
        {t("periodEnds")} <span className="font-mono">{formatDate(subscription.period_end)}</span>
        {subscription.expired ? ` ${t("expired")}` : ""}
        {subscription.canceled && !subscription.expired ? ` ${t("canceledNoRenew")}` : ""}
      </p>
      <p className="text-sm text-muted-foreground">
        {t("reqPerMinute", { n: subscription.rate_limit_per_minute })}
      </p>
      {!subscription.expired && (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {subscription.canceled ? (
            <Button size="sm" disabled={renew.isPending} onClick={() => renew.mutate()}>
              {renew.isPending ? t("renewing") : t("renew")}
            </Button>
          ) : (
            <Button
              variant="destructive"
              size="sm"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              {cancel.isPending ? t("canceling") : t("cancelSubscription")}
            </Button>
          )}
          <CurrencyToggle currency={currency} rate={rate} onChange={setCurrency} />
        </div>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        {subscription.expired
          ? t("expiredForfeit")
          : subscription.canceled
            ? t("canceledBody")
            : t("cancelingBody")}{" "}
        {usd !== null ? t("shownUsd") : ""}
      </p>
    </div>
  );
}
