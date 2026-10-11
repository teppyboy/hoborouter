// Admin promo code management (safe subset of GET/POST/PATCH
// /api/v1/admin/promotions). Money and usage terms (amount_vnd, max_uses,
// expires_at) are fixed at creation — the PATCH boundary only accepts
// name/active, so the UI offers rename and activate/deactivate only, never
// delete and never term edits. The POST response carries the plaintext code
// exactly once; it lives in client memory only (never URL, localStorage, or
// logs) and is cleared the moment its dialog closes, so a later failure can
// never surface stale plaintext.
import { useState } from "react";
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
import { CopyButton, DataTable, PageHeader } from "../../components/page";
import { formatDate, formatVnd } from "../../lib/format";
import { ApiError, api } from "../../lib/api";
import { useT, type LocaleEntry } from "../../lib/i18n/t";
import { AdminGate, useAdminQuery } from "./shared";
import { parseIntVnd } from "./bundles";

export const promotionsDict = {
  title: { en: "Promo codes", vi: "Mã khuyến mãi" },
  description: {
    en: "Top-up promo codes. Amount, usage limit and expiry are fixed at creation; deactivate instead of deleting.",
    vi: "Mã khuyến mãi nạp tiền. Số tiền, giới hạn lượt dùng và hạn dùng cố định khi tạo; vô hiệu hoá thay vì xoá.",
  },
  name: { en: "Name", vi: "Tên" },
  kind: { en: "Type", vi: "Loại" },
  kindFixed: { en: "Fixed credit", vi: "Tín dụng cố định" },
  kindPercent: { en: "Percent off", vi: "Giảm theo phần trăm" },
  percent: { en: "Percent (%)" as const, vi: "Phần trăm (%)" as const },
  percentHint: {
    en: "3 = 3% off · decimals up to 99.99, e.g. 3.5",
    vi: "3 = giảm 3% · thập phân đến 99,99, ví dụ 3,5",
  },
  maxDiscount: { en: "Max discount (VND)", vi: "Giảm tối đa (VND)" },
  maxDiscountHint: {
    en: "Required: the discount never exceeds this cap.",
    vi: "Bắt buộc: mức giảm không vượt quá trần này.",
  },
  amount: { en: "Amount (VND)", vi: "Số tiền (VND)" },
  maxUses: { en: "Max uses", vi: "Số lượt tối đa" },
  expires: { en: "Expires (optional)", vi: "Hạn dùng (tuỳ chọn)" },
  create: { en: "Create code", vi: "Tạo mã" },
  creating: { en: "Creating…", vi: "Đang tạo…" },
  errName: { en: "Enter a name.", vi: "Nhập tên." },
  errAmount: {
    en: "Enter a positive whole VND amount.",
    vi: "Nhập số tiền VND nguyên dương.",
  },
  errPercent: {
    en: "Enter a percent between 0.01 and 99.99.",
    vi: "Nhập phần trăm từ 0,01 đến 99,99.",
  },
  errMaxDiscount: {
    en: "Enter a positive whole VND cap.",
    vi: "Nhập mức trần VND nguyên dương.",
  },
  errMaxUses: {
    en: "Enter a whole number of at least 1.",
    vi: "Nhập số nguyên từ 1 trở lên.",
  },
  errExpires: {
    en: "Expiry must be a future date.",
    vi: "Hạn dùng phải là ngày trong tương lai.",
  },
  colDiscount: { en: "Discount", vi: "Ưu đãi" },
  capOf: { en: "cap {cap}", vi: "trần {cap}" },
  colUses: { en: "Uses", vi: "Lượt dùng" },
  colExpires: { en: "Expires", vi: "Hết hạn" },
  colStatus: { en: "Status", vi: "Trạng thái" },
  colCreated: { en: "Created", vi: "Ngày tạo" },
  statusActive: { en: "Active", vi: "Đang hoạt động" },
  statusInactive: { en: "Inactive", vi: "Ngừng hoạt động" },
  rename: { en: "Rename", vi: "Đổi tên" },
  view: { en: "View code", vi: "Xem mã" },
  viewA: { en: "View promo code for {name}", vi: "Xem mã khuyến mãi {name}" },
  viewTitle: { en: "Promo code", vi: "Mã khuyến mãi" },
  viewNote: {
    en: "Codes are encrypted at rest; each view is audited.",
    vi: "Mã được mã hoá khi lưu; mỗi lần xem đều được ghi audit.",
  },
  deactivate: { en: "Deactivate", vi: "Vô hiệu hoá" },
  reactivate: { en: "Reactivate", vi: "Kích hoạt lại" },
  renameA: { en: "Rename {name}", vi: "Đổi tên {name}" },
  deactivateA: { en: "Deactivate {name}", vi: "Vô hiệu hoá {name}" },
  reactivateA: { en: "Reactivate {name}", vi: "Kích hoạt lại {name}" },
  renameTitle: { en: "Rename promo", vi: "Đổi tên mã khuyến mãi" },
  immutableNote: {
    en: "Amount, usage limit and expiry are fixed at creation.",
    vi: "Số tiền, giới hạn lượt dùng và hạn dùng cố định khi tạo.",
  },
  newName: { en: "New name", vi: "Tên mới" },
  save: { en: "Save", vi: "Lưu" },
  cancel: { en: "Cancel", vi: "Huỷ" },
  codeTitle: { en: "Promo code created", vi: "Đã tạo mã khuyến mãi" },
  codeOnce: {
    en: "Copy this code now. Codes created with the server encryption key can be re-viewed later via View code.",
    vi: "Sao chép mã ngay. Mã tạo khi có khoá mã hoá phía máy chủ có thể xem lại sau bằng nút Xem mã.",
  },
  codeLabel: { en: "Promo code", vi: "Mã khuyến mãi" },
  copyA: { en: "Copy promo code", vi: "Sao chép mã khuyến mãi" },
  done: { en: "Done", vi: "Xong" },
  updated: { en: "Updated", vi: "Đã cập nhật" },
  empty: { en: "No promo codes yet", vi: "Chưa có mã khuyến mãi" },
  requestFailed: { en: "Request failed", vi: "Yêu cầu thất bại" },
  customCode: { en: "Custom code (optional)", vi: "Mã tuỳ chọn" },
  customCodeHint: {
    en: "Leave blank to auto-generate. 1–64 characters — letters, numbers, spaces and symbols.",
    vi: "Để trống để tự tạo mã. 1–64 ký tự — chữ cái, chữ số, khoảng trắng và ký hiệu.",
  },
  replace: { en: "Replace", vi: "Thay thế" },
  replaceA: { en: "Replace {name}", vi: "Thay thế {name}" },
  replaceTitle: { en: "Replace promo", vi: "Thay thế mã khuyến mãi" },
  replaceKindNote: {
    en: "Kind is kept from the original: {kind}. To change kind, create a new code instead.",
    vi: "Loại giữ nguyên từ bản gốc: {kind}. Muốn đổi loại, hãy tạo mã mới.",
  },
  replaceNote: {
    en: "Creates a NEW promo with the terms below and a required new plaintext code. The original keeps its uses and history and is deactivated once the new code exists. The new code starts at 0 uses.",
    vi: "Tạo mã khuyến mãi MỚI với các điều kiện bên dưới và mã mới bắt buộc. Bản gốc giữ nguyên lượt dùng và lịch sử, và bị vô hiệu hoá sau khi mã mới được tạo. Mã mới bắt đầu từ 0 lượt dùng.",
  },
  newCode: { en: "New code (required)", vi: "Mã mới (bắt buộc)" },
  newCodeHint: {
    en: "Required — must be a brand-new code; reusing any existing code is rejected. View it later via View code.",
    vi: "Bắt buộc — phải là mã hoàn toàn mới; mã trùng với mã hiện có sẽ bị từ chối. Có thể xem lại bằng nút Xem mã.",
  },
  replaceConfirm: { en: "Create replacement", vi: "Tạo mã thay thế" },
  deactivateFailed: {
    en: "Replacement created, but the original {name} could not be deactivated — both codes are active. Deactivate the original with its Deactivate control; do not create another replacement.",
    vi: "Đã tạo mã thay thế nhưng không thể vô hiệu hoá bản gốc {name} — cả hai mã đều đang hoạt động. Hãy vô hiệu hoá bản gốc bằng nút Vô hiệu hoá; không tạo lại mã thay thế.",
  },
} as const satisfies Record<string, LocaleEntry>;

