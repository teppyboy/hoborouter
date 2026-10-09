/**
 * Unified promo panel (member-facing): ONE input + Apply, server-kind-driven.
 * Apply POSTs /api/v1/workspaces/:id/promotions/preview { code,
 * original_amount_vnd? } and renders the server's verdict:
 *
 * - kind "fixed": shows "Redeem X₫ credit?" and only the explicit Confirm
 *   button POSTs the existing redeem endpoint { code }. Preview never credits.
 * - kind "percent": renders the server-computed discount_vnd/final_due_vnd
 *   verbatim (the client never computes money) and only attaches the code to
 *   the pending top-up on an explicit action via onAttach — the code is then
 *   consumed by the normal payment-creation flow.
 *
 * Race guard: every preview response is applied only if its attempt is the
 * latest, the workspace is unchanged, and the typed code is unchanged — stale
 * responses are dropped. Input changes clear the preview and detach a stale
 * attached top-up code (onDetach); workspace changes reset everything.
 * All failures render honest friendly messages; nothing ever auto-retries.
 * The code is a secret-ish bearer token: controlled component state only,
 * never persisted or logged. `autocomplete=off` is kept.
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useT, type LocaleEntry } from "../lib/i18n/t";
import { formatVnd } from "../lib/format";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export interface PromoPreviewFixed {
  kind: "fixed";
  promo_id: string;
  name: string;
  amount_vnd: number;
}

export interface PromoPreviewPercent {
  kind: "percent";
  promo_id: string;
  name: string;
  percent_bp: number;
  max_discount_vnd: number;
  /** Present only when the preview carried a positive integer original_amount_vnd. */
  discount_vnd?: number;
  final_due_vnd?: number;
}

export type PromoPreview = PromoPreviewFixed | PromoPreviewPercent;

interface RedeemResponse {
  balance: number;
  credited_vnd: number;
  promo_id: string;
}

export type PromoPanelErrorKey =
  | "errEmpty"
  | "errFormat"
  | "errAmount"
  | "errReplay"
  | "errExpired"
  | "errExhausted"
  | "errInactive"
  | "errSuspended"
  | "errAuth"
  | "errNotFound"
  | "errGeneric";

/**
 * Preview error mapping: every failure becomes one dictionary key, never a raw
 * server string. Mirrors the preview contract (400 INVALID_CODE|INVALID_AMOUNT,
 * 401, 404 NOT_FOUND masking, 409 PROMO_INACTIVE|EXPIRED|EXHAUSTED|
 * ALREADY_REDEEMED) plus the redeem-era alias (PROMO_NOT_FOUND) and the
 * suspended-workspace gate.
 */
export function previewErrorKey(err: unknown): PromoPanelErrorKey {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "INVALID_CODE":
        return "errFormat";
      case "INVALID_AMOUNT":
        return "errAmount";
      case "NOT_FOUND":
      case "PROMO_NOT_FOUND":
        return "errNotFound";
      case "ALREADY_REDEEMED":
        return "errReplay";
      case "PROMO_EXPIRED":
        return "errExpired";
      case "PROMO_EXHAUSTED":
        return "errExhausted";
      case "PROMO_INACTIVE":
        return "errInactive";
      case "WORKSPACE_SUSPENDED":
        return "errSuspended";
    }
    if (err.status === 401 || err.status === 403) return "errAuth";
  }
  return "errGeneric";
}

/** Total mapping for the fixed-confirm redeem call (same endpoint as before). */
export function redeemErrorKey(err: unknown): PromoPanelErrorKey {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "ALREADY_REDEEMED":
        return "errReplay";
      case "PROMO_EXPIRED":
        return "errExpired";
      case "PROMO_EXHAUSTED":
        return "errExhausted";
      case "PROMO_INACTIVE":
        return "errInactive";
      case "WORKSPACE_SUSPENDED":
        return "errSuspended";
      case "INVALID_CODE":
        return "errFormat";
      case "PROMO_NOT_FOUND":
        return "errNotFound";
    }
    if (err.status === 401 || err.status === 403) return "errAuth";
  }
  return "errGeneric";
}

