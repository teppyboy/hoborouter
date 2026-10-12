import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { queryClient } from "../../lib/query-client";
import { authClient } from "../../lib/auth";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { AuthLayout } from "../../components/auth-layout";
import { SocialSignInButtons } from "../../components/shared/auth/social-buttons";
import { socialProvidersFrom } from "../../lib/public-config";
import { Turnstile, usePublicConfig } from "../../components/turnstile";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../../components/ui/form";
import { useAuthT, type AuthT } from "./copy";

/** Zod schema whose validation messages come from the active locale. */
export function makeLoginSchema(t: AuthT) {
  return z.object({
    email: z.string().email(t("emailInvalid")),
    password: z.string().min(8, t("passwordMin")),
  });
}
type Values = z.infer<ReturnType<typeof makeLoginSchema>>;

export default function LoginPage() {
  const t = useAuthT();
  const schema = useMemo(() => makeLoginSchema(t), [t]);
  const navigate = useNavigate();
  // Captcha is required only when the backend advertises a Turnstile site
  // key. While the config is pending or failed the submit stays disabled:
  // silently skipping captcha on a load error would fail the server check.
  const { data: config, isPending, isError, refetch } = usePublicConfig();
  const siteKey = config?.turnstileSiteKey ?? null;
  const captchaRequired = siteKey !== null;
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [scriptError, setScriptError] = useState(false);
  // Social sign-in availability: only the server-flagged providers render a
  // button. Availability flags never gate the email flow; captcha still does.
  const providers = socialProvidersFrom(config);
  const [oauthError, setOauthError] = useState(false);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
  });

  const handleValid = async (values: Values) => {
    const { error } = await authClient.signIn.email(values, {
      headers: captchaRequired && token ? { "x-captcha-response": token } : undefined,
    });
    if (error) {
      form.setError("password", { message: error.message ?? t("signInFailed") });
      // Tokens are one-shot: reset so the next attempt gets a fresh one.
      if (captchaRequired) {
        setToken(null);
        setResetKey((k) => k + 1);
      }
      return;
    }
    toast(t("signedInToast"));
    // Session identity changed: drop all cached workspace-scoped data so no
    // stale (or unauthorized) queries from the previous session refetch.
    queryClient.clear();
    navigate({ to: "/" });
  };

  return (
    <AuthLayout>
      <h1 className="text-2xl font-semibold tracking-tight">{t("signInTitle")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {t("signInPrompt")}{" "}
        <Link to="/signup" className="underline">
          {t("signUp")}
        </Link>
      </p>
      {oauthError && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {t("oauthFailed")}
        </p>
      )}
      <Form {...form}>
        <form onSubmit={form.handleSubmit(handleValid)} className="mt-6 grid gap-4">
          {(["email", "password"] as const).map((name, i) => (
            <FormField
              key={name}
              control={form.control}
              name={name}
              render={({ field }) => (
                <FormItem
                  className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both"
                  style={{ animationDelay: `${120 + i * 80}ms` }}
                >
                  <FormLabel>{name === "email" ? t("emailLabel") : t("passwordLabel")}</FormLabel>
                  <FormControl>
                    <Input
                      type={name}
                      autoComplete={name === "email" ? "email" : "current-password"}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage className="animate-in fade-in slide-in-from-top-1" />
                </FormItem>
              )}
            />
          ))}
          {isPending && <p className="text-sm text-muted-foreground">{t("checkingSecurity")}</p>}
          {isError && (
            <p role="alert" className="text-sm text-destructive">
              {t("securityLoadFailed")}{" "}
              <button type="button" className="underline" onClick={() => void refetch()}>
                {t("retry")}
              </button>
            </p>
          )}
          {scriptError && (
            <p role="alert" className="text-sm text-destructive">
              {t("captchaLoadFailed")}{" "}
              <button
                type="button"
                className="underline"
                onClick={() => {
                  setScriptError(false);
                  setResetKey((k) => k + 1);
                }}
              >
                {t("retry")}
              </button>
            </p>
          )}
          {siteKey && (
            <Turnstile
              siteKey={siteKey}
              onToken={setToken}
              resetKey={resetKey}
              onScriptError={() => setScriptError(true)}
            />
          )}
          <Button
            type="submit"
            disabled={
              isPending ||
              isError ||
              scriptError ||
              form.formState.isSubmitting ||
              (captchaRequired && !token)
            }
          >
            {t("signIn")}
          </Button>
          <p className="text-xs text-muted-foreground">
            <Link to="/terms" className="underline underline-offset-2">
              {t("termsLink")}
            </Link>
            {" · "}
            <Link to="/privacy" className="underline underline-offset-2">
              {t("privacyLink")}
            </Link>
          </p>
        </form>
      </Form>
      {providers.length > 0 && (
        <div className="mt-6 flex items-center gap-3" role="separator" aria-label={t("orDivider")}>
          <span aria-hidden="true" className="h-px flex-1 bg-border" />
          <span className="text-xs text-muted-foreground">{t("orDivider")}</span>
          <span aria-hidden="true" className="h-px flex-1 bg-border" />
        </div>
      )}
      <SocialSignInButtons
        providers={providers}
        disabled={form.formState.isSubmitting}
        onAttempt={() => setOauthError(false)}
        onError={() => setOauthError(true)}
      />
    </AuthLayout>
  );
}
