import { useEffect, useMemo } from "react";
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
import { useT } from "../../lib/i18n/t";

// General-tab copy: inline LocaleEntry set (see lib/i18n/common.ts). The zod
// schema becomes a factory so validation messages follow the locale (same
// pattern as the auth pages' makeLoginSchema).
const generalCopy = {
  workspaceName: { en: "Workspace name", vi: "Tên workspace" },
  saving: { en: "Saving…", vi: "Đang lưu…" },
  save: { en: "Save", vi: "Lưu" },
  ownerOnly: {
    en: "Only the workspace owner can rename it.",
    vi: "Chỉ chủ sở hữu workspace mới có thể đổi tên.",
  },
  nameRequired: { en: "Name is required", vi: "Vui lòng nhập tên" },
  nameInvalid: { en: "Name is required", vi: "Vui lòng nhập tên" },
  updated: { en: "Workspace name updated", vi: "Đã cập nhật tên workspace" },
  updateFailed: { en: "Update failed", vi: "Cập nhật thất bại" },
  loadFailed: { en: "Failed to load workspace.", vi: "Không tải được workspace." },
} as const;

const makeSchema = (t: (k: keyof typeof generalCopy) => string) =>
  z.object({ name: z.string().min(1, t("nameRequired")) });
type Values = z.infer<ReturnType<typeof makeSchema>>;

interface Workspace {
  id: string;
  name: string;
  status: string;
}

export default function GeneralTab({ workspaceId }: { workspaceId: string }) {
  const t = useT(generalCopy);
  const schema = useMemo(() => makeSchema(t), [t]);
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
      toast(t("updated"));
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t("updateFailed")),
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
                <FormLabel>{t("workspaceName")}</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <div>
            <Button type="submit" disabled={save.isPending} size="sm">
              {save.isPending ? t("saving") : t("save")}
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">{t("ownerOnly")}</p>
          </div>
        </form>
      </Form>
    </div>
  );
}

function Error({ message }: { message: unknown }) {
  const loadFailed = useT(generalCopy)("loadFailed");
  const text = message instanceof ApiError ? message.message : loadFailed;
  return <p className="text-sm text-destructive">{text}</p>;
}
