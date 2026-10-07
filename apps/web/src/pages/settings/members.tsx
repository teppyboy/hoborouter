import * as React from "react";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "../../lib/api";
import { DataTable } from "../../components/page";
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
import { Skeleton } from "../../components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import type { ColumnDef } from "@tanstack/react-table";
import { useT } from "../../lib/i18n/t";

type Role = "owner" | "admin" | "member";

interface Member {
  user_id: string;
  role: Role;
  email: string;
  name: string | null;
}

// Members-tab copy: inline LocaleEntry set (see lib/i18n/common.ts). Role
// *values* stay raw API enums ("owner"|"admin"|"member"); only the words
// around them are translated.
const membersCopy = {
  emailInvalid: { en: "Enter a valid email", vi: "Nhập email hợp lệ" },
  roleUpdated: { en: "Role updated", vi: "Đã cập nhật vai trò" },
  updateFailed: { en: "Update failed", vi: "Cập nhật thất bại" },
  memberRemoved: { en: "Member removed", vi: "Đã xoá thành viên" },
  removeFailed: { en: "Remove failed", vi: "Xoá thất bại" },
  loadFailed: { en: "Failed to load members.", vi: "Không tải được danh sách thành viên." },
  cannotView: { en: "Cannot view members: {message}", vi: "Không xem được thành viên: {message}" },
  emailHeader: { en: "Email", vi: "Email" },
  nameHeader: { en: "Name", vi: "Tên" },
  roleHeader: { en: "Role", vi: "Vai trò" },
  roleOwner: { en: "owner", vi: "chủ sở hữu" },
  roleAdmin: { en: "admin", vi: "quản trị" },
  roleMember: { en: "member", vi: "thành viên" },
  roleFor: { en: "Role for {email}", vi: "Vai trò của {email}" },
  remove: { en: "Remove", vi: "Xoá" },
  noMembers: {
    en: "No members. Invited users must already have an account.",
    vi: "Chưa có thành viên. Người được mời phải đã có tài khoản.",
  },
  removeMember: { en: "Remove member", vi: "Xoá thành viên" },
  removeConfirm: {
    en: "Remove {email} from this workspace?",
    vi: "Xoá {email} khỏi workspace này?",
  },
  cancel: { en: "Cancel", vi: "Huỷ" },
  memberAdded: { en: "Member added", vi: "Đã thêm thành viên" },
  inviteFailed: { en: "Invite failed", vi: "Mời thất bại" },
  inviteByEmail: { en: "Invite by email", vi: "Mời qua email" },
  add: { en: "Add", vi: "Thêm" },
} as const;

function roleLabelKey(role: Role): "roleOwner" | "roleAdmin" | "roleMember" {
  return role === "owner" ? "roleOwner" : role === "admin" ? "roleAdmin" : "roleMember";
}

export default function MembersTab({ workspaceId }: { workspaceId: string }) {
  const t = useT(membersCopy);
  const qc = useQueryClient();
  const [removing, setRemoving] = React.useState<Member | null>(null);

  const {
    data: members,
    error,
    isLoading,
  } = useQuery({
    queryKey: ["members", workspaceId],
    queryFn: () => api<Member[]>(`/api/v1/workspaces/${workspaceId}/members`),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["members", workspaceId] });
    void qc.invalidateQueries({ queryKey: ["workspaces"] });
  };

  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      api(`/api/v1/workspaces/${workspaceId}/members/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      }),
    onSuccess: () => {
      toast(t("roleUpdated"));
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t("updateFailed")),
  });

  const removeMember = useMutation({
    mutationFn: (userId: string) =>
      api(`/api/v1/workspaces/${workspaceId}/members/${userId}`, { method: "DELETE" }),
    onSuccess: () => {
      toast(t("memberRemoved"));
      setRemoving(null);
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t("removeFailed")),
  });

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error) {
    return (
      <p className="text-sm text-muted-foreground">
        {error instanceof ApiError
          ? t("cannotView", { message: error.message })
          : t("loadFailed")}
      </p>
    );
  }

  const columns: ColumnDef<Member, unknown>[] = [
    {
      accessorKey: "email",
      header: t("emailHeader"),
      meta: "font-mono",
    },
    { accessorKey: "name", header: t("nameHeader") },
    {
      accessorKey: "role",
      header: t("roleHeader"),
      cell: ({ row }) =>
        row.original.role === "owner" ? (
          t(roleLabelKey(row.original.role))
        ) : (
          <Select
            value={row.original.role}
            onValueChange={(role) =>
              void changeRole
                .mutateAsync({ userId: row.original.user_id, role: role as Role })
                .catch(() => undefined)
            }
          >
            <SelectTrigger
              className="h-8 w-28"
              aria-label={t("roleFor", { email: row.original.email })}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="owner">{t("roleOwner")}</SelectItem>
              <SelectItem value="admin">{t("roleAdmin")}</SelectItem>
              <SelectItem value="member">{t("roleMember")}</SelectItem>
            </SelectContent>
          </Select>
        ),
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive"
          onClick={() => setRemoving(row.original)}
        >
          {t("remove")}
        </Button>
      ),
    },
  ];

  return (
    <div className="max-w-2xl">
      <InviteForm workspaceId={workspaceId} onInvited={invalidate} />
      <div className="mt-6">
        <DataTable
          columns={columns}
          data={members ?? []}
          empty={members?.length ? undefined : t("noMembers")}
        />
      </div>

      <Dialog open={!!removing} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("removeMember")}</DialogTitle>
            <DialogDescription>{t("removeConfirm", { email: removing?.email ?? "" })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRemoving(null)}>
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={removeMember.isPending}
              onClick={() =>
                removing && removeMember.mutateAsync(removing.user_id).catch(() => undefined)
              }
            >
              {t("remove")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InviteForm({ workspaceId, onInvited }: { workspaceId: string; onInvited: () => void }) {
  const t = useT(membersCopy);
  const makeInviteSchema = () =>
    z.object({ email: z.string().email(t("emailInvalid")), role: z.enum(["owner", "admin", "member"]) });
  const form = useForm<z.infer<ReturnType<typeof makeInviteSchema>>>({
    resolver: zodResolver(makeInviteSchema()),
    defaultValues: { email: "", role: "member" },
  });

  const invite = useMutation({
    mutationFn: (values: z.infer<ReturnType<typeof makeInviteSchema>>) =>
      api(`/api/v1/workspaces/${workspaceId}/members`, {
        method: "POST",
        body: JSON.stringify(values),
      }),
    onSuccess: () => {
      toast(t("memberAdded"));
      form.reset({ email: "", role: "member" });
      onInvited();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t("inviteFailed")),
  });

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit((v) => invite.mutateAsync(v).catch(() => undefined))}
        className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-2"
      >
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem className="flex-1">
              <FormLabel>{t("inviteByEmail")}</FormLabel>
              <FormControl>
                <Input type="email" placeholder="user@example.com" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="role"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("roleHeader")}</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger className="w-full sm:w-28">
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="owner">{t("roleOwner")}</SelectItem>
                  <SelectItem value="admin">{t("roleAdmin")}</SelectItem>
                  <SelectItem value="member">{t("roleMember")}</SelectItem>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" size="sm" disabled={invite.isPending} className="sm:mt-8">
          {t("add")}
        </Button>
      </form>
    </Form>
  );
}
