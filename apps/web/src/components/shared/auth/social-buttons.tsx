// Shared social sign-in buttons for the auth pages. Availability comes from
// the server's public-config socialProviders flags (lib/public-config.ts) —
// the buttons never appear for unflagged providers, so email-only
// deployments render exactly as before. Provider initiation uses the Better
// Auth client's signIn.social with the exact client provider id and a
// fixed same-origin post-login callback (the SPA root, "/"); the provider
// round-trip happens server-side, so this component only handles initiation
// errors with a shared, non-leaky recovery message.
import { useState } from "react";
import { signIn } from "../../../lib/auth";
import { Button } from "../../ui/button";
import { useAuthT, type AuthT } from "../../../pages/auth/copy";
import type { SocialProviderId } from "../../../lib/public-config";

/** Display names are proper nouns: shown verbatim in every locale. */
const PROVIDER_NAMES: Record<SocialProviderId, string> = {
  google: "Google",
  discord: "Discord",
  github: "GitHub",
};

/**
 * One button per enabled provider. While an initiation is in flight every
 * button locks (no duplicate consent flows); an error clears the lock and
 * reports through onError so the page renders the shared recovery message.
 */
export function SocialSignInButtons({
  providers,
  disabled = false,
  onAttempt,
  onError,
}: {
  providers: readonly SocialProviderId[];
  disabled?: boolean;
  /** Fired synchronously when an attempt starts (lets pages clear stale errors). */
  onAttempt?: () => void;
  onError: () => void;
}) {
  const t: AuthT = useAuthT();
  const [pending, setPending] = useState(false);
  if (providers.length === 0) return null;
  const locked = disabled || pending;

  const start = async (provider: SocialProviderId) => {
    if (locked) return;
    onAttempt?.();
    setPending(true);
    // Fixed same-origin post-login path: the SPA root after a successful
    // provider round-trip (the session then loads through the normal flow).
    const { error } = await signIn.social({
      provider,
      callbackURL: window.location.origin + "/",
    });
    if (error) {
      setPending(false);
      onError();
    }
    // No success path here: the browser navigates to the provider and back.
  };

  return (
    <div className="grid gap-2">
      {providers.map((provider) => (
        <Button
          key={provider}
          type="button"
          variant="outline"
          disabled={locked}
          aria-busy={pending}
          onClick={() => void start(provider)}
        >
          {t("continueWith", { provider: PROVIDER_NAMES[provider] })}
        </Button>
      ))}
    </div>
  );
}
