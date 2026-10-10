// System card module: the instance-health card lives under the admin
// Settings page (/admin/settings); /admin/system redirects there, so this
// file intentionally exports only the card (no standalone page route).
import { CheckCircle2, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { useT } from "../../lib/i18n/t";
import { useAdminQuery } from "./shared";

interface AdminSystem {
  gateway_enabled: boolean;
  usd_vnd_rate: number;
  payos_configured: boolean;
  manual_payments: boolean;
  db: { wal: string };
  counts: { users: number; workspaces: number; models: number; requests: number };
}

/** Instance-system card copy; USD/VND codes and DB values stay verbatim. */
const systemCopy = {
  sectionDesc: { en: "Instance health and status.", vi: "Tình trạng và trạng thái instance." },
  cardTitle: { en: "System", vi: "Hệ thống" },
  loading: { en: "Loading…", vi: "Đang tải…" },
  loadFailed: {
    en: "Failed to load system info",
    vi: "Không tải được thông tin hệ thống",
  },
  gateway: { en: "Gateway", vi: "Gateway" },
  usdVndRate: { en: "USD/VND rate", vi: "Tỷ giá USD/VND" },
  payos: { en: "PayOS", vi: "PayOS" },
  manualPayments: { en: "Manual payments", vi: "Thanh toán thủ công" },
  dbJournal: { en: "DB journal mode", vi: "Chế độ journal DB" },
  counts: { en: "Counts", vi: "Số liệu" },
  on: { en: "on", vi: "bật" },
  off: { en: "off", vi: "tắt" },
  configured: { en: "configured", vi: "đã cấu hình" },
  notConfigured: { en: "not configured", vi: "chưa cấu hình" },
  enabled: { en: "enabled", vi: "bật" },
  disabled: { en: "disabled", vi: "tắt" },
  countsLine: {
    en: "users {users} · workspaces {workspaces} · models {models} · requests {requests}",
    vi: "người dùng {users} · workspace {workspaces} · mô hình {models} · yêu cầu {requests}",
  },
} as const;

export function SystemCard() {
  const t = useT(systemCopy);
  const query = useAdminQuery<AdminSystem>(["admin", "system"], "/api/v1/admin/system");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{t("cardTitle")}</CardTitle>
        <p className="text-xs text-muted-foreground">{t("sectionDesc")}</p>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        ) : query.error ? (
          <p className="flex items-center gap-2 text-sm text-destructive">
            <XCircle className="size-4" />
            {query.error instanceof Error ? query.error.message : t("loadFailed")}
          </p>
        ) : (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">{t("gateway")}</dt>
              <dd className="flex items-center gap-1.5">
                {query.data.gateway_enabled ? (
                  <>
                    <CheckCircle2 className="size-4" /> {t("on")}
                  </>
                ) : (
                  <>
                    <XCircle className="size-4" /> {t("off")}
                  </>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("usdVndRate")}</dt>
              <dd className="font-mono text-xs">
                {query.data.usd_vnd_rate.toLocaleString("vi-VN")}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("payos")}</dt>
              <dd>
                <Badge variant={query.data.payos_configured ? "default" : "outline"}>
                  {query.data.payos_configured ? t("configured") : t("notConfigured")}
                </Badge>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("manualPayments")}</dt>
              <dd>
                <Badge variant={query.data.manual_payments ? "secondary" : "outline"}>
                  {query.data.manual_payments ? t("enabled") : t("disabled")}
                </Badge>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("dbJournal")}</dt>
              <dd className="font-mono text-xs">{query.data.db.wal}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("counts")}</dt>
              <dd className="break-words font-mono text-xs">
                {t("countsLine", {
                  users: query.data.counts.users,
                  workspaces: query.data.counts.workspaces,
                  models: query.data.counts.models,
                  requests: query.data.counts.requests,
                })}
              </dd>
            </div>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}
