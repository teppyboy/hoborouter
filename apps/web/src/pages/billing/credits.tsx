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
import { useT } from "../../lib/i18n/t";

// Credits page copy: inline LocaleEntry set (see lib/i18n/common.ts).
// Money values, ledger kinds and API-derived data are never translated.
const creditsCopy = {
  wholeVnd: { en: "Must be a whole number of VND", vi: "Phải là số VND nguyên" },
  minTopUp: { en: "Minimum top-up is 10.000 ₫", vi: "Nạp tối thiểu 10.000 ₫" },
  enterUsd: { en: "Enter a USD amount", vi: "Nhập số tiền USD" },
  usdFormat: {
    en: "USD amount must be a number with at most 2 decimals",
    vi: "Số tiền USD phải là số có tối đa 2 chữ số thập phân",
  },
  usdPositive: { en: "USD amount must be greater than zero", vi: "Số tiền USD phải lớn hơn 0" },
  time: { en: "Time", vi: "Thời gian" },
  source: { en: "Source", vi: "Nguồn" },
  kind: { en: "Kind", vi: "Loại" },
  amount: { en: "Amount", vi: "Số tiền" },
  balanceAfter: { en: "Balance after", vi: "Số dư sau" },
  request: { en: "Request", vi: "Request" },
  title: { en: "Credits", vi: "Tín dụng" },
  description: {
    en: "Wallet balance, top-ups and the append-only credit ledger.",
    vi: "Số dư ví, lịch sử nạp và sổ tín dụng chỉ-ghi-thêm.",
  },
  balance: { en: "Balance", vi: "Số dư" },
  reserved: { en: "Reserved", vi: "Đang giữ" },
  available: { en: "Available", vi: "Khả dụng" },
  ledger: { en: "Ledger", vi: "Sổ tín dụng" },
  noLedger: { en: "No ledger entries yet", vi: "Chưa có mục nào trong sổ" },
  noLedgerBody: {
    en: "Not available yet — entries appear after the first top-up or usage.",
    vi: "Chưa có dữ liệu — mục xuất hiện sau lần nạp hoặc sử dụng đầu tiên.",
  },
  topUp: { en: "Top up", vi: "Nạp tín dụng" },
  topUpCurrency: { en: "Top-up currency", vi: "Đơn vị nạp" },
  amountVnd: { en: "Amount (VND)", vi: "Số tiền (VND)" },
  amountUsd: { en: "Amount (USD)", vi: "Số tiền (USD)" },
  approxExact: {
    en: "(approximate — the server calculates the exact credit)",
    vi: "(ước tính — server tính số tín dụng chính xác)",
  },
  maxTopUp: {
    en: "Max top-up {max} · pending payments expire after {minutes} minutes.",
    vi: "Nạp tối đa {max} · thanh toán chờ hết hạn sau {minutes} phút.",
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
  creating: { en: "Creating payment…", vi: "Đang tạo thanh toán…" },
  continuePayos: { en: "Continue to PayOS", vi: "Tiếp tục tới PayOS" },
  createPayment: { en: "Create payment", vi: "Tạo thanh toán" },
  payosRedirect: {
    en: "Redirecting to PayOS checkout…",
    vi: "Đang chuyển tới trang thanh toán PayOS…",
  },
  paymentCreated: {
    en: "Payment created — waiting for admin confirmation",
    vi: "Đã tạo thanh toán — đang chờ quản trị viên xác nhận",
  },
  topUpFailed: { en: "Top-up failed", vi: "Nạp tín dụng thất bại" },
  promoCode: { en: "Promo code (optional)", vi: "Mã khuyến mãi (tuỳ chọn)" },
  promoPlaceholder: { en: "32-character code", vi: "Mã gồm 32 ký tự" },
  errPromoFormat: {
    en: "Codes are 32 letters or numbers — check for typos",
    vi: "Mã gồm 32 chữ cái hoặc chữ số — bạn kiểm tra lại giúp mình",
  },
  errPromoReplay: {
    en: "This code was already used by this workspace",
    vi: "Mã này đã được workspace này sử dụng",
  },
  errPromoExpired: { en: "This code has expired", vi: "Mã này đã hết hạn" },
  errPromoExhausted: {
    en: "This code has no uses left",
    vi: "Mã này đã hết lượt sử dụng",
  },
  errPromoInactive: {
    en: "This code is not active",
    vi: "Mã này hiện không hoạt động",
  },
  errPromoSuspended: {
    en: "This workspace is suspended, so codes cannot be applied",
    vi: "Workspace này đang bị tạm ngưng nên không thể áp dụng mã",
  },
  errPromoNotFound: {
    en: "Unknown code — check it and try again",
    vi: "Không tìm thấy mã — kiểm tra lại rồi thử nhé",
  },
  errPromoFixed: {
    en: "Fixed-credit codes are redeemed with the Redeem form, not at checkout",
    vi: "Mã tặng tín dụng cố định được đổi qua form Đổi mã, không dùng khi thanh toán",
  },
  errPromoGeneric: {
    en: "Applying the code failed — try again in a moment",
    vi: "Áp dụng mã không thành công — bạn thử lại sau ít phút nhé",
  },
  voucherApplied: {
    en: "Voucher applied: credit {original} − discount {discount} = due {due}",
    vi: "Đã áp mã: tín dụng {original} − giảm {discount} = phải thanh toán {due}",
  },
  completesWhen: {
    en: "Payment completes when the provider confirms; status shows on the Payments page.",
    vi: "Thanh toán hoàn tất khi nhà cung cấp xác nhận; trạng thái hiển thị tại trang Thanh toán.",
  },
  subscriptionCredit: { en: "Subscription credit", vi: "Tín dụng gói đăng ký" },
  periodEnds: { en: "Period ends", vi: "Kỳ kết thúc" },
  expired: { en: "(expired)", vi: "(hết hạn)" },
  reqPerMinute: {
    en: "{n} requests per minute",
    vi: "{n} request mỗi phút",
  },
  unusedLost: {
    en: "Unused subscription credit is lost when the period ends without a renewal.",
    vi: "Tín dụng gói đăng ký không dùng hết sẽ mất khi kỳ kết thúc mà không gia hạn.",
  },
  usageDeductions: { en: "Usage deductions", vi: "Khấu trừ sử dụng" },
  topUpHistory: { en: "Top-up history", vi: "Lịch sử nạp" },
  adjustmentsRefunds: { en: "Adjustments & refunds", vi: "Điều chỉnh & hoàn tiền" },
  noUsage: {
    en: "No usage yet — deductions appear after the first request.",
    vi: "Chưa có sử dụng — khấu trừ xuất hiện sau request đầu tiên.",
  },
  noTopUps: { en: "No top-ups yet.", vi: "Chưa có lần nạp nào." },
  noAdjustments: { en: "No adjustments or refunds.", vi: "Không có điều chỉnh hay hoàn tiền." },
  ledgerSections: { en: "Ledger sections", vi: "Phần của sổ tín dụng" },
} as const;

const makeSchema = (t: (k: keyof typeof creditsCopy) => string) =>
  z.object({
    amount: z.coerce.number().int(t("wholeVnd")).min(10_000, t("minTopUp")),
  });
type Values = z.infer<ReturnType<typeof makeSchema>>;

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

/** Display-safe payment limits from GET /api/v1/payment-config (hints only — the server enforces the real limits). */
export interface PaymentConfig {
  timeout_minutes: number;
  max_amount_vnd: number;
  usd_vnd_rate: number;
}

/** Union sent to POST payments; USD input stays a string end to end. */
type TopUpPayload =
  | { currency: "VND"; amount: number; promoCode?: string }
  | { currency: "USD"; usdAmount: string; promoCode?: string };

/** Server payment-creation response: voucher snapshot echo (absent when no promo). */
interface TopUpResponse {
  id: string;
  status: string;
  checkout_url: string;
  amount: number;
  original_amount_vnd?: number;
  discount_vnd?: number;
  promo_code_id?: string;
}

// Backend contract: promo codes are 32 hex characters, normalized
// trim().toUpperCase() server-side (see apps/api routes/admin-promotions).
const PROMO_CODE_PATTERN = /^[0-9a-f]{32}$/i;

/**
 * Total promo-apply error mapping: known server failure codes become one
 * dictionary key each; anything else (400 INVALID with mixed causes, network)
 * returns null so the caller can fall back to the server message verbatim.
 * Mirrors PROMO_APPLY_STATUS in apps/api/src/routes/payments.ts.
 */
export function promoApplyErrorKey(
  err: unknown,
):
  | "errPromoReplay"
  | "errPromoExpired"
  | "errPromoExhausted"
  | "errPromoInactive"
  | "errPromoSuspended"
  | "errPromoNotFound"
  | "errPromoFixed"
  | null {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "ALREADY_REDEEMED":
        return "errPromoReplay";
      case "PROMO_EXPIRED":
        return "errPromoExpired";
      case "PROMO_EXHAUSTED":
        return "errPromoExhausted";
      case "PROMO_INACTIVE":
        return "errPromoInactive";
      case "WORKSPACE_SUSPENDED":
        return "errPromoSuspended";
      case "NOT_FOUND":
        return "errPromoNotFound";
      case "PROMO_NOT_PERCENT":
        return "errPromoFixed";
    }
  }
  return null;
}

