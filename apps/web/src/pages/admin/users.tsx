import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { toast } from "sonner";
import { checkPassword } from "@hoborouter/shared";
import { CopyButton, DataTable, PageHeader } from "../../components/page";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../../components/ui/form";
import { Input } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import { useSession } from "../../lib/auth";
import { ApiError, api } from "../../lib/api";
import { formatDate } from "../../lib/format";
import { AdminGate, useAdminQuery } from "./shared";
import { useT } from "../../lib/i18n/t";

// Admin users copy: inline LocaleEntry set (see lib/i18n/common.ts). Names,
// emails, identifiers and role values (admin/user badges) are never translated.
const usersCopy = {
  title: { en: "Users", vi: "Người dùng" },
  usersTable: { en: "Users list", vi: "Danh sách người dùng" },
  description: { en: "Instance users.", vi: "Người dùng trên instance." },
  addUser: { en: "Add user", vi: "Thêm người dùng" },
  email: { en: "Email", vi: "Email" },
  name: { en: "Name", vi: "Tên" },
  emailStatus: { en: "Email status", vi: "Trạng thái email" },
  unavailable: { en: "Unavailable", vi: "Không xác định" },
  verified: { en: "Verified", vi: "Đã xác minh" },
  unverified: { en: "Unverified", vi: "Chưa xác minh" },
  copyUserId: { en: "Copy user ID", vi: "Sao chép ID người dùng" },
  joined: { en: "Joined", vi: "Ngày tham gia" },
  role: { en: "Role", vi: "Vai trò" },
  workspaces: { en: "Workspaces", vi: "Workspace" },
  edit: { en: "Edit", vi: "Sửa" },
  resetPassword: { en: "Reset password", vi: "Đặt lại mật khẩu" },
  remove: { en: "Remove", vi: "Xóa" },
  editAria: { en: "Edit {email}", vi: "Sửa {email}" },
  resetAria: { en: "Reset password for {email}", vi: "Đặt lại mật khẩu cho {email}" },
  removeAria: { en: "Remove {email}", vi: "Xóa {email}" },
  noUsers: { en: "No users", vi: "Không có người dùng" },
  removeTitle: { en: "Remove user?", vi: "Xóa người dùng?" },
  removeDesc: {
    en: "Remove {name} ({email})? Their sessions are revoked and they can no longer sign in. Billing history is kept.",
    vi: "Xóa {name} ({email})? Các phiên của họ sẽ bị thu hồi và họ không thể đăng nhập nữa. Lịch sử thanh toán được giữ lại.",
  },
  cancel: { en: "Cancel", vi: "Hủy" },
  editTitle: { en: "Edit user", vi: "Sửa người dùng" },
  editDesc: {
    en: "Change the name or email of {name} ({email}). Changing the email revokes all of their sessions and they must sign in again.",
    vi: "Thay đổi tên hoặc email của {name} ({email}). Đổi email sẽ thu hồi tất cả phiên của họ và họ phải đăng nhập lại.",
  },
  saving: { en: "Saving…", vi: "Đang lưu…" },
  save: { en: "Save", vi: "Lưu" },
  resetTitle: { en: "Reset password", vi: "Đặt lại mật khẩu" },
  resetDesc: {
    en: "Set a new password for {name} ({email}). No old password is needed. This signs the user out of all their sessions and they must sign in again.",
    vi: "Đặt mật khẩu mới cho {name} ({email}). Không cần mật khẩu cũ. Thao tác này đăng xuất người dùng khỏi mọi phiên và họ phải đăng nhập lại.",
  },
  newPassword: { en: "New password", vi: "Mật khẩu mới" },
  confirmPassword: { en: "Confirm new password", vi: "Xác nhận mật khẩu mới" },
  resetting: { en: "Resetting…", vi: "Đang đặt lại…" },
  createTitle: { en: "Add user", vi: "Thêm người dùng" },
  createDesc: {
    en: "Create a user with an initial password.",
    vi: "Tạo người dùng với mật khẩu ban đầu.",
  },
  password: { en: "Password", vi: "Mật khẩu" },
  instanceAdmin: { en: "Instance admin", vi: "Quản trị instance" },
  creating: { en: "Creating…", vi: "Đang tạo…" },
  create: { en: "Create", vi: "Tạo" },
  passwordRule: {
    en: "At least 8 characters, with upper- and lowercase letters, a digit, and a special character",
    vi: "Ít nhất 8 ký tự, gồm chữ hoa và chữ thường, một chữ số và một ký tự đặc biệt",
  },
  minChars: { en: "At least 8 characters", vi: "Ít nhất 8 ký tự" },
  maxChars: { en: "At most 200 characters", vi: "Tối đa 200 ký tự" },
  passwordsMismatch: { en: "Passwords do not match", vi: "Mật khẩu không khớp" },
  removeSelf: {
    en: "You cannot remove your own account. Ask another instance admin.",
    vi: "Bạn không thể xóa tài khoản của chính mình. Hãy nhờ quản trị instance khác.",
  },
  lastAdmin: {
    en: "This is the last instance admin. Promote another admin first.",
    vi: "Đây là quản trị instance cuối cùng. Hãy nâng quyền một quản trị khác trước.",
  },
  soleOwnerNamed: {
    en: "This user is the sole owner of: {names}. Transfer ownership first.",
    vi: "Người dùng này là chủ sở hữu duy nhất của: {names}. Hãy chuyển quyền sở hữu trước.",
  },
  soleOwner: {
    en: "This user is the sole owner of at least one workspace. Transfer ownership first.",
    vi: "Người dùng này là chủ sở hữu duy nhất của ít nhất một workspace. Hãy chuyển quyền sở hữu trước.",
  },
  emailTaken: {
    en: "A user with this email already exists.",
    vi: "Đã tồn tại người dùng với email này.",
  },
  requestFailed: { en: "Request failed", vi: "Yêu cầu thất bại" },
  updatedToast: { en: "Updated {name}", vi: "Đã cập nhật {name}" },
  resetToast: {
    en: "Password reset for {name}; all their sessions were signed out",
    vi: "Đã đặt lại mật khẩu cho {name}; tất cả phiên của họ đã bị đăng xuất",
  },
  removedToast: { en: "Removed {name}", vi: "Đã xóa {name}" },
  createdToast: { en: "User created", vi: "Đã tạo người dùng" },
} as const;

