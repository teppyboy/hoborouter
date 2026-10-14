import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { MemberChatPolicy, MemberChatAccess } from "@hoborouter/shared";
import { api, ApiError } from "../lib/api";
import { useSession } from "../lib/auth";
import { useT } from "../lib/i18n/t";
import { formatVnd, formatDate } from "../lib/format";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Skeleton } from "./ui/skeleton";
import { Switch } from "./ui/switch";

// Member chat policy section: admin editor for the General settings tab, plus
// the member-facing read view Chat integrators mount. Wire shapes come from the
// frozen shared DTOs; the server is the authority — the client precheck only
// hides the editor from non-admins, it never grants anything.
const policyCopy = {
  title: { en: "Member chat", vi: "Chat cho thành viên" },
  help: {
    en: "Lets workspace members chat with the shared models under a daily VND cap per member (UTC day, shared across all their keys). Changing the cap never resets today's usage.",
    vi: "Cho phép thành viên workspace chat với các model dùng chung trong hạn mức VND mỗi ngày theo từng thành viên (theo ngày UTC, dùng chung cho mọi key của họ). Thay đổi hạn mức không bao giờ đặt lại mức đã dùng trong ngày.",
  },
  enableLabel: { en: "Allow member chat", vi: "Cho phép thành viên chat" },
  capLabel: { en: "Daily cap per member (VND)", vi: "Hạn mức mỗi ngày mỗi thành viên (VND)" },
  capDisabledHint: {
    en: "Enable member chat to set a daily cap.",
    vi: "Bật chat cho thành viên để đặt hạn mức hằng ngày.",
  },
  capRequired: {
    en: "Enter a positive whole VND amount",
    vi: "Nhập số VND nguyên dương",
  },
  save: { en: "Save", vi: "Lưu" },
  saving: { en: "Saving…", vi: "Đang lưu…" },
  saved: { en: "Member chat policy updated", vi: "Đã cập nhật chính sách chat" },
  saveFailed: { en: "Update failed", vi: "Cập nhật thất bại" },
  loadFailed: {
    en: "Failed to load member chat policy.",
    vi: "Không tải được chính sách chat.",
  },
} as const;

const accessCopy = {
  chatBlocked: {
    en: "Chat is not enabled for this workspace. Ask a workspace admin to enable member chat.",
    vi: "Chat chưa được bật cho workspace này. Hãy nhờ quản trị viên workspace bật chat cho thành viên.",
  },
  limitReached: {
    en: "You have used today's member chat limit. It resets {time}.",
    vi: "Bạn đã dùng hết hạn mức chat hôm nay. Hạn mức sẽ đặt lại lúc {time}.",
  },
  usageLine: {
    en: "Today: {used} of {cap} — remaining {remaining}",
    vi: "Hôm nay: đã dùng {used} trên {cap} — còn {remaining}",
  },
  resetsAt: { en: "Resets {time} (UTC daily)", vi: "Đặt lại lúc {time} (hằng ngày theo UTC)" },
  loadFailed: {
    en: "Failed to load your chat access.",
    vi: "Không tải được quyền chat của bạn.",
  },
} as const;

type Role = "owner" | "admin" | "member";

interface Member {
  user_id: string;
  role: Role;
}