const dict = {
  title: { en: "Promo code", vi: "Mã khuyến mãi" },
  label: { en: "Promo code", vi: "Mã khuyến mãi" },
  apply: { en: "Apply", vi: "Áp dụng" },
  errEmpty: { en: "Enter a promo code", vi: "Nhập mã khuyến mãi" },
  errFormat: {
    en: "That code is not valid — check it and try again",
    vi: "Mã không hợp lệ — bạn kiểm tra lại rồi thử nhé",
  },
  errAmount: {
    en: "Enter a valid top-up amount first, then apply the code again",
    vi: "Bạn nhập số tiền nạp hợp lệ rồi áp dụng mã lại nhé",
  },
  errReplay: {
    en: "This code was already used by this workspace",
    vi: "Mã này đã được workspace này sử dụng",
  },
  errExpired: { en: "This code has expired", vi: "Mã này đã hết hạn" },
  errExhausted: {
    en: "This code has no redemptions left",
    vi: "Mã này đã hết lượt sử dụng",
  },
  errInactive: { en: "This code is not active", vi: "Mã này hiện không hoạt động" },
  errSuspended: {
    en: "This workspace is suspended, so codes cannot be applied",
    vi: "Workspace này đang bị tạm ngưng nên không thể áp dụng mã",
  },
  errAuth: {
    en: "Your session ended — sign in and try again",
    vi: "Phiên đăng nhập đã hết — bạn đăng nhập lại rồi thử nhé",
  },
  errNotFound: {
    en: "Unknown code — check it and try again",
    vi: "Không tìm thấy mã — kiểm tra lại rồi thử nhé",
  },
  errGeneric: {
    en: "Applying the code failed — try again in a moment",
    vi: "Áp dụng mã không thành công — bạn thử lại sau ít phút nhé",
  },
  fixedConfirm: { en: "Redeem {amount} credit?", vi: "Đổi {amount} tín dụng?" },
  confirmRedeem: { en: "Confirm redeem", vi: "Xác nhận đổi" },
  redeeming: { en: "Redeeming…", vi: "Đang đổi mã…" },
  percentOff: {
    en: "{percent} off top-ups (up to {cap})",
    vi: "Giảm {percent} khi nạp (tối đa {cap})",
  },
  discountLine: {
    en: "Discount {discount} · you pay {due}",
    vi: "Giảm {discount} · bạn thanh toán {due}",
  },
  attachToTopup: { en: "Apply to top-up", vi: "Dùng cho lần nạp" },
  attachedNote: {
    en: "Code attached — it will apply to your next top-up.",
    vi: "Đã gắn mã — mã sẽ áp dụng cho lần nạp tiếp theo.",
  },
  success: {
    en: "Redeemed {amount} — new balance {balance}",
    vi: "Đã đổi {amount} — số dư mới {balance}",
  },
} satisfies Record<string, LocaleEntry>;

/** Friendly display of basis points: 300 -> "3%", 350 -> "3.5%", 333 -> "3.33%". */
function formatPercentBp(bp: number): string {
  return `${Number((bp / 100).toFixed(2))}%`;
}

export interface PromoCodePanelProps {
  workspaceId: string;
  /**
   * Current top-up amount in VND (null when the amount is unknown, e.g. USD
   * input — USD amounts resolve server-side and the client never converts).
   * Sent as original_amount_vnd so the server can compute the percent discount.
   */
  amountVnd: number | null;
  /** Code currently attached to the pending top-up (parent-owned state). */
  attachedCode: string | null;
  /** Attach a percent code to the top-up (explicit user action only). */
  onAttach: (code: string) => void;
  /** Detach the stale attached code (input or workspace changed). */
  onDetach: () => void;
}

interface PreviewVars {
  wsId: string;
  code: string;
  amount: number | null;
  attempt: number;
}

/** An accepted preview, tagged with the workspace and code it belongs to. */
interface PreviewState {
  wsId: string;
  code: string;
  data: PromoPreview;
}

