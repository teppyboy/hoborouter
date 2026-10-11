import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useCurrentWorkspaceId } from "../../lib/workspace-queries";
import { PageHeader } from "../../components/page";
import { useLocaleEntry } from "../../lib/i18n/t";

// Settings chrome copy: inline LocaleEntry set (see lib/i18n/common.ts).
const settingsCopy = {
  title: { en: "Settings", vi: "Cài đặt" },
  description: { en: "Workspace, members and account.", vi: "Workspace, thành viên và tài khoản." },
  unavailable: {
    en: "Not available yet — no workspace selected.",
    vi: "Chưa khả dụng — chưa chọn workspace.",
  },
  general: { en: "General", vi: "Chung" },
  members: { en: "Members", vi: "Thành viên" },
  account: { en: "Account", vi: "Tài khoản" },
} as const;
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import GeneralTab from "./general";
import MembersTab from "./members";
import AccountTab from "./account";
import DangerZone from "./danger-zone";

export default function SettingsPage() {
  const workspaceId = useCurrentWorkspaceId();
  // Deep-linkable initial tab (`?tab=account`): OAuth account-linking callbacks
  // return here so users land on the section that started the flow.
  const tabParam = new URLSearchParams(window.location.search).get("tab");
  const initialTab = tabParam === "members" || tabParam === "account" ? tabParam : "general";

  const { data: ws } = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => api<{ name: string }>(`/api/v1/workspaces/${workspaceId}`),
    enabled: !!workspaceId,
  });

  const title = useLocaleEntry(settingsCopy.title);
  const description = useLocaleEntry(settingsCopy.description);
  const unavailable = useLocaleEntry(settingsCopy.unavailable);
  const general = useLocaleEntry(settingsCopy.general);
  const members = useLocaleEntry(settingsCopy.members);
  const account = useLocaleEntry(settingsCopy.account);
  return (
    <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col p-6">
      <PageHeader title={title} description={description} />
      {!workspaceId ? (
        <p className="mt-6 text-sm text-muted-foreground">{unavailable}</p>
      ) : (
        <Tabs defaultValue={initialTab} className="mt-6 flex min-h-0 flex-1 flex-col">
          {/* Bounded flex column so the members tab's table panel can take the
              remaining height; other tabs keep their natural block layout. */}
          <TabsList>
            <TabsTrigger value="general">{general}</TabsTrigger>
            <TabsTrigger value="members">{members}</TabsTrigger>
            <TabsTrigger value="account">{account}</TabsTrigger>
          </TabsList>
          <TabsContent value="general" className="mt-4">
            <GeneralTab workspaceId={workspaceId} />
            <div className="mt-8">
              <DangerZone workspaceId={workspaceId} workspaceName={ws?.name ?? workspaceId} />
            </div>
          </TabsContent>
          <TabsContent value="members" className="mt-4 flex min-h-0 flex-1 flex-col">
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
