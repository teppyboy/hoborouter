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

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().refine((v) => checkPassword(v).length === 0, {
    message: "At least 8 characters, with upper- and lowercase letters, a digit, and a special character",
  }),
  instance_admin: z.boolean(),
});
type CreateValues = z.infer<typeof createSchema>;

const editSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email(),
});
type EditValues = z.infer<typeof editSchema>;

const resetSchema = z
  .object({
    newPassword: z.string().refine((v) => checkPassword(v).length === 0, {
      message: "At least 8 characters, with upper- and lowercase letters, a digit, and a special character",
    }),
    confirmPassword: z.string().min(8, "At least 8 characters").max(200, "At most 200 characters"),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });
type ResetValues = z.infer<typeof resetSchema>;

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

function removeErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "CANNOT_REMOVE_SELF")
      return "You cannot remove your own account. Ask another instance admin.";
    if (err.code === "LAST_ADMIN")
      return "This is the last instance admin. Promote another admin first.";
    if (err.code === "SOLE_OWNER") {
      const sole = err as ApiError & SoleOwnerWorkspaces;
      const names = sole.workspaces?.map((w) => w.name).join(", ");
      return names
        ? `This user is the sole owner of: ${names}. Transfer ownership first.`
        : "This user is the sole owner of at least one workspace. Transfer ownership first.";
    }
    if (err.code === "EMAIL_TAKEN") return "A user with this email already exists.";
  }
  return err instanceof Error ? err.message : "Request failed";
}

