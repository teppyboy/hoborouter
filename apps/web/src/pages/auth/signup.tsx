import { useState } from "react";
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
import { Turnstile, usePublicConfig } from "../../components/turnstile";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../../components/ui/form";

const PASSWORD_MESSAGE = "Does not meet the password requirements below";

const schema = z
  .object({
    name: z.string().min(1, "Name is required"),
    email: z.string().email(),
    password: z.string().refine((v) => checkPassword(v).length === 0, {
      message: PASSWORD_MESSAGE,
    }),
    confirmPassword: z.string().min(1, "Confirm your password"),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });
type Values = z.infer<typeof schema>;

const fields = [
  { name: "name", label: "Name", type: "text", autoComplete: "name" },
  { name: "email", label: "Email", type: "email", autoComplete: "email" },
  { name: "password", label: "Password", type: "password", autoComplete: "new-password" },
] as const;

/** Live rule checklist under the password field; ticks as rules are satisfied. */
function PasswordChecklist({ value }: { value: string }) {
  return (
    <ul
      aria-label="Password requirements"
      aria-live="polite"
      className="grid gap-1 text-xs text-muted-foreground"
    >
      {PASSWORD_RULES.map((rule) => {
        const ok = rule.test(value);
        return (
          <li key={rule.key} className={ok ? "text-emerald-600" : undefined}>
            <span aria-hidden="true">{ok ? "\u2713" : "\u25CB"}</span> {rule.label}
            <span className="sr-only">{ok ? " (met)" : " (not yet met)"}</span>
          </li>
        );
      })}
    </ul>
  );
}

export default function SignupPage() {
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
      form.setError("email", { message: error.message ?? "Sign up failed" });
      // Tokens are one-shot: reset so the next attempt gets a fresh one.
      if (captchaRequired) {
        setToken(null);
        setResetKey((k) => k + 1);
      }
      return;
    }
    toast.success("Account created");
    // Optional verification only: with SMTP configured the backend already
    // mailed a signed link on signup. The user can use the app either way.
    if (config?.emailVerification.enabled) {
      toast("Verification email sent — check your inbox");
    }
    queryClient.clear();
    navigate({ to: "/" });
  };

  return (
    <AuthLayout>
      <h1 className="text-2xl font-semibold tracking-tight">Create account</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link to="/login" className="underline">
          Sign in
        </Link>
      </p>
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
                  <FormLabel>{f.label}</FormLabel>
                  <FormControl>
                    <Input type={f.type} autoComplete={f.autoComplete} {...field} />
                  </FormControl>
                  {f.name === "password" && <PasswordChecklist value={watchedPassword ?? ""} />}
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
                <FormLabel>Confirm password</FormLabel>
                <FormControl>
                  <Input type="password" autoComplete="new-password" {...field} />
                </FormControl>
                <FormMessage className="animate-in fade-in slide-in-from-top-1" />
              </FormItem>
            )}
          />
          {isPending && (
            <p className="text-sm text-muted-foreground">Checking security options…</p>
          )}
          {isError && (
            <p role="alert" className="text-sm text-destructive">
              Could not load security options. {" "}
              <button type="button" className="underline" onClick={() => void refetch()}>
                Retry
              </button>
            </p>
          )}
          {scriptError && (
            <p role="alert" className="text-sm text-destructive">
              Could not load the captcha check. {" "}
              <button
                type="button"
                className="underline"
                onClick={() => {
                  setScriptError(false);
                  setResetKey((k) => k + 1);
                }}
              >
                Retry
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
            Sign up
          </Button>
          <p className="text-xs text-muted-foreground">
            By creating an account you agree to the{" "}
            <Link to="/terms" className="underline underline-offset-2">
              Terms of Service
            </Link>{" "}
            and{" "}
            <Link to="/privacy" className="underline underline-offset-2">
              Privacy Policy
            </Link>
            .
          </p>
        </form>
      </Form>
    </AuthLayout>
  );
}
