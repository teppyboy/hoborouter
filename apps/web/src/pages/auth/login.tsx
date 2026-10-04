import { useState } from "react";
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
import { Turnstile, usePublicConfig } from "../../components/turnstile";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../../components/ui/form";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});
type Values = z.infer<typeof schema>;

export default function LoginPage() {
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
    defaultValues: { email: "", password: "" },
  });

  const handleValid = async (values: Values) => {
    const { error } = await authClient.signIn.email(values, {
      headers: captchaRequired && token ? { "x-captcha-response": token } : undefined,
    });
    if (error) {
      form.setError("password", { message: error.message ?? "Sign in failed" });
      // Tokens are one-shot: reset so the next attempt gets a fresh one.
      if (captchaRequired) {
        setToken(null);
        setResetKey((k) => k + 1);
      }
      return;
    }
    toast("Signed in");
    // Session identity changed: drop all cached workspace-scoped data so no
    // stale (or unauthorized) queries from the previous session refetch.
    queryClient.clear();
    navigate({ to: "/" });
  };

  return (
    <AuthLayout>
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Welcome back. No account?{" "}
        <Link to="/signup" className="underline">
          Sign up
        </Link>
      </p>
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
                  <FormLabel>{name === "email" ? "Email" : "Password"}</FormLabel>
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
            Sign in
          </Button>
          <p className="text-xs text-muted-foreground">
            <Link to="/terms" className="underline underline-offset-2">Terms</Link>
            {" · "}
            <Link to="/privacy" className="underline underline-offset-2">Privacy</Link>
          </p>
        </form>
      </Form>
    </AuthLayout>
  );
}
