// Instance-admin CPA management page. Contracts mirror
// apps/api/src/routes/admin-cpa-mutations.ts (mutations) and the read surface
// that actually exists: GET /api/v1/admin/cpa/health, the redacted
// /api/v1/admin/cpa/management/config proxy, and GET /api/v1/admin/cpa/models
// (rendered once, in the single "CPA models" section: alias-resolved model
// table plus the alias/exclusion forms). There is deliberately no list read
// for api keys / auth files / aliases — those sections are write-only forms
// against the mutation contracts. Every mutation passes through an explicit
// confirm dialog; secret inputs are write-only (type=password) and are never
// rendered back.
import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Textarea } from "../../components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, PageHeader, ScrollPanel } from "../../components/page";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { api } from "../../lib/api";
import { useT, useLocaleEntry, type LocaleEntry } from "../../lib/i18n/t";
import { AdminGate, useAdminQuery } from "./shared";

// ── Backend contracts (admin-cpa-mutations.ts) ─────────────────────────────

/** CPA v0/management boolean config fields (BOOL_FLAGS in the backend). */
export const CPA_BOOL_FLAGS = [
  "debug",
  "usage-statistics-enabled",
  "request-log",
  "ws-auth",
  "logging-to-file",
  "force-model-prefix",
  "quota-exceeded/switch-project",
  "quota-exceeded/switch-preview-model",
] as const;

/** Routing strategies (ROUTING_STRATEGIES in the backend). */
export const CPA_ROUTING_STRATEGIES = [
  "round-robin",
  "weighted-round-robin",
  "fill-first",
] as const;

const MAX_ALIASES = 200;
const MAX_EXCLUDED_MODELS = 500;

export interface AliasEntry {
  name: string;
  alias: string;
  fork?: boolean;
  display_name?: string;
  force_mapping?: boolean;
}

const ALIAS_FIELDS = ["name", "alias", "fork", "display_name", "force_mapping"] as const;

/** Validate the JSON alias list against the model-alias contract (empty clears the channel). */
export function parseAliasesJson(
  text: string,
): { ok: true; aliases: AliasEntry[] } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: "Expected a JSON array" };
  const aliases: AliasEntry[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null)
      return { ok: false, error: "Each alias must be an object" };
    const o = item as Record<string, unknown>;
    if (typeof o.name !== "string" || !o.name || typeof o.alias !== "string" || !o.alias)
      return { ok: false, error: "Each alias needs non-empty name and alias" };
    for (const key of Object.keys(o)) {
      if (!(ALIAS_FIELDS as readonly string[]).includes(key))
        return { ok: false, error: `Unknown alias field: ${key}` };
    }
    const entry: AliasEntry = { name: o.name, alias: o.alias };
    if (o.fork !== undefined) {
      if (typeof o.fork !== "boolean") return { ok: false, error: "fork must be a boolean" };
      entry.fork = o.fork;
    }
    if (o.display_name !== undefined) {
      if (typeof o.display_name !== "string")
        return { ok: false, error: "display_name must be a string" };
      entry.display_name = o.display_name;
    }
    if (o.force_mapping !== undefined) {
      if (typeof o.force_mapping !== "boolean")
        return { ok: false, error: "force_mapping must be a boolean" };
      entry.force_mapping = o.force_mapping;
    }
    aliases.push(entry);
  }
  if (aliases.length > MAX_ALIASES)
    return { ok: false, error: `At most ${MAX_ALIASES} aliases per channel` };
  return { ok: true, aliases };
}

/** Newline-separated exclusion models: trimmed, deduped; null over the backend cap. */
export function parseExclusionModels(text: string): string[] | null {
  const models = [
    ...new Set(
      text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ];
  if (models.length > MAX_EXCLUDED_MODELS) return null;
  return models;
}

const RETRY_FIELDS = ["request_retry", "max_retry_credentials", "max_retry_interval"] as const;
type RetryField = (typeof RETRY_FIELDS)[number];

/** Build the retry-tuning body: only filled integer fields 0..1000; null on any invalid value. */
export function retryBody(
  input: Partial<Record<RetryField, string>>,
): Partial<Record<RetryField, number>> | null {
  const out: Partial<Record<RetryField, number>> = {};
  for (const key of RETRY_FIELDS) {
    const raw = input[key];
    if (raw === undefined || raw.trim() === "") continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 1000) return null;
    out[key] = n;
  }
  return out;
}

/** Build the PATCH /api-keys body (add = old==new==key; rotate = {old,new}; set-index = {index,value}). */
export function apiKeyBody(input: {
  mode: "add" | "rotate" | "set-index";
  key: string;
  oldKey?: string;
  index?: string;
}): Record<string, unknown> | null {
  const key = input.key.trim();
  if (!key) return null;
  if (input.mode === "add") return { old: key, new: key };
  if (input.mode === "rotate") {
    const oldKey = input.oldKey?.trim();
    if (!oldKey) return null;
    return { old: oldKey, new: key };
  }
  const index = Number(input.index);
  if (input.index === undefined || !Number.isInteger(index) || index < 0) return null;
  return { index, value: key };
}

/** Auth-file metadata fields object: JSON object, 1..32 keys, string keys. */
function parseAuthFields(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length < 1 || keys.length > 32) return null;
  return parsed as Record<string, unknown>;
}

const AUTH_FILE_NAMES_MAX = 50;