export function PromoCodePanel({
  workspaceId,
  amountVnd,
  attachedCode,
  onAttach,
  onDetach,
}: PromoCodePanelProps) {
  const t = useT(dict);
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const [validationError, setValidationError] = useState<PromoPanelErrorKey | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [redeemed, setRedeemed] = useState<{
    wsId: string;
    amount: number;
    balance: number;
  } | null>(null);

  // Race-guard state, kept in refs so mutation callbacks always see the
  // current values without re-creating the mutations.
  const attemptRef = useRef(0);
  const codeRef = useRef(code);
  codeRef.current = code;
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;
  const amountRef = useRef(amountVnd);
  amountRef.current = amountVnd;
  // Tracks which code currently owns a percent preview (shown or re-loading
  // after an amount change). The amount effect keys on this instead of the
  // rendered preview, because the stale preview is cleared while re-loading.
  const activePercentCodeRef = useRef<string | null>(null);
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const attachedRef = useRef(attachedCode);
  attachedRef.current = attachedCode;
  const onDetachRef = useRef(onDetach);
  onDetachRef.current = onDetach;

  // A response belongs to this attempt only if the attempt is current, the
  // workspace is unchanged, and the typed code is unchanged.
  const isCurrent = (vars: PreviewVars) =>
    vars.attempt === attemptRef.current &&
    vars.wsId === workspaceRef.current &&
    vars.code === codeRef.current.trim();

  const previewMutation = useMutation({
    mutationFn: ({ wsId, code: promoCode, amount }: PreviewVars) =>
      api<PromoPreview>(`/api/v1/workspaces/${wsId}/promotions/preview`, {
        method: "POST",
        // The discount math needs the amount; anything else (USD top-ups,
        // invalid amounts) previews percent + cap only, never client money.
        body: JSON.stringify(
          amount != null && amount > 0 && Number.isSafeInteger(amount)
            ? { code: promoCode, original_amount_vnd: amount }
            : { code: promoCode },
        ),
      }),
    onSuccess: (data, vars) => {
      if (!isCurrent(vars)) return;
      setPreview({ wsId: vars.wsId, code: vars.code, data });
      activePercentCodeRef.current = data.kind === "percent" ? vars.code : null;
      setValidationError(null);
    },
    onError: (err, vars) => {
      if (!isCurrent(vars)) return;
      setPreview(null);
      activePercentCodeRef.current = null;
      setValidationError(previewErrorKey(err));
    },
  });
  const previewMutate = previewMutation.mutate;

  const firePreview = (rawCode: string) => {
    const trimmed = rawCode.trim();
    if (!trimmed) {
      setValidationError("errEmpty");
      return;
    }
    setValidationError(null);
    // No client format gate: the server normalizes and validates (legacy
    // 32-hex and freeform codes are both sent outer-trimmed).
    activePercentCodeRef.current = null;
    const attempt = ++attemptRef.current;
    previewMutate({
      wsId: workspaceRef.current,
      code: trimmed,
      amount: amountRef.current,
      attempt,
    });
  };

  // A top-up amount change re-previews the active percent discount with the
  // new amount (server math). The stale preview is cleared first so the old
  // computed discount/due numbers are never displayed against the new amount
  // while the re-preview loads, and the same attempt guard drops stale
  // responses. Fixed previews are amount-independent and stay put.
  const lastAmountRef = useRef(amountVnd);
  useEffect(() => {
    const prev = lastAmountRef.current;
    lastAmountRef.current = amountVnd;
    if (prev === amountVnd) return;
    const current = codeRef.current.trim();
    if (!current || activePercentCodeRef.current !== current) return;
    setPreview(null);
    const attempt = ++attemptRef.current;
    previewMutate({ wsId: workspaceRef.current, code: current, amount: amountVnd, attempt });
  }, [amountVnd, previewMutate]);

  // Identity boundary: a workspace switch invalidates everything captured for
  // the previous one — input, preview, validation error, redeem state — and
  // detaches the code attached to the previous workspace's top-up. The initial
  // mount is not a switch: whatever the parent attached belongs to THIS
  // workspace and must survive it.
  const mountedWorkspaceRef = useRef(workspaceId);
  useEffect(() => {
    if (mountedWorkspaceRef.current === workspaceId) return;
    mountedWorkspaceRef.current = workspaceId;
    setCode("");
    setValidationError(null);
    setPreview(null);
    activePercentCodeRef.current = null;
    setRedeemed(null);
    redeem.reset();
    if (attachedRef.current) onDetachRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const redeem = useMutation({
    mutationFn: ({ wsId, promoCode }: { wsId: string; promoCode: string }) =>
      api<RedeemResponse>(`/api/v1/workspaces/${wsId}/promotions/redeem`, {
        method: "POST",
        body: JSON.stringify({ code: promoCode }),
      }),
    onSuccess: async (data, vars) => {
      await queryClient.invalidateQueries({ queryKey: ["wallet", vars.wsId] });
      await queryClient.invalidateQueries({ queryKey: ["ledger", vars.wsId] });
      setRedeemed({ wsId: vars.wsId, amount: data.credited_vnd, balance: data.balance });
      setPreview(null);
      setCode("");
    },
  });

  const pending = previewMutation.isPending;
  const previewError = validationError ? t(validationError) : null;

  // A preview is shown only while the typed code still matches it and it
  // belongs to the current workspace; anything else is stale and hidden.
  const showPreview =
    preview && preview.wsId === workspaceId && preview.code === code.trim() ? preview : null;
  const fixed = showPreview && showPreview.data.kind === "fixed" ? showPreview.data : null;
  const percent = showPreview && showPreview.data.kind === "percent" ? showPreview.data : null;
  const attached = attachedCode != null && attachedCode === showPreview?.code;

  const redeemPending = redeem.isPending;
  const redeemError = redeem.isError ? t(redeemErrorKey(redeem.error)) : null;
  // Success belongs to the workspace it was redeemed in; a changed workspace
  // never sees the old balance message even before the reset effect commits.
  const showRedeemed = redeemed && redeemed.wsId === workspaceId ? redeemed : null;

  const handleApply = (event: React.FormEvent) => {
    event.preventDefault();
    firePreview(code);
  };

  const handleConfirmRedeem = () => {
    // Only reachable with a fixed preview for the current workspace; the code
    // is captured from the preview, not re-read from the input.
    if (!showPreview || showPreview.data.kind !== "fixed" || redeemPending) return;
    redeem.mutate({ wsId: workspaceId, promoCode: showPreview.code });
  };

  const handleAttach = () => {
    if (!showPreview || showPreview.data.kind !== "percent") return;
    onAttach(showPreview.code);
  };

  return (
    <div className="mt-6 border-t pt-4">
      <h3 className="text-sm font-semibold">{t("title")}</h3>
      <form onSubmit={handleApply} className="mt-2 space-y-2" noValidate>
        <label htmlFor="promo-code-input" className="block text-xs font-medium">
          {t("label")}
        </label>
        <Input
          id="promo-code-input"
          name="promo-code"
          type="text"
          autoComplete="off"
          // Never offer to save a promo code as a credential or autofill it.
          spellCheck={false}
          className="font-mono"
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            setValidationError(null);
            // The old preview and any attached top-up code belong to the old
            // input; typing alone never fires a request (Apply is explicit).
            setPreview(null);
            activePercentCodeRef.current = null;
            if (attachedRef.current) onDetachRef.current();
          }}
          disabled={pending}
        />
        <Button type="submit" className="w-full" aria-busy={pending}>
          {t("apply")}
        </Button>
        {previewError ? (
          <p role="alert" className="text-sm text-destructive">
            {previewError}
          </p>
        ) : null}
      </form>
      {fixed ? (
        <div className="mt-2 space-y-2">
          <p role="status" className="text-sm font-medium">
            {t("fixedConfirm", { amount: formatVnd(fixed.amount_vnd) })}
          </p>
          <Button
            type="button"
            className="w-full"
            disabled={redeemPending}
            onClick={handleConfirmRedeem}
          >
            {redeemPending ? t("redeeming") : t("confirmRedeem")}
          </Button>
        </div>
      ) : null}
      {percent ? (
        <div className="mt-2 space-y-2">
          <p role="status" className="text-sm font-medium">
            {t("percentOff", {
              percent: formatPercentBp(percent.percent_bp),
              cap: formatVnd(percent.max_discount_vnd),
            })}
          </p>
          {percent.discount_vnd != null && percent.final_due_vnd != null ? (
            <p role="status" className="text-sm">
              {t("discountLine", {
                discount: formatVnd(percent.discount_vnd),
                due: formatVnd(percent.final_due_vnd),
              })}
            </p>
          ) : null}
          {attached ? (
            <p role="status" className="text-sm font-medium">
              {t("attachedNote")}
            </p>
          ) : (
            <Button type="button" className="w-full" onClick={handleAttach}>
              {t("attachToTopup")}
            </Button>
          )}
        </div>
      ) : null}
      {redeemError ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {redeemError}
        </p>
      ) : null}
      {showRedeemed ? (
        <p role="status" className="mt-2 text-sm font-medium">
          {t("success", {
            amount: formatVnd(showRedeemed.amount),
            balance: formatVnd(showRedeemed.balance),
          })}
        </p>
      ) : null}
    </div>
  );
}

export default PromoCodePanel;
