import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Switch } from "../../components/ui/switch";
import { Input } from "../../components/ui/input";
import { Button } from "../../components/ui/button";
import { Label } from "../../components/ui/label";
import { PageHeader } from "../../components/page";
import { api } from "../../lib/api";
import { AdminGate, useAdminQuery } from "./shared";
import { SystemCard } from "./system";
import { useT } from "../../lib/i18n/t";
import { DEFAULT_SUPPORT_EMAIL } from "../../components/support-links";

// Admin settings copy: inline LocaleEntry set (see lib/i18n/common.ts).
// Money amounts and integer field values are never translated.
// Exported for the UI contract tests (same pattern as promotionsDict).
export const adminSettingsCopy = {
  saved: { en: "Settings saved", vi: "Đã lưu cài đặt" },
  loading: { en: "Loading…", vi: "Đang tải…" },
  loadFailed: { en: "Failed to load settings", vi: "Không tải được cài đặt" },
  promptCaching: { en: "Prompt caching", vi: "Prompt caching" },
  promptCachingLabel: { en: "Prompt caching (all models)", vi: "Prompt caching (mọi mô hình)" },
  promptCachingHint: {
    en: "When off, cached tokens are billed at the full input price. Requests are sent unchanged; providers may still cache.",
    vi: "Khi tắt, token cache được tính theo giá input đầy đủ. Request được gửi nguyên bản; nhà cung cấp vẫn có thể cache.",
  },
  bonus: { en: "First top-up bonus", vi: "Thưởng nạp lần đầu" },
  bonusLabel: {
    en: "Bonus on a workspace's first paid top-up",
    vi: "Thưởng cho lần nạp trả phí đầu tiên của workspace",
  },
  bonusHint: {
    en: "One-time extra credit when a workspace's first top-up payment succeeds.",
    vi: "Tín dụng thêm một lần khi lần nạp đầu tiên của workspace thành công.",
  },
  bonusAmount: { en: "Bonus amount (VND)", vi: "Số tiền thưởng (VND)" },
  saveAmount: { en: "Save amount", vi: "Lưu số tiền" },
  noBonus: {
    en: "No valid bonus amount is configured — first top-ups get no bonus until one is set.",
    vi: "Chưa cấu hình số tiền thưởng hợp lệ — lần nạp đầu sẽ không có thưởng cho đến khi đặt.",
  },
  paymentControls: { en: "Payment controls", vi: "Điều khiển thanh toán" },
  timeoutLabel: { en: "Payment timeout (minutes)", vi: "Hạn thanh toán (phút)" },
  timeoutHint: {
    en: "Pending payments expire after this many minutes ({min}–{max}).",
    vi: "Thanh toán chờ hết hạn sau số phút này ({min}–{max}).",
  },
  maxTopUpLabel: { en: "Max top-up amount (VND)", vi: "Số tiền nạp tối đa (VND)" },
  maxTopUpHint: {
    en: "Largest single top-up accepted; larger requests are rejected.",
    vi: "Mức nạp đơn lẻ lớn nhất được chấp nhận; yêu cầu lớn hơn bị từ chối.",
  },
  rateLabel: { en: "USD → VND rate", vi: "Tỷ giá USD → VND" },
  rateHint: {
    en: "VND per 1 USD; converts USD top-up input into VND credit.",
    vi: "VND trên 1 USD; quy đổi số tiền nạp USD thành tín dụng VND.",
  },
  saving: { en: "Saving…", vi: "Đang lưu…" },
  save: { en: "Save", vi: "Lưu" },
  title: { en: "Instance settings", vi: "Cài đặt instance" },
  description: { en: "Global platform settings.", vi: "Cài đặt toàn hệ thống." },
  support: { en: "Support & contact", vi: "Hỗ trợ & liên hệ" },
  displayName: { en: "Display name", vi: "Tên hiển thị" },
  emailLabel: { en: "Support email", vi: "Email hỗ trợ" },
  telegramLabel: { en: "Telegram URL", vi: "URL Telegram" },
  facebookLabel: { en: "Facebook URL", vi: "URL Facebook" },
  threadsLabel: { en: "Threads URL", vi: "URL Threads" },
  urlHint: {
    en: "HTTPS URL only, without embedded credentials.",
    vi: "Chỉ nhận URL HTTPS, không chứa thông tin đăng nhập.",
  },
  emailFallbackHint: {
    en: "When unset, the project contact {email} is shown publicly.",
    vi: "Khi bỏ trống, địa chỉ liên hệ {email} của dự án được hiển thị công khai.",
  },
  invalidName: {
    en: "Must be a non-empty name without control characters (max 100).",
    vi: "Phải là tên không rỗng, không có ký tự điều khiển (tối đa 100 ký tự).",
  },
  invalidEmail: { en: "Must be a valid email address.", vi: "Phải là địa chỉ email hợp lệ." },
  invalidUrl: {
    en: "Must be an HTTPS URL without credentials.",
    vi: "Phải là URL HTTPS không chứa thông tin đăng nhập.",
  },
  customSection: { en: "Custom links", vi: "Liên kết tùy chỉnh" },
  customLabel: { en: "Label", vi: "Nhãn" },
  customUrl: { en: "URL", vi: "Đường dẫn" },
  customHint: {
    en: "Up to {max} extra HTTPS links shown publicly after the channels above.",
    vi: "Tối đa {max} liên kết HTTPS hiển thị công khai sau các kênh ở trên.",
  },
  addCustomLink: { en: "Add link", vi: "Thêm liên kết" },
  removeCustomLink: { en: "Remove", vi: "Xóa" },
  invalidCustomLabel: {
    en: "Label must be 1–30 characters without control characters.",
    vi: "Nhãn phải dài 1–30 ký tự, không có ký tự điều khiển.",
  },
} as const;