/** Admin-only editor. Renders nothing for non-admins (no admin API calls). */
export default function MemberChatPolicySection({ workspaceId }: { workspaceId: string }) {
  const t = useT(policyCopy);
  const qc = useQueryClient();
  const { data: session } = useSession();
  const userId = session?.user?.id ?? null;

  // Role precheck via the existing members query key (shared with MembersTab);
  // visibility only — the server still enforces admin on every endpoint.
  const { data: members } = useQuery({
    queryKey: ["members", workspaceId],
    queryFn: ({ signal }) => api<Member[]>(`/api/v1/workspaces/${workspaceId}/members`, { signal }),
    enabled: !!userId,
    retry: false,
  });
  const role = members?.find((m) => m.user_id === userId)?.role ?? null;
  const isAdmin = role === "owner" || role === "admin";

  const policy = useQuery({
    queryKey: ["member-chat-policy", workspaceId],
    queryFn: ({ signal }) =>
      api<MemberChatPolicy>(`/api/v1/workspaces/${workspaceId}/member-chat-policy`, { signal }),
    enabled: isAdmin,
    retry: false,
  });

  const [enabled, setEnabled] = useState(false);
  const [capText, setCapText] = useState("");
  const [capError, setCapError] = useState<string | null>(null);

  // Sync local controls to the server policy (also after a successful PUT via
  // setQueryData). Server data always wins — never local-only state.
  useEffect(() => {
    if (policy.data) {
      setEnabled(policy.data.enabled);
      setCapText(policy.data.daily_cap_vnd == null ? "" : String(policy.data.daily_cap_vnd));
      setCapError(null);
    }
  }, [policy.data]);

  const save = useMutation({
    mutationFn: (body: MemberChatPolicy) =>
      api<MemberChatPolicy>(`/api/v1/workspaces/${workspaceId}/member-chat-policy`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: (updated) => {
      qc.setQueryData(["member-chat-policy", workspaceId], updated);
      void qc.invalidateQueries({ queryKey: ["member-chat-access", workspaceId] });
      toast(t("saved"));
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t("saveFailed")),
  });

  if (!isAdmin) return null;

  if (policy.isLoading) return <Skeleton className="h-40 w-full max-w-md" />;
  if (policy.error)
    return (
      <p className="text-sm text-destructive">
        {policy.error instanceof ApiError ? policy.error.message : t("loadFailed")}
      </p>
    );
  if (!policy.data) return null;

  const trimmed = capText.trim();
  const parsedCap = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  const dirty =
    policy.data.enabled !== enabled ||
    (enabled ? policy.data.daily_cap_vnd !== parsedCap : policy.data.daily_cap_vnd !== null);

  const submit = () => {
    let daily_cap_vnd: number | null = null;
    if (enabled) {
      // Mirror of the server rule: an enabled policy is always explicitly
      // capped with a positive integer (DB CHECK + API validation).
      if (!Number.isSafeInteger(parsedCap) || parsedCap <= 0) {
        setCapError(t("capRequired"));
        return;
      }
      daily_cap_vnd = parsedCap;
    }
    setCapError(null);
    save.mutate({ enabled, daily_cap_vnd });
  };

  return (
    <section className="max-w-md rounded-lg border p-4" aria-label={t("title")}>
      <h3 className="text-sm font-medium">{t("title")}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{t("help")}</p>
      <div className="mt-3 flex items-center gap-2">
        <Switch
          id="member-chat-enabled"
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label={t("enableLabel")}
        />
        <Label htmlFor="member-chat-enabled">{t("enableLabel")}</Label>
      </div>
      <div className="mt-3">
        <Label htmlFor="member-chat-daily-cap">{t("capLabel")}</Label>
        <Input
          id="member-chat-daily-cap"
          className="mt-1"
          inputMode="numeric"
          autoComplete="off"
          value={capText}
          onChange={(e) => setCapText(e.target.value)}
          disabled={!enabled}
          placeholder={enabled ? undefined : t("capDisabledHint")}
          aria-invalid={capError ? true : undefined}
        />
        {capError && <p className="mt-1 text-sm text-destructive">{capError}</p>}
      </div>
      {save.isError && (
        <p className="mt-2 text-sm text-destructive">
          {save.error instanceof ApiError ? save.error.message : t("saveFailed")}
        </p>
      )}
      <Button
        type="button"
        size="sm"
        className="mt-3"
        disabled={save.isPending || !dirty}
        onClick={submit}
      >
        {save.isPending ? t("saving") : t("save")}
      </Button>
    </section>
  );
}

/**
 * Member-facing read view of the caller's own chat access. Read-only: it shows
 * the remaining daily limit and reset time; it never resets usage and has no
 * actions. Exported for the Chat page integrator.
 */
export function MemberChatAccessView({ workspaceId }: { workspaceId: string }) {
  const t = useT(accessCopy);
  const { data: session } = useSession();
  const userId = session?.user?.id ?? null;
  const access = useQuery({
    queryKey: ["member-chat-access", workspaceId, userId],
    queryFn: ({ signal }) =>
      api<MemberChatAccess>(`/api/v1/workspaces/${workspaceId}/member-chat-access`, {
        signal,
      }),
    enabled: !!userId,
    retry: false,
  });

  if (access.isLoading) return <Skeleton className="h-16 w-full max-w-md" />;
  if (access.error)
    return (
      <p className="text-sm text-muted-foreground">
        {access.error instanceof ApiError ? access.error.message : t("loadFailed")}
      </p>
    );
  if (!access.data) return null;

  const a = access.data;
  if (!a.can_chat) {
    // remaining_vnd === 0 means the daily cap is exhausted, not disabled.
    if (a.remaining_vnd === 0)
      return (
        <p className="text-sm text-muted-foreground">
          {t("limitReached", { time: formatDate(a.resets_at) })}
        </p>
      );
    return <p className="text-sm text-muted-foreground">{t("chatBlocked")}</p>;
  }
  return (
    <div className="max-w-md rounded-lg border p-4 text-sm">
      <p>
        {t("usageLine", {
          used: formatVnd(a.used_vnd),
          cap: formatVnd(a.daily_cap_vnd),
          remaining: formatVnd(a.remaining_vnd),
        })}
      </p>
      <p className="mt-1 text-muted-foreground">
        {t("resetsAt", { time: formatDate(a.resets_at) })}
      </p>
    </div>
  );
}