export default function AdminUsersPage() {
  const query = useAdminQuery<{ data: AdminUser[] }>(["admin", "users"], "/api/v1/admin/users");
  const { data: session } = useSession();
  const [createOpen, setCreateOpen] = useState(false);
  return (
    <div className="space-y-4">
      <PageHeader
        title="Users"
        description="Instance users."
        actions={
          <Button onClick={() => setCreateOpen(true)} size="sm">
            Add user
          </Button>
        }
      />
      <AdminGate query={query}>
        <UsersTable
          users={query.data?.data ?? []}
          currentUserId={session?.user?.id ?? null}
        />
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
  const [toRemove, setToRemove] = useState<AdminUser | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [toEdit, setToEdit] = useState<AdminUser | null>(null);
  const [toReset, setToReset] = useState<AdminUser | null>(null);

  const columns: ColumnDef<AdminUser, unknown>[] = [
    { accessorKey: "email", header: "Email" },
    {
      accessorKey: "email_verified",
      header: "Email status",
      cell: (c) => {
        const verified = c.getValue() as boolean | undefined;
        // Undefined means the backend payload predates the flag: report
        // honestly instead of guessing.
        return verified === undefined ? (
          <Badge variant="secondary">Unavailable</Badge>
        ) : verified ? (
          <Badge variant="default">Verified</Badge>
        ) : (
          <Badge variant="outline">Unverified</Badge>
        );
      },
    },
    { accessorKey: "name", header: "Name" },
    {
      accessorKey: "created_at",
      header: "Joined",
      cell: (c) => (
        <span className="font-mono text-xs">{formatDate(new Date(c.getValue() as number))}</span>
      ),
    },
    {
      accessorKey: "is_instance_admin",
      header: "Role",
      cell: (c) =>
        c.getValue() ? <Badge variant="default">admin</Badge> : <Badge variant="outline">user</Badge>,
    },
    { accessorKey: "workspace_count", header: "Workspaces" },
    {
      accessorKey: "id",
      header: "ID",
      cell: (c) => (
        <span className="flex items-center gap-1">
          <span className="font-mono text-xs">{(c.getValue() as string).slice(0, 8)}…</span>
          <CopyButton value={c.getValue() as string} label="Copy user ID" />
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
              aria-label={`Edit ${user.email}`}
              onClick={() => setToEdit(user)}
            >
              Edit
            </Button>
            <Button
              variant="outline"
              size="sm"
              aria-label={`Reset password for ${user.email}`}
              onClick={() => setToReset(user)}
            >
              Reset password
            </Button>
            {user.id !== currentUserId && (
              <Button
                variant="destructive"
                size="sm"
                aria-label={`Remove ${user.email}`}
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
      <DataTable columns={columns} data={users} empty="No users" />
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
            <DialogTitle>Remove user?</DialogTitle>
            <DialogDescription>
              Remove {toRemove?.name} ({toRemove?.email})? Their sessions are revoked and
              they can no longer sign in. Billing history is kept.
            </DialogDescription>
          </DialogHeader>
          {removeError && <p className="text-destructive text-sm">{removeError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setToRemove(null)}>
              Cancel
            </Button>
            {toRemove && (
              <RemoveButton
                user={toRemove}
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
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<EditValues>({
    resolver: zodResolver(editSchema),
    defaultValues: { name: user.name, email: user.email },
  });

  const save = useMutation({
    mutationFn: (values: EditValues) =>
      api<{ user: { id: string; name: string; email: string } }>(
        `/api/v1/admin/users/${user.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            name: values.name.trim(),
            email: values.email.trim().toLowerCase(),
          }),
        },
      ),
    onSuccess: (data) => {
      toast.success(`Updated ${data.user.name}`);
      void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      // An email change revokes the target's sessions server-side; if the
      // admin edited their own email, refresh the local session store.
      if (data.user.email !== user.email && user.id === currentUserId) void refetchSession();
      onClose();
    },
    onError: (err) => {
      // Duplicate email maps onto the email field; everything else inline.
      if (err instanceof ApiError && err.code === "EMAIL_TAKEN") {
        form.setError("email", { message: "A user with this email already exists." });
      } else {
        setFormError(err instanceof Error ? err.message : "Request failed");
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
          <DialogTitle>Edit user</DialogTitle>
          <DialogDescription>
            Change the name or email of {user.name} ({user.email}). Changing the email revokes all
            of their sessions and they must sign in again.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            className="space-y-4"
            onSubmit={form.handleSubmit((values) => save.mutate(values))}
          >
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
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
                  <FormLabel>Email</FormLabel>
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
                Cancel
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? "Saving…" : "Save"}
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
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<ResetValues>({
    resolver: zodResolver(resetSchema),
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
      toast.success(`Password reset for ${user.name}; all their sessions were signed out`);
      void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      // The reset revokes sessions server-side; if the admin reset their own
      // password, refresh the local session store.
      void refetchSession();
      onClose();
    },
    onError: (err) => setFormError(err instanceof Error ? err.message : "Request failed"),
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
          <DialogTitle>Reset password</DialogTitle>
          <DialogDescription>
            Set a new password for {user.name} ({user.email}). No old password is needed. This
            signs the user out of all their sessions and they must sign in again.
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
                  <FormLabel>New password</FormLabel>
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
                  <FormLabel>Confirm new password</FormLabel>
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
                {reset.isPending ? "Resetting…" : "Reset password"}
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
  onError,
  onDone,
}: {
  user: AdminUser;
  onError: (message: string) => void;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => removeUser(user.id),
    onSuccess: () => {
      toast.success(`Removed ${user.name}`);
      void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      onDone();
    },
    onError: (err) => onError(removeErrorMessage(err)),
  });
  return (
    <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
      {remove.isPending ? "Removing…" : "Remove"}
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
  const form = useForm<CreateValues>({
    resolver: zodResolver(createSchema),
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
      toast.success("User created");
      void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      onOpenChange(false);
      form.reset();
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add user</DialogTitle>
          <DialogDescription>Create a user with an initial password.</DialogDescription>
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
                  <FormLabel>Name</FormLabel>
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
                  <FormLabel>Email</FormLabel>
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
                  <FormLabel>Password</FormLabel>
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
                  <FormLabel className="font-normal">Instance admin</FormLabel>
                </FormItem>
              )}
            />
            {create.error && <p className="text-destructive text-sm">{removeErrorMessage(create.error)}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? "Creating…" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
