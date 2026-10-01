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
  name: z.string().min(1, "Name is required"),
  email: z.string().email(),
  password: z.string().min(8, "At least 8 characters"),
});
type Values = z.infer<typeof schema>;

export default function SignupPage() {
  const navigate = useNavigate();
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", email: "", password: "" },
  });

  const handleValid = async (values: Values) => {
    const { error } = await authClient.signUp.email(values);
    if (error) {
      form.setError("email", { message: error.message ?? "Sign up failed" });
      return;
    }
    toast("Account created");
    navigate({ to: "/" });
  };

  return (
    <div className="mx-auto mt-16 w-full max-w-sm">
      <h1 className="text-lg font-semibold">Create account</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link to="/login" className="underline">
          Sign in
        </Link>
      </p>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(handleValid)} className="mt-6 grid gap-4">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Name</FormLabel>
                <FormControl>
                  <Input autoComplete="name" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
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
                  <Input type="password" autoComplete="new-password" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button type="submit" disabled={form.formState.isSubmitting}>
            Sign up
          </Button>
        </form>
      </Form>
    </div>
  );
}
