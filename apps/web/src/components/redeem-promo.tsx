/**
 * Promo code redemption form (member-facing). POSTs
 * /api/v1/workspaces/:id/promotions/redeem with { code } and invalidates the
 * wallet/ledger queries for the workspace captured at submit time.
 *
 * Identity boundary: the workspace id is captured when the user submits, not
 * when the response arrives. A late response for a previous workspace must
 * never surface as success in the new workspace, and switching workspaces
 * resets the input and any stale result/error.
 *
 * The code is a secret-ish bearer token: kept in controlled component state
 * only — never persisted, never logged, never sent anywhere except the redeem
 * endpoint. No client-side credit math: amounts shown come from the response.
 */
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useT, type LocaleEntry } from "../lib/i18n/t";
import { formatVnd } from "../lib/format";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

interface RedeemResponse {
  balance: number;
  credited_vnd: number;
  promo_id: string;
}

// Backend contract: codes are 32 hex characters (see apps/api routes/promotions).
const CODE_PATTERN = /^[0-9a-f]{32}$/i;

interface RedeemResult {
  /** Workspace the redemption actually applied to. */
  workspaceId: string;
  creditedVnd: number;
  balance: number;
}

/** Total error mapping: every failure becomes one dictionary key, never a raw server string. */
export function redeemErrorKey(err: unknown): keyof typeof dict {
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
  title: { en: "Redeem a promo code", vi: "Đổi mã khuyến mãi" },
  label: { en: "Promo code", vi: "Mã khuyến mãi" },
  placeholder: { en: "32-character code", vi: "Mã gồm 32 ký tự" },
  submit: { en: "Redeem", vi: "Đổi mã" },
  submitting: { en: "Redeeming…", vi: "Đang đổi mã…" },
  errEmpty: { en: "Enter a promo code", vi: "Nhập mã khuyến mãi" },
  errFormat: {
    en: "Codes are 32 letters or numbers — check for typos",
    vi: "Mã gồm 32 chữ cái hoặc chữ số — bạn kiểm tra lại giúp mình",
  },
  errReplay: {
    en: "This code was already redeemed for this workspace",
    vi: "Mã này đã được dùng cho workspace này rồi",
  },
  errExpired: { en: "This code has expired", vi: "Mã này đã hết hạn" },
  errExhausted: {
    en: "This code has no redemptions left",
    vi: "Mã này đã hết lượt sử dụng",
  },
  errInactive: { en: "This code is not active", vi: "Mã này hiện không hoạt động" },
  errSuspended: {
    en: "This workspace is suspended, so codes cannot be redeemed",
    vi: "Workspace này đang bị tạm ngưng nên không thể đổi mã",
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
    en: "Redeem failed — try again in a moment",
    vi: "Đổi mã không thành công — bạn thử lại sau ít phút nhé",
  },
  success: {
    en: "Redeemed {amount} — new balance {balance}",
    vi: "Đã đổi {amount} — số dư mới {balance}",
  },
} satisfies Record<string, LocaleEntry>;

export default function RedeemPromo({ workspaceId }: { workspaceId: string }) {
  const t = useT(dict);
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const [validationError, setValidationError] = useState<keyof typeof dict | null>(null);
  const [result, setResult] = useState<RedeemResult | null>(null);

  // Identity boundary: a workspace switch invalidates everything captured for
  // the previous one — input, local validation error, mutation state, result.
  useEffect(() => {
    setCode("");
    setValidationError(null);
    setResult(null);
    redeem.reset();
    // redeem is stable per TanStack Query observer; the effect tracks the id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const redeem = useMutation({
    // workspaceId rides in the variables so the request target is captured at
    // submit time, not re-read from the (possibly changed) prop on response.
    mutationFn: ({ wsId, promoCode }: { wsId: string; promoCode: string }) =>
      api<RedeemResponse>(`/api/v1/workspaces/${wsId}/promotions/redeem`, {
        method: "POST",
        body: JSON.stringify({ code: promoCode }),
      }),
    onSuccess: async (data, vars) => {
      await queryClient.invalidateQueries({ queryKey: ["wallet", vars.wsId] });
      await queryClient.invalidateQueries({ queryKey: ["ledger", vars.wsId] });
      setResult({ workspaceId: vars.wsId, creditedVnd: data.credited_vnd, balance: data.balance });
    },
  });

  const pending = redeem.isPending;
  const errorKey = redeem.isError ? redeemErrorKey(redeem.error) : null;
  // Success belongs to the workspace it was redeemed in; a changed workspace
  // never sees the old balance message even before the effect resets it.
  const showResult = result && result.workspaceId === workspaceId ? result : null;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) {
      setValidationError("errEmpty");
      return;
    }
    if (!CODE_PATTERN.test(trimmed)) {
      setValidationError("errFormat");
      return;
    }
    setValidationError(null);
    redeem.mutate({ wsId: workspaceId, promoCode: trimmed });
  };

  return (
    <div className="mt-6 border-t pt-4">
      <h3 className="text-sm font-semibold">{t("title")}</h3>
      <form onSubmit={handleSubmit} className="mt-2 space-y-2" noValidate>
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
          placeholder={t("placeholder")}
          className="font-mono"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          disabled={pending}
        />
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? t("submitting") : t("submit")}
        </Button>
        {validationError ? (
          <p role="alert" className="text-sm text-destructive">
            {t(validationError)}
          </p>
        ) : null}
        {errorKey && errorKey !== "errEmpty" && errorKey !== "errFormat" ? (
          <p role="alert" className="text-sm text-destructive">
            {t(errorKey)}
          </p>
        ) : null}
        {showResult ? (
          <p role="status" className="text-sm font-medium">
            {t("success", {
              amount: formatVnd(showResult.creditedVnd),
              balance: formatVnd(showResult.balance),
            })}
          </p>
        ) : null}
      </form>
    </div>
  );
}
