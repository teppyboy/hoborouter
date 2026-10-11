import { useRef, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Badge } from "../../components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { DataTable, PageHeader, ScrollPanel } from "../../components/page";
import { formatDate, formatUsdAmountText, formatVnd } from "../../lib/format";
import { ApiError, api } from "../../lib/api";
import { AdminGate, useAdminQuery } from "./shared";
import { useT, type LocaleEntry } from "../../lib/i18n/t";

// Admin catalog billing copy: keys name UI meaning (not the English sentence).
// Currency codes (USD/VND), numbers and amounts are data — untranslated.
export const adminBundlesCopy = {
  title: { en: "Bundles & plans", vi: "Gói credit & gói đăng ký" },
  description: {
    en: "Purchasable credit bundles and subscription plans. Amounts are fixed at creation; deactivate instead of deleting.",
    vi: "Gói credit mua được và gói đăng ký. Số tiền cố định khi tạo; hãy ngừng hoạt động thay vì xoá.",
  },

  // Shared chrome.
  createdToast: { en: "Created", vi: "Đã tạo" },
  requestFailed: { en: "Request failed", vi: "Yêu cầu thất bại" },
  cancel: { en: "Cancel", vi: "Huỷ" },
  save: { en: "Save", vi: "Lưu" },

  // Edit dialog: metadata edits PATCH in place; financial edits revise.
  edit: { en: "Edit", vi: "Sửa" },
  editDialogTitle: { en: "Edit catalog item", vi: "Sửa mục danh mục" },
  editDialogDescription: {
    en: "Name and rate limit save in place. Changing amounts creates a replacement item for future purchases.",
    vi: "Tên và giới hạn lưu trực tiếp. Đổi số tiền sẽ tạo mục thay thế cho các lần mua sau.",
  },
  termsFutureOnly: {
    en: "New terms apply to future purchases only. Pending payments settle on the old terms; history is retained and nothing is credited retroactively.",
    vi: "Điều khoản mới chỉ áp dụng cho các lần mua sau. Thanh toán đang chờ vẫn tất toán theo điều khoản cũ; lịch sử được giữ nguyên và không hoàn tín dụng hồi tố.",
  },
  reviseTerms: { en: "Revise terms", vi: "Sửa điều khoản" },
  revisedToast: { en: "Terms revised", vi: "Đã sửa điều khoản" },
  superseded: {
    en: "This item was already superseded by another revision. Reload to see the current item.",
    vi: "Mục này đã được thay thế bởi một lần sửa khác. Hãy tải lại để xem mục hiện tại.",
  },

  // Catalog table columns / row actions.
  colName: { en: "Name", vi: "Tên" },
  colPrice: { en: "Price", vi: "Giá" },
  colStatus: { en: "Status", vi: "Trạng thái" },
  colCreated: { en: "Created", vi: "Đã tạo" },
  active: { en: "Active", vi: "Đang bán" },
  inactive: { en: "Inactive", vi: "Đang ẩn" },
  deactivate: { en: "Deactivate", vi: "Ngừng bán" },
  reactivate: { en: "Reactivate", vi: "Bán lại" },
  noRowsYet: { en: "No {thing} yet", vi: "Chưa có {thing} nào" },

  // Bundles card.
  bundlesCardTitle: { en: "Credit bundles", vi: "Gói credit" },
  bundlesTableLabel: { en: "Credit bundles", vi: "Gói credit" },
  nameLabel: { en: "Name", vi: "Tên" },
  priceLabel: { en: "Price", vi: "Giá" },
  creditLabel: { en: "Credit", vi: "Tín dụng" },
  bonusLabel: { en: "Bonus", vi: "Thưởng" },
  priceCurrency: { en: "Price currency", vi: "Đơn vị giá" },
  creditCurrency: { en: "Credit currency", vi: "Đơn vị tín dụng" },
  bonusCurrency: { en: "Bonus currency", vi: "Đơn vị thưởng" },
  createBundle: { en: "Create bundle", vi: "Tạo gói" },
  creating: { en: "Creating…", vi: "Đang tạo…" },

  // Plans card.
  plansCardTitle: { en: "Subscription plans", vi: "Gói đăng ký" },
  plansTableLabel: { en: "Subscription plans", vi: "Gói đăng ký" },
  planCreditDetailLabel: { en: "Credit/period", vi: "Tín dụng/kỳ" },
  creditPerPeriodLabel: { en: "Credit per period", vi: "Tín dụng mỗi kỳ" },
  creditPerPeriodCurrency: {
    en: "Credit per period currency",
    vi: "Đơn vị tín dụng mỗi kỳ",
  },
  planPriceCurrency: { en: "Plan price currency", vi: "Đơn vị giá gói" },
  periodDaysLabel: { en: "Period days", vi: "Số ngày kỳ" },
  rateLimitLabel: { en: "Rate limit (req/min)", vi: "Giới hạn (req/phút)" },
  dailyGrantLabel: { en: "Daily grant (VND)", vi: "Tặng mỗi ngày (VND)" },
  createPlan: { en: "Create plan", vi: "Tạo gói đăng ký" },

  // Help text.
  amountsHelp: {
    en: "USD prices are stored exactly as authored; the VND credit is derived once at creation and never recomputed.",
    vi: "Giá USD được lưu nguyên bản khi nhập; tín dụng VND được quy đổi một lần khi tạo và không bao giờ tính lại.",
  },

  // Credit detail line (amounts are formatted numbers; only the words move).
  creditDetail: {
    en: "{credit} credit · {grant} grant (fixed at creation){bonus}",
    vi: "{credit} tín dụng · {grant} tặng (cố định khi tạo){bonus}",
  },
  bonusPartUsd: { en: " + {amount} bonus", vi: " + {amount} thưởng" },
  planDetailTail: { en: "{days}d · {rate}/min", vi: "{days} ngày · {rate}/phút" },
  dailyGrantDetail: { en: " + {amount}/day", vi: " + {amount}/ngày" },

  // Amount validation (shared shapes per field).
  usdInvalid: {
    en: "Enter a USD amount like {example} (up to two decimals, no sign).",
    vi: "Nhập số USD dạng {example} (tối đa hai chữ số thập phân, không có dấu).",
  },
  vndPositive: {
    en: "Enter a whole VND amount greater than 0.",
    vi: "Nhập số VND nguyên lớn hơn 0.",
  },
  vndNonNegative: {
    en: "Enter a whole VND amount of 0 or more.",
    vi: "Nhập số VND nguyên từ 0 trở lên.",
  },
  periodInvalid: {
    en: "Enter a whole number of days, at least 1.",
    vi: "Nhập số ngày nguyên, ít nhất là 1.",
  },
  rateInvalid: {
    en: "Rate limit is between 1 and 600 requests per minute.",
    vi: "Giới hạn nằm trong khoảng 1 đến 600 request mỗi phút.",
  },
} as const satisfies Record<string, LocaleEntry>;