/** Safe promo row: the API never returns code_hash or plaintext codes here. */
export interface AdminPromo {
  id: string;
  name: string;
  kind: "fixed" | "percent";
  amount_vnd: number | null;
  percent_bp: number | null;
  max_discount_vnd: number | null;
  max_uses: number;
  uses: number;
  expires_at: number | null;
  active: boolean;
  created_at: number;
  /** True when the server holds an encrypted copy (admin repeat view). */
  code_available?: boolean;
}

/** Fixed = VND credit; percent = basis points + required VND cap (server shapes). */
export type CreatePromoBody =
  | {
      name: string;
      amount_vnd: number;
      max_uses: number;
      expires_at: number | null;
      /** Optional custom code; absent = server generates the legacy 32-hex code. */
      code?: string;
    }
  | {
      name: string;
      kind: "percent";
      percent_bp: number;
      max_discount_vnd: number;
      max_uses: number;
      expires_at: number | null;
      /** Optional custom code; absent = server generates the legacy 32-hex code. */
      code?: string;
    };

export interface PromoFormInput {
  kind: "fixed" | "percent";
  name: string;
  /** Fixed kind only. */
  amount: string;
  /** Percent kind only: friendly percent text ("3", "3%", "3,5"). */
  percent: string;
  /** Percent kind only: required VND cap on the discount. */
  maxDiscount: string;
  maxUses: string;
  expiresDate: string;
  /**
   * Optional custom code, sent verbatim (outer-trimmed): the server is the
   * only validator (normalization, Unicode, bounds, collisions). The client
   * imposes no character or case rules and never hashes.
   */
  customCode: string;
}

