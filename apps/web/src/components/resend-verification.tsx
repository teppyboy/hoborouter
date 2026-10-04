// Shared "Resend verification email" control for the unverified-session
// banner and the /verify-email page. Errors stay safe and coarse: Better Auth
// answers identically for unknown/verified addresses and rate-limits to 3/60s;
// the verification token never reaches the client (links are signed
// server-side), so there is nothing here to leak or log.
import { useState } from "react";
import { toast } from "sonner";
import { resendVerification } from "../lib/auth";
import { Button } from "./ui/button";

export function ResendVerificationButton({
  email,
  label = "Resend verification email",
}: {
  email: string;
  label?: string;
}) {
  const [sending, setSending] = useState(false);
  const send = async () => {
    setSending(true);
    const { ok, rateLimited } = await resendVerification(email);
    setSending(false);
    if (ok) toast.success("Verification email sent — check your inbox");
    else if (rateLimited) toast.error("Too many emails requested; try again in a minute");
    else toast.error("Could not send the verification email; try again later");
  };
  return (
    <Button variant="outline" size="sm" onClick={() => void send()} disabled={sending}>
      {sending ? "Sending…" : label}
    </Button>
  );
}
