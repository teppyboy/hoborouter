import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { authClient } from "../../lib/auth";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
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
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
  });

  const handleValid = async (values: Values) => {
    const { error } = await authClient.signIn.email(values);
    if (error) {
      form.setError("password", { message: error.message ?? "Sign in failed" });
      return;
    }
    toast("Signed in");
    navigate({ to: "/" });
  };

  return (
    <div className="mx-auto mt-16 w-full max-w-sm">
      <h1 className="text-lg font-semibold">Sign in</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Welcome back. No account?{" "}
        <Link to="/signup" className="underline">
          Sign up
        </Link>
      </p>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(handleValid)} className="mt-6 grid gap-4">
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormControl>
                  <Input type="email" autoComplete="email" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Password</FormLabel>
                <FormControl>
                  <Input type="password" autoComplete="current-password" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button type="submit" disabled={form.formState.isSubmitting}>
            Sign in
          </Button>
        </form>
      </Form>
    </div>
  );
}
