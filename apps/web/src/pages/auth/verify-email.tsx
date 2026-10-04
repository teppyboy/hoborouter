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
import { Button } from "../../components/ui/button";

export function VerifyEmailView({
  user,
  loading,
}: {
  user: SessionUser | null;
  loading: boolean;
}) {
  if (loading) {
    return <p className="text-sm text-muted-foreground">Checking your sign-in status…</p>;
  }
  if (user && user.emailVerified === true) {
    return (
      <div className="grid gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Email verified</h1>
        <p className="text-sm text-muted-foreground">
          Your email address is confirmed. Everything is ready to go.
        </p>
        <Button asChild size="sm" className="w-fit">
          <Link to="/">Go to Hoborouter</Link>
        </Button>
      </div>
    );
  }
  if (user) {
    return (
      <div className="grid gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Email not verified yet</h1>
        <p className="text-sm text-muted-foreground">
          The verification link may have expired or already been used. You can keep using
          Hoborouter either way{user.email ? <> — a new link can be sent to {user.email}</> : null}.
        </p>
        {user.email && <ResendVerificationButton email={user.email} />}
        <Link to="/" className="text-sm underline">
          Back to Hoborouter
        </Link>
      </div>
    );
  }
  return (
    <div className="grid gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">Verification link processed</h1>
      <p className="text-sm text-muted-foreground">
        Verification link processed; sign in to check your email status.
      </p>
      <Button asChild size="sm" className="w-fit">
        <Link to="/login">Sign in</Link>
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
    <div className="mx-auto max-w-md py-16">
      <VerifyEmailView user={session?.user ?? null} loading={isPending} />
    </div>
  );
}
