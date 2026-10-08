import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Gauge as GaugeIcon,
  Package as PackageIcon,
  RefreshCw as RefreshCwIcon,
} from "lucide-react";
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { useT } from "../../lib/i18n/t";

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

export interface ThroughputProduct {
  id: string;
  name: string;
  price_vnd: number;
  requests_per_minute: number;
  duration_days: number;
}

export interface ThroughputAllowanceInfo {
  requests_per_minute: number;
  starts_at: number;
  ends_at: number;
  status: string;
  /** False while a purchased window is queued (has not started limiting). */
  limiting: boolean;
}

/**
 * Normative product wording for the allowance: a gateway admission limit —
 * never a provider-capacity guarantee or a priority promise.
 */
export const THROUGHPUT_ALLOWANCE_DISCLAIMER =
  "A prepaid throughput allowance is a gateway admission limit for your workspace: while the window is active, the gateway admits at most the purchased number of requests per minute. It grants no wallet credit. It is not a provider-capacity guarantee and not a priority promise.";

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
  word: string,
): string | null {
  const authored = isUsdText(usd) && Number(usd) > 0;
  if (!authored && vnd <= 0) return null;
  if (authored && (currency === "USD" || vnd <= 0)) return `+${formatUsdAmountText(usd!)} ${word}`;
  if (currency === "USD" && hasRate(rate)) return `+${formatUsdFromVnd(vnd, rate)} ${word}`;
  return `+ ${formatVnd(vnd)} ${word}`;
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

// Checkout + tab copy introduced with the selection-gated checkout. New
// visible strings are bilingual; money values and API-derived data never are.
const bundlesCopy = {
  tabBundles: { en: "Credit bundles", vi: "Gói tín dụng" },
  tabPlans: { en: "Subscription plans", vi: "Gói đăng ký" },
  tabThroughput: { en: "Prepaid throughput", vi: "Thông lượng trả trước" },
  select: { en: "Select", vi: "Chọn" },
  checkout: { en: "Checkout", vi: "Thanh toán" },
  price: { en: "Price", vi: "Giá" },
  paymentMethod: { en: "Payment method", vi: "Phương thức thanh toán" },
  manualTransfer: { en: "Manual transfer", vi: "Chuyển khoản thủ công" },
  manualTransferBody: {
    en: "Create a pending payment; an admin confirms it out-of-band.",
    vi: "Tạo thanh toán chờ; quản trị viên sẽ xác nhận riêng.",
  },
  payos: { en: "PayOS", vi: "PayOS" },
  payosBody: {
    en: "Pay by bank app or QR at PayOS; you will be redirected there and the payment status here updates from the server.",
    vi: "Thanh toán qua ứng dụng ngân hàng hoặc mã QR tại PayOS; bạn sẽ được chuyển hướng đến đó và trạng thái thanh toán ở đây cập nhật từ server.",
  },
  confirmPurchase: { en: "Confirm purchase", vi: "Xác nhận mua" },
  confirmSubscription: { en: "Confirm subscription", vi: "Xác nhận đăng ký" },
  confirmRenewal: { en: "Confirm renewal", vi: "Xác nhận gia hạn" },
  cancel: { en: "Cancel", vi: "Hủy" },
  creatingPayment: { en: "Creating payment…", vi: "Đang tạo thanh toán…" },

  // Section headers, empty states and error fallbacks.
  bundlesDesc: {
    en: "Buy credit in fixed bundles; credit lands in the wallet once the payment settles.",
    vi: "Mua tín dụng theo gói cố định; tín dụng sẽ vào ví sau khi thanh toán được xác nhận.",
  },
  plansDesc: {
    en: "A plan credits the subscription balance each period; the gateway spends it first while the period is active.",
    vi: "Gói đăng ký nạp vào số dư đăng ký mỗi kỳ; gateway ưu tiên dùng số dư này trong khi kỳ còn hiệu lực.",
  },
  throughputTitle: {
    en: "Prepaid throughput allowance",
    vi: "Khoản thông lượng trả trước",
  },
  throughputDesc: {
    en: "Buy a fixed-window gateway admission cap for the whole workspace; it activates once the payment settles.",
    vi: "Mua giới hạn tiếp nhận gateway theo cửa sổ cố định cho toàn bộ workspace; kích hoạt sau khi thanh toán được xác nhận.",
  },
  loadFailed: {
    en: "Couldn't load this section. Check your connection and try again.",
    vi: "Không tải được mục này. Vui lòng kiểm tra kết nối và thử lại.",
  },
  noBundles: { en: "No bundles available", vi: "Chưa có gói tín dụng nào" },
  noBundlesDesc: {
    en: "No credit bundles are on sale right now — check back later.",
    vi: "Hiện chưa có gói tín dụng nào được bán — vui lòng quay lại sau.",
  },
  noPlans: { en: "No plans available", vi: "Chưa có gói đăng ký nào" },
  noPlansDesc: {
    en: "No subscription plans are on sale right now — check back later.",
    vi: "Hiện chưa có gói đăng ký nào được bán — vui lòng quay lại sau.",
  },
  noThroughput: {
    en: "No throughput products available",
    vi: "Chưa có gói thông lượng nào",
  },
  noThroughputDesc: {
    en: "No prepaid throughput allowance products are on sale right now — check back later.",
    vi: "Hiện chưa có gói thông lượng trả trước nào được bán — vui lòng quay lại sau.",
  },

  // Currency toggle and card copy.
  showVnd: { en: "Show VND", vi: "Hiện VND" },
  showUsd: { en: "Show USD", vi: "Hiện USD" },
  vndEstimate: {
    en: "VND estimate; the final amount is fixed when the payment is created.",
    vi: "Ước tính theo VND; số tiền cuối cùng được chốt khi tạo thanh toán.",
  },
  creditWord: { en: "credit", vi: "tín dụng" },
  bonusWord: { en: "bonus", vi: "thưởng" },
  daysWord: { en: "days", vi: "ngày" },
  creditUsdExact: {
    en: "Credit is the exact authored USD amount; the VND grant is fixed at creation.",
    vi: "Tín dụng là đúng số USD đã đặt; mức VND được chốt khi tạo.",
  },
  creditVndFixed: {
    en: "Credit is a fixed VND amount set at creation; USD shows the current-rate equivalent.",
    vi: "Tín dụng là mức VND cố định đặt khi tạo; USD hiển thị theo tỷ giá hiện tại.",
  },
  paymentSettles: {
    en: "Payment completes when the provider confirms; status shows on the Payments page.",
    vi: "Thanh toán hoàn tất khi nhà cung cấp xác nhận; trạng thái hiển thị trên trang Thanh toán.",
  },
  upToRpm: {
    en: "Up to {n} requests per minute on subscription credit",
    vi: "Tối đa {n} yêu cầu mỗi phút bằng tín dụng đăng ký",
  },

  // Throughput allowance card and product cards.
  admissionCap: {
    en: "{n} requests/minute gateway admission cap",
    vi: "Giới hạn tiếp nhận gateway {n} yêu cầu/phút",
  },
  requestsPerMinute: { en: "{n} requests/minute", vi: "{n} yêu cầu/phút" },
  activeForDay: { en: "Active for {n} day", vi: "Hoạt động trong {n} ngày" },
  activeForDays: { en: "Active for {n} days", vi: "Hoạt động trong {n} ngày" },
  activeAllowance: { en: "Active allowance", vi: "Khoản thông lượng đang hoạt động" },
  limiting: { en: "Limiting", vi: "Đang giới hạn" },
  queued: { en: "Queued", vi: "Đang chờ" },
  allowanceBody: {
    en: "The allowance caps all gateway traffic for this workspace while the window is active. It grants no wallet credit and adds no wallet balance.",
    vi: "Khoản thông lượng này giới hạn toàn bộ lưu lượng gateway của workspace trong khi cửa sổ còn hiệu lực. Nó không cấp tín dụng vào ví và không làm tăng số dư ví.",
  },
  throughputDisclaimer: {
    en: THROUGHPUT_ALLOWANCE_DISCLAIMER,
    vi: "Khoản thông lượng trả trước là giới hạn tiếp nhận của gateway cho workspace của bạn: trong khi cửa sổ còn hiệu lực, gateway tiếp nhận tối đa số yêu cầu mỗi phút đã mua. Nó không cấp tín dụng vào ví. Đây không phải cam kết về năng lực của nhà cung cấp và không phải cam kết ưu tiên.",
  },

  // Checkout success/error toasts (fallbacks only; server messages win).
  redirectToPayos: {
    en: "Redirecting to PayOS checkout…",
    vi: "Đang chuyển hướng đến thanh toán PayOS…",
  },
  paymentCreated: {
    en: "Payment created — waiting for admin confirmation",
    vi: "Đã tạo thanh toán — đang chờ quản trị viên xác nhận",
  },
  purchaseFailed: { en: "Purchase failed", vi: "Mua thất bại" },

  // Subscription status card.
  yourSubscription: { en: "Your subscription", vi: "Gói đăng ký của bạn" },
  periodEnds: { en: "Period ends", vi: "Kỳ kết thúc vào" },
  expiredSuffix: { en: " (expired)", vi: " (đã hết hạn)" },
  canceledSuffix: {
    en: " (canceled — will not renew)",
    vi: " (đã hủy — sẽ không tự gia hạn)",
  },
  rpmPlain: { en: "{n} requests per minute", vi: "{n} yêu cầu mỗi phút" },
  renewing: { en: "Renewing…", vi: "Đang gia hạn…" },
  renew: { en: "Renew", vi: "Gia hạn" },
  canceling: { en: "Canceling…", vi: "Đang hủy…" },
  cancelSubscription: { en: "Cancel subscription", vi: "Hủy đăng ký" },
  subCanceledToast: {
    en: "Subscription canceled — credit stays usable until the period ends",
    vi: "Đã hủy đăng ký — tín dụng vẫn dùng được đến khi kỳ kết thúc",
  },
  cancelFailed: { en: "Cancel failed", vi: "Hủy thất bại" },
  subRenewedToast: {
    en: "Subscription renewed — renewal re-enabled for the next period",
    vi: "Đã gia hạn đăng ký — đã bật lại tự gia hạn cho kỳ tiếp theo",
  },
  renewFailed: { en: "Renew failed", vi: "Gia hạn thất bại" },
  subExpiredNote: {
    en: "The period has ended; unused credit is forfeited. Paying for a plan again starts a new period.",
    vi: "Kỳ đã kết thúc; tín dụng chưa dùng sẽ mất. Thanh toán lại gói sẽ bắt đầu kỳ mới.",
  },
  subCanceledNote: {
    en: "Renew re-enables renewal (no charge now): the next plan payment renews the period. Credit stays usable until the period ends, then unused credit is forfeited.",
    vi: "Gia hạn sẽ bật lại tự gia hạn (không tính phí bây giờ): lần thanh toán gói tiếp theo sẽ gia hạn kỳ. Tín dụng vẫn dùng được đến khi kỳ kết thúc, sau đó tín dụng chưa dùng sẽ mất.",
  },
  subActiveNote: {
    en: "Canceling stops renewal only (will not renew): credit stays usable until the period ends, then unused credit is forfeited.",
    vi: "Hủy chỉ dừng việc tự gia hạn (sẽ không tự gia hạn): tín dụng vẫn dùng được đến khi kỳ kết thúc, sau đó tín dụng chưa dùng sẽ mất.",
  },
  shownInUsd: {
    en: "Shown in USD from the VND ledger.",
    vi: "Hiển thị theo USD từ sổ cái VND.",
  },
};

/** Known purchase-failure API codes mapped to friendly localized copy; any
 * other ApiError surfaces the server's own message (details never hidden). */
const purchaseErrorCopy = {
  INACTIVE: {
    en: "This product is no longer available",
    vi: "Sản phẩm này hiện không còn bán",
  },
  NOT_FOUND: {
    en: "This product no longer exists",
    vi: "Sản phẩm này không còn tồn tại",
  },
  WORKSPACE_SUSPENDED: {
    en: "Workspace is suspended",
    vi: "Workspace bị tạm ngưng",
  },
} as const;

/**
 * Selection-gated checkout state: no payment method and no mutation exist
 * until a product card's Select puts one here. Tab switches clear it.
 */
interface SelectedProduct {
  kind: "bundle" | "plan" | "throughput";
  id: string;
  name: string;
  priceVnd: number;
  priceUsd?: string | null;
}

/** Same endpoints and payload shapes as the pre-dialog purchase flow. */
function purchasePath(workspaceId: string, selected: SelectedProduct): string {
  const kind =
    selected.kind === "bundle"
      ? "bundles"
      : selected.kind === "plan"
        ? "subscription-plans"
        : "throughput-products";
  return `/api/v1/workspaces/${workspaceId}/${kind}/${selected.id}/purchase`;
}

/**
 * Everything the purchase mutation needs, captured at confirm time. The
 * workspace and product travel as mutation variables (never read from a
 * closure at completion time), so a slow POST can never bill or refresh the
 * wrong workspace. `gen` is the page's selection generation at confirm time.
 */
interface PurchaseVars {
  workspaceId: string;
  selected: SelectedProduct;
  provider: "manual" | "payos";
  gen: number;
}

/**
 * Checkout for the selected product. The body is remounted per selection
 * (keyed by the caller) so a stale provider choice never survives switching
 * products: selecting another product resets the checkout to manual.
 */
function CheckoutBody({
  selected,
  workspaceId,
  payosAvailable,
  subscribed,
  rate,
  liveSelectionGen,
  onClose,
  onNavigate,
}: {
  selected: SelectedProduct;
  workspaceId: string | undefined;
  payosAvailable: boolean;
  subscribed: boolean;
  rate: number | undefined;
  /** Page-level selection generation ref; read at completion time. */
  liveSelectionGen: { current: number };
  onClose: () => void;
  onNavigate: (href: string) => void;
}) {
  const t = useT(bundlesCopy);
  const terr = useT(purchaseErrorCopy);
  const queryClient = useQueryClient();

  // Same provider semantics as the top-up form: manual default, collapses
  // back to manual when the backend stops advertising PayOS.
  const [providerChoice, setProviderChoice] = useState<"manual" | "payos">("manual");
  const provider = payosAvailable && providerChoice === "payos" ? "payos" : "manual";

  const buy = useMutation({
    // Body is empty for manual so the request matches the plain manual
    // purchase shape; provider is sent only for PayOS. No amounts are ever
    // sent: the server charges its own VND price (money invariant).
    mutationFn: (vars: PurchaseVars) =>
      api<{ id: string; status: string; checkout_url: string }>(
        purchasePath(vars.workspaceId, vars.selected),
        {
          method: "POST",
          body: JSON.stringify(vars.provider === "payos" ? { provider: vars.provider } : {}),
        },
      ),
    onSuccess: (payment: { id: string; status: string; checkout_url: string }, vars) => {
      // Refresh history for the workspace the payment was created in — the
      // captured one, never the currently active one.
      void queryClient.invalidateQueries({ queryKey: ["payments", vars.workspaceId] });
      if (vars.selected.kind === "plan") {
        void queryClient.invalidateQueries({ queryKey: ["wallet", vars.workspaceId] });
      }
      // The checkout may have moved on while the POST was in flight (tab or
      // product change, workspace switch). The dispatched payment is never
      // canceled or deleted — only its success UX is dropped: navigate/toast
      // only when the selection generation that confirmed is still current.
      if (liveSelectionGen.current !== vars.gen) return;
      onClose();
      // Same redirect rule as the top-up: an absolute checkout URL must be a
      // full browser navigation; a relative path (manual) stays in-app.
      // Status is never read from query parameters.
      if (!payment.checkout_url.startsWith("/")) {
        toast(t("redirectToPayos"));
        window.location.assign(payment.checkout_url);
        return;
      }
      toast(t("paymentCreated"));
      onNavigate(`/billing/payments?payment=${payment.id}`);
    },
    onError: (err: unknown, vars: PurchaseVars) => {
      // Stale-generation guard: if the selection moved on while the POST was
      // in flight (tab/product change), the error belongs to a checkout the
      // user already left — surface nothing (the dispatch itself is not
      // canceled; only the error UX is dropped, same as the success UX).
      if (liveSelectionGen.current !== vars.gen) return;
      // Known API codes map to friendly localized copy; other ApiErrors
      // surface the server's own message so details are never hidden.
      if (err instanceof ApiError) {
        toast.error(
          err.code in purchaseErrorCopy
            ? terr(err.code as keyof typeof purchaseErrorCopy)
            : err.message,
        );
      } else {
        toast.error(t("purchaseFailed"));
      }
    },
  });

  const confirmLabel =
    selected.kind === "plan"
      ? subscribed
        ? t("confirmRenewal")
        : t("confirmSubscription")
      : t("confirmPurchase");

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("checkout")}</DialogTitle>
        <DialogDescription>{selected.name}</DialogDescription>
      </DialogHeader>
      <div className="space-y-4">
        <div>
          <p className="text-xs text-muted-foreground">{t("price")}</p>
          {/* VND leads (ledger truth); authored USD text still shows verbatim. */}
          <CardPrice
            priceVnd={selected.priceVnd}
            priceUsd={selected.priceUsd}
            currency="VND"
            rate={rate}
            testId="checkout-price"
            className="font-mono text-xl font-semibold"
          />
        </div>
        {payosAvailable && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("paymentMethod")}</legend>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="checkout-payment-provider"
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
                name="checkout-payment-provider"
                value="payos"
                checked={provider === "payos"}
                onChange={() => setProviderChoice("payos")}
                className="mt-1"
              />
              <span>
                {t("payos")}
                <span className="block text-xs text-muted-foreground">{t("payosBody")}</span>
              </span>
            </label>
          </fieldset>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {t("cancel")}
        </Button>
        <Button
          disabled={buy.isPending}
          onClick={() =>
            buy.isPending ||
            buy.mutate({
              workspaceId: workspaceId!,
              selected,
              provider,
              gen: liveSelectionGen.current,
            })
          }
        >
          {buy.isPending ? t("creatingPayment") : confirmLabel}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * Selection-gated checkout dialog: renders nothing (and no payment methods)
 * until a product is selected. The body is keyed by the selection so picking
 * another product always starts from a fresh manual-default checkout.
 */
function CheckoutDialog({
  selected,
  workspaceId,
  onClose,
  payosAvailable,
  subscribed,
  rate,
  liveSelectionGen,
  onNavigate,
}: {
  selected: SelectedProduct | null;
  workspaceId: string | undefined;
  onClose: () => void;
  payosAvailable: boolean;
  subscribed: boolean;
  rate: number | undefined;
  /** Page-level selection generation ref; read at completion time. */
  liveSelectionGen: { current: number };
  onNavigate: (href: string) => void;
}) {
  return (
    <Dialog open={selected !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {selected && (
          <CheckoutBody
            key={`${selected.kind}:${selected.id}`}
            selected={selected}
            workspaceId={workspaceId}
            payosAvailable={payosAvailable}
            subscribed={subscribed}
            rate={rate}
            liveSelectionGen={liveSelectionGen}
            onClose={onClose}
            onNavigate={onNavigate}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function BillingBundlesPage() {
  const workspaceId = useCurrentWorkspaceId();
  const navigate = useNavigate();

  const t = useT(bundlesCopy);
  // One page-level selection: switching tabs clears it (and its provider
  // choice), so no stale checkout can ever be confirmed from another tab.
  // Every selection change bumps the generation: an in-flight purchase whose
  // confirm-time generation is superseded drops only its success UX (the
  // dispatched payment itself is never canceled or deleted).
  const [selected, setSelected] = useState<SelectedProduct | null>(null);
  const selectionGenRef = useRef(0);
  const selectProduct = (s: SelectedProduct | null) => {
    selectionGenRef.current += 1;
    setSelected(s);
  };
  // A workspace switch invalidates any open checkout: the selection and its
  // payment-method choice belonged to the previous workspace's catalog.
  useEffect(() => {
    selectProduct(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

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
  // Fetched only once a product is selected (a cached result is reused as-is;
  // no network requirement is invented for an open checkout).
  const methods = useQuery({
    queryKey: ["payment-methods"],
    queryFn: () => api<{ manual: boolean; payos: boolean }>("/api/v1/payment-methods"),
    enabled: selected !== null,
    staleTime: 60_000,
    retry: false,
  });
  const payosAvailable = methods.data?.payos === true;

  const products = useQuery({
    queryKey: ["throughput-products"],
    queryFn: () => api<{ data: ThroughputProduct[] }>("/api/v1/throughput-products"),
  });
  const allowance = useQuery({
    queryKey: ["throughput-allowance", workspaceId],
    queryFn: () =>
      api<{ allowance: ThroughputAllowanceInfo | null }>(
        `/api/v1/workspaces/${workspaceId}/throughput-allowance`,
      ),
    enabled: !!workspaceId,
  });

  // FX rate for the USD-canonical display: the catalog envelope rate wins
  // (no wallet round-trip needed); the wallet rate is the older-backend
  // fallback. USD-authored rows display exact USD text even without either.
  const walletRate = useUsdVndRate(workspaceId).data;
  const rate = catalogEnvelopeRate(bundles.data, plans.data, walletRate);

  return (
    <Tabs defaultValue="bundles" onValueChange={() => selectProduct(null)} className="space-y-6">
      <TabsList>
        <TabsTrigger value="bundles">{t("tabBundles")}</TabsTrigger>
        <TabsTrigger value="plans">{t("tabPlans")}</TabsTrigger>
        <TabsTrigger value="throughput">{t("tabThroughput")}</TabsTrigger>
      </TabsList>

      <TabsContent value="bundles">
        <section aria-label={t("tabBundles")} className="space-y-4">
          <PageHeader title={t("tabBundles")} description={t("bundlesDesc")} />

          {bundles.isPending ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <Skeleton className="h-44 w-full" />
              <Skeleton className="h-44 w-full" />
              <Skeleton className="h-44 w-full" />
            </div>
          ) : bundles.isError ? (
            <ErrorState
              message={bundles.error instanceof ApiError ? bundles.error.message : t("loadFailed")}
            />
          ) : bundles.data.data.length === 0 ? (
            <EmptyState
              icon={PackageIcon}
              title={t("noBundles")}
              description={t("noBundlesDesc")}
            />
          ) : (
            <BundleCards
              bundles={bundles.data.data}
              workspaceId={workspaceId ?? undefined}
              selectedId={selected?.kind === "bundle" ? selected.id : null}
              onSelect={(bundle) =>
                selectProduct({
                  kind: "bundle",
                  id: bundle.id,
                  name: bundle.name,
                  priceVnd: bundle.price_vnd,
                  priceUsd: bundle.price_usd ?? null,
                })
              }
              rate={rate}
            />
          )}
        </section>
      </TabsContent>

      <TabsContent value="plans">
        <section aria-label={t("tabPlans")} className="space-y-4">
          <PageHeader title={t("tabPlans")} description={t("plansDesc")} />
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
            <ErrorState
              message={plans.error instanceof ApiError ? plans.error.message : t("loadFailed")}
            />
          ) : plans.data.data.length === 0 ? (
            <EmptyState icon={RefreshCwIcon} title={t("noPlans")} description={t("noPlansDesc")} />
          ) : (
            <PlanCards
              plans={plans.data.data}
              workspaceId={workspaceId ?? undefined}
              selectedId={selected?.kind === "plan" ? selected.id : null}
              onSelect={(plan) =>
                selectProduct({
                  kind: "plan",
                  id: plan.id,
                  name: plan.name,
                  priceVnd: plan.price_vnd,
                  priceUsd: plan.price_usd ?? null,
                })
              }
              rate={rate}
            />
          )}
        </section>
      </TabsContent>

      <TabsContent value="throughput">
        <section aria-label={t("throughputTitle")} className="space-y-4">
          <PageHeader title={t("throughputTitle")} description={t("throughputDesc")} />
          {allowance.data?.allowance && workspaceId ? (
            <ThroughputAllowanceStatus allowance={allowance.data.allowance} />
          ) : null}
          {products.isPending ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <Skeleton className="h-44 w-full" />
            </div>
          ) : products.isError ? (
            <ErrorState
              message={
                products.error instanceof ApiError ? products.error.message : t("loadFailed")
              }
            />
          ) : products.data.data.length === 0 ? (
            <EmptyState
              icon={GaugeIcon}
              title={t("noThroughput")}
              description={t("noThroughputDesc")}
            />
          ) : (
            <ThroughputProductCards
              products={products.data.data}
              workspaceId={workspaceId ?? undefined}
              selectedId={selected?.kind === "throughput" ? selected.id : null}
              onSelect={(product) =>
                selectProduct({
                  kind: "throughput",
                  id: product.id,
                  name: product.name,
                  priceVnd: product.price_vnd,
                })
              }
            />
          )}
          <p className="text-xs text-muted-foreground">{t("throughputDisclaimer")}</p>
        </section>
      </TabsContent>

      <CheckoutDialog
        selected={selected}
        workspaceId={workspaceId ?? undefined}
        liveSelectionGen={selectionGenRef}
        onClose={() => selectProduct(null)}
        payosAvailable={payosAvailable}
        subscribed={subscribed}
        rate={rate}
        onNavigate={(href) => void navigate({ href })}
      />
    </Tabs>
  );
}

/**
 * Current allowance state for the workspace: the purchased admission cap and
 * its active window. A queued window (future starts_at) is shown without a
 * "limiting" claim until it begins.
 */
export function ThroughputAllowanceStatus({ allowance }: { allowance: ThroughputAllowanceInfo }) {
  const t = useT(bundlesCopy);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("activeAllowance")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p data-testid="throughput-allowance-rpm" className="font-mono">
          {t("admissionCap", { n: allowance.requests_per_minute })}
        </p>
        <p className="text-muted-foreground">
          {t(allowance.limiting ? "limiting" : "queued")}: {formatDate(allowance.starts_at)} –{" "}
          {formatDate(allowance.ends_at)}
        </p>
        <p className="text-xs text-muted-foreground">{t("allowanceBody")}</p>
      </CardContent>
    </Card>
  );
}

/**
 * Throughput product cards, selection-gated like BundleCards. Extracted for
 * render tests; cards fire nothing — the checkout dialog owns the purchase.
 * VND-only product: the price shows the integer VND amount.
 */
export function ThroughputProductCards({
  products,
  workspaceId,
  selectedId,
  onSelect,
}: {
  products: ThroughputProduct[];
  workspaceId: string | undefined;
  /** Highlight hook for the selected card; the dialog itself lives above. */
  selectedId: string | null;
  onSelect: (product: ThroughputProduct) => void;
}) {
  const t = useT(bundlesCopy);

  return (
    <div className="space-y-4">
      {/* min-w-0 on cards: nothing may force the page wider than 375px. */}
      <div className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {products.map((product) => (
          <Card key={product.id} className="flex min-w-0 flex-col">
            <CardHeader>
              <CardTitle className="text-base">{product.name}</CardTitle>
            </CardHeader>
            <CardContent className="flex min-w-0 flex-1 flex-col gap-3">
              <div>
                <p className="text-xs text-muted-foreground">{t("price")}</p>
                <p
                  data-testid={`throughput-price-${product.id}`}
                  className="font-mono text-xl font-semibold"
                >
                  {formatVnd(product.price_vnd)}
                </p>
              </div>
              <div className="text-sm">
                <p className="font-mono">
                  {t("requestsPerMinute", { n: product.requests_per_minute })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t(product.duration_days === 1 ? "activeForDay" : "activeForDays", {
                    n: product.duration_days,
                  })}
                </p>
              </div>
              <Button
                className="mt-auto w-full"
                disabled={!workspaceId}
                aria-pressed={selectedId === product.id}
                onClick={() => onSelect(product)}
              >
                {t("select")}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{t("throughputDisclaimer")}</p>
    </div>
  );
}

/**
 * Bundle cards, selection-gated: Buy became Select — the checkout dialog
 * (page-level) owns the payment method and the purchase mutation, so cards
 * fire nothing. Extracted for render tests; static rendering fires nothing.
 */
export function BundleCards({
  bundles,
  workspaceId,
  selectedId,
  onSelect,
  rate,
}: {
  bundles: Bundle[];
  workspaceId: string | undefined;
  /** Highlight hook for the selected card; the dialog itself lives above. */
  selectedId: string | null;
  onSelect: (bundle: Bundle) => void;
  /** Backend FX rate; undefined (older backend) keeps VND-only display. */
  rate?: number;
}) {
  // USD is the canonical display currency; without a rate the section stays
  // VND-only (behavior-preserving fallback).
  const [currency, setCurrency] = useState<DisplayCurrency>("USD");
  const t = useT(bundlesCopy);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
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
                  {grantText(bundle.credit_usd, bundle.credit_vnd, currency, rate)}{" "}
                  {t("creditWord")}
                </p>
                {(() => {
                  const bonus = bonusText(
                    bundle.bonus_usd,
                    bundle.bonus_vnd,
                    currency,
                    rate,
                    t("bonusWord"),
                  );
                  return bonus ? (
                    <p className="font-mono text-xs text-emerald-600 dark:text-emerald-400">
                      {bonus}
                    </p>
                  ) : null;
                })()}
                {isUsdText(bundle.credit_usd) ? (
                  <p className="text-xs text-muted-foreground">{t("creditUsdExact")}</p>
                ) : isUsdText(bundle.price_usd) ? (
                  <p className="text-xs text-muted-foreground">{t("creditVndFixed")}</p>
                ) : null}
              </div>
              <Button
                className="mt-auto w-full"
                disabled={!workspaceId}
                aria-pressed={selectedId === bundle.id}
                onClick={() => onSelect(bundle)}
              >
                {t("select")}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">{t("paymentSettles")}</p>
    </div>
  );
}

/**
 * Subscription plan cards, selection-gated like BundleCards: Subscribe/Renew
 * wording moved into the checkout dialog's confirm label; cards fire nothing.
 */
export function PlanCards({
  plans,
  workspaceId,
  selectedId,
  onSelect,
  rate,
}: {
  plans: Plan[];
  workspaceId: string | undefined;
  /** Highlight hook for the selected card; the dialog itself lives above. */
  selectedId: string | null;
  onSelect: (plan: Plan) => void;
  /** Backend FX rate; undefined (older backend) keeps VND-only display. */
  rate?: number;
}) {
  // USD canonical display, same rules as BundleCards.
  const [currency, setCurrency] = useState<DisplayCurrency>("USD");
  const t = useT(bundlesCopy);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
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
                  {grantText(
                    plan.credit_per_period_usd,
                    plan.credit_per_period_vnd,
                    currency,
                    rate,
                  )}{" "}
                  {t("creditWord")} / {plan.period_days} {t("daysWord")}
                </p>
                {!!plan.rate_limit_per_minute && (
                  <p className="text-xs text-muted-foreground">
                    {t("upToRpm", { n: plan.rate_limit_per_minute })}
                  </p>
                )}
                {isUsdText(plan.credit_per_period_usd) ? (
                  <p className="text-xs text-muted-foreground">{t("creditUsdExact")}</p>
                ) : isUsdText(plan.price_usd) ? (
                  <p className="text-xs text-muted-foreground">{t("creditVndFixed")}</p>
                ) : null}
              </div>
              <Button
                className="mt-auto w-full"
                disabled={!workspaceId}
                aria-pressed={selectedId === plan.id}
                onClick={() => onSelect(plan)}
              >
                {t("select")}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">{t("paymentSettles")}</p>
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
  const t = useT(bundlesCopy);

  const cancel = useMutation({
    mutationFn: () =>
      api<{ id: string; status: string; period_end: number }>(
        `/api/v1/workspaces/${workspaceId}/subscription`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["wallet", workspaceId] });
      toast(t("subCanceledToast"));
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
      toast(t("subRenewedToast"));
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
        {subscription.expired ? t("expiredSuffix") : ""}
        {subscription.canceled && !subscription.expired ? t("canceledSuffix") : ""}
      </p>
      <p className="text-sm text-muted-foreground">
        {t("rpmPlain", { n: subscription.rate_limit_per_minute })}
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
          ? t("subExpiredNote")
          : subscription.canceled
            ? t("subCanceledNote")
            : t("subActiveNote")}{" "}
        {usd !== null ? t("shownInUsd") : ""}
      </p>
    </div>
  );
}
