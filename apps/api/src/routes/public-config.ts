// Unauthenticated public client configuration: what the SPA needs before any
// session exists. Turnstile site key (public by design) + email-verification
// flags. The TURNSTILE_SECRET_KEY never leaves the server; a site key is only
// exposed when captcha is actually enforced, otherwise sign-up/sign-in would
// demand a token the client cannot produce.
import { Elysia, t } from "elysia";
import { jsonError } from "../authz";
import { emailVerificationEnabled } from "../email";
import { oauthProviderFlags } from "../oauth-config";

export const publicConfigRoutes = () =>
  new Elysia({ name: "public-config" }).get(
    "/api/v1/public-config",
    {
      response: t.Object({
        turnstileSiteKey: t.Union([t.String(), t.Null()]),
        emailVerification: t.Object({
          enabled: t.Boolean(),
          required: t.Boolean(),
        }),
        socialProviders: t.Object({
          google: t.Boolean(),
          discord: t.Boolean(),
          github: t.Boolean(),
        }),
      }),
      detail: {
        tags: ["System"],
        summary: "Public client configuration",
        description:
          "Unauthenticated flags for the SPA: Turnstile site key (null when captcha is disabled) and email-verification settings. Never contains secrets.",
      },
    },
    () => {
      const secretSet = !!process.env.TURNSTILE_SECRET_KEY;
      // Legacy VITE_TURNSTILE_SITE_KEY is accepted as a fallback while the
      // web app still reads it via import.meta.env.
      const siteKey = (
        process.env.TURNSTILE_SITE_KEY ?? process.env.VITE_TURNSTILE_SITE_KEY
      )?.trim();
      // Fail closed: server-side captcha is enforced, but without a site key
      // no client can pass it. Report a safe 503 instead of leaking a
      // misconfiguration or silently disabling the protection.
      if (secretSet && !siteKey) {
        return jsonError(
          503,
          "CONFIGURATION_ERROR",
          "Captcha is enforced but the site key is not configured",
        );
      }
      return {
        turnstileSiteKey: secretSet ? siteKey || null : null,
        // Verification is optional infrastructure: "enabled" only reports that
        // signup/resend mails will actually be sent (SMTP configured). It is
        // NEVER a requirement flag — unverified users can sign in normally.
        emailVerification: { enabled: emailVerificationEnabled(), required: false },
        // Server truth: a provider is advertised ONLY when both of its env
        // credentials are configured (see oauth-config). Credentials and other
        // secrets never appear here; the SPA renders provider buttons per flag.
        socialProviders: oauthProviderFlags(process.env),
      };
    },
  );
