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
  name: z.string().min(1, "Name is required"),
  email: z.string().email(),
  password: z.string().min(8, "At least 8 characters"),
});
type Values = z.infer<typeof schema>;

const fields = [
  { name: "name", label: "Name", type: "text", autoComplete: "name" },
  { name: "email", label: "Email", type: "email", autoComplete: "email" },
  { name: "password", label: "Password", type: "password", autoComplete: "new-password" },
] as const;

export default function SignupPage() {
  const navigate = useNavigate();
  const [token, setToken] = useState<string | null>(null);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", email: "", password: "" },
  });

  const handleValid = async (values: Values) => {
    const { error } = await authClient.signUp.email(values, {
      headers: turnstileEnabled && token ? { "x-captcha-response": token } : undefined,
    });
    if (error) {
      form.setError("email", { message: error.message ?? "Sign up failed" });
      return;
    }
    toast("Account created");
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
                  <FormMessage className="animate-in fade-in slide-in-from-top-1" />
                </FormItem>
              )}
            />
          ))}
          {turnstileEnabled && <Turnstile onToken={setToken} />}
          <Button
            type="submit"
            disabled={form.formState.isSubmitting || (turnstileEnabled && !token)}
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