type UsersT = (key: keyof typeof usersCopy, vars?: Record<string, string | number>) => string;

function removeErrorMessage(err: unknown, t: UsersT): string {
  if (err instanceof ApiError) {
    if (err.code === "CANNOT_REMOVE_SELF") return t("removeSelf");
    if (err.code === "LAST_ADMIN") return t("lastAdmin");
    if (err.code === "SOLE_OWNER") {
      const sole = err as ApiError & SoleOwnerWorkspaces;
      const names = sole.workspaces?.map((w) => w.name).join(", ");
      return names ? t("soleOwnerNamed", { names }) : t("soleOwner");
    }
    if (err.code === "EMAIL_TAKEN") return t("emailTaken");
  }
  return err instanceof Error ? err.message : t("requestFailed");
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  created_at: number;
  // EXISTS(...) over Postgres → real boolean.
  is_instance_admin: boolean;
  /** Better Auth emailVerified flag; absent on pre-email-verification payloads. */
  email_verified?: boolean;
  workspace_count: number;
}

interface SoleOwnerWorkspaces {
  workspaces?: { id: string; name: string }[];
}

const makeCreateSchema = (t: UsersT) =>
  z.object({
    name: z.string().trim().min(1).max(80),
    email: z.string().trim().toLowerCase().email(),
    password: z.string().refine((v) => checkPassword(v).length === 0, {
      message: t("passwordRule"),
    }),
    instance_admin: z.boolean(),
  });
type CreateValues = z.infer<ReturnType<typeof makeCreateSchema>>;

const editSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email(),
});
type EditValues = z.infer<typeof editSchema>;

const makeResetSchema = (t: UsersT) =>
  z
    .object({
      newPassword: z.string().refine((v) => checkPassword(v).length === 0, {
        message: t("passwordRule"),
      }),
      confirmPassword: z.string().min(8, t("minChars")).max(200, t("maxChars")),
    })
    .refine((v) => v.newPassword === v.confirmPassword, {
      message: t("passwordsMismatch"),
      path: ["confirmPassword"],
    });
type ResetValues = z.infer<ReturnType<typeof makeResetSchema>>;

