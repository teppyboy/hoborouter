import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { checkPassword } from "@hoborouter/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "../../lib/auth";
import { authClient } from "../../lib/auth";
import { usePublicConfig } from "../../components/turnstile";
import { socialProvidersFrom, type SocialProviderId } from "../../lib/public-config";
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
import { useT } from "../../lib/i18n/t";

/** Refetch the Better Auth session so the app-shell menu picks up name/image changes. */
async function refreshSession() {
  await authClient.getSession();
}

// Account-tab copy: inline LocaleEntry set (see lib/i18n/common.ts). The zod
// schemas become factories so validation messages follow the locale (same
// pattern as the auth pages' makeLoginSchema).
export const accountCopy = {
  nameRequired: { en: "Name is required", vi: "Vui lòng nhập tên" },
  nameTooLong: { en: "At most 80 characters", vi: "Tối đa 80 ký tự" },
  emailInvalid: { en: "Enter a valid email", vi: "Nhập email hợp lệ" },
  currentPasswordRequired: {
    en: "Current password is required",
    vi: "Vui lòng nhập mật khẩu hiện tại",
  },
  passwordRuleFailed: {
    en: "At least 8 characters, with upper- and lowercase letters, a digit, and a special character",
    vi: "Ít nhất 8 ký tự, gồm chữ hoa, chữ thường, chữ số và ký tự đặc biệt",
  },
  confirmRequired: { en: "Confirm your new password", vi: "Vui lòng xác nhận mật khẩu mới" },
  passwordMismatch: { en: "Passwords do not match", vi: "Mật khẩu không khớp" },
  nameUpdateFailed: { en: "Failed to update name", vi: "Cập nhật tên thất bại" },
  nameUpdated: { en: "Name updated", vi: "Đã cập nhật tên" },
  name: { en: "Name", vi: "Tên" },
  saveName: { en: "Save name", vi: "Lưu tên" },
  wrongPassword: { en: "Wrong password", vi: "Sai mật khẩu" },
  emailTaken: { en: "Email already in use", vi: "Email đã được sử dụng" },
  emailChangeFailed: { en: "Failed to change email", vi: "Đổi email thất bại" },
  emailUpdated: { en: "Email updated", vi: "Đã cập nhật email" },
  email: { en: "Email", vi: "Email" },
  currentPassword: { en: "Current password", vi: "Mật khẩu hiện tại" },
  changeEmail: { en: "Change email", vi: "Đổi email" },
  passwordUpdated: {
    en: "Password updated; other sessions revoked",
    vi: "Đã cập nhật mật khẩu; các phiên khác đã bị đăng xuất",
  },
  newPassword: { en: "New password", vi: "Mật khẩu mới" },
  confirmNewPassword: { en: "Confirm new password", vi: "Xác nhận mật khẩu mới" },
  changePassword: { en: "Change password", vi: "Đổi mật khẩu" },
  avatarTooLarge: {
    en: "Avatar too large (max {kb} KB)",
    vi: "Ảnh đại diện quá lớn (tối đa {kb} KB)",
  },
  invalidImage: { en: "That file is not a valid image", vi: "Tệp này không phải ảnh hợp lệ" },
  avatarUploadFailed: { en: "Failed to upload avatar", vi: "Tải ảnh đại diện lên thất bại" },
  avatarUpdated: { en: "Avatar updated", vi: "Đã cập nhật ảnh đại diện" },
  avatarRemoved: { en: "Avatar removed", vi: "Đã xoá ảnh đại diện" },
  avatar: { en: "Avatar", vi: "Ảnh đại diện" },
  upload: { en: "Upload", vi: "Tải lên" },
  remove: { en: "Remove", vi: "Xoá" },
  uploadAvatar: { en: "Upload avatar image", vi: "Tải ảnh đại diện lên" },
  profile: { en: "Profile", vi: "Hồ sơ" },
  password: { en: "Password", vi: "Mật khẩu" },
  connectedAccounts: {
    en: "Connected accounts",
    vi: "Tài khoản liên kết",
  },
  connected: { en: "Connected", vi: "Đã liên kết" },
  notConnected: { en: "Not connected", vi: "Chưa liên kết" },
  connect: { en: "Connect", vi: "Liên kết" },
  unlink: { en: "Unlink", vi: "Gỡ liên kết" },
  unlinked: { en: "Account unlinked", vi: "Đã gỡ liên kết" },
  connectFailed: {
    en: "Could not start connecting. Try again.",
    vi: "Không thể bắt đầu liên kết. Vui lòng thử lại.",
  },
  unlinkFailed: {
    en: "Failed to unlink account",
    vi: "Gỡ liên kết thất bại",
  },
  unlinkReauth: {
    en: "Your session is too old — sign in again, then unlink.",
    vi: "Phiên đăng nhập đã cũ — hãy đăng nhập lại rồi gỡ liên kết.",
  },
  unlinkLast: {
    en: "You cannot unlink your only sign-in method.",
    vi: "Không thể gỡ phương thức đăng nhập duy nhất của bạn.",
  },
} as const;

