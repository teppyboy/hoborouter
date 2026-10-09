import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { PASSWORD_RULES, checkPassword } from "@hoborouter/shared";
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
export function makeSignupSchema(t: AuthT) {
  return z
    .object({
      name: z.string().min(1, t("nameRequired")),
      email: z.string().email(t("emailInvalid")),
      password: z.string().refine((v) => checkPassword(v).length === 0, {
        message: t("passwordRuleFailed"),
      }),
      confirmPassword: z.string().min(1, t("confirmRequired")),
    })
    .refine((v) => v.password === v.confirmPassword, {
      message: t("passwordMismatch"),
      path: ["confirmPassword"],
    });
}
type Values = z.infer<ReturnType<typeof makeSignupSchema>>;

const fields = [
  { name: "name", label: "nameLabel", type: "text", autoComplete: "name" },
  { name: "email", label: "emailLabel", type: "email", autoComplete: "email" },
  {
    name: "password",
    label: "passwordLabel",
    type: "password",
    autoComplete: "new-password",
  },
] as const;

/** Live rule checklist under the password field; ticks as rules are satisfied. */
function PasswordChecklist({ value, t }: { value: string; t: AuthT }) {
  return (
    <ul
      aria-label={t("passwordRequirements")}
      aria-live="polite"
      className="grid gap-1 text-xs text-muted-foreground"
    >
      {PASSWORD_RULES.map((rule) => {
        const ok = rule.test(value);
        return (
          <li key={rule.key} className={ok ? "text-emerald-600" : undefined}>
            <span aria-hidden="true">{ok ? "\u2713" : "\u25CB"}</span> {rule.label}
            <span className="sr-only">{ok ? t("ruleMet") : t("ruleNotMet")}</span>
          </li>
        );
      })}
    </ul>
  );
}

export default function SignupPage() {
  const t = useAuthT();
  const schema = useMemo(() => makeSignupSchema(t), [t]);
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
    defaultValues: { name: "", email: "", password: "", confirmPassword: "" },
  });
  const watchedPassword = form.watch("password");

  const handleValid = async (values: Values) => {
    const { error } = await authClient.signUp.email(
      { name: values.name, email: values.email, password: values.password },
      {
        headers: captchaRequired && token ? { "x-captcha-response": token } : undefined,
      },
    );
    if (error) {
      form.setError("email", { message: error.message ?? t("signUpFailed") });
      // Tokens are one-shot: reset so the next attempt gets a fresh one.
      if (captchaRequired) {
        setToken(null);
        setResetKey((k) => k + 1);
      }
      return;
    }
    toast.success(t("accountCreatedToast"));
    // Optional verification only: with SMTP configured the backend already
    // mailed a signed link on signup. The user can use the app either way.
    if (config?.emailVerification.enabled) {
      toast(t("verificationEmailToast"));
    }
    queryClient.clear();
    navigate({ to: "/" });
  };

  return (
    <AuthLayout>
      <h1 className="text-2xl font-semibold tracking-tight">{t("signUpTitle")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {t("signUpPrompt")}{" "}
        <Link to="/login" className="underline">
          {t("signIn")}
        </Link>
      </p>
      {oauthError && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {t("oauthFailed")}
        </p>
      )}
      <SocialSignInButtons
        providers={providers}
        disabled={form.formState.isSubmitting}
        onAttempt={() => setOauthError(false)}
        onError={() => setOauthError(true)}
      />
      {providers.length > 0 && (
        <p aria-hidden="true" className="mt-6 text-center text-xs text-muted-foreground">
          {t("orContinueWithEmail")}
        </p>
      )}
      <Form {...form}>
        <form onSubmit={form.handleSubmit(handleValid)} className="mt-6 grid gap-4">
          {fields.map((f, i) => (
            <FormField
              key={f.name}
              control={form.control}
              name={f.name}
              render={({ field }) => (
                <FormItem
                  className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both"
                  style={{ animationDelay: `${120 + i * 80}ms` }}
                >
                  <FormLabel>{t(f.label)}</FormLabel>
                  <FormControl>
                    <Input type={f.type} autoComplete={f.autoComplete} {...field} />
                  </FormControl>
                  {f.name === "password" && (
                    <PasswordChecklist value={watchedPassword ?? ""} t={t} />
                  )}
                  <FormMessage className="animate-in fade-in slide-in-from-top-1" />
                </FormItem>
              )}
            />
          ))}
          <FormField
            control={form.control}
            name="confirmPassword"
            render={({ field }) => (
              <FormItem
                className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both"
                style={{ animationDelay: `${120 + 3 * 80}ms` }}
              >
                <FormLabel>{t("confirmPasswordLabel")}</FormLabel>
                <FormControl>
                  <Input type="password" autoComplete="new-password" {...field} />
                </FormControl>
                <FormMessage className="animate-in fade-in slide-in-from-top-1" />
              </FormItem>
            )}
          />
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
            {t("signUp")}
          </Button>
          <p className="text-xs text-muted-foreground">
            {t("agreePrefix")}{" "}
            <Link to="/terms" className="underline underline-offset-2">
              {t("termsOfServiceLink")}
            </Link>{" "}
            {t("and")}{" "}
            <Link to="/privacy" className="underline underline-offset-2">
              {t("privacyPolicyLink")}
            </Link>
            .
          </p>
        </form>
      </Form>
    </AuthLayout>
  );
}