export interface PromoFormState {
  valid: boolean;
  nameInvalid: boolean;
  amountInvalid: boolean;
  percentInvalid: boolean;
  maxDiscountInvalid: boolean;
  maxUsesInvalid: boolean;
  expiresInvalid: boolean;
  body: CreatePromoBody | null;
}

/**
 * End of the selected local day: the last moment that calendar date is still
 * in the future. Calendar rollover (e.g. 2026-02-31) is rejected, not shifted.
 */
export function promoExpiryMs(dateStr: string, now: number): number | null | "invalid" {
  const s = dateStr.trim();
  if (s === "") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return "invalid";
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = new Date(y, mo - 1, d, 23, 59, 59, 999).getTime();
  const dt = new Date(ms);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return "invalid";
  return ms > now ? ms : "invalid";
}

/**
 * Friendly percent text -> integer basis points. Accepts an optional "%" and
 * a comma decimal separator (Vietnamese input), at most two decimals. The
 * conversion is exact by construction (string digits, Math.round for float
 * dust) so 3% is always 300bp — never a float. Bounds mirror the backend:
 * 1..9999 bp (0% and 100% are both rejected server-side too).
 */
export function parsePercentBp(text: string): number | null {
  const s = text.trim().replace(/,/g, ".").replace(/%$/, "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const bp = Math.round(Number(s) * 100);
  return bp >= 1 && bp <= 9999 ? bp : null;
}

/** Display form of basis points: 300 -> "3%", 350 -> "3.5%", 333 -> "3.33%". */
export function formatPercentBp(bp: number): string {
  return `${Number((bp / 100).toFixed(2))}%`;
}

/** Local-calendar YYYY-MM-DD of an epoch-ms timestamp (expiry prefill). */
function dateInputValue(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Pure create-form state shared by the form and its validation tests. */
export function promoFormState(input: PromoFormInput, now: number): PromoFormState {
  const name = input.name.trim();
  const maxUsesN = parseIntVnd(input.maxUses);
  const expiry = promoExpiryMs(input.expiresDate, now);
  const nameInvalid = name.length === 0;
  const maxUsesInvalid = maxUsesN === null || maxUsesN < 1;
  const expiresInvalid = expiry === "invalid";
  // The custom code is sent outer-trimmed with interior characters (spaces,
  // punctuation, Unicode) preserved; normalization is entirely server-side.
  const customCode = input.customCode.trim();
  let amountInvalid = false;
  let percentInvalid = false;
  let maxDiscountInvalid = false;
  let funding: CreatePromoBody | null = null;
  if (input.kind === "fixed") {
    // Percent-only fields are ignored by the fixed kind (and vice versa), so
    // a stale value in the hidden half can never block or corrupt a submit.
    const amountN = parseIntVnd(input.amount);
    amountInvalid = amountN === null || amountN <= 0;
    if (!amountInvalid && !maxUsesInvalid && !expiresInvalid) {
      funding = {
        name,
        amount_vnd: amountN as number,
        max_uses: maxUsesN as number,
        expires_at: expiry === null ? null : (expiry as number),
        ...(customCode ? { code: customCode } : {}),
      };
    }
  } else {
    const bp = parsePercentBp(input.percent);
    const capN = parseIntVnd(input.maxDiscount);
    percentInvalid = bp === null;
    maxDiscountInvalid = capN === null || capN <= 0;
    if (!percentInvalid && !maxDiscountInvalid && !maxUsesInvalid && !expiresInvalid) {
      funding = {
        name,
        kind: "percent",
        percent_bp: bp as number,
        max_discount_vnd: capN as number,
        max_uses: maxUsesN as number,
        expires_at: expiry === null ? null : (expiry as number),
        ...(customCode ? { code: customCode } : {}),
      };
    }
  }
  const valid =
    !nameInvalid &&
    !amountInvalid &&
    !percentInvalid &&
    !maxDiscountInvalid &&
    !maxUsesInvalid &&
    !expiresInvalid;
  return {
    valid,
    nameInvalid,
    amountInvalid,
    percentInvalid,
    maxDiscountInvalid,
    maxUsesInvalid,
    expiresInvalid,
    body: funding,
  };
}

function Field({
  id,
  label,
  error,
  errorId,
  invalid,
  children,
}: {
  id: string;
  label: string;
  error: string;
  errorId: string;
  invalid: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {invalid && (
        <p id={errorId} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function RenameDialog({
  row,
  onClose,
  onSubmit,
  pending,
}: {
  row: AdminPromo | null;
  onClose: () => void;
  onSubmit: (id: string, name: string) => void;
  pending: boolean;
}) {
  const t = useT(promotionsDict);
  const [name, setName] = useState<string | null>(null);
  const value = name ?? row?.name ?? "";
  return (
    <Dialog
      open={row !== null}
      onOpenChange={(open) => {
        if (!open) {
          setName(null);
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("renameTitle")}</DialogTitle>
          <DialogDescription>{t("immutableNote")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1">
          <Label htmlFor="promo-rename-name">{t("newName")}</Label>
          <Input
            id="promo-rename-name"
            value={value}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            className="pointer-coarse:h-11"
            onClick={() => {
              setName(null);
              onClose();
            }}
          >
            {t("cancel")}
          </Button>
          <Button
            className="pointer-coarse:h-11"
            disabled={value.trim().length === 0 || pending}
            onClick={() => {
              if (row) onSubmit(row.id, value.trim());
              setName(null);
            }}
          >
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Financial replacement (approved flow): a NEW promo row is created through the
 * existing POST endpoint with a REQUIRED new plaintext code (never a variant of
 * any existing code — the server rejects collisions), prefilled with the
 * original's terms; on create success the original row is deactivated with the
 * name/active-only PATCH, keeping its uses and redemption history intact.
 * Kind is locked to the original; kind changes go through the create form.
 */
function ReplaceDialog({
  row,
  onClose,
  onSubmit,
  pending,
  serverError,
}: {
  row: AdminPromo;
  onClose: () => void;
  onSubmit: (body: CreatePromoBody) => void;
  pending: boolean;
  serverError: string | null;
}) {
  const t = useT(promotionsDict);
  const [name, setName] = useState(row.name);
  const [amount, setAmount] = useState(row.amount_vnd != null ? String(row.amount_vnd) : "");
  const [percent, setPercent] = useState(
    row.percent_bp != null ? formatPercentBp(row.percent_bp) : "",
  );
  const [maxDiscount, setMaxDiscount] = useState(
    row.max_discount_vnd != null ? String(row.max_discount_vnd) : "",
  );
  const [maxUses, setMaxUses] = useState(String(row.max_uses));
  // Only a still-future expiry is prefilled; a past expiry must be cleared or
  // replaced by the admin (the server rejects past timestamps).
  const [expiresDate, setExpiresDate] = useState(
    row.expires_at != null && row.expires_at > Date.now() ? dateInputValue(row.expires_at) : "",
  );
  // The replacement code is REQUIRED: absent means "server generates", which
  // would silently keep the same shape without the admin-chosen new code.
  const [newCode, setNewCode] = useState("");
  const form = promoFormState(
    {
      kind: row.kind,
      name,
      amount,
      percent,
      maxDiscount,
      maxUses,
      expiresDate,
      customCode: newCode,
    },
    Date.now(),
  );
  const codeMissing = newCode.trim().length === 0;
  const kindLabel = row.kind === "fixed" ? t("kindFixed") : t("kindPercent");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("replaceTitle")}</DialogTitle>
          <DialogDescription>{t("replaceNote")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <p className="text-xs text-muted-foreground">
            {t("replaceKindNote", { kind: kindLabel })}
          </p>
          <Field
            id="promo-replace-name"
            label={t("name")}
            error={t("errName")}
            errorId="promo-replace-name-error"
            invalid={form.nameInvalid}
          >
            <Input
              id="promo-replace-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={form.nameInvalid}
              aria-describedby={form.nameInvalid ? "promo-replace-name-error" : undefined}
              className={form.nameInvalid ? "border-destructive" : undefined}
            />
          </Field>
          <div className="grid gap-1">
            <Label htmlFor="promo-replace-code">{t("newCode")}</Label>
            <Input
              id="promo-replace-code"
              value={newCode}
              onChange={(e) => setNewCode(e.target.value)}
              // A promo code is a secret-ish bearer token: no autofill, no save.
              autoComplete="off"
              spellCheck={false}
              maxLength={64}
              className={`font-mono ${serverError ? "border-destructive" : undefined}`}
              aria-invalid={serverError !== null}
              aria-describedby={
                serverError ? "promo-replace-code-error" : "promo-replace-code-hint"
              }
            />
            <p id="promo-replace-code-hint" className="text-xs text-muted-foreground">
              {t("newCodeHint")}
            </p>
            {serverError ? (
              <p id="promo-replace-code-error" role="alert" className="text-xs text-destructive">
                {serverError}
              </p>
            ) : null}
          </div>
          {row.kind === "fixed" ? (
            <Field
              id="promo-replace-amount"
              label={t("amount")}
              error={t("errAmount")}
              errorId="promo-replace-amount-error"
              invalid={form.amountInvalid}
            >
              <Input
                id="promo-replace-amount"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="numeric"
                aria-invalid={form.amountInvalid}
                aria-describedby={form.amountInvalid ? "promo-replace-amount-error" : undefined}
                className={form.amountInvalid ? "border-destructive" : undefined}
              />
            </Field>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                id="promo-replace-percent"
                label={t("percent")}
                error={t("errPercent")}
                errorId="promo-replace-percent-error"
                invalid={form.percentInvalid}
              >
                <Input
                  id="promo-replace-percent"
                  value={percent}
                  onChange={(e) => setPercent(e.target.value)}
                  inputMode="decimal"
                  aria-invalid={form.percentInvalid}
                  aria-describedby={form.percentInvalid ? "promo-replace-percent-error" : undefined}
                  className={form.percentInvalid ? "border-destructive" : undefined}
                />
              </Field>
              <Field
                id="promo-replace-max-discount"
                label={t("maxDiscount")}
                error={t("errMaxDiscount")}
                errorId="promo-replace-max-discount-error"
                invalid={form.maxDiscountInvalid}
              >
                <Input
                  id="promo-replace-max-discount"
                  value={maxDiscount}
                  onChange={(e) => setMaxDiscount(e.target.value)}
                  inputMode="numeric"
                  aria-invalid={form.maxDiscountInvalid}
                  aria-describedby={
                    form.maxDiscountInvalid ? "promo-replace-max-discount-error" : undefined
                  }
                  className={form.maxDiscountInvalid ? "border-destructive" : undefined}
                />
              </Field>
            </div>
          )}
          <Field
            id="promo-replace-max-uses"
            label={t("maxUses")}
            error={t("errMaxUses")}
            errorId="promo-replace-max-uses-error"
            invalid={form.maxUsesInvalid}
          >
            <Input
              id="promo-replace-max-uses"
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value)}
              inputMode="numeric"
              aria-invalid={form.maxUsesInvalid}
              aria-describedby={form.maxUsesInvalid ? "promo-replace-max-uses-error" : undefined}
              className={form.maxUsesInvalid ? "border-destructive" : undefined}
            />
          </Field>
          <Field
            id="promo-replace-expires"
            label={t("expires")}
            error={t("errExpires")}
            errorId="promo-replace-expires-error"
            invalid={form.expiresInvalid}
          >
            <Input
              id="promo-replace-expires"
              type="date"
              value={expiresDate}
              onChange={(e) => setExpiresDate(e.target.value)}
              aria-invalid={form.expiresInvalid}
              aria-describedby={form.expiresInvalid ? "promo-replace-expires-error" : undefined}
              className={form.expiresInvalid ? "border-destructive" : undefined}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            className="pointer-coarse:h-11"
            onClick={() => {
              onClose();
            }}
          >
            {t("cancel")}
          </Button>
          <Button
            className="pointer-coarse:h-11"
            disabled={!form.valid || codeMissing || pending}
            onClick={() => {
              if (form.body) onSubmit(form.body);
            }}
          >
            {pending ? t("creating") : t("replaceConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Plaintext reveal (create-time or admin re-view). Component state only. */
function CodeDialog({
  code,
  onClose,
  warning,
  view = false,
}: {
  code: string | null;
  onClose: () => void;
  /** Persisted partial-failure warning shown alongside the retained reveal. */
  warning?: string | null;
  /** Re-view flow: different title/description than the create-time reveal. */
  view?: boolean;
}) {
  const t = useT(promotionsDict);
  return (
    <Dialog
      open={code !== null}
      onOpenChange={(open) => {
        // Closing always clears the plaintext from memory.
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{view ? t("viewTitle") : t("codeTitle")}</DialogTitle>
          <DialogDescription>{view ? t("viewNote") : t("codeOnce")}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
          <code className="min-w-0 flex-1 font-mono text-sm break-all" aria-label={t("codeLabel")}>
            {code}
          </code>
          <CopyButton value={code ?? ""} label={t("copyA")} />
        </div>
        {warning ? (
          <p role="alert" className="text-sm text-destructive">
            {warning}
          </p>
        ) : null}
        <DialogFooter>
          <Button className="pointer-coarse:h-11" onClick={onClose}>
            {t("done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PromotionsCard({ data }: { data: AdminPromo[] }) {
  const t = useT(promotionsDict);
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"fixed" | "percent">("fixed");
  const [amount, setAmount] = useState("");
  const [percent, setPercent] = useState("");
  const [maxDiscount, setMaxDiscount] = useState("");
  const [maxUses, setMaxUses] = useState("");
  const [expiresDate, setExpiresDate] = useState("");
  // Optional custom code: sent verbatim, validated only by the server. Server
  // INVALID_CODE/CODE_EXISTS errors render inline (never as a toast), and the
  // typed text stays so the admin can correct it.
  const [customCode, setCustomCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<AdminPromo | null>(null);
  // Financial replacement: the row being replaced (null = dialog closed).
  const [replacing, setReplacing] = useState<AdminPromo | null>(null);
  const [replaceCodeError, setReplaceCodeError] = useState<string | null>(null);
  // Saved partial-failure state: the replacement row exists but the original
  // could not be deactivated. Persisted (survives the reveal dialog) until a
  // successful manual deactivation of that exact row; never auto-retried and
  // the POST is never re-issued (a retry would 400 CODE_EXISTS on the new code).
  const [deactivateFailedFor, setDeactivateFailedFor] = useState<{
    id: string;
    name: string;
  } | null>(null);
  // Plaintext code lives here and nowhere else; null whenever no dialog is open.
  const [revealedCode, setRevealedCode] = useState<string | null>(null);
  // True while the open dialog came from the admin re-view flow (different
  // title/description; the partial-deactivate warning is create-flow only).
  const [viewing, setViewing] = useState(false);

  const onError = (e: unknown) => {
    if (e instanceof ApiError && (e.code === "INVALID_CODE" || e.code === "CODE_EXISTS")) {
      setCodeError(e.message);
      return;
    }
    toast.error(e instanceof ApiError ? e.message : t("requestFailed"));
  };

  const create = useMutation({
    mutationFn: (body: CreatePromoBody) =>
      api<{ promo: AdminPromo; code: string }>("/api/v1/admin/promotions", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: ({ code }) => {
      setRevealedCode(code);
      setViewing(false);
      setName("");
      setAmount("");
      setPercent("");
      setMaxDiscount("");
      setMaxUses("");
      setExpiresDate("");
      setCustomCode("");
      setCodeError(null);
      toast.success(t("codeTitle"));
      void qc.invalidateQueries({ queryKey: ["admin", "promotions"] });
    },
    onError,
  });

  const reveal = useMutation({
    mutationFn: (id: string) =>
      api<{ code: string }>(`/api/v1/admin/promotions/${id}/code`, { method: "GET" }),
    onSuccess: ({ code }) => {
      setRevealedCode(code);
      setViewing(true);
    },
    onError,
  });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { name?: string; active?: boolean } }) =>
      api<AdminPromo>(`/api/v1/admin/promotions/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: (_res, variables) => {
      toast.success(t("updated"));
      void qc.invalidateQueries({ queryKey: ["admin", "promotions"] });
      // A confirmed manual deactivation of the exact failed row is the cleanup
      // path: only a server-verified success clears the both-active warning.
      if (variables.body.active === false && deactivateFailedFor?.id === variables.id)
        setDeactivateFailedFor(null);
    },
    onError,
  });

  // Per-replacement deactivation of the original row. A failure here is NOT a
  // create failure: the replacement already exists, so nothing is re-POSTed —
  // the saved warning names both active rows until manual cleanup succeeds.
  const deactivateOld = useMutation({
    mutationFn: ({ id }: { id: string; name: string }) =>
      api<AdminPromo>(`/api/v1/admin/promotions/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: false }),
      }),
    onSuccess: () => {
      toast.success(t("updated"));
      void qc.invalidateQueries({ queryKey: ["admin", "promotions"] });
    },
    onError: (_e, variables) => {
      setDeactivateFailedFor({ id: variables.id, name: variables.name });
      void qc.invalidateQueries({ queryKey: ["admin", "promotions"] });
    },
  });
  const replaceCreate = useMutation({
    mutationFn: ({ body, oldId }: { body: CreatePromoBody; oldId: string }) =>
      api<{ promo: AdminPromo; code: string }>("/api/v1/admin/promotions", {
        method: "POST",
        body: JSON.stringify(body),
      }).then((res) => ({ res, oldId })),
    onSuccess: ({ res: { code }, oldId }) => {
      setRevealedCode(code);
      setViewing(false);
      setReplacing(null);
      setReplaceCodeError(null);
      toast.success(t("codeTitle"));
      deactivateOld.mutate({ id: oldId, name: replacing?.name ?? "" });
      void qc.invalidateQueries({ queryKey: ["admin", "promotions"] });
    },
    onError: (e: unknown) => {
      // Inline server errors keep the dialog and every field intact so the
      // admin can correct only the code (e.g. a collision with any existing
      // code, including the original — never alias/reuse).
      if (e instanceof ApiError && (e.code === "INVALID_CODE" || e.code === "CODE_EXISTS")) {
        setReplaceCodeError(e.message);
        return;
      }
      toast.error(e instanceof ApiError ? e.message : t("requestFailed"));
    },
  });

  const form = promoFormState(
    { kind, name, amount, percent, maxDiscount, maxUses, expiresDate, customCode },
    Date.now(),
  );

  const columns: ColumnDef<AdminPromo, unknown>[] = [
    { accessorKey: "name", header: t("name") },
    {
      id: "discount",
      header: t("colDiscount"),
      // Percent rows show the friendly percent + their VND cap; fixed rows
      // keep the VND credit. All values come from the server row snapshot.
      cell: (c) => {
        const row = c.row.original;
        if (row.kind === "percent" && row.percent_bp != null) {
          return (
            <span className="font-mono text-xs">
              {formatPercentBp(row.percent_bp)}
              {row.max_discount_vnd != null
                ? ` · ${t("capOf", { cap: formatVnd(row.max_discount_vnd) })}`
                : ""}
            </span>
          );
        }
        return (
          <span className="font-mono text-xs">
            {row.amount_vnd == null ? "—" : formatVnd(row.amount_vnd)}
          </span>
        );
      },
    },
    {
      id: "uses",
      header: t("colUses"),
      cell: (c) => (
        <span className="font-mono text-xs">
          {c.row.original.uses} / {c.row.original.max_uses}
        </span>
      ),
    },
    {
      accessorKey: "expires_at",
      header: t("colExpires"),
      cell: (c) => (
        <span className="font-mono text-xs">{formatDate(c.getValue<number | null>())}</span>
      ),
    },
    {
      accessorKey: "active",
      header: t("colStatus"),
      cell: (c) =>
        c.getValue<boolean>() ? (
          <Badge>{t("statusActive")}</Badge>
        ) : (
          <Badge variant="secondary">{t("statusInactive")}</Badge>
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
            {row.code_available === true && (
              <Button
                size="sm"
                variant="outline"
                className="pointer-coarse:h-11"
                aria-label={t("viewA", { name: row.name })}
                disabled={reveal.isPending}
                onClick={() => {
                  if (!reveal.isPending) reveal.mutate(row.id);
                }}
              >
                {t("view")}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              className="pointer-coarse:h-11"
              aria-label={t("renameA", { name: row.name })}
              onClick={() => setRenaming(row)}
            >
              {t("rename")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="pointer-coarse:h-11"
              aria-label={t("replaceA", { name: row.name })}
              onClick={() => {
                setReplaceCodeError(null);
                setReplacing(row);
              }}
            >
              {t("replace")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="pointer-coarse:h-11"
              aria-label={
                row.active
                  ? t("deactivateA", { name: row.name })
                  : t("reactivateA", { name: row.name })
              }
              disabled={update.isPending}
              onClick={() => {
                if (!update.isPending) update.mutate({ id: row.id, body: { active: !row.active } });
              }}
            >
              {row.active ? t("deactivate") : t("reactivate")}
            </Button>
          </span>
        );
      },
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {deactivateFailedFor !== null && (
          <div
            role="alert"
            className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm"
          >
            {t("deactivateFailed", { name: deactivateFailedFor.name })}
          </div>
        )}
        <form
          className={`grid gap-3 sm:items-start ${kind === "percent" ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2 lg:grid-cols-3"}`}
          onSubmit={(e) => {
            e.preventDefault();
            setCodeError(null);
            if (form.body && !create.isPending) create.mutate(form.body);
          }}
        >
          <div className="grid gap-1">
            <Label>{t("kind")}</Label>
            <div className="flex gap-1" role="group" aria-label={t("kind")}>
              {(["fixed", "percent"] as const).map((k) => (
                <Button
                  key={k}
                  type="button"
                  size="sm"
                  variant={kind === k ? "default" : "outline"}
                  onClick={() => setKind(k)}
                >
                  {k === "fixed" ? t("kindFixed") : t("kindPercent")}
                </Button>
              ))}
            </div>
          </div>
          <Field
            id="promo-name"
            label={t("name")}
            error={t("errName")}
            errorId="promo-name-error"
            invalid={form.nameInvalid}
          >
            <Input
              id="promo-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="SUMMER2026"
              aria-invalid={form.nameInvalid}
              aria-describedby={form.nameInvalid ? "promo-name-error" : undefined}
              className={form.nameInvalid ? "border-destructive" : undefined}
            />
          </Field>
          <div className="grid gap-1">
            <Label htmlFor="promo-custom-code">{t("customCode")}</Label>
            <Input
              id="promo-custom-code"
              value={customCode}
              onChange={(e) => {
                setCustomCode(e.target.value);
                setCodeError(null);
              }}
              // A promo code is a secret-ish bearer token: no autofill, no save.
              autoComplete="off"
              spellCheck={false}
              maxLength={64}
              className={`font-mono ${codeError ? "border-destructive" : undefined}`}
              aria-invalid={codeError !== null}
              aria-describedby={codeError ? "promo-custom-code-error" : "promo-custom-code-hint"}
            />
            <p id="promo-custom-code-hint" className="text-xs text-muted-foreground">
              {t("customCodeHint")}
            </p>
            {codeError ? (
              <p id="promo-custom-code-error" role="alert" className="text-xs text-destructive">
                {codeError}
              </p>
            ) : null}
          </div>
          {kind === "fixed" ? (
            <Field
              id="promo-amount"
              label={t("amount")}
              error={t("errAmount")}
              errorId="promo-amount-error"
              invalid={form.amountInvalid}
            >
              <Input
                id="promo-amount"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="500000"
                inputMode="numeric"
                aria-invalid={form.amountInvalid}
                aria-describedby={form.amountInvalid ? "promo-amount-error" : undefined}
                className={form.amountInvalid ? "border-destructive" : undefined}
              />
            </Field>
          ) : (
            <>
              <Field
                id="promo-percent"
                label={t("percent")}
                error={t("errPercent")}
                errorId="promo-percent-error"
                invalid={form.percentInvalid}
              >
                <Input
                  id="promo-percent"
                  value={percent}
                  onChange={(e) => setPercent(e.target.value)}
                  placeholder="3"
                  inputMode="decimal"
                  aria-invalid={form.percentInvalid}
                  aria-describedby={
                    form.percentInvalid ? "promo-percent-error" : "promo-percent-hint"
                  }
                  className={form.percentInvalid ? "border-destructive" : undefined}
                />
                <p id="promo-percent-hint" className="text-xs text-muted-foreground">
                  {t("percentHint")}
                </p>
              </Field>
              <Field
                id="promo-max-discount"
                label={t("maxDiscount")}
                error={t("errMaxDiscount")}
                errorId="promo-max-discount-error"
                invalid={form.maxDiscountInvalid}
              >
                <Input
                  id="promo-max-discount"
                  value={maxDiscount}
                  onChange={(e) => setMaxDiscount(e.target.value)}
                  placeholder="100000"
                  inputMode="numeric"
                  aria-invalid={form.maxDiscountInvalid}
                  aria-describedby={
                    form.maxDiscountInvalid ? "promo-max-discount-error" : "promo-max-discount-hint"
                  }
                  className={form.maxDiscountInvalid ? "border-destructive" : undefined}
                />
                <p id="promo-max-discount-hint" className="text-xs text-muted-foreground">
                  {t("maxDiscountHint")}
                </p>
              </Field>
            </>
          )}
          <Field
            id="promo-max-uses"
            label={t("maxUses")}
            error={t("errMaxUses")}
            errorId="promo-max-uses-error"
            invalid={form.maxUsesInvalid}
          >
            <Input
              id="promo-max-uses"
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value)}
              placeholder="10"
              inputMode="numeric"
              aria-invalid={form.maxUsesInvalid}
              aria-describedby={form.maxUsesInvalid ? "promo-max-uses-error" : undefined}
              className={form.maxUsesInvalid ? "border-destructive" : undefined}
            />
          </Field>
          <Field
            id="promo-expires"
            label={t("expires")}
            error={t("errExpires")}
            errorId="promo-expires-error"
            invalid={form.expiresInvalid}
          >
            <Input
              id="promo-expires"
              type="date"
              value={expiresDate}
              onChange={(e) => setExpiresDate(e.target.value)}
              aria-invalid={form.expiresInvalid}
              aria-describedby={form.expiresInvalid ? "promo-expires-error" : undefined}
              className={form.expiresInvalid ? "border-destructive" : undefined}
            />
          </Field>
          <Button
            type="submit"
            className="pointer-coarse:h-11"
            disabled={!form.valid || create.isPending}
          >
            {create.isPending ? t("creating") : t("create")}
          </Button>
        </form>
        <DataTable columns={columns} data={data} empty={t("empty")} globalFilter="" />
      </CardContent>
      <RenameDialog
        row={renaming}
        onClose={() => setRenaming(null)}
        onSubmit={(id, n) => update.mutate({ id, body: { name: n } })}
        pending={update.isPending}
      />
      {replacing !== null && (
        <ReplaceDialog
          key={replacing.id}
          row={replacing}
          onClose={() => {
            setReplacing(null);
            setReplaceCodeError(null);
          }}
          onSubmit={(body) => {
            if (!replaceCreate.isPending) replaceCreate.mutate({ body, oldId: replacing.id });
          }}
          pending={replaceCreate.isPending}
          serverError={replaceCodeError}
        />
      )}
      <CodeDialog
        code={revealedCode}
        view={viewing}
        onClose={() => {
          setRevealedCode(null);
          setViewing(false);
        }}
        warning={
          !viewing && deactivateFailedFor !== null
            ? t("deactivateFailed", { name: deactivateFailedFor.name })
            : null
        }
      />
    </Card>
  );
}

/** Pure view: no router or layout coupling; route/nav wiring lands separately. */
export default function AdminPromotionsPage() {
  const t = useT(promotionsDict);
  const query = useAdminQuery<{ data: AdminPromo[] }>(
    ["admin", "promotions"],
    "/api/v1/admin/promotions",
  );
  return (
    <div className="mx-auto w-full max-w-5xl space-y-4">
      <PageHeader title={t("title")} description={t("description")} />
      <AdminGate query={query}>
        <PromotionsCard data={query.data?.data ?? []} />
      </AdminGate>
    </div>
  );
}
