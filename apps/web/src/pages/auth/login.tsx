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
import { Turnstile, turnstileEnabled } from "../../components/turnstile";
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
  const [token, setToken] = useState<string | null>(null);
  const onToken = setToken;
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
  });

  const handleValid = async (values: Values) => {
    const { error } = await authClient.signIn.email(values, {
      headers: turnstileEnabled && token ? { "x-captcha-response": token } : undefined,
    });
    if (error) {
      form.setError("password", { message: error.message ?? "Sign in failed" });
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
      <h1 className="text-lg font-semibold">Sign in</h1>
      <p className="mt-1 text-sm text-muted-foreground">
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
          {turnstileEnabled && <Turnstile onToken={onToken} />}
          <Button
            type="submit"
            disabled={form.formState.isSubmitting || (turnstileEnabled && !token)}
          >
            Sign in
          </Button>
        </form>
      </Form>
    </AuthLayout>
  );
}
