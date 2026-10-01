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

type Role = "owner" | "admin" | "member";

interface Member {
  user_id: string;
  role: Role;
  email: string;
  name: string | null;
}

const inviteSchema = z.object({
  email: z.string().email("Enter a valid email"),
  role: z.enum(["owner", "admin", "member"]),
});
type InviteValues = z.infer<typeof inviteSchema>;

export default function MembersTab({ workspaceId }: { workspaceId: string }) {
  const qc = useQueryClient();
  const [removing, setRemoving] = React.useState<Member | null>(null);

  const { data: members, error, isLoading } = useQuery({
    queryKey: ["members", workspaceId],
    queryFn: () => api<Member[]>(`/api/workspaces/${workspaceId}/members`),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["members", workspaceId] });
    void qc.invalidateQueries({ queryKey: ["workspaces"] });
  };

  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      api(`/api/workspaces/${workspaceId}/members/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      }),
    onSuccess: () => {
      toast("Role updated");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Update failed"),
  });

  const removeMember = useMutation({
    mutationFn: (userId: string) =>
      api(`/api/workspaces/${workspaceId}/members/${userId}`, { method: "DELETE" }),
    onSuccess: () => {
      toast("Member removed");
      setRemoving(null);
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Remove failed"),
  });

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error) {
    return (
      <p className="text-sm text-muted-foreground">
        {error instanceof ApiError
          ? `Cannot view members: ${error.message}`
          : "Failed to load members."}
      </p>
    );
  }

  const columns: ColumnDef<Member, unknown>[] = [
    {
      accessorKey: "email",
      header: "Email",
      meta: "font-mono",
    },
    { accessorKey: "name", header: "Name" },
    {
      accessorKey: "role",
      header: "Role",
      cell: ({ row }) =>
        row.original.role === "owner" ? (
          row.original.role
        ) : (
          <Select
            value={row.original.role}
            onValueChange={(role) =>
              void changeRole.mutateAsync({ userId: row.original.user_id, role: role as Role }).catch(
                () => undefined,
              )
            }
          >
            <SelectTrigger className="h-8 w-28" aria-label={`Role for ${row.original.email}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="owner">owner</SelectItem>
              <SelectItem value="admin">admin</SelectItem>
              <SelectItem value="member">member</SelectItem>
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
          Remove
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
          empty={
            members?.length
              ? undefined
              : "No members. Invited users must already have an account."
          }
        />
      </div>

      <Dialog open={!!removing} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove member</DialogTitle>
            <DialogDescription>
              Remove {removing?.email} from this workspace?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={removeMember.isPending}
              onClick={() => removing && removeMember.mutateAsync(removing.user_id).catch(() => undefined)}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InviteForm({
  workspaceId,
  onInvited,
}: {
  workspaceId: string;
  onInvited: () => void;
}) {
  const form = useForm<InviteValues>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { email: "", role: "member" },
  });

  const invite = useMutation({
    mutationFn: (values: InviteValues) =>
      api(`/api/workspaces/${workspaceId}/members`, {
        method: "POST",
        body: JSON.stringify(values),
      }),
    onSuccess: () => {
      toast("Member added");
      form.reset({ email: "", role: "member" });
      onInvited();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Invite failed"),
  });

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit((v) => invite.mutateAsync(v).catch(() => undefined))}
        className="flex items-start gap-2"
      >
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem className="flex-1">
              <FormLabel>Invite by email</FormLabel>
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
              <FormLabel>Role</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="owner">owner</SelectItem>
                  <SelectItem value="admin">admin</SelectItem>
                  <SelectItem value="member">member</SelectItem>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" size="sm" disabled={invite.isPending} className="mt-8">
          Add
        </Button>
      </form>
    </Form>
  );
}
