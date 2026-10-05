import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { checkPassword } from "@hoborouter/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "../../lib/auth";
import { authClient } from "../../lib/auth";
import { ApiError, api } from "../../lib/api";
import { compressAvatar, gravatarUrl, MAX_AVATAR_BYTES } from "../../lib/avatar";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/skeleton";
import { InitialAvatar } from "../../components/app-shell";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../../components/ui/form";

/** Refetch the Better Auth session so the app-shell menu picks up name/image changes. */
async function refreshSession() {
  await authClient.getSession();
}

const nameSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80, "At most 80 characters"),
});
const emailSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  currentPassword: z.string().min(1, "Current password is required"),
});
const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z.string().refine((v) => checkPassword(v).length === 0, {
      message:
        "At least 8 characters, with upper- and lowercase letters, a digit, and a special character",
    }),
    confirmPassword: z.string().min(1, "Confirm your new password"),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

type NameValues = z.infer<typeof nameSchema>;
type EmailValues = z.infer<typeof emailSchema>;
type PasswordValues = z.infer<typeof passwordSchema>;

function NameSection({ name }: { name: string }) {
  const form = useForm<NameValues>({
    resolver: zodResolver(nameSchema),
    defaultValues: { name },
  });
  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(async (values) => {
          const { error } = await authClient.updateUser({ name: values.name });
          if (error) {
            toast.error(error.message ?? "Failed to update name");
            return;
          }
          await refreshSession();
          toast.success("Name updated");
          form.reset({ name: values.name });
        })}
        className="grid gap-4"
      >
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
        <Button
          type="submit"
          size="sm"
          className="w-fit"
          disabled={form.formState.isSubmitting || !form.formState.isDirty}
        >
          Save name
        </Button>
      </form>
    </Form>
  );
}

function EmailSection({ email }: { email: string }) {
  const form = useForm<EmailValues>({
    resolver: zodResolver(emailSchema),
    defaultValues: { email, currentPassword: "" },
  });
  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(async (values) => {
          try {
            await api("/api/v1/account/email", {
              method: "POST",
              body: JSON.stringify({
                email: values.email.trim().toLowerCase(),
                currentPassword: values.currentPassword,
              }),
            });
          } catch (err) {
            if (err instanceof ApiError && err.code === "WRONG_PASSWORD") {
              form.setError("currentPassword", { message: "Wrong password" });
            } else if (err instanceof ApiError && err.code === "EMAIL_TAKEN") {
              form.setError("email", { message: "Email already in use" });
            } else {
              toast.error(err instanceof Error ? err.message : "Failed to change email");
            }
            return;
          }
          await refreshSession();
          toast.success("Email updated");
          form.reset({ email: values.email.trim().toLowerCase(), currentPassword: "" });
        })}
        className="grid gap-4"
      >
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
          name="currentPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Current password</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="current-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button
          type="submit"
          size="sm"
          className="w-fit"
          disabled={form.formState.isSubmitting || !form.formState.isDirty}
        >
          Change email
        </Button>
      </form>
    </Form>
  );
}

function PasswordSection() {
  const form = useForm<PasswordValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });
  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(async (values) => {
          const { error } = await authClient.changePassword({
            currentPassword: values.currentPassword,
            newPassword: values.newPassword,
            revokeOtherSessions: true,
          });
          if (error) {
            form.setError("currentPassword", { message: error.message ?? "Wrong password" });
            return;
          }
          form.reset();
          toast.success("Password updated; other sessions revoked");
        })}
        className="grid gap-4"
      >
        <FormField
          control={form.control}
          name="currentPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Current password</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="current-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="newPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>New password</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="new-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="confirmPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Confirm new password</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="new-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" size="sm" className="w-fit" disabled={form.formState.isSubmitting}>
          Change password
        </Button>
      </form>
    </Form>
  );
}

interface SessionUser {
  name?: string | null;
  email?: string | null;
  image?: string | null;
}

function AvatarSection({ user }: { user: SessionUser }) {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [gravatar, setGravatar] = useState<string | null>(null);
  const [gravatarFailed, setGravatarFailed] = useState(false);
  void gravatarUrl(user.email).then((u) => setGravatar(u));

  const showGravatar = !user.image && gravatar && !gravatarFailed;

  async function onUpload(file: File) {
    setBusy(true);
    try {
      const blob = await compressAvatar(file);
      const res = await fetch("/api/v1/account/avatar", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": blob.type },
        body: blob,
      });
      if (!res.ok) {
        let code = "";
        try {
          code = (await res.json())?.error?.code ?? "";
        } catch {
          // non-JSON error body
        }
        toast.error(
          res.status === 413 || code === "TOO_LARGE"
            ? `Avatar too large (max ${Math.floor(MAX_AVATAR_BYTES / 1024)} KB)`
            : code === "INVALID_IMAGE"
              ? "That file is not a valid image"
              : "Failed to upload avatar",
        );
        return;
      }
      await refreshSession();
      await queryClient.invalidateQueries({ queryKey: ["session"] });
      toast.success("Avatar updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to upload avatar");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid gap-3">
      <h3 className="text-sm font-medium">Avatar</h3>
      <div className="flex items-center gap-4">
        {user.image ? (
          <img src={user.image} alt="" className="size-16 rounded-full object-cover" />
        ) : showGravatar ? (
          <img
            src={gravatar!}
            alt=""
            className="size-16 rounded-full object-cover"
            onError={() => setGravatarFailed(true)}
          />
        ) : (
          <InitialAvatar
            label={user.name || user.email?.split("@")[0] || "?"}
            className="size-16 text-xl"
          />
        )}
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            Upload
          </Button>
          {user.image && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await fetch("/api/v1/account/avatar", {
                    method: "DELETE",
                    credentials: "include",
                  });
                  await refreshSession();
                  toast.success("Avatar removed");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Remove
            </Button>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="sr-only"
          aria-label="Upload avatar image"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void onUpload(file);
          }}
        />
      </div>
    </section>
  );
}

export default function AccountTab() {
  const { data: session, isPending } = useSession();

  if (isPending) return <Skeleton className="h-24 w-full max-w-md" />;

  const user = session?.user;
  return (
    <div className="max-w-md space-y-10">
      {user && <AvatarSection user={user} />}
      <section className="grid gap-3">
        <h3 className="text-sm font-medium">Profile</h3>
        <NameSection name={user?.name ?? ""} />
      </section>
      <section className="grid gap-3">
        <h3 className="text-sm font-medium">Email</h3>
        <EmailSection email={user?.email ?? ""} />
      </section>
      <section className="grid gap-3">
        <h3 className="text-sm font-medium">Password</h3>
        <PasswordSection />
      </section>
      <div>
        <dl className="grid gap-3 text-sm">
          <div className="flex items-center justify-between border-b border-border pb-2">
            <dt className="text-muted-foreground">Email</dt>
            <dd className="font-mono">{user?.email ?? "—"}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
