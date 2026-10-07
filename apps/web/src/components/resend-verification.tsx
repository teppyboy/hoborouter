// Shared "Resend verification email" control for the unverified-session
// banner and the /verify-email page. Errors stay safe and coarse: Better Auth
// answers identically for unknown/verified addresses and rate-limits to 3/60s;
// the verification token never reaches the client (links are signed
// server-side), so there is nothing here to leak or log.
import { useState } from "react";
import { toast } from "sonner";
import { resendVerification } from "../lib/auth";
import { Button } from "./ui/button";
import { useT } from "../lib/i18n/t";

// Toast/status copy for the resend action; labels are passed by callers in
// their own dictionaries (e.g. authCopy.resendVerificationEmail).
const resendCopy = {
  label: { en: "Resend verification email", vi: "Gửi lại email xác thực" },
  sending: { en: "Sending…", vi: "Đang gửi…" },
  sent: { en: "Verification email sent — check your inbox", vi: "Đã gửi email xác thực — hãy kiểm tra hộp thư" },
  rateLimited: {
    en: "Too many emails requested; try again in a minute",
    vi: "Yêu cầu email quá nhiều; thử lại sau một phút",
  },
  failed: {
    en: "Could not send the verification email; try again later",
    vi: "Không gửi được email xác thực; thử lại sau",
  },
} as const;

export function ResendVerificationButton({
  email,
  label,
}: {
  email: string;
  label?: string;
}) {
  const t = useT(resendCopy);
  const [sending, setSending] = useState(false);
  const send = async () => {
    setSending(true);
    const { ok, rateLimited } = await resendVerification(email);
    setSending(false);
    if (ok) toast.success(t("sent"));
    else if (rateLimited) toast.error(t("rateLimited"));
    else toast.error(t("failed"));
  };
  return (
    <Button variant="outline" size="sm" onClick={() => void send()} disabled={sending}>
      {sending ? t("sending") : (label ?? t("label"))}
    </Button>
  );
}