// USD input validation without numeric parsing: plain digits, at most 2
// decimals, at least one nonzero digit. The exact cents→VND conversion happens
// only on the server (BigInt cents at the configured rate).
const USD_INPUT_RE = /^\d+(\.\d{1,2})?$/;
function validateUsdInput(text: string, t: (k: keyof typeof creditsCopy) => string): string | null {
  const s = text.trim();
  if (s === "") return t("enterUsd");
  if (!USD_INPUT_RE.test(s)) return t("usdFormat");
  if (!/[1-9]/.test(s)) return t("usdPositive");
  return null;
}

export type LedgerColumns = ColumnDef<LedgerEntry>[];

const PRESETS = [50_000, 100_000, 200_000, 500_000];

export default function BillingCreditsPage() {
  const t = useT(creditsCopy);
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
    { accessorKey: "created_at", header: t("time"), cell: (c) => formatDate(c.getValue<string>()) },
    {
      accessorKey: "wallet_kind",
      header: t("source"),
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
      header: t("kind"),
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
      header: t("amount"),
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
      header: t("balanceAfter"),
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
      header: t("request"),
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
      <PageHeader title={t("title")} description={t("description")} />

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
              <StatCard label={t("balance")} value={wallet.data.balance} rate={rate} big />
              <StatCard label={t("reserved")} value={wallet.data.reserved} rate={rate} />
              <StatCard label={t("available")} value={wallet.data.available} rate={rate} />
            </div>
          )}

          <h2 className="text-sm font-semibold">{t("ledger")}</h2>
          {ledger.isPending ? (
            <Skeleton className="h-40 w-full" />
          ) : ledger.isError ? (
            <ErrorState message={ledger.error.message} />
          ) : ledger.data.data.length === 0 ? (
            <EmptyState icon={WalletIcon} title={t("noLedger")} description={t("noLedgerBody")} />
          ) : (
            <LedgerTabs columns={columns} sections={partitionLedger(ledger.data.data)} />
          )}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t("topUp")}</CardTitle>
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
  const t = useT(creditsCopy);
  const queryClient = useQueryClient();
  const schema = makeSchema(t);
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
  const usdProblem = validateUsdInput(usdText, t);

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

  // Optional percent-voucher code: controlled state only (same handling as the
  // redeem form — never persisted, never logged). Empty means no promo_code is
  // sent at all, so bodies without it stay byte-identical to the old shape.
  const [promoText, setPromoText] = useState("");
  const [promoError, setPromoError] = useState<string | null>(null);
  // Voucher snapshot display: set only from the authoritative response echo,
  // never from client math; cleared on the next submit attempt.
  const [voucherNote, setVoucherNote] = useState<{
    original: number;
    discount: number;
    due: number;
  } | null>(null);
  const promoCode = promoText.trim();
  const promoFormatBad = promoCode !== "" && !PROMO_CODE_PATTERN.test(promoCode);

  const topUp = useMutation({
    // provider is sent only for PayOS, so the manual bodies keep their
    // pre-existing shapes byte-identical: {amount} for VND, {usd_amount} for USD.
    // promo_code is added only when a code was typed (both currencies support
    // the voucher apply server-side; USD amounts resolve before the discount).
    mutationFn: (payload: TopUpPayload) => {
      const base =
        payload.currency === "USD"
          ? provider === "payos"
            ? { usd_amount: payload.usdAmount, provider }
            : { usd_amount: payload.usdAmount }
          : provider === "payos"
            ? { amount: payload.amount, provider }
            : { amount: payload.amount };
      const body = payload.promoCode ? { ...base, promo_code: payload.promoCode } : base;
      return api<TopUpResponse>(`/api/v1/workspaces/${workspaceId}/payments`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: async (payment) => {
      void queryClient.invalidateQueries({ queryKey: ["payments", workspaceId] });
      // The voucher snapshot echo is authoritative: original credit, snapshot
      // discount and final due come from the server response — never recomputed
      // client-side, and absent entirely when no promo was applied.
      if (payment.original_amount_vnd != null && payment.discount_vnd != null) {
        setPromoText("");
        setVoucherNote({
          original: payment.original_amount_vnd,
          discount: payment.discount_vnd,
          due: payment.amount,
        });
      }
      // PayOS hands back an absolute provider checkout URL: the only correct
      // action is a full browser redirect — no fake success, status is later
      // shown by the Payments page polling the backend. A relative path (the
      // manual response) stays an in-app navigation. Status is never read
      // from query parameters.
      if (!payment.checkout_url.startsWith("/")) {
        toast(t("payosRedirect"));
        window.location.assign(payment.checkout_url);
        return;
      }
      toast(t("paymentCreated"));
      onNavigate(`/billing/payments?payment=${payment.id}`);
    },
    onError: (err, payload) => {
      // Promo-apply failures surface next to the promo field; everything else
      // keeps its existing input routing.
      if (payload.promoCode) {
        const key = promoApplyErrorKey(err);
        setPromoError(key ? t(key) : err instanceof ApiError ? err.message : t("errPromoGeneric"));
        return;
      }
      const message = err instanceof ApiError ? err.message : t("topUpFailed");
      // Server errors stay visible next to whichever input produced them.
      if (payload.currency === "USD") setUsdError(message);
      else form.setError("amount", { message });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    // Promo format is validated before any POST (same 32-hex contract as the
    // redeem endpoint); empty means no code is sent at all.
    if (promoFormatBad) {
      setPromoError(t("errPromoFormat"));
      return;
    }
    setPromoError(null);
    setVoucherNote(null);
    const withPromo = <T extends object>(base: T) =>
      promoCode === "" ? base : { ...base, promoCode };
    if (currency === "USD") {
      const problem = validateUsdInput(usdText, t);
      if (problem !== null) {
        setUsdError(problem);
        return;
      }
      setUsdError(null);
      topUp.mutate(withPromo({ currency: "USD", usdAmount: usdText.trim() }));
      return;
    }
    void form.handleSubmit((v: Values) =>
      topUp.mutate(withPromo({ currency: "VND", amount: v.amount })),
    )(e);
  };

  return (
    <Form {...form}>
      <form onSubmit={submit} className="space-y-4">
        <div className="flex gap-1" role="group" aria-label={t("topUpCurrency")}>
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
                  <FormLabel>{t("amountVnd")}</FormLabel>
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
              <FormLabel htmlFor="topup_usd_amount">{t("amountUsd")}</FormLabel>
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
                {usdApproxVnd !== null ? `≈ ${formatVnd(usdApproxVnd)} ${t("approxExact")}` : ""}
              </p>
            </FormItem>
          </>
        )}
        {paymentConfig && (
          <p className="text-xs text-muted-foreground">
            {t("maxTopUp", {
              max: formatVnd(paymentConfig.max_amount_vnd),
              minutes: paymentConfig.timeout_minutes,
            })}
          </p>
        )}
        <FormItem>
          <FormLabel htmlFor="topup_promo_code">{t("promoCode")}</FormLabel>
          <FormControl>
            <Input
              id="topup_promo_code"
              value={promoText}
              onChange={(e) => {
                setPromoText(e.target.value);
                setPromoError(null);
              }}
              autoComplete="off"
              // A promo code is a bearer secret: no autofill, no save.
              spellCheck={false}
              placeholder={t("promoPlaceholder")}
              className="font-mono"
              aria-invalid={promoError !== null || promoFormatBad}
            />
          </FormControl>
          <FormMessage>{promoError ?? undefined}</FormMessage>
        </FormItem>
        {voucherNote ? (
          <p role="status" className="text-sm font-medium">
            {t("voucherApplied", {
              original: formatVnd(voucherNote.original),
              discount: formatVnd(voucherNote.discount),
              due: formatVnd(voucherNote.due),
            })}
          </p>
        ) : null}
        {payosAvailable && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("paymentMethod")}</legend>
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
                {t("manualTransfer")}
                <span className="block text-xs text-muted-foreground">
                  {t("manualTransferBody")}
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
                <span className="block text-xs text-muted-foreground">{t("payosBody")}</span>
              </span>
            </label>
          </fieldset>
        )}
        <Button type="submit" className="w-full" disabled={topUp.isPending}>
          {topUp.isPending
            ? t("creating")
            : provider === "payos"
              ? t("continuePayos")
              : t("createPayment")}
        </Button>
        <p className="text-xs text-muted-foreground">{t("completesWhen")}</p>
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
  const t = useT(creditsCopy);
  const usd = formatUsdFromVnd(subscription.balance, rate);
  return (
    <div className="min-w-0 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold">{t("subscriptionCredit")}</p>
        <p className="text-xs text-muted-foreground">{subscription.plan_name}</p>
      </div>
      <p
        className={`mt-1 font-mono text-2xl font-semibold ${subscription.expired ? "text-muted-foreground" : ""}`}
      >
        {usd ?? formatVnd(subscription.balance)}
      </p>
      <p className="mt-1 text-sm">
        {t("periodEnds")} <span className="font-mono">{formatDate(subscription.period_end)}</span>
        {subscription.expired ? ` ${t("expired")}` : ""}
      </p>
      <p className="text-sm text-muted-foreground">
        {t("reqPerMinute", { n: subscription.rate_limit_per_minute })}
      </p>
      <p className="mt-2 text-xs text-muted-foreground">{t("unusedLost")}</p>
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
  const t = useT(creditsCopy);
  const tabs = [
    {
      id: "usage",
      title: t("usageDeductions"),
      entries: sections.usage,
      empty: t("noUsage"),
    },
    {
      id: "topups",
      title: t("topUpHistory"),
      entries: sections.topups,
      empty: t("noTopUps"),
    },
    {
      id: "adjustments",
      title: t("adjustmentsRefunds"),
      entries: sections.adjustments,
      empty: t("noAdjustments"),
    },
  ];
  return (
    <Tabs defaultValue="usage" className="min-w-0">
      <TabsList aria-label={t("ledgerSections")} className="h-auto max-w-full flex-wrap">
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