/** Removes a user; returns workspaces list on 409 SOLE_OWNER so UI can name them. */
async function removeUser(id: string): Promise<void> {
  const res = await fetch(`/api/v1/admin/users/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (res.ok) return;
  let code = "unknown";
  let message = `Request failed (${res.status})`;
  let extra: SoleOwnerWorkspaces = {};
  try {
    const body = await res.json();
    if (body?.error?.code) code = body.error.code;
    if (body?.error?.message) message = body.error.message;
    if (body?.error?.workspaces) extra = body.error;
  } catch {
    // non-JSON error body
  }
  const err = new ApiError(res.status, code, message) as ApiError & SoleOwnerWorkspaces;
  Object.assign(err, extra);
  throw err;
}

export default function AdminUsersPage() {
  const t = useT(usersCopy);
  const query = useAdminQuery<{ data: AdminUser[] }>(["admin", "users"], "/api/v1/admin/users");
  const { data: session } = useSession();
  const [createOpen, setCreateOpen] = useState(false);
  return (
    <div className="space-y-4">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <Button onClick={() => setCreateOpen(true)} size="sm">
            {t("addUser")}
          </Button>
        }
      />
      <AdminGate query={query}>
        <UsersTable users={query.data?.data ?? []} currentUserId={session?.user?.id ?? null} />
      </AdminGate>
      <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

export function UsersTable({
  users,
  currentUserId,
}: {
  users: AdminUser[];
  currentUserId: string | null;
}) {
  const t = useT(usersCopy);
  const [toRemove, setToRemove] = useState<AdminUser | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [toEdit, setToEdit] = useState<AdminUser | null>(null);
  const [toReset, setToReset] = useState<AdminUser | null>(null);

  const columns: ColumnDef<AdminUser, unknown>[] = [
    { accessorKey: "email", header: t("email") },
    {
      accessorKey: "email_verified",
      header: t("emailStatus"),
      cell: (c) => {
        const verified = c.getValue() as boolean | undefined;
        // Undefined means the backend payload predates the flag: report
        // honestly instead of guessing.
        return verified === undefined ? (
          <Badge variant="secondary">{t("unavailable")}</Badge>
        ) : verified ? (
          <Badge variant="default">{t("verified")}</Badge>
        ) : (
          <Badge variant="outline">{t("unverified")}</Badge>
        );
      },
    },
    { accessorKey: "name", header: t("name") },
    {
      accessorKey: "created_at",
      header: t("joined"),
      cell: (c) => (
        <span className="font-mono text-xs">{formatDate(new Date(c.getValue() as number))}</span>
      ),
    },
    {
      accessorKey: "is_instance_admin",
      header: t("role"),
      cell: (c) =>
        c.getValue() ? (
          <Badge variant="default">admin</Badge>
        ) : (
          <Badge variant="outline">user</Badge>
        ),
    },
    { accessorKey: "workspace_count", header: t("workspaces") },
    {
      accessorKey: "id",
      header: "ID",
      cell: (c) => (
        <span className="flex items-center gap-1">
          <span className="font-mono text-xs">{(c.getValue() as string).slice(0, 8)}…</span>
          <CopyButton value={c.getValue() as string} label={t("copyUserId")} />
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      cell: (c) => {
        const user = c.row.original;
        // Removal stays self-hidden (server also rejects it); edit and reset
        // are allowed on the admin's own account.
        return (
          <div className="flex flex-wrap items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              aria-label={t("editAria", { email: user.email })}
              onClick={() => setToEdit(user)}
            >
              {t("edit")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              aria-label={t("resetAria", { email: user.email })}
              onClick={() => setToReset(user)}
            >
              {t("resetPassword")}
            </Button>
            {user.id !== currentUserId && (
              <Button
                variant="destructive"
                size="sm"
                aria-label={t("removeAria", { email: user.email })}
                onClick={() => setToRemove(user)}
              >
                Remove
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <>
      <DataTable
        columns={columns}
        data={users}
        empty={t("noUsers")}
        scroll={{ label: t("usersTable") }}
      />
      <Dialog
        open={toRemove !== null}
        onOpenChange={(open) => {
          if (!open) {
            setToRemove(null);
            setRemoveError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("removeTitle")}</DialogTitle>
            <DialogDescription>
              {t("removeDesc", {
                name: toRemove?.name ?? "",
                email: toRemove?.email ?? "",
              })}
            </DialogDescription>
          </DialogHeader>
          {removeError && <p className="text-destructive text-sm">{removeError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setToRemove(null)}>
              {t("cancel")}
            </Button>
            {toRemove && (
              <RemoveButton
                user={toRemove}
                t={t}
                onError={setRemoveError}
                onDone={() => setToRemove(null)}
              />
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {toEdit && (
        <EditUserDialog
          user={toEdit}
          currentUserId={currentUserId}
          onClose={() => setToEdit(null)}
        />
      )}
      {toReset && <ResetPasswordDialog user={toReset} onClose={() => setToReset(null)} />}
    </>
  );
}

function EditUserDialog({
  user,
  currentUserId,
  onClose,
}: {
  user: AdminUser;
  currentUserId: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { refetch: refetchSession } = useSession();
  const t = useT(usersCopy);
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<EditValues>({
    resolver: zodResolver(editSchema),
    defaultValues: { name: user.name, email: user.email },
  });

  const save = useMutation({
    mutationFn: (values: EditValues) =>
      api<{ user: { id: string; name: string; email: string } }>(`/api/v1/admin/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: values.name.trim(),
          email: values.email.trim().toLowerCase(),
        }),
      }),
    onSuccess: (data) => {
      toast.success(t("updatedToast", { name: data.user.name }));
      void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      // An email change revokes the target's sessions server-side; if the
      // admin edited their own email, refresh the local session store.
      if (data.user.email !== user.email && user.id === currentUserId) void refetchSession();
      onClose();
    },
    onError: (err) => {
      // Duplicate email maps onto the email field; everything else inline.
      if (err instanceof ApiError && err.code === "EMAIL_TAKEN") {
        form.setError("email", { message: t("emailTaken") });
      } else {
        setFormError(err instanceof Error ? err.message : t("requestFailed"));
      }
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          form.reset();
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("editTitle")}</DialogTitle>
          <DialogDescription>
            {t("editDesc", { name: user.name, email: user.email })}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form className="space-y-4" onSubmit={form.handleSubmit((values) => save.mutate(values))}>
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("name")}</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="Ada Lovelace" />
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
                  <FormLabel>{t("email")}</FormLabel>
                  <FormControl>
                    <Input {...field} type="email" placeholder="ada@example.com" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {formError && <p className="text-destructive text-sm">{formError}</p>}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  form.reset();
                  onClose();
                }}
              >
                {t("cancel")}
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? t("saving") : t("save")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { refetch: refetchSession } = useSession();
  const t = useT(usersCopy);
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<ResetValues>({
    resolver: zodResolver(makeResetSchema(t)),
    defaultValues: { newPassword: "", confirmPassword: "" },
  });

  const reset = useMutation({
    mutationFn: (values: ResetValues) =>
      api<{ success: boolean }>(`/api/v1/admin/users/${user.id}/reset-password`, {
        method: "POST",
        body: JSON.stringify({ newPassword: values.newPassword }),
      }),
    onSuccess: () => {
      // The toast never contains the password.
      toast.success(t("resetToast", { name: user.name }));
      void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      // The reset revokes sessions server-side; if the admin reset their own
      // password, refresh the local session store.
      void refetchSession();
      onClose();
    },
    onError: (err) => setFormError(err instanceof Error ? err.message : t("requestFailed")),
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          form.reset();
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("resetTitle")}</DialogTitle>
          <DialogDescription>
            {t("resetDesc", { name: user.name, email: user.email })}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            className="space-y-4"
            onSubmit={form.handleSubmit((values) => reset.mutate(values))}
          >
            <FormField
              control={form.control}
              name="newPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("newPassword")}</FormLabel>
                  <FormControl>
                    <Input {...field} type="password" autoComplete="new-password" />
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
                  <FormLabel>{t("confirmPassword")}</FormLabel>
                  <FormControl>
                    <Input {...field} type="password" autoComplete="new-password" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {formError && <p className="text-destructive text-sm">{formError}</p>}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  form.reset();
                  onClose();
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={reset.isPending}>
                {reset.isPending ? t("resetting") : t("resetPassword")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function RemoveButton({
  user,
  t,
  onError,
  onDone,
}: {
  user: AdminUser;
  t: UsersT;
  onError: (message: string) => void;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => removeUser(user.id),
    onSuccess: () => {
      toast.success(t("removedToast", { name: user.name }));
      void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      onDone();
    },
    onError: (err) => onError(removeErrorMessage(err, t)),
  });
  return (
    <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
      {remove.isPending ? t("resetting") : t("remove")}
    </Button>
  );
}

function CreateUserDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const t = useT(usersCopy);
  const form = useForm<CreateValues>({
    resolver: zodResolver(makeCreateSchema(t)),
    defaultValues: { name: "", email: "", password: "", instance_admin: false },
  });

  const create = useMutation({
    mutationFn: (values: CreateValues) =>
      api<{ id: string }>("/api/v1/admin/users", {
        method: "POST",
        body: JSON.stringify({
          name: values.name.trim(),
          email: values.email.trim().toLowerCase(),
          password: values.password,
          instance_admin: values.instance_admin,
        }),
      }),
    onSuccess: () => {
      toast.success(t("createdToast"));
      void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      onOpenChange(false);
      form.reset();
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("createTitle")}</DialogTitle>
          <DialogDescription>{t("createDesc")}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            className="space-y-4"
            onSubmit={form.handleSubmit((values) => create.mutate(values))}
          >
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("name")}</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="Ada Lovelace" />
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
                  <FormLabel>{t("email")}</FormLabel>
                  <FormControl>
                    <Input {...field} type="email" placeholder="ada@example.com" />
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
                  <FormLabel>{t("password")}</FormLabel>
                  <FormControl>
                    <Input {...field} type="password" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="instance_admin"
              render={({ field }) => (
                <FormItem className="flex items-center gap-2">
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                  <FormLabel className="font-normal">{t("instanceAdmin")}</FormLabel>
                </FormItem>
              )}
            />
            {create.error && (
              <p className="text-destructive text-sm">{removeErrorMessage(create.error, t)}</p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("cancel")}
              </Button>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? t("creating") : t("create")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