function parseAuthFileNames(text: string): string[] | null {
  const names = [
    ...new Set(
      text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ];
  if (names.length < 1 || names.length > AUTH_FILE_NAMES_MAX) return null;
  return names;
}

const PROXY_URL_RE = /^(https?|socks5h?):\/\/[^\s]+$/;

// ── Shared plumbing ─────────────────────────────────────────────────────────

// Shared CPA-page copy: confirm dialog chrome, the danger disclosure and the
// generic request-failure fallback. Card-specific dicts live next to the card.
const cpaSharedCopy = {
  confirmAction: { en: "Confirm action", vi: "Xác nhận thao tác" },
  cancel: { en: "Cancel", vi: "Hủy" },
  confirm: { en: "Confirm", vi: "Xác nhận" },
  danger: {
    en: "This talks to the pinned CPA management API and cannot be undone on this page.",
    vi: "Thao tác này gọi trực tiếp API quản trị CPA và không thể hoàn tác trên trang này.",
  },
  requestFailed: { en: "Request failed", vi: "Yêu cầu thất bại" },
} as const;

/**
 * Localized display strings for the known validation errors returned by
 * `parseAliasesJson`. The function's English error contract is preserved
 * (exported + tested); only the toast display maps to the active locale.
 * Unknown (dynamic) errors surface raw instead of being hidden.
 */
const aliasValidationErrorCopy = {
  "Invalid JSON": { en: "Invalid JSON", vi: "JSON không hợp lệ" },
  "Expected a JSON array": { en: "Expected a JSON array", vi: "Phải là mảng JSON" },
  "Each alias must be an object": {
    en: "Each alias must be an object",
    vi: "Mỗi alias phải là một đối tượng",
  },
  "Each alias needs non-empty name and alias": {
    en: "Each alias needs non-empty name and alias",
    vi: "Mỗi alias cần name và alias khác rỗng",
  },
  "fork must be a boolean": { en: "fork must be a boolean", vi: "fork phải là boolean" },
  "display_name must be a string": {
    en: "display_name must be a string",
    vi: "display_name phải là chuỗi",
  },
  "force_mapping must be a boolean": {
    en: "force_mapping must be a boolean",
    vi: "force_mapping phải là boolean",
  },
  "At most 200 aliases per channel": {
    en: "At most 200 aliases per channel",
    vi: "Tối đa 200 alias mỗi kênh",
  },
} as const;

type CpaMethod = "PATCH" | "PUT" | "POST" | "DELETE";

function useCpaMutation(
  method: CpaMethod,
  path: string,
  successMsg: LocaleEntry,
  onSuccessExtra?: () => void,
) {
  const success = useLocaleEntry(successMsg);
  const t = useT(cpaSharedCopy);
  return useMutation({
    mutationFn: (body: unknown) => api(path, { method, body: JSON.stringify(body) }),
    onSuccess: () => {
      toast(success);
      onSuccessExtra?.();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : t("requestFailed")),
  });
}

interface ConfirmRequest {
  title: string;
  description: string;
  action: () => void;
}

/** Confirm dialog plumbing: every CPA mutation routes through `confirm(...)`. */
function useConfirm() {
  const t = useT(cpaSharedCopy);
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const confirm = (r: ConfirmRequest) => setRequest(r);
  const dialog = (
    <Dialog open={request !== null} onOpenChange={(open) => !open && setRequest(null)}>
      {request && (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("confirmAction")}</DialogTitle>
            <DialogDescription>{request.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRequest(null)}>
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const action = request.action;
                setRequest(null);
                action();
              }}
            >
              {t("confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
  return { confirm, dialog };
}

// ── Health ──────────────────────────────────────────────────────────────────

interface CpaHealth {
  status: string;
  proxy_endpoint: { healthy: boolean; http_status: number };
  management_api: { healthy: boolean; http_status: number };
  latency_ms: number;
  cpa_host: string;
  checked_at: string;
}

const healthCopy = {
  title: { en: "CPA health", vi: "Sức khỏe CPA" },
  checking: { en: "Checking…", vi: "Đang kiểm tra…" },
  unreachable: { en: "CPA unreachable", vi: "Không kết nối được CPA" },
  managementApi: { en: "Management API", vi: "API quản trị" },
  proxyEndpoint: { en: "Proxy endpoint", vi: "Endpoint proxy" },
  healthy: { en: "Healthy ({status})", vi: "Hoạt động ({status})" },
  down: { en: "Down ({status})", vi: "Mất kết nối ({status})" },
  checkLatency: { en: "Check latency", vi: "Độ trễ kiểm tra" },
  cpaHost: { en: "CPA host", vi: "Máy chủ CPA" },
} as const;

export function CpaHealthCard() {
  const t = useT(healthCopy);
  const query = useAdminQuery<CpaHealth>(["admin", "cpa-health"], "/api/v1/admin/cpa/health");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <p className="text-sm text-muted-foreground">{t("checking")}</p>
        ) : query.error ? (
          <p className="flex items-center gap-2 text-sm text-destructive">
            <XCircle className="size-4" />
            {query.error instanceof Error ? query.error.message : t("unreachable")}
          </p>
        ) : (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">{t("managementApi")}</dt>
              <dd className="flex items-center gap-1.5">
                {query.data.management_api.healthy ? (
                  <CheckCircle2 className="size-4" />
                ) : (
                  <XCircle className="size-4" />
                )}
                {query.data.management_api.healthy
                  ? t("healthy", { status: query.data.management_api.http_status })
                  : t("down", { status: query.data.management_api.http_status })}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("proxyEndpoint")}</dt>
              <dd className="flex items-center gap-1.5">
                {query.data.proxy_endpoint.healthy ? (
                  <CheckCircle2 className="size-4" />
                ) : (
                  <XCircle className="size-4" />
                )}
                {query.data.proxy_endpoint.healthy
                  ? t("healthy", { status: query.data.proxy_endpoint.http_status })
                  : t("down", { status: query.data.proxy_endpoint.http_status })}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("checkLatency")}</dt>
              <dd className="font-mono text-xs">{query.data.latency_ms} ms</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("cpaHost")}</dt>
              <dd className="font-mono text-xs">{query.data.cpa_host}</dd>
            </div>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

// ── Config YAML (read = redacted proxy; write = dangerous full replace) ────

// ConfigCard copy: inline LocaleEntry set (see lib/i18n/common.ts). YAML
// content, placeholders and identifiers stay untranslated.
const configCopy = {
  title: { en: "Config", vi: "Cấu hình" },
  loading: { en: "Loading current config…", vi: "Đang tải cấu hình hiện tại…" },
  loadError: { en: "Failed to load config", vi: "Không tải được cấu hình" },
  showCurrent: {
    en: "View current config",
    vi: "Xem cấu hình hiện tại",
  },
  hideCurrent: { en: "Hide current config", vi: "Ẩn cấu hình hiện tại" },
  newLabel: {
    en: "New config.yaml (full replace)",
    vi: "config.yaml mới (thay thế toàn bộ)",
  },
  save: { en: "Save config", vi: "Lưu cấu hình" },
  replaceTitle: { en: "Replace CPA config.yaml", vi: "Thay thế config.yaml của CPA" },
  replaceDesc: {
    en: "This replaces the entire upstream config file.",
    vi: "Thao tác này thay thế toàn bộ tệp cấu hình upstream.",
  },
  fullscreen: {
    en: "Fullscreen edit",
    vi: "Chỉnh sửa toàn màn hình",
  },
  fullscreenTitle: {
    en: "New config.yaml (full replace)",
    vi: "config.yaml mới (thay thế toàn bộ)",
  },
  fullscreenDesc: {
    en: "The editor starts empty on purpose: the current config is redacted, so it can never be pasted back. This replaces the entire upstream config file.",
    vi: "Trình soạn thảo luôn trống ban đầu: cấu hình hiện tại đã bị che thông tin nhạy cảm nên không thể dán lại. Thao tác này thay thế toàn bộ tệp cấu hình upstream.",
  },
  saved: { en: "Config saved", vi: "Đã lưu cấu hình" },
} as const;

/**
 * Single write-only YAML editor for the dangerous full-replace config PUT.
 * The editable textarea never starts from the redacted read: the proxy output
 * contains "[REDACTED]" placeholders, and pasting them back would write
 * placeholders into real secret fields upstream. The redacted current config
 * is only a collapsible read-only <pre> preview (never a textarea), so the
 * two surfaces cannot be confused or round-tripped.
 */
export function ConfigCard() {
  const { confirm, dialog } = useConfirm();
  const t = useT(configCopy);
  const tS = useT(cpaSharedCopy);
  const query = useAdminQuery<unknown>(
    ["admin", "cpa-config"],
    "/api/v1/admin/cpa/management/config",
  );
  const [yaml, setYaml] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const [showCurrent, setShowCurrent] = useState(false);
  const save = useCpaMutation("PUT", "/api/v1/admin/cpa/config", configCopy.saved, () => {
    setYaml("");
    setFullscreen(false);
  });

  // One logical editor rendered either inline or inside the fullscreen Dialog
  // (never both at once), so the draft survives the mode switch.
  const editor = (
    <Textarea
      id="cpa-config-yaml"
      rows={fullscreen ? 16 : 8}
      className="font-mono text-xs"
      value={yaml}
      onChange={(e) => setYaml(e.target.value)}
      placeholder="port: 8317 …"
      aria-label={t("newLabel")}
    />
  );
  const saveButton = (
    <Button
      size="sm"
      disabled={save.isPending || yaml.trim().length === 0}
      onClick={() =>
        confirm({
          title: t("replaceTitle"),
          description: `${t("replaceDesc")} ${tS("danger")}`,
          action: () => save.mutate({ config_yaml: yaml, confirm: true }),
        })
      }
    >
      {t("save")}
    </Button>
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isPending ? (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        ) : query.error ? (
          <p className="text-sm text-destructive">
            {query.error instanceof Error ? query.error.message : t("loadError")}
          </p>
        ) : (
          <div className="space-y-1">
            <Button
              size="sm"
              variant="outline"
              aria-expanded={showCurrent}
              aria-label={showCurrent ? t("hideCurrent") : t("showCurrent")}
              onClick={() => setShowCurrent((v) => !v)}
            >
              {showCurrent ? t("hideCurrent") : t("showCurrent")}
            </Button>
            {showCurrent && (
              <pre
                id="cpa-config-current"
                aria-readonly="true"
                className="max-h-64 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap"
              >
                {JSON.stringify(query.data, null, 2)}
              </pre>
            )}
          </div>
        )}
        {!fullscreen && (
          <div className="space-y-1">
            <Label htmlFor="cpa-config-yaml">{t("newLabel")}</Label>
            {editor}
          </div>
        )}
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="outline"
            aria-label={t("fullscreen")}
            disabled={fullscreen}
            onClick={() => setFullscreen(true)}
          >
            {t("fullscreen")}
          </Button>
          {!fullscreen && saveButton}
        </div>
        <Dialog
          open={fullscreen}
          onOpenChange={(open) => {
            if (!open) setFullscreen(false);
          }}
        >
          <DialogContent
            aria-label={t("fullscreenTitle")}
            className="h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[calc(100dvw-2rem)]"
          >
            <DialogHeader>
              <DialogTitle>{t("fullscreenTitle")}</DialogTitle>
              <DialogDescription>{t("fullscreenDesc")}</DialogDescription>
            </DialogHeader>
            {fullscreen && editor}
            <DialogFooter>{saveButton}</DialogFooter>
          </DialogContent>
        </Dialog>
        {dialog}
      </CardContent>
    </Card>
  );
}

