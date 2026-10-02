import { useEffect } from "react";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/skeleton";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../../components/ui/form";

const schema = z.object({ name: z.string().min(1, "Name is required") });
type Values = z.infer<typeof schema>;

interface Workspace {
  id: string;
  name: string;
  status: string;
}

export default function GeneralTab({ workspaceId }: { workspaceId: string }) {
  const qc = useQueryClient();
  const {
    data: ws,
    error,
    isLoading,
  } = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => api<Workspace>(`/api/v1/workspaces/${workspaceId}`),
  });

  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { name: "" } });

  // Load the current name once the workspace query resolves (controlled input).
  useEffect(() => {
    if (ws) form.reset({ name: ws.name });
  }, [ws, form]);

  const save = useMutation({
    mutationFn: (values: Values) =>
      api<Workspace>(`/api/v1/workspaces/${workspaceId}`, {
        method: "PATCH",
        body: JSON.stringify(values),
      }),
    onSuccess: (updated) => {
      qc.setQueryData(["workspace", workspaceId], updated);
      void qc.invalidateQueries({ queryKey: ["workspaces"] });
      toast("Workspace name updated");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Update failed"),
  });

  if (isLoading) return <Skeleton className="h-40 w-full max-w-md" />;
  if (error) return <Error message={error} />;
  if (!ws) return null;

  return (
    <div className="max-w-md">
      <Form {...form}>
        <form
          onSubmit={form.handleSubmit((v) => save.mutateAsync(v).catch(() => undefined))}
          className="grid gap-4"
        >
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Workspace name</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <div>
            <Button type="submit" disabled={save.isPending} size="sm">
              {save.isPending ? "Saving…" : "Save"}
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">
              Only the workspace owner can rename it.
            </p>
          </div>
        </form>
      </Form>
    </div>
  );
}

function Error({ message }: { message: unknown }) {
  const text = message instanceof ApiError ? message.message : "Failed to load workspace.";
  return <p className="text-sm text-destructive">{text}</p>;
}