export type BundlesT = (
  key: keyof typeof adminBundlesCopy,
  vars?: Record<string, string | number>,
) => string;

interface Bundle {
  id: string;
  name: string;
  price_vnd: number;
  credit_vnd: number;
  bonus_vnd: number;
  /** Authored USD price text; null/absent for legacy VND-authored rows. */
  price_usd?: string | null;
  credit_usd?: string | null;
  bonus_usd?: string | null;
  active: boolean;
  created_at: number;
}

interface Plan {
  id: string;
  name: string;
  price_vnd: number;
  credit_per_period_vnd: number;
  price_usd?: string | null;
  credit_per_period_usd?: string | null;
  period_days: number;
  rate_limit_per_minute: number;
  /** Authored once-per-UTC-day VND grant; 0 = none. */
  daily_grant_vnd: number;
  active: boolean;
  created_at: number;
}

interface CatalogRow {
  id: string;
  name: string;
  price_vnd: number;
  price_usd?: string | null;
  active: boolean;
  created_at: number;
}

/** One authoring amount: its own currency choice plus both raw texts. */
interface AmountInput {
  currency: "USD" | "VND";
  usd: string;
  vnd: string;
}

/** Integer VND from a text field; null when not a safe integer. Sign is the caller's rule. */
export function parseIntVnd(raw: string): number | null {
  const s = raw.trim();
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Exact USD decimal text from a form field; null when not valid catalog
 * syntax (at most two decimals, no sign/exponent). The text is POSTed
 * verbatim — the server derives VND, never the client. Sign is the
 * caller's rule (price > 0, credit/bonus >= 0).
 */
export function parseUsdAmount(raw: string): string | null {
  const s = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return s;
}

function useCatalogMutation(path: string, key: readonly unknown[], t: BundlesT) {
  const qc = useQueryClient();
  const onError = (e: unknown) =>
    toast.error(e instanceof ApiError ? e.message : t("requestFailed"));
  const create = useMutation({
    mutationFn: (body: Record<string, number | string>) =>
      api<CatalogRow>(path, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      toast(t("createdToast"));
      void qc.invalidateQueries({ queryKey: key });
    },
    onError,
  });
  const update = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: { name?: string; active?: boolean; rate_limit_per_minute?: number };
    }) => api<CatalogRow>(`${path}/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError,
  });
  const revise = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, number | string> }) =>
      api<unknown>(`${path}/${id}/revise`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      toast(t("revisedToast"));
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => {
      onError(e);
      // Superseded guidance needs fresh rows: refresh so the next edit opens
      // on the authoritative row instead of the captured stale one.
      if (e instanceof ApiError && e.status === 409) void qc.invalidateQueries({ queryKey: key });
    },
  });
  return { create, update, revise };
}

/** Currency mode toggle; USD is the default authoring currency, VND is legacy. */
function CurrencyToggle({
  value,
  onChange,
  label,
}: {
  value: "USD" | "VND";
  onChange: (c: "USD" | "VND") => void;
  /** Unique accessible name; each amount field owns its own toggle. */
  label: string;
}) {
  return (
    <div className="flex gap-1" role="group" aria-label={label}>
      {(["USD", "VND"] as const).map((c) => (
        <Button
          key={c}
          type="button"
          size="sm"
          variant={value === c ? "default" : "outline"}
          aria-pressed={value === c}
          onClick={() => onChange(c)}
        >
          {c}
        </Button>
      ))}
    </div>
  );
}

/**
 * One authoring amount with an independent USD/VND selector. Exactly one raw
 * text is submitted per field — the currency of its own toggle — so a bundle
 * can mix, say, a USD price with a VND credit. Untoggled texts stay in state
 * but never reach the request body.
 */
function AmountField({
  idPrefix,
  label,
  groupLabel,
  field,
  onChange,
  usdPlaceholder,
  vndPlaceholder,
  error,
}: {
  idPrefix: string;
  label: string;
  groupLabel: string;
  field: AmountInput;
  onChange: (f: AmountInput) => void;
  usdPlaceholder: string;
  vndPlaceholder: string;
  /** Validation message for the ACTIVE currency's text; null = no error. */
  error: string | null;
}) {
  return (
    <div className="grid gap-1">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={`${idPrefix}-${field.currency.toLowerCase()}`}>
          {label} ({field.currency})
        </Label>
        <CurrencyToggle
          value={field.currency}
          onChange={(c) => onChange({ ...field, currency: c })}
          label={groupLabel}
        />
      </div>
      {field.currency === "USD" ? (
        <Input
          id={`${idPrefix}-usd`}
          value={field.usd}
          onChange={(e) => onChange({ ...field, usd: e.target.value })}
          placeholder={usdPlaceholder}
          inputMode="decimal"
          aria-invalid={error !== null}
          aria-describedby={error !== null ? `${idPrefix}-error` : undefined}
          className={error !== null ? "border-destructive" : undefined}
        />
      ) : (
        <Input
          id={`${idPrefix}-vnd`}
          value={field.vnd}
          onChange={(e) => onChange({ ...field, vnd: e.target.value })}
          placeholder={vndPlaceholder}
          inputMode="numeric"
          aria-invalid={error !== null}
          aria-describedby={error !== null ? `${idPrefix}-error` : undefined}
          className={error !== null ? "border-destructive" : undefined}
        />
      )}
      {error !== null && (
        <p id={`${idPrefix}-error`} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function CreateField({
  id,
  label,
  value,
  onChange,
  placeholder,
  error,
  decimal,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  /** Validation message; null = no error. Empty text stays unflagged. */
  error?: string | null;
  decimal?: boolean;
}) {
  const invalid = error != null && error !== "";
  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode={decimal ? "decimal" : "numeric"}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${id}-error` : undefined}
        className={invalid ? "border-destructive" : undefined}
      />
      {invalid && (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** A row captured at dialog-open time; the dialog edits this snapshot, not live query data. */
type EditTarget = { kind: "bundle"; row: Bundle } | { kind: "plan"; row: Plan };

/** Prefill: USD rows keep their exact authored text; legacy rows prefill VND. */
const amountFrom = (usd: string | null | undefined, vnd: number): AmountInput =>
  usd != null && usd !== ""
    ? { currency: "USD", usd, vnd: String(vnd) }
    : { currency: "VND", usd: "", vnd: String(vnd) };

/** Successor/old row id from a revise response (`{data: row}` per contract; bare row tolerated). */
const revisedRowId = (res: unknown): string | null => {
  const d =
    res !== null && typeof res === "object" ? ((res as { data?: unknown }).data ?? res) : null;
  if (d !== null && typeof d === "object" && typeof (d as { id?: unknown }).id === "string")
    return (d as { id: string }).id;
  return null;
};

const rateLimitInvalid = (v: number | null) => v === null || v < 1 || v > 600;

/**
 * One edit dialog per catalog row. Metadata fields (name, plan rate limit)
 * go through the existing PATCH; any financial-terms change submits the full
 * create-shape body to POST .../revise (no rate limit — RPM stays a live
 * PATCH field on the authoritative row). An unchanged or invalid dialog
 * submits nothing.
 */
function EditDialog({
  target,
  onPatch,
  onRevise,
  onClose,
}: {
  target: EditTarget;
  onPatch: (
    id: string,
    body: { name?: string; rate_limit_per_minute?: number },
  ) => Promise<unknown>;
  onRevise: (id: string, body: Record<string, number | string>) => Promise<unknown>;
  onClose: () => void;
}) {
  const t = useT(adminBundlesCopy);
  const row = target.row;
  const isPlan = target.kind === "plan";
  const [name, setName] = useState(row.name);
  // Initializers run once per mount (the dialog remounts with a row key), so
  // they can read the captured row directly.
  const [rate, setRate] = useState(
    target.kind === "plan" ? String(target.row.rate_limit_per_minute) : "",
  );
  const [period, setPeriod] = useState(
    target.kind === "plan" ? String(target.row.period_days) : "",
  );
  // Blank means "keep the row's current grant" (carried by the server), so a
  // 0-grant plan prefills blank instead of "0" — keeps legacy rows without
  // the column rendering a valid, unchanged dialog.
  const [dailyGrant, setDailyGrant] = useState(
    target.kind === "plan" && target.row.daily_grant_vnd > 0
      ? String(target.row.daily_grant_vnd)
      : "",
  );
  const [price, setPrice] = useState<AmountInput>(() => amountFrom(row.price_usd, row.price_vnd));
  const [credit, setCredit] = useState<AmountInput>(() =>
    target.kind === "bundle"
      ? amountFrom(target.row.credit_usd, target.row.credit_vnd)
      : amountFrom(target.row.credit_per_period_usd, target.row.credit_per_period_vnd),
  );
  const [bonus, setBonus] = useState<AmountInput>(() =>
    target.kind === "bundle"
      ? amountFrom(target.row.bonus_usd, target.row.bonus_vnd)
      : zeroAmount(),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Synchronous submit guard: state updates lag a click, a ref does not.
  const inFlight = useRef(false);

  const priceN = parseIntVnd(price.vnd);
  const creditN = parseIntVnd(credit.vnd);
  const bonusN = parseIntVnd(bonus.vnd);
  const priceUsdT = parseUsdAmount(price.usd);
  const creditUsdT = parseUsdAmount(credit.usd);
  const bonusUsdT = parseUsdAmount(bonus.usd);
  const periodN = parseIntVnd(period);
  const rateN = parseIntVnd(rate);
  const dailyGrantN = parseIntVnd(dailyGrant);

  const priceError =
    price.currency === "USD"
      ? price.usd !== "" && priceUsdT === null
        ? t("usdInvalid", { example: "9.99" })
        : null
      : price.vnd !== "" && (priceN === null || priceN <= 0)
        ? t("vndPositive")
        : null;
  const creditError =
    credit.currency === "USD"
      ? credit.usd !== "" && creditUsdT === null
        ? t("usdInvalid", { example: "12" })
        : null
      : credit.vnd !== "" && (creditN === null || creditN < 0)
        ? t("vndNonNegative")
        : null;
  const bonusError =
    bonus.currency === "USD"
      ? bonus.usd !== "" && bonusUsdT === null
        ? t("usdInvalid", { example: "2.50" })
        : null
      : bonus.vnd !== "" && (bonusN === null || bonusN < 0)
        ? t("vndNonNegative")
        : null;
  const periodError =
    period !== "" && (periodN === null || periodN < 1) ? t("periodInvalid") : null;
  const rateError = rate !== "" && rateLimitInvalid(rateN) ? t("rateInvalid") : null;
  const dailyGrantError =
    dailyGrant !== "" && (dailyGrantN === null || dailyGrantN < 0) ? t("vndNonNegative") : null;

  const nameValid = name.trim().length > 0;
  const moneyValid =
    (price.currency === "USD"
      ? priceUsdT !== null && Number(priceUsdT) > 0
      : priceN !== null && priceN > 0) &&
    (credit.currency === "USD" ? creditUsdT !== null : creditN !== null && creditN >= 0) &&
    (isPlan
      ? (period === "" || (periodN !== null && periodN >= 1)) &&
        (dailyGrant === "" || (dailyGrantN !== null && dailyGrantN >= 0))
      : bonus.currency === "USD"
        ? bonusUsdT !== null || bonus.usd.trim() === ""
        : (bonusN !== null && bonusN >= 0) || bonus.vnd.trim() === "");

  const nameChanged = name.trim() !== row.name;
  const rateChanged =
    target.kind === "plan" && rateN !== null && rateN !== target.row.rate_limit_per_minute;
  // Money change compares the would-submit value against the row's own
  // authored metadata, per field and currency — never a recomputed amount.
  const moneyChanged = (() => {
    if (target.kind === "bundle") {
      const b = target.row;
      return (
        (price.currency === "USD" ? b.price_usd !== priceUsdT : b.price_vnd !== priceN) ||
        (credit.currency === "USD" ? b.credit_usd !== creditUsdT : b.credit_vnd !== creditN) ||
        (bonus.currency === "USD"
          ? b.bonus_usd !== (bonusUsdT ?? "0")
          : b.bonus_vnd !== (bonusN ?? 0))
      );
    }
    const p = target.row;
    return (
      (price.currency === "USD" ? p.price_usd !== priceUsdT : p.price_vnd !== priceN) ||
      (credit.currency === "USD"
        ? p.credit_per_period_usd !== creditUsdT
        : p.credit_per_period_vnd !== creditN) ||
      (periodN !== null && periodN !== p.period_days) ||
      // Blank means "keep the row's current grant" (carried by the server).
      (dailyGrant !== "" && dailyGrantN !== p.daily_grant_vnd)
    );
  })();
  const changed = nameChanged || rateChanged || moneyChanged;

  const submit = async () => {
    if (inFlight.current || busy) return;
    const nameT = name.trim();
    if (!nameValid || !moneyValid || !changed) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      let patchId = row.id;
      if (moneyChanged) {
        // Full create-shape body: the successor is a brand-new purchasable
        // row. Rate limit is deliberately absent — it is not frozen terms.
        const body: Record<string, number | string> = { name: nameT };
        if (price.currency === "USD") body.price_usd = priceUsdT!;
        else body.price_vnd = priceN!;
        if (target.kind === "bundle") {
          if (credit.currency === "USD") body.credit_usd = creditUsdT!;
          else body.credit_vnd = creditN!;
          if (bonus.currency === "USD") body.bonus_usd = bonusUsdT ?? "0";
          else body.bonus_vnd = bonusN ?? 0;
        } else {
          if (credit.currency === "USD") body.credit_per_period_usd = creditUsdT!;
          else body.credit_per_period_vnd = creditN!;
          if (periodN !== null) body.period_days = periodN!;
          if (dailyGrant !== "" && dailyGrantN !== null) body.daily_grant_vnd = dailyGrantN;
        }
        const res = await onRevise(row.id, body);
        const successorId = revisedRowId(res);
        if (successorId !== null) patchId = successorId;
      }
      const patchBody: { name?: string; rate_limit_per_minute?: number } = {};
      if (!moneyChanged && nameChanged) patchBody.name = nameT;
      if (rateChanged) patchBody.rate_limit_per_minute = rateN!;
      if (Object.keys(patchBody).length > 0) await onPatch(patchId, patchBody);
      onClose();
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "RESOURCE_SUPERSEDED"
          ? t("superseded")
          : e instanceof ApiError
            ? e.message
            : t("requestFailed"),
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("editDialogTitle")}</DialogTitle>
          <DialogDescription>{t("editDialogDescription")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label htmlFor="edit-name">{t("nameLabel")}</Label>
            <Input
              id="edit-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={!nameValid}
              autoFocus
            />
          </div>
          <AmountField
            idPrefix="edit-price"
            label={t("priceLabel")}
            groupLabel={isPlan ? t("planPriceCurrency") : t("priceCurrency")}
            field={price}
            onChange={setPrice}
            usdPlaceholder="9.99"
            vndPlaceholder="500000"
            error={priceError}
          />
          <AmountField
            idPrefix="edit-credit"
            label={isPlan ? t("creditPerPeriodLabel") : t("creditLabel")}
            groupLabel={isPlan ? t("creditPerPeriodCurrency") : t("creditCurrency")}
            field={credit}
            onChange={setCredit}
            usdPlaceholder="12"
            vndPlaceholder="500000"
            error={creditError}
          />
          {isPlan ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <CreateField
                  id="edit-period"
                  label={t("periodDaysLabel")}
                  value={period}
                  onChange={setPeriod}
                  placeholder="30"
                  error={periodError}
                />
                <CreateField
                  id="edit-rate"
                  label={t("rateLimitLabel")}
                  value={rate}
                  onChange={setRate}
                  placeholder="15"
                  error={rateError}
                />
              </div>
              <CreateField
                id="edit-daily-grant"
                label={t("dailyGrantLabel")}
                value={dailyGrant}
                onChange={setDailyGrant}
                placeholder="0"
                error={dailyGrantError}
              />
            </>
          ) : (
            <AmountField
              idPrefix="edit-bonus"
              label={t("bonusLabel")}
              groupLabel={t("bonusCurrency")}
              field={bonus}
              onChange={setBonus}
              usdPlaceholder="0"
              vndPlaceholder="0"
              error={bonusError}
            />
          )}
        </div>
        {moneyChanged && (
          <p className="text-xs text-amber-600" role="note">
            {t("termsFutureOnly")}
          </p>
        )}
        {error !== null && (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button disabled={busy || !nameValid || !moneyValid || !changed} onClick={submit}>
            {moneyChanged ? t("reviseTerms") : t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CatalogTable<T extends CatalogRow>({
  data,
  detailLabel,
  detail,
  onEdit,
  onSetActive,
  editTarget,
  setEditTarget,
  onPatch,
  onRevise,
  tableLabel,
}: {
  data: T[];
  tableLabel: string;
  detailLabel: string;
  detail: (row: T) => string;
  /** Open the edit dialog for a row; the row object is captured at open time. */
  onEdit: (row: T) => void;
  onSetActive: (row: T, active: boolean) => void;
  editTarget: EditTarget | null;
  setEditTarget: (target: EditTarget | null) => void;
  onPatch: (
    id: string,
    body: { name?: string; rate_limit_per_minute?: number },
  ) => Promise<unknown>;
  onRevise: (id: string, body: Record<string, number | string>) => Promise<unknown>;
}) {
  const t = useT(adminBundlesCopy);
  const columns: ColumnDef<T, unknown>[] = [
    { accessorKey: "name", header: t("colName") },
    {
      accessorKey: "price_vnd",
      header: t("colPrice"),
      cell: (c) => {
        const row = c.row.original;
        if (row.price_usd) {
          // Authored USD price is the source of truth; VND shown as the
          // creation-time derived equivalent.
          return (
            <span className="font-mono text-xs">
              {formatUsdAmountText(row.price_usd)}
              <span className="block text-muted-foreground">{formatVnd(row.price_vnd)}</span>
            </span>
          );
        }
        return <span className="font-mono text-xs">{formatVnd(row.price_vnd)}</span>;
      },
    },
    {
      id: "detail",
      header: detailLabel,
      cell: (c) => <span className="font-mono text-xs">{detail(c.row.original)}</span>,
    },
    {
      accessorKey: "active",
      header: t("colStatus"),
      cell: (c) =>
        c.getValue<boolean>() ? (
          <Badge>{t("active")}</Badge>
        ) : (
          <Badge variant="secondary">{t("inactive")}</Badge>
        ),
    },
    {
      accessorKey: "created_at",
      header: t("colCreated"),
      cell: (c) => (
        <span className="font-mono text-xs">{formatDate(new Date(c.getValue<number>()))}</span>
      ),
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      cell: (c) => {
        const row = c.row.original;
        return (
          <span className="flex flex-wrap items-center gap-1">
            <Button size="sm" variant="outline" onClick={() => onEdit(row)}>
              {t("edit")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => onSetActive(row, !row.active)}>
              {row.active ? t("deactivate") : t("reactivate")}
            </Button>
          </span>
        );
      },
    },
  ];
  return (
    <>
      {/* Long catalogs scroll inside their own panel instead of growing the page. */}
      <ScrollPanel label={tableLabel} stickyHeader>
        <DataTable
          columns={columns}
          data={data}
          empty={t("noRowsYet", { thing: detailLabel.toLowerCase() })}
          globalFilter=""
        />
      </ScrollPanel>
      {/* Remounts per captured row: prefilled state always reflects the row
          that was current when Edit was clicked. */}
      {editTarget && (
        <EditDialog
          key={`${editTarget.kind}:${editTarget.row.id}`}
          target={editTarget}
          onPatch={onPatch}
          onRevise={onRevise}
          onClose={() => setEditTarget(null)}
        />
      )}
    </>
  );
}

const emptyAmount = (): AmountInput => ({ currency: "USD", usd: "", vnd: "" });
const zeroAmount = (): AmountInput => ({ currency: "USD", usd: "0", vnd: "0" });

function BundlesCard({ query }: { query: { data?: { data: Bundle[] } } }) {
  const t = useT(adminBundlesCopy);
  const { create, update, revise } = useCatalogMutation(
    "/api/v1/admin/bundles",
    ["admin", "bundles"],
    t,
  );
  const [name, setName] = useState("");
  const [price, setPrice] = useState<AmountInput>(emptyAmount);
  const [credit, setCredit] = useState<AmountInput>(emptyAmount);
  const [bonus, setBonus] = useState<AmountInput>(zeroAmount);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const patchAsync = (id: string, body: { name?: string; rate_limit_per_minute?: number }) =>
    update.mutateAsync({ id, body });
  const reviseAsync = (id: string, body: Record<string, number | string>) =>
    revise.mutateAsync({ id, body });

  const priceN = parseIntVnd(price.vnd);
  const creditN = parseIntVnd(credit.vnd);
  const bonusN = parseIntVnd(bonus.vnd);
  const priceUsdT = parseUsdAmount(price.usd);
  const creditUsdT = parseUsdAmount(credit.usd);
  const bonusUsdT = parseUsdAmount(bonus.usd);
  // Only the field's own active currency is validated; the hidden text of a
  // toggled field is dormant state, never part of the request body. A blank
  // bonus is valid: it is submitted as 0, matching the server default.
  const valid =
    name.trim().length > 0 &&
    (price.currency === "USD"
      ? priceUsdT !== null && Number(priceUsdT) > 0
      : priceN !== null && priceN > 0) &&
    (credit.currency === "USD" ? creditUsdT !== null : creditN !== null && creditN >= 0) &&
    (bonus.currency === "USD"
      ? bonusUsdT !== null || bonus.usd.trim() === ""
      : (bonusN !== null && bonusN >= 0) || bonus.vnd.trim() === "");

  const priceError =
    price.currency === "USD"
      ? price.usd !== "" && priceUsdT === null
        ? t("usdInvalid", { example: "9.99" })
        : null
      : price.vnd !== "" && (priceN === null || priceN <= 0)
        ? t("vndPositive")
        : null;
  const creditError =
    credit.currency === "USD"
      ? credit.usd !== "" && creditUsdT === null
        ? t("usdInvalid", { example: "12" })
        : null
      : credit.vnd !== "" && (creditN === null || creditN < 0)
        ? t("vndNonNegative")
        : null;
  const bonusError =
    bonus.currency === "USD"
      ? bonus.usd !== "" && bonusUsdT === null
        ? t("usdInvalid", { example: "2.50" })
        : null
      : bonus.vnd !== "" && (bonusN === null || bonusN < 0)
        ? t("vndNonNegative")
        : null;

  const reset = () => {
    setName("");
    setPrice(emptyAmount());
    setCredit(emptyAmount());
    setBonus(zeroAmount());
  };
  const submit = () => {
    // Exactly one amount key per field, keyed by that field's own currency.
    // No fabricated USD metadata: a VND-authored field sends only its VND key.
    const body: Record<string, number | string> = { name: name.trim() };
    if (price.currency === "USD") body.price_usd = priceUsdT!;
    else body.price_vnd = priceN!;
    if (credit.currency === "USD") body.credit_usd = creditUsdT!;
    else body.credit_vnd = creditN!;
    // Bonus defaults to "0" server-side; sent explicitly for clarity.
    if (bonus.currency === "USD") body.bonus_usd = bonusUsdT ?? "0";
    else body.bonus_vnd = bonusN ?? 0;
    create.mutate(body, { onSuccess: reset });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{t("bundlesCardTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5 sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) submit();
          }}
        >
          <CreateField
            id="bundle-name"
            label={t("nameLabel")}
            value={name}
            onChange={setName}
            placeholder="500k pack"
          />
          <AmountField
            idPrefix="bundle-price"
            label={t("priceLabel")}
            groupLabel={t("priceCurrency")}
            field={price}
            onChange={setPrice}
            usdPlaceholder="9.99"
            vndPlaceholder="500000"
            error={priceError}
          />
          <AmountField
            idPrefix="bundle-credit"
            label={t("creditLabel")}
            groupLabel={t("creditCurrency")}
            field={credit}
            onChange={setCredit}
            usdPlaceholder="12"
            vndPlaceholder="500000"
            error={creditError}
          />
          <AmountField
            idPrefix="bundle-bonus"
            label={t("bonusLabel")}
            groupLabel={t("bonusCurrency")}
            field={bonus}
            onChange={setBonus}
            usdPlaceholder="0"
            vndPlaceholder="0"
            error={bonusError}
          />
          <Button type="submit" disabled={!valid || create.isPending}>
            {create.isPending ? t("creating") : t("createBundle")}
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">{t("amountsHelp")}</p>
        <CatalogTable
          data={query.data?.data ?? []}
          tableLabel={t("bundlesTableLabel")}
          detailLabel={t("creditLabel")}
          detail={(b) => {
            // Each grant uses its OWN USD metadata, independent of the price
            // currency: mixed rows may pair USD price with VND credit or
            // vice versa, and legacy rows keep plain VND display.
            const bonusPart = b.bonus_usd
              ? Number(b.bonus_usd) > 0
                ? t("bonusPartUsd", { amount: formatUsdAmountText(b.bonus_usd) })
                : ""
              : b.bonus_vnd > 0
                ? t("bonusPartUsd", { amount: formatVnd(b.bonus_vnd) })
                : "";
            if (b.credit_usd) {
              return t("creditDetail", {
                credit: formatUsdAmountText(b.credit_usd),
                grant: formatVnd(b.credit_vnd),
                bonus: bonusPart,
              });
            }
            return formatVnd(b.credit_vnd) + bonusPart;
          }}
          onEdit={(row) => setEditTarget({ kind: "bundle", row })}
          onSetActive={(row, active) => update.mutate({ id: row.id, body: { active } })}
          editTarget={editTarget}
          setEditTarget={setEditTarget}
          onPatch={patchAsync}
          onRevise={reviseAsync}
        />
      </CardContent>
    </Card>
  );
}

function PlansCard({ query }: { query: { data?: { data: Plan[] } } }) {
  const t = useT(adminBundlesCopy);
  const { create, update, revise } = useCatalogMutation(
    "/api/v1/admin/subscription-plans",
    ["admin", "subscription-plans"],
    t,
  );
  const [name, setName] = useState("");
  const [price, setPrice] = useState<AmountInput>(emptyAmount);
  const [credit, setCredit] = useState<AmountInput>(emptyAmount);
  const [period, setPeriod] = useState("30");
  const [rateLimit, setRateLimit] = useState("15");
  const [dailyGrant, setDailyGrant] = useState("");
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const patchAsync = (id: string, body: { name?: string; rate_limit_per_minute?: number }) =>
    update.mutateAsync({ id, body });
  const reviseAsync = (id: string, body: Record<string, number | string>) =>
    revise.mutateAsync({ id, body });

  const priceN = parseIntVnd(price.vnd);
  const creditN = parseIntVnd(credit.vnd);
  const periodN = parseIntVnd(period);
  const rateN = parseIntVnd(rateLimit);
  const dailyGrantN = parseIntVnd(dailyGrant);
  const priceUsdT = parseUsdAmount(price.usd);
  const creditUsdT = parseUsdAmount(credit.usd);
  const rateInvalid = (v: number | null) => v === null || v < 1 || v > 600;
  const sharedValid =
    name.trim().length > 0 &&
    (period === "" || (periodN !== null && periodN >= 1)) &&
    (rateLimit === "" || !rateInvalid(rateN));
  const priceError =
    price.currency === "USD"
      ? price.usd !== "" && priceUsdT === null
        ? t("usdInvalid", { example: "9.99" })
        : null
      : price.vnd !== "" && (priceN === null || priceN <= 0)
        ? t("vndPositive")
        : null;
  const creditError =
    credit.currency === "USD"
      ? credit.usd !== "" && creditUsdT === null
        ? t("usdInvalid", { example: "12" })
        : null
      : credit.vnd !== "" && (creditN === null || creditN < 0)
        ? t("vndNonNegative")
        : null;
  const periodError =
    period !== "" && (periodN === null || periodN < 1) ? t("periodInvalid") : null;
  const rateError = rateLimit !== "" && rateInvalid(rateN) ? t("rateInvalid") : null;
  const dailyGrantError =
    dailyGrant !== "" && (dailyGrantN === null || dailyGrantN < 0) ? t("vndNonNegative") : null;
  // Only the field's own active currency is validated; the hidden text of a
  // toggled field is dormant state, never part of the request body.
  const valid =
    sharedValid &&
    dailyGrantError === null &&
    (price.currency === "USD"
      ? priceUsdT !== null && Number(priceUsdT) > 0
      : priceN !== null && priceN > 0) &&
    (credit.currency === "USD" ? creditUsdT !== null : creditN !== null && creditN >= 0);

  const reset = () => {
    setName("");
    setPrice(emptyAmount());
    setCredit(emptyAmount());
    setPeriod("30");
    setRateLimit("15");
    setDailyGrant("");
  };
  const submit = () => {
    // Exactly one amount key per field, keyed by that field's own currency.
    // No fabricated USD metadata: a VND-authored field sends only its VND key.
    const body: Record<string, number | string> = { name: name.trim() };
    if (price.currency === "USD") body.price_usd = priceUsdT!;
    else body.price_vnd = priceN!;
    if (credit.currency === "USD") body.credit_per_period_usd = creditUsdT!;
    else body.credit_per_period_vnd = creditN!;
    if (period !== "") body.period_days = periodN!;
    if (rateLimit !== "") body.rate_limit_per_minute = rateN!;
    // Optional authored term: omitted (0 server default) when left blank.
    if (dailyGrant !== "" && dailyGrantN !== null) body.daily_grant_vnd = dailyGrantN;
    create.mutate(body, { onSuccess: reset });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{t("plansCardTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5 sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) submit();
          }}
        >
          <CreateField
            id="plan-name"
            label={t("nameLabel")}
            value={name}
            onChange={setName}
            placeholder="Monthly"
          />
          <AmountField
            idPrefix="plan-price"
            label={t("priceLabel")}
            groupLabel={t("planPriceCurrency")}
            field={price}
            onChange={setPrice}
            usdPlaceholder="9.99"
            vndPlaceholder="200000"
            error={priceError}
          />
          <AmountField
            idPrefix="plan-credit"
            label={t("creditPerPeriodLabel")}
            groupLabel={t("creditPerPeriodCurrency")}
            field={credit}
            onChange={setCredit}
            usdPlaceholder="12"
            vndPlaceholder="200000"
            error={creditError}
          />
          <CreateField
            id="plan-period"
            label={t("periodDaysLabel")}
            value={period}
            onChange={setPeriod}
            placeholder="30"
            error={periodError}
          />
          <CreateField
            id="plan-rate"
            label={t("rateLimitLabel")}
            value={rateLimit}
            onChange={setRateLimit}
            placeholder="15"
            error={rateError}
          />
          <CreateField
            id="plan-daily-grant"
            label={t("dailyGrantLabel")}
            value={dailyGrant}
            onChange={setDailyGrant}
            placeholder="0"
            error={dailyGrantError}
          />
          <Button type="submit" disabled={!valid || create.isPending}>
            {create.isPending ? t("creating") : t("createPlan")}
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">{t("amountsHelp")}</p>
        <CatalogTable
          data={query.data?.data ?? []}
          tableLabel={t("plansTableLabel")}
          detailLabel={t("planCreditDetailLabel")}
          detail={(p) => {
            const credit = p.credit_per_period_usd
              ? t("creditDetail", {
                  credit: formatUsdAmountText(p.credit_per_period_usd),
                  grant: formatVnd(p.credit_per_period_vnd),
                  bonus: "",
                })
              : formatVnd(p.credit_per_period_vnd);
            return `${credit} / ${t("planDetailTail", {
              days: p.period_days,
              rate: p.rate_limit_per_minute,
            })}${p.daily_grant_vnd > 0 ? t("dailyGrantDetail", { amount: formatVnd(p.daily_grant_vnd) }) : ""}`;
          }}
          onEdit={(row) => setEditTarget({ kind: "plan", row })}
          onSetActive={(row, active) => update.mutate({ id: row.id, body: { active } })}
          editTarget={editTarget}
          setEditTarget={setEditTarget}
          onPatch={patchAsync}
          onRevise={reviseAsync}
        />
      </CardContent>
    </Card>
  );
}

export default function AdminBundlesPage() {
  const t = useT(adminBundlesCopy);
  const bundles = useAdminQuery<{ data: Bundle[] }>(["admin", "bundles"], "/api/v1/admin/bundles");
  const plans = useAdminQuery<{ data: Plan[] }>(
    ["admin", "subscription-plans"],
    "/api/v1/admin/subscription-plans",
  );
  return (
    <div className="mx-auto w-full max-w-5xl space-y-4">
      <PageHeader title={t("title")} description={t("description")} />
      <AdminGate query={bundles}>
        <BundlesCard query={bundles} />
      </AdminGate>
      <AdminGate query={plans}>
        <PlansCard query={plans} />
      </AdminGate>
    </div>
  );
}