// ── Routing strategy, flags, retry tuning, proxy URL ───────────────────────

const routingCopy = {
  title: { en: "Routing & flags", vi: "Định tuyến & cờ" },
  strategyLabel: {
    en: "Credential routing strategy",
    vi: "Chiến lược định tuyến credential",
  },
  useStrategy: { en: "Use {strategy}", vi: "Dùng {strategy}" },
  setStrategyTitle: {
    en: "Set routing strategy",
    vi: "Đặt chiến lược định tuyến",
  },
  setStrategyDesc: {
    en: 'Set the CPA credential routing strategy to "{strategy}"?',
    vi: 'Đặt chiến lược định tuyến credential của CPA thành "{strategy}"?',
  },
  flagsLabel: { en: "Boolean config flags", vi: "Cờ cấu hình boolean" },
  setFlagOn: { en: "Set {flag} on", vi: "Bật {flag}" },
  setFlagOff: { en: "Set {flag} off", vi: "Tắt {flag}" },
  toggleFlagTitle: { en: "Toggle CPA flag", vi: "Bật/tắt cờ CPA" },
  enableFlagDesc: {
    en: 'Enable "{flag}" upstream?',
    vi: 'Bật "{flag}" phía upstream?',
  },
  disableFlagDesc: {
    en: 'Disable "{flag}" upstream?',
    vi: 'Tắt "{flag}" phía upstream?',
  },
  on: { en: "on", vi: "bật" },
  off: { en: "off", vi: "tắt" },
  retryLabel: {
    en: "Retry tuning (integers 0–1000, blank = leave unchanged)",
    vi: "Tinh chỉnh retry (số nguyên 0–1000, bỏ trống = giữ nguyên)",
  },
  retryInvalid: {
    en: "Retry values must be integers between 0 and 1000",
    vi: "Giá trị retry phải là số nguyên từ 0 đến 1000",
  },
  retryTitle: { en: "Update retry tuning", vi: "Cập nhật tinh chỉnh retry" },
  retryDesc: {
    en: "Send the changed retry fields to the CPA management API?",
    vi: "Gửi các trường retry đã thay đổi tới API quản trị CPA?",
  },
  applyRetry: { en: "Apply retry tuning", vi: "Áp dụng tinh chỉnh retry" },
  proxyLabel: {
    en: "Upstream proxy URL (redirects all CPA traffic)",
    vi: "URL proxy upstream (chuyển hướng toàn bộ lưu lượng CPA)",
  },
  proxyInvalid: {
    en: "Proxy URL must be an http(s) or socks5(h) URL",
    vi: "URL proxy phải là URL http(s) hoặc socks5(h)",
  },
  setProxyTitle: { en: "Set upstream proxy URL", vi: "Đặt URL proxy upstream" },
  setProxyDesc: {
    en: "All CPA upstream traffic will go through {value}.",
    vi: "Toàn bộ lưu lượng upstream của CPA sẽ đi qua {value}.",
  },
  setProxyBtn: { en: "Set proxy URL", vi: "Đặt URL proxy" },
  clearProxyTitle: { en: "Clear upstream proxy URL", vi: "Xóa URL proxy upstream" },
  clearProxyDesc: {
    en: "CPA will connect directly again.",
    vi: "CPA sẽ kết nối trực tiếp trở lại.",
  },
  clearProxyBtn: { en: "Clear proxy URL", vi: "Xóa URL proxy" },
  strategyUpdated: {
    en: "Routing strategy updated",
    vi: "Đã cập nhật chiến lược định tuyến",
  },
  flagUpdated: { en: "Flag updated", vi: "Đã cập nhật cờ" },
  retryUpdated: {
    en: "Retry tuning updated",
    vi: "Đã cập nhật tinh chỉnh retry",
  },
  proxySet: { en: "Proxy URL set", vi: "Đã đặt URL proxy" },
  proxyCleared: { en: "Proxy URL cleared", vi: "Đã xóa URL proxy" },
} as const;

