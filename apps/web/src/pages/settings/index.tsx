import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useCurrentWorkspaceId } from "../../lib/workspace-queries";
import { PageHeader } from "../../components/page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import GeneralTab from "./general";
import MembersTab from "./members";
import AccountTab from "./account";
import DangerZone from "./danger-zone";

export default function SettingsPage() {
  const workspaceId = useCurrentWorkspaceId();

  const { data: ws } = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => api<{ name: string }>(`/api/v1/workspaces/${workspaceId}`),
    enabled: !!workspaceId,
  });

  return (
    <div className="mx-auto w-full max-w-4xl p-6">
      <PageHeader title="Settings" description="Workspace, members and account." />
      {!workspaceId ? (
        <p className="mt-6 text-sm text-muted-foreground">
          Not available yet — no workspace selected.
        </p>
      ) : (
        <Tabs defaultValue="general" className="mt-6">
          <TabsList>
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="members">Members</TabsTrigger>
            <TabsTrigger value="account">Account</TabsTrigger>
          </TabsList>
          <TabsContent value="general" className="mt-4">
            <GeneralTab workspaceId={workspaceId} />
            <div className="mt-8">
              <DangerZone
                workspaceId={workspaceId}
                workspaceName={ws?.name ?? workspaceId}
              />
            </div>
          </TabsContent>
          <TabsContent value="members" className="mt-4">
            <MembersTab workspaceId={workspaceId} />
          </TabsContent>
          <TabsContent value="account" className="mt-4">
            <AccountTab />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
