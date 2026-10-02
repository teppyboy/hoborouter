import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Switch } from "../../components/ui/switch";
import { Label } from "../../components/ui/label";
import { PageHeader } from "../../components/page";
import { api } from "../../lib/api";
import { AdminGate, useAdminQuery } from "./shared";

interface AdminSettings {
  prompt_caching_enabled: boolean;
}

function PromptCachingCard({
  query,
}: {
  query: { data?: AdminSettings; isPending: boolean; error: unknown };
}) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (enabled: boolean) =>
      api<AdminSettings>("/api/v1/admin/settings", {
        method: "PUT",
        body: JSON.stringify({ prompt_caching_enabled: enabled }),
      }),
    onSuccess: () => {
      toast("Settings saved");
      void qc.invalidateQueries({ queryKey: ["admin", "settings"] });
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Prompt caching</CardTitle>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : query.error ? (
          <p className="text-sm text-destructive">
            {query.error instanceof Error ? query.error.message : "Failed to load settings"}
          </p>
        ) : query.data ? (
          <div className="flex items-center justify-between gap-4">            <div className="grid gap-1">
              <Label htmlFor="prompt_caching">Prompt caching (all models)</Label>
              <p className="text-xs text-muted-foreground">
                When off, cached tokens are billed at the full input price. Requests are sent
                unchanged; providers may still cache.
              </p>
            </div>
            <Switch
              id="prompt_caching"
              checked={query.data.prompt_caching_enabled}
              onCheckedChange={(c) => mutation.mutate(c)}
              disabled={mutation.isPending}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default function AdminSettingsPage() {
  const query = useAdminQuery<AdminSettings>(["admin", "settings"], "/api/v1/admin/settings");
  return (
    <div className="mx-auto w-full max-w-4xl p-6">
      <PageHeader title="Instance settings" description="Global platform settings." />
      <AdminGate query={query}>
        <div className="mt-6">
          <PromptCachingCard query={query} />
        </div>
      </AdminGate>
    </div>
  );
}