type AccountT = (key: keyof typeof accountCopy, vars?: Record<string, string | number>) => string;

const makeNameSchema = (t: AccountT) =>
  z.object({
    name: z.string().trim().min(1, t("nameRequired")).max(80, t("nameTooLong")),
  });
const makeEmailSchema = (t: AccountT) =>
  z.object({
    email: z.string().trim().toLowerCase().email(t("emailInvalid")),
    currentPassword: z.string().min(1, t("currentPasswordRequired")),
  });
const makePasswordSchema = (t: AccountT) =>
  z
    .object({
      currentPassword: z.string().min(1, t("currentPasswordRequired")),
      newPassword: z.string().refine((v) => checkPassword(v).length === 0, {
        message: t("passwordRuleFailed"),
      }),
      confirmPassword: z.string().min(1, t("confirmRequired")),
    })
    .refine((v) => v.newPassword === v.confirmPassword, {
      message: t("passwordMismatch"),
      path: ["confirmPassword"],
    });

type NameValues = z.infer<ReturnType<typeof makeNameSchema>>;
type EmailValues = z.infer<ReturnType<typeof makeEmailSchema>>;
type PasswordValues = z.infer<ReturnType<typeof makePasswordSchema>>;

function NameSection({ name }: { name: string }) {
  const t = useT(accountCopy);
  const form = useForm<NameValues>({
    resolver: zodResolver(makeNameSchema(t)),
    defaultValues: { name },
  });
  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(async (values) => {
          const { error } = await authClient.updateUser({ name: values.name });
          if (error) {
            toast.error(error.message ?? t("nameUpdateFailed"));
            return;
          }
          await refreshSession();
          toast.success(t("nameUpdated"));
          form.reset({ name: values.name });
        })}
        className="grid gap-4"
      >
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("name")}</FormLabel>
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
          {t("saveName")}
        </Button>
      </form>
    </Form>
  );
}

function EmailSection({ email }: { email: string }) {
  const t = useT(accountCopy);
  const form = useForm<EmailValues>({
    resolver: zodResolver(makeEmailSchema(t)),
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
              form.setError("currentPassword", { message: t("wrongPassword") });
            } else if (err instanceof ApiError && err.code === "EMAIL_TAKEN") {
              form.setError("email", { message: t("emailTaken") });
            } else {
              toast.error(err instanceof Error ? err.message : t("emailChangeFailed"));
            }
            return;
          }
          await refreshSession();
          toast.success(t("emailUpdated"));
          form.reset({ email: values.email.trim().toLowerCase(), currentPassword: "" });
        })}
        className="grid gap-4"
      >
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("email")}</FormLabel>
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
              <FormLabel>{t("currentPassword")}</FormLabel>
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
          {t("changeEmail")}
        </Button>
      </form>
    </Form>
  );
}