interface AdminSettings {
  prompt_caching_enabled: boolean;
  first_topup_bonus_enabled: boolean;
  first_topup_bonus_amount_vnd: number | null;
  payment_timeout_minutes: number;
  payment_max_amount_vnd: number;
  payment_usd_vnd_rate: number;
}

// Server bounds (packages/payments/src/payment-settings.ts); mirrored here so
// the form blocks out-of-range input before the PUT instead of round-tripping.
const PAYMENT_TIMEOUT_MIN = 1;
const PAYMENT_TIMEOUT_MAX = 1440;

/** Digits-only positive integer; returns null for empty/non-numeric/unsafe input. */
function parsePositiveIntegerField(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function PromptCachingCard({
  query,
}: {
  query: { data?: AdminSettings; isPending: boolean; error: unknown };
}) {
  const t = useT(adminSettingsCopy);
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (enabled: boolean) =>
      api<AdminSettings>("/api/v1/admin/settings", {
        method: "PUT",
        body: JSON.stringify({ prompt_caching_enabled: enabled }),
      }),
    onSuccess: () => {
      toast(t("saved"));
      void qc.invalidateQueries({ queryKey: ["admin", "settings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{t("promptCaching")}</CardTitle>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        ) : query.error ? (
          <p className="text-sm text-destructive">
            {query.error instanceof Error ? query.error.message : t("loadFailed")}
          </p>
        ) : query.data ? (
          <div className="flex items-center justify-between gap-4">
            {" "}
            <div className="grid gap-1">
              <Label htmlFor="prompt_caching">{t("promptCachingLabel")}</Label>
              <p className="text-xs text-muted-foreground">{t("promptCachingHint")}</p>
            </div>
            <Switch
              id="prompt_caching"
              checked={query.data.prompt_caching_enabled}
              onCheckedChange={(c) => mutation.mutate(c)}
              disabled={mutation.isPending}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function FirstTopupBonusCard({
  query,
}: {
  query: { data?: AdminSettings; isPending: boolean; error: unknown };
}) {
  const t = useT(adminSettingsCopy);
  const qc = useQueryClient();
  const [amount, setAmount] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (body: Partial<AdminSettings>) =>
      api<AdminSettings>("/api/v1/admin/settings", {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      toast(t("saved"));
      setAmount(null);
      void qc.invalidateQueries({ queryKey: ["admin", "settings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const current = query.data?.first_topup_bonus_amount_vnd ?? null;
  const parsed = amount === null ? null : Number(amount.trim());
  const amountValid =
    amount === null ||
    (amount.trim() !== "" && Number.isSafeInteger(parsed) && (parsed as number) > 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{t("bonus")}</CardTitle>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        ) : query.error ? (
          <p className="text-sm text-destructive">
            {query.error instanceof Error ? query.error.message : t("loadFailed")}
          </p>
        ) : query.data ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="grid gap-1">
                <Label htmlFor="first_topup_bonus">{t("bonusLabel")}</Label>
                <p className="text-xs text-muted-foreground">{t("bonusHint")}</p>
              </div>
              <Switch
                id="first_topup_bonus"
                checked={query.data.first_topup_bonus_enabled}
                onCheckedChange={(c) => mutation.mutate({ first_topup_bonus_enabled: c })}
                disabled={mutation.isPending}
              />
            </div>
            <div className="flex items-end gap-2">
              <div className="grid gap-1">
                <Label htmlFor="first_topup_bonus_amount">{t("bonusAmount")}</Label>
                <Input
                  id="first_topup_bonus_amount"
                  value={amount ?? (current === null ? "" : String(current))}
                  onChange={(e) => setAmount(e.target.value)}
                  inputMode="numeric"
                  placeholder="20000"
                  aria-invalid={!amountValid}
                  className={!amountValid ? "border-destructive" : undefined}
                />
              </div>
              <Button
                variant="outline"
                disabled={amount === null || !amountValid || mutation.isPending}
                onClick={() =>
                  mutation.mutate({
                    first_topup_bonus_amount_vnd: parsed as number,
                  })
                }
              >
                {t("saveAmount")}
              </Button>
            </div>
            {current === null && <p className="text-xs text-muted-foreground">{t("noBonus")}</p>}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * Payment controls: timeout / max top-up / USD rate. Each field saves its own
 * single-key PUT (atomic per field — the backend validates the whole body and
 * never partially persists, so one field can never corrupt another).
 */
export function PaymentControlsCard({
  query,
}: {
  query: { data?: AdminSettings; isPending: boolean; error: unknown };
}) {
  const t = useT(adminSettingsCopy);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{t("paymentControls")}</CardTitle>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        ) : query.error ? (
          <p className="text-sm text-destructive">
            {query.error instanceof Error ? query.error.message : t("loadFailed")}
          </p>
        ) : query.data ? (
          <div className="space-y-6">
            <PaymentIntegerField
              field="payment_timeout_minutes"
              label={t("timeoutLabel")}
              hint={t("timeoutHint", { min: PAYMENT_TIMEOUT_MIN, max: PAYMENT_TIMEOUT_MAX })}
              placeholder="30"
              current={query.data.payment_timeout_minutes}
              min={PAYMENT_TIMEOUT_MIN}
              max={PAYMENT_TIMEOUT_MAX}
            />
            <PaymentIntegerField
              field="payment_max_amount_vnd"
              label={t("maxTopUpLabel")}
              hint={t("maxTopUpHint")}
              placeholder="100000000"
              current={query.data.payment_max_amount_vnd}
            />
            <PaymentIntegerField
              field="payment_usd_vnd_rate"
              label={t("rateLabel")}
              hint={t("rateHint")}
              placeholder="26000"
              current={query.data.payment_usd_vnd_rate}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** One bounded integer setting with local edit state and a per-field Save. */
function PaymentIntegerField({
  field,
  label,
  hint,
  placeholder,
  current,
  min,
  max,
}: {
  field: "payment_timeout_minutes" | "payment_max_amount_vnd" | "payment_usd_vnd_rate";
  label: string;
  hint: string;
  placeholder: string;
  current: number;
  min?: number;
  max?: number;
}) {
  const t = useT(adminSettingsCopy);
  const qc = useQueryClient();
  const [value, setValue] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (n: number) =>
      api<AdminSettings>("/api/v1/admin/settings", {
        method: "PUT",
        body: JSON.stringify({ [field]: n }),
      }),
    onSuccess: () => {
      toast(t("saved"));
      setValue(null);
      void qc.invalidateQueries({ queryKey: ["admin", "settings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const parsed = value === null ? null : parsePositiveIntegerField(value);
  const valid =
    value === null ||
    (parsed !== null &&
      (min === undefined || parsed >= min) &&
      (max === undefined || parsed <= max));
  return (
    <div className="space-y-1">
      <Label htmlFor={field}>{label}</Label>
      <p className="text-xs text-muted-foreground">{hint}</p>
      <div className="flex items-center gap-2">
        <Input
          id={field}
          value={value ?? String(current)}
          onChange={(e) => setValue(e.target.value)}
          inputMode="numeric"
          placeholder={placeholder}
          aria-invalid={!valid}
          className={!valid ? "border-destructive" : undefined}
        />
        <Button
          variant="outline"
          disabled={value === null || !valid || mutation.isPending}
          onClick={() => parsed !== null && mutation.mutate(parsed)}
        >
          {mutation.isPending ? t("saving") : t("save")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Support & contact settings (GET/PUT /api/v1/admin/support-settings).
 * GET response is nested ({ display_name, support: { email, telegram, facebook,
 * threads, custom } }); the PUT body is FLAT over exactly the five whitelisted
 * string keys plus the structured `support_custom` array (null clears, up to
 * 10 { label, url } entries) and is validated as a whole server-side before
 * any write, so the form always sends every key (dirty value, current value,
 * or null to clear).
 */
export interface SupportSettings {
  display_name: string | null;
  support: {
    email: string | null;
    telegram: string | null;
    facebook: string | null;
    threads: string | null;
    custom: { label: string; url: string }[];
  };
}

type SupportFieldKey =
  | "display_name"
  | "support_email"
  | "support_telegram"
  | "support_facebook"
  | "support_threads";

type SupportFlat = Record<SupportFieldKey, string | null>;

// Admin-curated custom links (apps/api/src/routes/support-settings.ts is the
// validation authority: max 10 entries, labels <= 30, HTTPS URLs).
const SUPPORT_CUSTOM_MAX = 10;
const SUPPORT_CUSTOM_LABEL_MAX = 30;
type SupportCustomDraft = { label: string; url: string };
type SupportValues = Partial<Record<SupportFieldKey, string>> & { custom?: SupportCustomDraft[] };

// Mirrored validators (apps/api/src/routes/support-settings.ts is the authority;
// kept in sync here only for immediate input feedback — the server rejects on
// its own rules regardless of what the client thinks).
const SUPPORT_EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const SUPPORT_EMAIL_MAX = 254;

const hasSupportControlChars = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
};

function validateSupportEmail(raw: string): boolean {
  const v = raw.trim();
  return (
    !!v && v.length <= SUPPORT_EMAIL_MAX && !hasSupportControlChars(v) && SUPPORT_EMAIL_RE.test(v)
  );
}

function validateSupportHttpsUrl(raw: string): boolean {
  const v = raw.trim();
  if (!v || hasSupportControlChars(v) || v.includes("\\") || v.startsWith("//")) return false;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  return (
    u.protocol === "https:" &&
    !u.username &&
    !u.password &&
    !!u.hostname &&
    u.hostname.includes(".")
  );
}

function validateSupportDisplayName(raw: string): boolean {
  const v = raw.trim();
  return !!v && v.length <= 100 && !hasSupportControlChars(v);
}

function validateSupportCustomLabel(raw: string): boolean {
  const v = raw.trim();
  return !!v && v.length <= SUPPORT_CUSTOM_LABEL_MAX && !hasSupportControlChars(v);
}

// Sent rows: trimmed; fully-empty rows dropped (a half-filled row stays so the
// client feedback and the server rejection can point at it).
function normalizeCustomRows(rows: SupportCustomDraft[]): SupportCustomDraft[] {
  return rows
    .map((r) => ({ label: r.label.trim(), url: r.url.trim() }))
    .filter((r) => r.label !== "" || r.url !== "");
}

function supportFieldValid(key: SupportFieldKey, raw: string): boolean {
  switch (key) {
    case "support_email":
      return validateSupportEmail(raw);
    case "support_telegram":
    case "support_facebook":
    case "support_threads":
      return validateSupportHttpsUrl(raw);
    case "display_name":
      return validateSupportDisplayName(raw);
  }
}

const toFlat = (shape: SupportSettings): SupportFlat => ({
  display_name: shape.display_name,
  support_email: shape.support.email,
  support_telegram: shape.support.telegram,
  support_facebook: shape.support.facebook,
  support_threads: shape.support.threads,
});

// Field metadata: label/copy keys and the client validator mirror per key.
const SUPPORT_FIELDS: {
  key: SupportFieldKey;
  labelKey: "displayName" | "emailLabel" | "telegramLabel" | "facebookLabel" | "threadsLabel";
  invalidHintKey: "invalidName" | "invalidEmail" | "invalidUrl";
  kind: "name" | "email" | "url";
}[] = [
  { key: "display_name", labelKey: "displayName", invalidHintKey: "invalidName", kind: "name" },
  { key: "support_email", labelKey: "emailLabel", invalidHintKey: "invalidEmail", kind: "email" },
  { key: "support_telegram", labelKey: "telegramLabel", invalidHintKey: "invalidUrl", kind: "url" },
  { key: "support_facebook", labelKey: "facebookLabel", invalidHintKey: "invalidUrl", kind: "url" },
  { key: "support_threads", labelKey: "threadsLabel", invalidHintKey: "invalidUrl", kind: "url" },
];

// Saved shape: a value is dirty when its input differs from the fetched one;
// blank input clears (null). Saved values feed the flat PUT body verbatim.
function buildSupportBody(
  current: SupportFlat,
  currentCustom: SupportCustomDraft[],
  values: SupportValues | null,
): SupportFlat & { support_custom: SupportCustomDraft[] } {
  const out = { ...current };
  for (const key of Object.keys(current) as SupportFieldKey[]) {
    const raw = values?.[key];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    out[key] = trimmed === "" ? null : trimmed;
  }
  const custom = values?.custom !== undefined ? values.custom : currentCustom;
  return { ...out, support_custom: normalizeCustomRows(custom) };
}

/** One support field: label + input + client-mirror feedback + channel hints. */
function SupportFieldRow({
  field,
  value,
  invalid,
  emailUnset,
  onChange,
}: {
  field: (typeof SUPPORT_FIELDS)[number];
  value: string;
  invalid: boolean;
  emailUnset: boolean;
  onChange: (value: string) => void;
}) {
  const t = useT(adminSettingsCopy);
  return (
    <div className="space-y-1">
      <Label htmlFor={field.key}>{t(field.labelKey)}</Label>
      <Input
        id={field.key}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid}
        className={invalid ? "border-destructive" : undefined}
      />
      {invalid && <p className="text-xs text-destructive">{t(field.invalidHintKey)}</p>}
      {field.kind === "email" && emailUnset && (
        <p className="text-xs text-muted-foreground">
          {t("emailFallbackHint", { email: DEFAULT_SUPPORT_EMAIL })}
        </p>
      )}
      {field.kind === "url" && <p className="text-xs text-muted-foreground">{t("urlHint")}</p>}
    </div>
  );
}

/** Admin-curated custom links editor: bounded rows of label + HTTPS URL. */
function CustomLinksEditor({
  rows,
  edited,
  onChange,
}: {
  rows: SupportCustomDraft[];
  edited: boolean;
  onChange: (rows: SupportCustomDraft[]) => void;
}) {
  const t = useT(adminSettingsCopy);
  const setRow = (i: number, patch: Partial<SupportCustomDraft>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{t("customSection")}</p>
      <p className="text-xs text-muted-foreground">
        {t("customHint", { max: SUPPORT_CUSTOM_MAX })}
      </p>
      {rows.map((row, i) => {
        const invalidLabel = edited && !validateSupportCustomLabel(row.label);
        const invalidUrl = edited && !validateSupportHttpsUrl(row.url);
        return (
          <div key={i} className="flex flex-wrap items-start gap-2">
            <div className="min-w-[8rem] flex-1 space-y-1">
              <Input
                id={`custom_label_${i}`}
                value={row.label}
                placeholder={t("customLabel")}
                aria-label={t("customLabel")}
                aria-invalid={invalidLabel}
                className={invalidLabel ? "border-destructive" : undefined}
                onChange={(e) => setRow(i, { label: e.target.value })}
              />
              {invalidLabel && (
                <p className="text-xs text-destructive">{t("invalidCustomLabel")}</p>
              )}
            </div>
            <div className="min-w-[12rem] flex-[2] space-y-1">
              <Input
                id={`custom_url_${i}`}
                value={row.url}
                placeholder={t("customUrl")}
                aria-label={t("customUrl")}
                aria-invalid={invalidUrl}
                className={invalidUrl ? "border-destructive" : undefined}
                onChange={(e) => setRow(i, { url: e.target.value })}
              />
              {invalidUrl && <p className="text-xs text-destructive">{t("invalidUrl")}</p>}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
            >
              {t("removeCustomLink")}
            </Button>
          </div>
        );
      })}
      <Button
        variant="outline"
        size="sm"
        disabled={rows.length >= SUPPORT_CUSTOM_MAX}
        onClick={() => onChange([...rows, { label: "", url: "" }])}
      >
        {t("addCustomLink")}
      </Button>
    </div>
  );
}

/** Edit form: per-field rows + save. Owns the PUT mutation and inline server error. */
function SupportForm({
  current,
  currentCustom,
  values,
  setValues,
  emailUnset,
}: {
  current: SupportFlat;
  currentCustom: SupportCustomDraft[];
  values: SupportValues | null;
  setValues: (values: SupportValues | null) => void;
  emailUnset: boolean;
}) {
  const t = useT(adminSettingsCopy);
  const qc = useQueryClient();
  // Server rejections render inline (the toast is not testable/visible in every
  // surface); cleared on the next successful save.
  const [serverError, setServerError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (body: SupportFlat) =>
      api<SupportSettings>("/api/v1/admin/support-settings", {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      toast(t("saved"));
      setServerError(null);
      setValues(null);
      void qc.invalidateQueries({ queryKey: ["admin", "support-settings"] });
    },
    onError: (e: Error) => setServerError(e.message),
  });
  const dirty = values !== null;
  return (
    <div className="space-y-4">
      {SUPPORT_FIELDS.map((field) => {
        const edited = values?.[field.key];
        const value = values?.[field.key] ?? current[field.key] ?? "";
        return (
          <SupportFieldRow
            key={field.key}
            field={field}
            value={value}
            invalid={edited !== undefined && !supportFieldValid(field.key, edited)}
            emailUnset={emailUnset}
            onChange={(v) => setValues({ ...values, [field.key]: v })}
          />
        );
      })}
      <CustomLinksEditor
        rows={values?.custom ?? currentCustom}
        edited={values?.custom !== undefined}
        onChange={(rows) => setValues({ ...values, custom: rows })}
      />
      {serverError && <p className="text-sm text-destructive">{serverError}</p>}
      <Button
        variant="outline"
        disabled={!dirty || mutation.isPending}
        onClick={() => values && mutation.mutate(buildSupportBody(current, currentCustom, values))}
      >
        {mutation.isPending ? t("saving") : t("save")}
      </Button>
    </div>
  );
}

export function SupportSettingsCard() {
  const t = useT(adminSettingsCopy);
  const query = useAdminQuery<SupportSettings>(
    ["admin", "support-settings"],
    "/api/v1/admin/support-settings",
  );
  // null = pristine (render fetched values); otherwise the touched edit strings
  // only (untouched keys keep rendering the fetched value).
  const [values, setValues] = useState<SupportValues | null>(null);

  const current: SupportFlat | null = query.data ? toFlat(query.data) : null;
  const currentCustom = query.data?.support.custom ?? [];
  const emailUnset = (current?.support_email ?? "").trim() === "";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{t("support")}</CardTitle>
      </CardHeader>
      <CardContent>
        <AdminGate query={query}>
          {current ? (
            <SupportForm
              current={current}
              currentCustom={currentCustom}
              values={values}
              setValues={setValues}
              emailUnset={emailUnset}
            />
          ) : null}
        </AdminGate>
      </CardContent>
    </Card>
  );
}

export default function AdminSettingsPage() {
  const t = useT(adminSettingsCopy);
  const query = useAdminQuery<AdminSettings>(["admin", "settings"], "/api/v1/admin/settings");
  return (
    // No p-6: router wrapper already pads the page; double padding starves 375px phones.
    <div className="mx-auto w-full max-w-4xl">
      <PageHeader title={t("title")} description={t("description")} />
      <AdminGate query={query}>
        <div className="mt-6 space-y-4">
          <PromptCachingCard query={query} />
          <FirstTopupBonusCard query={query} />
          <PaymentControlsCard query={query} />
          <SupportSettingsCard />
          <SystemCard />
        </div>
      </AdminGate>
    </div>
  );
}
