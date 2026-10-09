// Public /verify-email landing page. The signed verification link is handled
// entirely by the Better Auth API route, which redirects here AFTER the token
// is verified (or rejected) server-side — this page never receives, sends, or
// logs a token, and never calls the verify endpoint from a plain query string.
// Status is reported only from the real session flag (user.emailVerified), so
// a forged query parameter can never produce a "Verified" message.
import { useEffect } from "react";
import { Link } from "@tanstack/react-router";
import { useSession, type SessionUser } from "../../lib/auth";
import { ResendVerificationButton } from "../../components/resend-verification";
import { AuthLayout } from "../../components/auth-layout";
import { Button } from "../../components/ui/button";
import { useAuthT } from "./copy";

export function VerifyEmailView({ user, loading }: { user: SessionUser | null; loading: boolean }) {
  const t = useAuthT();
  if (loading) {
    return <p className="text-sm text-muted-foreground">{t("verifyLoading")}</p>;
  }
  if (user && user.emailVerified === true) {
    return (
      <div className="grid gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t("verifiedTitle")}</h1>
        <p className="text-sm text-muted-foreground">{t("verifiedBody")}</p>
        <Button asChild size="sm" className="w-fit">
          <Link to="/">{t("goHome")}</Link>
        </Button>
      </div>
    );
  }
  if (user) {
    return (
      <div className="grid gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t("unverifiedTitle")}</h1>
        <p className="text-sm text-muted-foreground">
          {user.email
            ? t("unverifiedBodyWithEmail", { email: user.email })
            : t("unverifiedBodyNoEmail")}
        </p>
        {user.email && (
          <ResendVerificationButton email={user.email} label={t("resendVerificationEmail")} />
        )}
        <Link to="/" className="text-sm underline">
          {t("backHome")}
        </Link>
      </div>
    );
  }
  return (
    <div className="grid gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">{t("processedTitle")}</h1>
      <p className="text-sm text-muted-foreground">{t("processedBody")}</p>
      <Button asChild size="sm" className="w-fit">
        <Link to="/login">{t("signIn")}</Link>
      </Button>
    </div>
  );
}

export default function VerifyEmailPage() {
  const { data: session, isPending, refetch } = useSession();
  // The cached session may predate the click on the verification link: refresh
  // once on mount so the flag reflects the verification that just happened.
  useEffect(() => {
    void refetch();
  }, [refetch]);
  return (
    // Same house auth frame as /login and /signup: one layout, three surfaces.
    <AuthLayout>
      <VerifyEmailView user={session?.user ?? null} loading={isPending} />
    </AuthLayout>
  );
}