function PasswordSection() {
  const t = useT(accountCopy);
  const form = useForm<PasswordValues>({
    resolver: zodResolver(makePasswordSchema(t)),
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
            form.setError("currentPassword", { message: error.message ?? t("wrongPassword") });
            return;
          }
          form.reset();
          toast.success(t("passwordUpdated"));
        })}
        className="grid gap-4"
      >
        <FormField
          control={form.control}
          name="currentPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("currentPassword")}</FormLabel>
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
              <FormLabel>{t("newPassword")}</FormLabel>
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
              <FormLabel>{t("confirmNewPassword")}</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="new-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" size="sm" className="w-fit" disabled={form.formState.isSubmitting}>
          {t("changePassword")}
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
  const t = useT(accountCopy);
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
        const maxKb = Math.floor(MAX_AVATAR_BYTES / 1024);
        toast.error(
          res.status === 413 || code === "TOO_LARGE"
            ? t("avatarTooLarge", { kb: maxKb })
            : code === "INVALID_IMAGE"
              ? t("invalidImage")
              : t("avatarUploadFailed"),
        );
        return;
      }
      await refreshSession();
      await queryClient.invalidateQueries({ queryKey: ["session"] });
      toast.success(t("avatarUpdated"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("avatarUploadFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid gap-3">
      <h3 className="text-sm font-medium">{t("avatar")}</h3>
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
            {t("upload")}
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
                  toast.success(t("avatarRemoved"));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t("remove")}
            </Button>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="sr-only"
          aria-label={t("uploadAvatar")}
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

/**
 * Post-link/unlink return target. The settings page reads `?tab=` for its
 * initial tab, so the provider round-trip lands back on this section.
 */
const LINK_CALLBACK_PATH = "/settings?tab=account";

/** Display names are proper nouns: shown verbatim in every locale. */
const PROVIDER_NAMES: Record<SocialProviderId, string> = {
  google: "Google",
  discord: "Discord",
  github: "GitHub",
};

/**
 * Explicit social account linking (Better Auth /link-social, /list-accounts,
 * /unlink-account). Availability comes from the server's public-config flags —
 * the same safe defaults as sign-in apply server-side: linking needs a
 * VERIFIED provider email matching the local user's email, state/PKCE are
 * minted per request, and unlinking the last remaining sign-in method is
 * rejected (a fresh session is required, older sessions must re-sign-in).
 */
function ConnectedAccountsSection() {
  const t = useT(accountCopy);
  const queryClient = useQueryClient();
  const { data: config } = usePublicConfig();
  const providers = socialProvidersFrom(config);
  const accountsQuery = useQuery({
    queryKey: ["linked-accounts"],
    queryFn: async () => {
      const { data, error } = await authClient.listAccounts();
      if (error) throw new Error(error.message ?? "list-accounts failed");
      return data ?? [];
    },
  });
  const [connecting, setConnecting] = useState<SocialProviderId | null>(null);
  const [unlinkingId, setUnlinkingId] = useState<string | null>(null);

  // Email-only deployments render exactly as before: no section at all.
  if (providers.length === 0) return null;

  // The password login lives in its own row of the `account` table
  // (providerId "credential"); it is managed by the password section above.
  const socialAccounts = (accountsQuery.data ?? []).filter((a) => a.providerId !== "credential");
  const linkedProviders = new Set(socialAccounts.map((a) => a.providerId));

  const connect = async (provider: SocialProviderId) => {
    setConnecting(provider);
    const { error } = await authClient.linkSocial({
      provider,
      callbackURL: window.location.origin + LINK_CALLBACK_PATH,
      errorCallbackURL: window.location.origin + LINK_CALLBACK_PATH + "&linking=error",
    });
    if (error) {
      setConnecting(null);
      // Initiation failure only; the provider round-trip itself reports
      // through errorCallbackURL. Message stays generic (never upstream text).
      toast.error(t("connectFailed"));
    }
    // Success: the Better Auth client redirect hook navigates to the provider.
  };

  const unlink = async (accountId: string) => {
    setUnlinkingId(accountId);
    const { error } = await authClient.unlinkAccount({ accountId });
    setUnlinkingId(null);
    if (error) {
      const code = error.code ?? "";
      if (error.status === 403 || code === "SESSION_NOT_FRESH") {
        toast.error(t("unlinkReauth"));
      } else if (error.status === 400 || code === "FAILED_TO_UNLINK_LAST_ACCOUNT") {
        toast.error(t("unlinkLast"));
      } else {
        toast.error(t("unlinkFailed"));
      }
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ["linked-accounts"] });
    toast.success(t("unlinked"));
  };

  return (
    <section className="grid gap-3">
      <h3 className="text-sm font-medium">{t("connectedAccounts")}</h3>
      <div className="grid gap-2">
        {providers.map((provider) => {
          const linked = linkedProviders.has(provider);
          const providerName = PROVIDER_NAMES[provider];
          const account = socialAccounts.find((a) => a.providerId === provider);
          return (
            <div
              key={provider}
              className="flex items-center justify-between gap-4 border-b border-border pb-2"
            >
              <div>
                <span className="text-sm">{providerName}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {linked ? t("connected") : t("notConnected")}
                </span>
              </div>
              {linked ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={unlinkingId !== null}
                  onClick={() => account && void unlink(account.id)}
                >
                  {t("unlink")}
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={connecting !== null || accountsQuery.isPending}
                  onClick={() => void connect(provider)}
                >
                  {t("connect")}
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default function AccountTab() {
  const t = useT(accountCopy);
  const { data: session, isPending } = useSession();

  if (isPending) return <Skeleton className="h-24 w-full max-w-md" />;

  const user = session?.user;
  return (
    <div className="max-w-md space-y-10">
      {user && <AvatarSection user={user} />}
      <section className="grid gap-3">
        <h3 className="text-sm font-medium">{t("profile")}</h3>
        <NameSection name={user?.name ?? ""} />
      </section>
      <section className="grid gap-3">
        <h3 className="text-sm font-medium">{t("email")}</h3>
        <EmailSection email={user?.email ?? ""} />
      </section>
      <section className="grid gap-3">
        <h3 className="text-sm font-medium">{t("password")}</h3>
        <PasswordSection />
      </section>
      <ConnectedAccountsSection />
      <div>
        <dl className="grid gap-3 text-sm">
          <div className="flex items-center justify-between border-b border-border pb-2">
            <dt className="text-muted-foreground">{t("email")}</dt>
            <dd className="font-mono">{user?.email ?? "—"}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