function RoutingCard() {
  const { confirm, dialog } = useConfirm();
  const t = useT(routingCopy);
  const tS = useT(cpaSharedCopy);
  const strategy = useCpaMutation(
    "PUT",
    "/api/v1/admin/cpa/routing/strategy",
    routingCopy.strategyUpdated,
  );
  const flags = useCpaMutation("PATCH", "/api/v1/admin/cpa/config/flags", routingCopy.flagUpdated);
  const retry = useCpaMutation("PUT", "/api/v1/admin/cpa/config/retry", routingCopy.retryUpdated);
  const setProxy = useCpaMutation(
    "PUT",
    "/api/v1/admin/cpa/config/proxy-url",
    routingCopy.proxySet,
  );
  const clearProxy = useCpaMutation(
    "DELETE",
    "/api/v1/admin/cpa/config/proxy-url",
    routingCopy.proxyCleared,
  );
  const [retryForm, setRetryForm] = useState<Record<RetryField, string>>({
    request_retry: "",
    max_retry_credentials: "",
    max_retry_interval: "",
  });
  const [proxyUrl, setProxyUrl] = useState("");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <Label>{t("strategyLabel")}</Label>
          <div className="flex flex-wrap gap-1.5">
            {CPA_ROUTING_STRATEGIES.map((s) => (
              <Button
                key={s}
                size="sm"
                variant="outline"
                aria-label={t("useStrategy", { strategy: s })}
                onClick={() =>
                  confirm({
                    title: t("setStrategyTitle"),
                    description: t("setStrategyDesc", { strategy: s }),
                    action: () => strategy.mutate({ strategy: s }),
                  })
                }
              >
                {s}
              </Button>
            ))}
          </div>
        </div>
        <div className="space-y-1">
          <Label>{t("flagsLabel")}</Label>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {CPA_BOOL_FLAGS.map((flag) => (
              <div key={flag} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate font-mono text-xs">{flag}</span>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={t("setFlagOn", { flag })}
                    onClick={() =>
                      confirm({
                        title: t("toggleFlagTitle"),
                        description: t("enableFlagDesc", { flag }),
                        action: () => flags.mutate({ flag, value: true }),
                      })
                    }
                  >
                    {t("on")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={t("setFlagOff", { flag })}
                    onClick={() =>
                      confirm({
                        title: t("toggleFlagTitle"),
                        description: t("disableFlagDesc", { flag }),
                        action: () => flags.mutate({ flag, value: false }),
                      })
                    }
                  >
                    {t("off")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="space-y-1">
          <Label>{t("retryLabel")}</Label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Input
              id="cpa-retry-request"
              inputMode="numeric"
              placeholder="request-retry"
              value={retryForm.request_retry}
              onChange={(e) => setRetryForm({ ...retryForm, request_retry: e.target.value })}
            />
            <Input
              id="cpa-retry-credentials"
              inputMode="numeric"
              placeholder="max-retry-credentials"
              value={retryForm.max_retry_credentials}
              onChange={(e) =>
                setRetryForm({ ...retryForm, max_retry_credentials: e.target.value })
              }
            />
            <Input
              id="cpa-retry-interval"
              inputMode="numeric"
              placeholder="max-retry-interval"
              value={retryForm.max_retry_interval}
              onChange={(e) => setRetryForm({ ...retryForm, max_retry_interval: e.target.value })}
            />
          </div>
          <Button
            size="sm"
            disabled={retry.isPending}
            onClick={() => {
              const body = retryBody(retryForm);
              if (!body) {
                toast.error(t("retryInvalid"));
                return;
              }
              confirm({
                title: t("retryTitle"),
                description: t("retryDesc"),
                action: () => retry.mutate(body),
              });
            }}
          >
            {t("applyRetry")}
          </Button>
        </div>
        <div className="space-y-1">
          <Label htmlFor="cpa-proxy-url">{t("proxyLabel")}</Label>
          <div className="flex flex-wrap gap-1.5">
            <Input
              id="cpa-proxy-url"
              className="max-w-sm"
              placeholder="http://proxy.internal:8080"
              value={proxyUrl}
              onChange={(e) => setProxyUrl(e.target.value)}
            />
            <Button
              size="sm"
              disabled={setProxy.isPending}
              onClick={() => {
                const value = proxyUrl.trim();
                if (!PROXY_URL_RE.test(value)) {
                  toast.error(t("proxyInvalid"));
                  return;
                }
                confirm({
                  title: t("setProxyTitle"),
                  description: `${t("setProxyDesc", { value })} ${tS("danger")}`,
                  action: () => setProxy.mutate({ value, confirm: true }),
                });
              }}
            >
              {t("setProxyBtn")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={clearProxy.isPending}
              onClick={() =>
                confirm({
                  title: t("clearProxyTitle"),
                  description: `${t("clearProxyDesc")} ${tS("danger")}`,
                  action: () => clearProxy.mutate({ confirm: true }),
                })
              }
            >
              {t("clearProxyBtn")}
            </Button>
          </div>
        </div>
        {dialog}
      </CardContent>
    </Card>
  );
}

// ── Client access keys (no read exists — write-only forms) ─────────────────

const keysCopy = {
  title: { en: "Client access keys", vi: "Key truy cập client" },
  secretsNote: {
    en: "Key values are secrets: they are sent upstream only and never listed back.",
    vi: "Giá trị key là thông tin bí mật: chỉ gửi lên upstream và không bao giờ hiển thị lại.",
  },
  newKeyValue: { en: "New key value", vi: "Giá trị key mới" },
  oldKeyValue: {
    en: "Old key value (rotation only)",
    vi: "Giá trị key cũ (chỉ khi xoay vòng)",
  },
  addKey: { en: "Add key", vi: "Thêm key" },
  rotateKey: { en: "Rotate key", vi: "Xoay vòng key" },
  index: { en: "Index", vi: "Chỉ mục" },
  replacementKey: { en: "Replacement key value", vi: "Giá trị key thay thế" },
  setAtIndex: { en: "Set at index", vi: "Đặt tại chỉ mục" },
  deleteKeyLabel: { en: "Key value to delete", vi: "Giá trị key cần xóa" },
  deleteKeyBtn: { en: "Delete key", vi: "Xóa key" },
  fillFields: {
    en: "Fill the key fields (non-empty key value, whole-number index)",
    vi: "Điền đủ các trường key (giá trị key khác rỗng, chỉ mục là số nguyên)",
  },
  updateTitle: { en: "Update client access keys", vi: "Cập nhật key truy cập client" },
  updateDesc: {
    en: "This rewrites CPA's access.api-keys list via the management API.",
    vi: "Thao tác này ghi đè danh sách access.api-keys của CPA qua API quản trị.",
  },
  enterDeleteKey: {
    en: "Enter the exact key value to delete",
    vi: "Nhập chính xác giá trị key cần xóa",
  },
  deleteTitle: { en: "Delete client access key", vi: "Xóa key truy cập client" },
  deleteDesc: {
    en: "The key will stop working immediately.",
    vi: "Key sẽ ngừng hoạt động ngay lập tức.",
  },
  updated: { en: "Access key updated", vi: "Đã cập nhật key truy cập" },
  deleted: { en: "Access key deleted", vi: "Đã xóa key truy cập" },
} as const;

export function ApiKeysCard() {
  const { confirm, dialog } = useConfirm();
  const t = useT(keysCopy);
  const tS = useT(cpaSharedCopy);
  const patch = useCpaMutation("PATCH", "/api/v1/admin/cpa/api-keys", keysCopy.updated);
  const del = useCpaMutation("DELETE", "/api/v1/admin/cpa/api-keys", keysCopy.deleted);
  const [keyNew, setKeyNew] = useState("");
  const [keyOld, setKeyOld] = useState("");
  const [keyIndex, setKeyIndex] = useState("");
  const [keyValue, setKeyValue] = useState("");
  const [deleteKey, setDeleteKey] = useState("");
  const runPatch = (input: Parameters<typeof apiKeyBody>[0]) => {
    const body = apiKeyBody(input);
    if (!body) {
      toast.error(t("fillFields"));
      return;
    }
    confirm({
      title: t("updateTitle"),
      description: t("updateDesc"),
      action: () => patch.mutate(body),
    });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">{t("secretsNote")}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="cpa-key-new">{t("newKeyValue")}</Label>
            <Input
              id="cpa-key-new"
              type="password"
              autoComplete="off"
              value={keyNew}
              onChange={(e) => setKeyNew(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cpa-key-old">{t("oldKeyValue")}</Label>
            <Input
              id="cpa-key-old"
              type="password"
              autoComplete="off"
              value={keyOld}
              onChange={(e) => setKeyOld(e.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            disabled={patch.isPending}
            onClick={() => runPatch({ mode: "add", key: keyNew })}
          >
            {t("addKey")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={patch.isPending}
            onClick={() => runPatch({ mode: "rotate", key: keyNew, oldKey: keyOld })}
          >
            {t("rotateKey")}
          </Button>
        </div>
        <div className="flex flex-wrap items-end gap-1.5">
          <div className="space-y-1">
            <Label htmlFor="cpa-key-index">{t("index")}</Label>
            <Input
              id="cpa-key-index"
              className="w-24"
              inputMode="numeric"
              value={keyIndex}
              onChange={(e) => setKeyIndex(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cpa-key-value">{t("replacementKey")}</Label>
            <Input
              id="cpa-key-value"
              type="password"
              autoComplete="off"
              value={keyValue}
              onChange={(e) => setKeyValue(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={patch.isPending}
            onClick={() => runPatch({ mode: "set-index", key: keyValue, index: keyIndex })}
          >
            {t("setAtIndex")}
          </Button>
        </div>
        <div className="flex flex-wrap items-end gap-1.5">
          <div className="space-y-1">
            <Label htmlFor="cpa-key-delete">{t("deleteKeyLabel")}</Label>
            <Input
              id="cpa-key-delete"
              type="password"
              autoComplete="off"
              value={deleteKey}
              onChange={(e) => setDeleteKey(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            variant="destructive"
            disabled={del.isPending}
            onClick={() => {
              const key = deleteKey.trim();
              if (!key) {
                toast.error(t("enterDeleteKey"));
                return;
              }
              confirm({
                title: t("deleteTitle"),
                description: `${t("deleteDesc")} ${tS("danger")}`,
                action: () => del.mutate({ key, confirm: true }),
              });
            }}
          >
            {t("deleteKeyBtn")}
          </Button>
        </div>
        {dialog}
      </CardContent>
    </Card>
  );
}

// ── Auth files (no read exists — write-only forms) ─────────────────────────

const authFilesCopy = {
  title: { en: "Auth files (credentials)", vi: "Tệp xác thực (credential)" },
  authName: { en: "Auth-file name", vi: "Tên auth-file" },
  authIndex: { en: "Auth index (optional)", vi: "Chỉ mục auth (không bắt buộc)" },
  disableAuth: { en: "Disable auth file", vi: "Vô hiệu hóa auth-file" },
  enableAuth: { en: "Enable auth file", vi: "Kích hoạt auth-file" },
  enterName: { en: "Enter the auth-file name first", vi: "Nhập tên auth-file trước" },
  disableTitle: { en: "Disable auth file", vi: "Vô hiệu hóa auth-file" },
  enableTitle: { en: "Enable auth file", vi: "Kích hoạt auth-file" },
  disableDesc: {
    en: 'Disable "{name}" on the CPA management API?',
    vi: 'Vô hiệu hóa "{name}" trên API quản trị CPA?',
  },
  enableDesc: {
    en: 'Enable "{name}" on the CPA management API?',
    vi: 'Kích hoạt "{name}" trên API quản trị CPA?',
  },
  fieldsLabel: {
    en: 'Metadata fields (JSON object, e.g. {"project_id": "…"})',
    vi: 'Trường metadata (đối tượng JSON, ví dụ {"project_id": "…"})',
  },
  patchFields: { en: "Patch auth fields", vi: "Cập nhật trường metadata" },
  fieldsInvalid: {
    en: "Fields must be a JSON object with 1–32 keys",
    vi: "Trường metadata phải là đối tượng JSON với 1–32 khóa",
  },
  patchTitle: { en: "Patch auth-file fields", vi: "Cập nhật trường metadata auth-file" },
  patchDesc: {
    en: 'Update metadata fields on "{name}"? CPA validates the field names.',
    vi: 'Cập nhật trường metadata trên "{name}"? CPA sẽ kiểm tra tên trường.',
  },
  deleteLabel: {
    en: "Auth files to delete (one name per line)",
    vi: "Auth files cần xóa (mỗi tên một dòng)",
  },
  deleteBtn: { en: "Delete auth files", vi: "Xóa auth files" },
  namesInvalid: {
    en: "Enter 1–50 auth-file names",
    vi: "Nhập 1–50 tên auth-file",
  },
  deleteTitle: { en: "Delete auth files", vi: "Xóa auth files" },
  deleteDesc: {
    en: "Named files only (never the destructive all-files variant).",
    vi: "Chỉ các tệp được nêu tên (không bao giờ dùng biến thể xóa toàn bộ).",
  },
  refreshBtn: { en: "Refresh auth files", vi: "Làm mới auth files" },
  refreshTitle: { en: "Refresh auth files", vi: "Làm mới auth files" },
  refreshDesc: {
    en: "Ask CPA to refresh token/credential state for all auth files?",
    vi: "Yêu cầu CPA làm mới trạng thái token/credential cho tất cả auth files?",
  },
  refreshRequested: {
    en: "Auth-file refresh requested",
    vi: "Đã yêu cầu làm mới auth-file",
  },
  statusUpdated: {
    en: "Auth-file status updated",
    vi: "Đã cập nhật trạng thái auth-file",
  },
  fieldsUpdated: {
    en: "Auth-file fields updated",
    vi: "Đã cập nhật trường metadata auth-file",
  },
  deleted: { en: "Auth files deleted", vi: "Đã xóa auth files" },
} as const;

function AuthFilesCard() {
  const { confirm, dialog } = useConfirm();
  const t = useT(authFilesCopy);
  const tS = useT(cpaSharedCopy);
  const refresh = useCpaMutation(
    "POST",
    "/api/v1/admin/cpa/auth-files/refresh",
    authFilesCopy.refreshRequested,
  );
  const status = useCpaMutation(
    "PATCH",
    "/api/v1/admin/cpa/auth-files/status",
    authFilesCopy.statusUpdated,
  );
  const fields = useCpaMutation(
    "PATCH",
    "/api/v1/admin/cpa/auth-files/fields",
    authFilesCopy.fieldsUpdated,
  );
  const del = useCpaMutation("DELETE", "/api/v1/admin/cpa/auth-files", authFilesCopy.deleted);
  const [name, setName] = useState("");
  const [authIndex, setAuthIndex] = useState("");
  const [fieldsJson, setFieldsJson] = useState("");
  const [deleteNames, setDeleteNames] = useState("");
  const setStatus = (disabled: boolean) => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error(t("enterName"));
      return;
    }
    const auth_index = authIndex.trim();
    confirm({
      title: disabled ? t("disableTitle") : t("enableTitle"),
      description: disabled
        ? t("disableDesc", { name: trimmed })
        : t("enableDesc", { name: trimmed }),
      action: () =>
        status.mutate({
          name: trimmed,
          ...(auth_index ? { auth_index } : {}),
          disabled,
        }),
    });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <Label htmlFor="cpa-auth-name">{t("authName")}</Label>
          <Input
            id="cpa-auth-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="gemini-credentials.json"
          />
        </div>
        <div className="flex flex-wrap items-end gap-1.5">
          <div className="space-y-1">
            <Label htmlFor="cpa-auth-index">{t("authIndex")}</Label>
            <Input
              id="cpa-auth-index"
              className="w-28"
              value={authIndex}
              onChange={(e) => setAuthIndex(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={status.isPending}
            onClick={() => setStatus(true)}
          >
            {t("disableAuth")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={status.isPending}
            onClick={() => setStatus(false)}
          >
            {t("enableAuth")}
          </Button>
        </div>
        <div className="space-y-1">
          <Label htmlFor="cpa-auth-fields">{t("fieldsLabel")}</Label>
          <Textarea
            id="cpa-auth-fields"
            rows={3}
            className="font-mono text-xs"
            value={fieldsJson}
            onChange={(e) => setFieldsJson(e.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={fields.isPending}
            onClick={() => {
              const trimmed = name.trim();
              if (!trimmed) {
                toast.error(t("enterName"));
                return;
              }
              const parsed = parseAuthFields(fieldsJson);
              if (!parsed) {
                toast.error(t("fieldsInvalid"));
                return;
              }
              confirm({
                title: t("patchTitle"),
                description: t("patchDesc", { name: trimmed }),
                action: () => fields.mutate({ name: trimmed, fields: parsed }),
              });
            }}
          >
            {t("patchFields")}
          </Button>
        </div>
        <div className="space-y-1">
          <Label htmlFor="cpa-auth-delete">{t("deleteLabel")}</Label>
          <Textarea
            id="cpa-auth-delete"
            rows={3}
            className="font-mono text-xs"
            value={deleteNames}
            onChange={(e) => setDeleteNames(e.target.value)}
          />
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="destructive"
              disabled={del.isPending}
              onClick={() => {
                const names = parseAuthFileNames(deleteNames);
                if (!names) {
                  toast.error(t("namesInvalid"));
                  return;
                }
                confirm({
                  title: t("deleteTitle"),
                  description: `${t("deleteDesc")} ${tS("danger")}`,
                  action: () => del.mutate({ names, confirm: true }),
                });
              }}
            >
              {t("deleteBtn")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={refresh.isPending}
              onClick={() =>
                confirm({
                  title: t("refreshTitle"),
                  description: t("refreshDesc"),
                  action: () => refresh.mutate(undefined),
                })
              }
            >
              {t("refreshBtn")}
            </Button>
          </div>
        </div>
        {dialog}
      </CardContent>
    </Card>
  );
}

// ── CPA models (read: /cpa/models; writes: alias + exclusions) ─────────────

interface CpaModel {
  id: string;
  owned_by: string | null;
  mapped: boolean;
  mapped_public_ids?: string[];
}

/** Bilingual copy for the merged CPA models section. */
const cpaModelsCopy = {
  title: { en: "CPA models", vi: "Mô hình CPA" },
  listLabel: { en: "CPA upstream models", vi: "Mô hình upstream của CPA" },
  hint: {
    en: "IDs are original upstream model names; configured aliases are resolved for display.",
    vi: "ID là tên gốc của mô hình upstream; alias đã cấu hình được ánh xạ lại để hiển thị.",
  },
  loading: { en: "Loading…", vi: "Đang tải…" },
  unreachable: { en: "CPA unreachable", vi: "Không kết nối được CPA" },
  colModel: { en: "Model", vi: "Mô hình" },
  colOwnedBy: { en: "Owned by", vi: "Sở hữu bởi" },
  colMapped: { en: "Mapped", vi: "Đã ánh xạ" },
  unmapped: { en: "unmapped", vi: "chưa ánh xạ" },
  empty: { en: "No CPA models", vi: "Chưa có mô hình CPA" },
  aliasChannel: { en: "Alias channel", vi: "Kênh alias" },
  aliasesJson: {
    en: "Aliases JSON (empty array clears the channel)",
    vi: "Danh sách alias JSON (mảng rỗng xóa sạch kênh)",
  },
  enterChannel: { en: "Enter the channel first", vi: "Nhập kênh trước" },
  saveAliases: { en: "Save aliases", vi: "Lưu alias" },
  saveAliasesTitle: { en: "Save model aliases", vi: "Lưu alias mô hình" },
  saveAliasesDesc: {
    en: 'Replace all aliases for channel "{channel}"? An empty list clears the channel.',
    vi: 'Thay thế toàn bộ alias của kênh "{channel}"? Danh sách rỗng sẽ xóa sạch kênh.',
  },
  exclChannel: { en: "Exclusion channel", vi: "Kênh loại ngoại" },
  exclModels: {
    en: "Excluded models (one per line; empty clears)",
    vi: "Mô hình loại ngoại (mỗi dòng một mô hình; để trống xóa sạch)",
  },
  exclLimit: {
    en: "At most 500 excluded models per channel",
    vi: "Tối đa 500 mô hình loại ngoại mỗi kênh",
  },
  saveExclusions: { en: "Save exclusions", vi: "Lưu loại ngoại" },
  saveExclusionsTitle: { en: "Save model exclusions", vi: "Lưu mô hình loại ngoại" },
  saveExclusionsDesc: {
    en: 'Replace the excluded models for channel "{channel}"? An empty list clears the channel.',
    vi: 'Thay thế danh sách mô hình loại ngoại của kênh "{channel}"? Danh sách rỗng sẽ xóa sạch kênh.',
  },
  aliasesSaved: { en: "Model aliases saved", vi: "Đã lưu alias mô hình" },
  exclusionsSaved: { en: "Model exclusions saved", vi: "Đã lưu mô hình loại ngoại" },
} as const;

/**
 * Map client-visible alias/display-name IDs back to original upstream model
 * IDs, from CPA's config as returned by the redacted management proxy
 * (GET /api/v1/admin/cpa/management/config → /v0/management/config).
 *
 * Why: CPA's /v1/models list reports alias IDs once oauth model aliases are
 * configured, so the admin page would otherwise show e.g. "MiMo v2.5" instead
 * of the original "xiaomi/mimo-v2.5". Alias entries use CPA's yaml-style keys
 * ("model-alias", "display-name") — the same shape admin-cpa-mutations.ts
 * sends to PATCH /v0/management/oauth-model-alias. Secrets in the config are
 * redacted server-side; alias entries carry no secret field names.
 */
export function aliasToOriginalMap(config: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (typeof config !== "object" || config === null) return map;
  const oauth = (config as { oauth?: unknown }).oauth;
  if (typeof oauth !== "object" || oauth === null) return map;
  const raw = (oauth as Record<string, unknown>)["model-alias"];
  if (typeof raw !== "object" || raw === null) return map;
  for (const entries of Object.values(raw as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const name = e.name;
      if (typeof name !== "string" || !name) continue;
      if (typeof e.alias === "string" && e.alias && e.alias !== name) map.set(e.alias, name);
      const display = e["display-name"];
      if (typeof display === "string" && display && display !== name) map.set(display, name);
    }
  }
  return map;
}

export function ModelMappingsCard() {
  const { confirm, dialog } = useConfirm();
  const t = useT(cpaModelsCopy);
  const tS = useT(cpaSharedCopy);
  const tv = useT(aliasValidationErrorCopy);
  const models = useAdminQuery<{ data: CpaModel[] }>(
    ["admin", "cpa-models"],
    "/api/v1/admin/cpa/models",
  );
  const config = useAdminQuery<unknown>(
    ["admin", "cpa-config"],
    "/api/v1/admin/cpa/management/config",
  );
  const aliasMap = useMemo(() => aliasToOriginalMap(config.data), [config.data]);
  const resolved = useMemo(() => {
    const merged = new Map<string, CpaModel>();
    for (const model of models.data?.data ?? []) {
      const id = aliasMap.get(model.id) ?? model.id;
      const previous = merged.get(id);
      merged.set(
        id,
        previous
          ? {
              id,
              owned_by: previous.owned_by ?? model.owned_by,
              mapped: previous.mapped || model.mapped,
              mapped_public_ids: [
                ...new Set([
                  ...(previous.mapped_public_ids ?? []),
                  ...(model.mapped_public_ids ?? []),
                ]),
              ],
            }
          : { ...model, id },
      );
    }
    return [...merged.values()];
  }, [models.data, aliasMap]);
  const alias = useCpaMutation("PUT", "/api/v1/admin/cpa/model-alias", cpaModelsCopy.aliasesSaved);
  const exclusions = useCpaMutation(
    "PUT",
    "/api/v1/admin/cpa/model-exclusions",
    cpaModelsCopy.exclusionsSaved,
  );
  const [aliasChannel, setAliasChannel] = useState("");
  const [aliasJson, setAliasJson] = useState("");
  const [exclChannel, setExclChannel] = useState("");
  const [exclModels, setExclModels] = useState("");
  // Column defs for the single alias-resolved model table; headers are
  // localized, model IDs and provider values stay verbatim.
  const columns: ColumnDef<CpaModel, unknown>[] = [
    {
      accessorKey: "id",
      header: t("colModel"),
      cell: (c) => <span className="font-mono text-xs">{c.getValue() as string}</span>,
    },
    {
      accessorKey: "owned_by",
      header: t("colOwnedBy"),
      cell: (c) => (
        <span className="font-mono text-xs">{(c.getValue() as string | null) ?? "—"}</span>
      ),
    },
    {
      accessorKey: "mapped",
      header: t("colMapped"),
      cell: ({ row }) => {
        const ids = row.original.mapped_public_ids;
        return ids && ids.length > 0 ? (
          <span className="font-mono text-xs">{ids.join(", ")}</span>
        ) : (
          <Badge variant="outline">{t("unmapped")}</Badge>
        );
      },
    },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <Label>{t("listLabel")}</Label>
          {models.isPending ? (
            <p className="text-sm text-muted-foreground">{t("loading")}</p>
          ) : models.error ? (
            <p className="text-sm text-destructive">
              {models.error instanceof Error ? models.error.message : t("unreachable")}
            </p>
          ) : (
            // ScrollPanel: labelled focusable region (bilingual aria-label,
            // tabIndex for keyboard scrolling, sticky thead); className caps
            // the panel height at max-h-64 so the alias/exclusion forms below
            // stay reachable without scrolling the tab.
            <ScrollPanel label={t("listLabel")} stickyHeader className="max-h-64">
              <DataTable columns={columns} data={resolved} empty={t("empty")} />
            </ScrollPanel>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t("hint")}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="cpa-alias-channel">{t("aliasChannel")}</Label>
            <Input
              id="cpa-alias-channel"
              value={aliasChannel}
              onChange={(e) => setAliasChannel(e.target.value)}
              placeholder="gemini"
            />
            <Label htmlFor="cpa-alias-json">{t("aliasesJson")}</Label>
            <Textarea
              id="cpa-alias-json"
              rows={4}
              className="font-mono text-xs"
              value={aliasJson}
              onChange={(e) => setAliasJson(e.target.value)}
              placeholder='[{"name":"gemini-2.5-pro","alias":"pro"}]'
            />
            <Button
              size="sm"
              disabled={alias.isPending}
              onClick={() => {
                const channel = aliasChannel.trim();
                if (!channel) {
                  toast.error(t("enterChannel"));
                  return;
                }
                const parsed = parseAliasesJson(aliasJson);
                if (!parsed.ok) {
                  // English validation contract preserved; known errors map to
                  // the active locale, dynamic ones surface raw.
                  const known = parsed.error as keyof typeof aliasValidationErrorCopy;
                  toast.error(known in aliasValidationErrorCopy ? tv(known) : parsed.error);
                  return;
                }
                confirm({
                  title: t("saveAliasesTitle"),
                  description: `${t("saveAliasesDesc", { channel })} ${tS("danger")}`,
                  action: () => alias.mutate({ channel, aliases: parsed.aliases }),
                });
              }}
            >
              {t("saveAliases")}
            </Button>
          </div>
          <div className="space-y-1">
            <Label htmlFor="cpa-excl-channel">{t("exclChannel")}</Label>
            <Input
              id="cpa-excl-channel"
              value={exclChannel}
              onChange={(e) => setExclChannel(e.target.value)}
              placeholder="codex"
            />
            <Label htmlFor="cpa-excl-models">{t("exclModels")}</Label>
            <Textarea
              id="cpa-excl-models"
              rows={4}
              className="font-mono text-xs"
              value={exclModels}
              onChange={(e) => setExclModels(e.target.value)}
            />
            <Button
              size="sm"
              disabled={exclusions.isPending}
              onClick={() => {
                const channel = exclChannel.trim();
                if (!channel) {
                  toast.error(t("enterChannel"));
                  return;
                }
                const parsed = parseExclusionModels(exclModels);
                if (!parsed) {
                  toast.error(t("exclLimit"));
                  return;
                }
                confirm({
                  title: t("saveExclusionsTitle"),
                  description: `${t("saveExclusionsDesc", { channel })} ${tS("danger")}`,
                  action: () => exclusions.mutate({ channel, models: parsed }),
                });
              }}
            >
              {t("saveExclusions")}
            </Button>
          </div>
        </div>
        {dialog}
      </CardContent>
    </Card>
  );
}

const pageCopy = {
  title: { en: "CPA management", vi: "Quản trị CPA" },
  description: {
    en: "CLIProxyAPI health, config, routing, keys, credentials and model mappings.",
    vi: "Sức khỏe, cấu hình, định tuyến, key, credential và ánh xạ mô hình của CLIProxyAPI.",
  },
  sectionsAria: {
    en: "CPA management sections",
    vi: "Các phần quản trị CPA",
  },
  tabHealth: { en: "Health", vi: "Tình trạng" },
  tabConfig: { en: "Config", vi: "Cấu hình" },
  tabRouting: { en: "Routing", vi: "Định tuyến" },
  tabKeys: { en: "Access keys", vi: "Key truy cập" },
  tabAuth: { en: "Auth files", vi: "Tệp xác thực" },
  tabModels: { en: "Models", vi: "Mô hình" },
} as const;

export default function AdminCpaPage() {
  const t = useT(pageCopy);
  const health = useAdminQuery<unknown>(["admin", "cpa-health"], "/api/v1/admin/cpa/health");
  // Tabs keep each section inside a bounded scroll container so the page
  // itself never scrolls; every tab panel is keyboard-scrollable. Scroll
  // chaining is contained so an inner ScrollPanel (e.g. the CPA models list)
  // does not scroll the whole tab panel once it hits its own edge.
  const panelClass = "max-h-[calc(100vh-12rem)] space-y-4 overflow-y-auto overscroll-contain pr-1";
  const tabs: { value: string; label: string; content: React.ReactNode }[] = [
    { value: "health", label: t("tabHealth"), content: <CpaHealthCard /> },
    { value: "config", label: t("tabConfig"), content: <ConfigCard /> },
    { value: "routing", label: t("tabRouting"), content: <RoutingCard /> },
    { value: "keys", label: t("tabKeys"), content: <ApiKeysCard /> },
    { value: "auth", label: t("tabAuth"), content: <AuthFilesCard /> },
    {
      value: "models",
      label: t("tabModels"),
      content: <ModelMappingsCard />,
    },
  ];
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden">
      <PageHeader title={t("title")} description={t("description")} />
      <AdminGate query={health}>
        <Tabs defaultValue="health" className="flex min-h-0 flex-col">
          <TabsList aria-label={t("sectionsAria")}>
            {tabs.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {tabs.map((t) => (
            <TabsContent key={t.value} value={t.value} className={panelClass}>
              {t.content}
            </TabsContent>
          ))}
        </Tabs>
      </AdminGate>
    </div>
  );
}
