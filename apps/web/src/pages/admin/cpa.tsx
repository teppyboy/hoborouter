// Instance-admin CPA management page. Contracts mirror
// apps/api/src/routes/admin-cpa-mutations.ts (mutations) and the read surface
// that actually exists: GET /api/v1/admin/cpa/health, the redacted
// /api/v1/admin/cpa/management/config proxy, and GET /api/v1/admin/cpa/models.
// There is deliberately no list read for api keys / auth files / aliases —
// those sections are write-only forms against the mutation contracts.
// Every mutation passes through an explicit confirm dialog; secret inputs are
// write-only (type=password) and are never rendered back.
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
import { DataTable, PageHeader } from "../../components/page";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { api } from "../../lib/api";
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

type CpaMethod = "PATCH" | "PUT" | "POST" | "DELETE";

function useCpaMutation(
  method: CpaMethod,
  path: string,
  successMsg: string,
  onSuccessExtra?: () => void,
) {
  return useMutation({
    mutationFn: (body: unknown) => api(path, { method, body: JSON.stringify(body) }),
    onSuccess: () => {
      toast(successMsg);
      onSuccessExtra?.();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : `${method} ${path} failed`),
  });
}

interface ConfirmRequest {
  title: string;
  description: string;
  action: () => void;
}

/** Confirm dialog plumbing: every CPA mutation routes through `confirm(...)`. */
function useConfirm() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const confirm = (r: ConfirmRequest) => setRequest(r);
  const dialog = (
    <Dialog open={request !== null} onOpenChange={(open) => !open && setRequest(null)}>
      {request && (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm action</DialogTitle>
            <DialogDescription>{request.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRequest(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const action = request.action;
                setRequest(null);
                action();
              }}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
  return { confirm, dialog };
}

const danger = "This talks to the pinned CPA management API and cannot be undone on this page.";

// ── Health ──────────────────────────────────────────────────────────────────

interface CpaHealth {
  status: string;
  proxy_endpoint: { healthy: boolean; http_status: number };
  management_api: { healthy: boolean; http_status: number };
  latency_ms: number;
  cpa_host: string;
  checked_at: string;
}

export function CpaHealthCard() {
  const query = useAdminQuery<CpaHealth>(["admin", "cpa-health"], "/api/v1/admin/cpa/health");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">CPA health</CardTitle>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <p className="text-sm text-muted-foreground">Checking…</p>
        ) : query.error ? (
          <p className="flex items-center gap-2 text-sm text-destructive">
            <XCircle className="size-4" />
            {query.error instanceof Error ? query.error.message : "CPA unreachable"}
          </p>
        ) : (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Management API</dt>
              <dd className="flex items-center gap-1.5">
                {query.data.management_api.healthy ? (
                  <CheckCircle2 className="size-4" />
                ) : (
                  <XCircle className="size-4" />
                )}
                {query.data.management_api.healthy
                  ? `Healthy (${query.data.management_api.http_status})`
                  : `Down (${query.data.management_api.http_status})`}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Proxy endpoint</dt>
              <dd className="flex items-center gap-1.5">
                {query.data.proxy_endpoint.healthy ? (
                  <CheckCircle2 className="size-4" />
                ) : (
                  <XCircle className="size-4" />
                )}
                {query.data.proxy_endpoint.healthy
                  ? `Healthy (${query.data.proxy_endpoint.http_status})`
                  : `Down (${query.data.proxy_endpoint.http_status})`}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Check latency</dt>
              <dd className="font-mono text-xs">{query.data.latency_ms} ms</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">CPA host</dt>
              <dd className="font-mono text-xs">{query.data.cpa_host}</dd>
            </div>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

// ── Config YAML (read = redacted proxy; write = dangerous full replace) ────

function ConfigCard() {
  const { confirm, dialog } = useConfirm();
  const query = useAdminQuery<unknown>(
    ["admin", "cpa-config"],
    "/api/v1/admin/cpa/management/config",
  );
  const [yaml, setYaml] = useState("");
  const save = useCpaMutation("PUT", "/api/v1/admin/cpa/config", "Config saved", () => {
    setYaml("");
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Config</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isPending ? (
          <p className="text-sm text-muted-foreground">Loading current config…</p>
        ) : query.error ? (
          <p className="text-sm text-destructive">
            {query.error instanceof Error ? query.error.message : "Failed to load config"}
          </p>
        ) : (
          <div className="space-y-1">
            <Label htmlFor="cpa-config-current">Current (secrets redacted by the API)</Label>
            <Textarea
              id="cpa-config-current"
              readOnly
              rows={8}
              className="font-mono text-xs"
              value={JSON.stringify(query.data, null, 2)}
            />
          </div>
        )}
        <div className="space-y-1">
          <Label htmlFor="cpa-config-yaml">New config.yaml (full replace)</Label>
          <Textarea
            id="cpa-config-yaml"
            rows={8}
            className="font-mono text-xs"
            value={yaml}
            onChange={(e) => setYaml(e.target.value)}
            placeholder="port: 8317 …"
          />
        </div>
        <Button
          size="sm"
          disabled={save.isPending || yaml.trim().length === 0}
          onClick={() =>
            confirm({
              title: "Replace CPA config.yaml",
              description: `This replaces the entire upstream config file. ${danger}`,
              action: () => save.mutate({ config_yaml: yaml, confirm: true }),
            })
          }
        >
          Save config
        </Button>
        {dialog}
      </CardContent>
    </Card>
  );
}

// ── Routing strategy, flags, retry tuning, proxy URL ───────────────────────

function RoutingCard() {
  const { confirm, dialog } = useConfirm();
  const strategy = useCpaMutation(
    "PUT",
    "/api/v1/admin/cpa/routing/strategy",
    "Routing strategy updated",
  );
  const flags = useCpaMutation("PATCH", "/api/v1/admin/cpa/config/flags", "Flag updated");
  const retry = useCpaMutation("PUT", "/api/v1/admin/cpa/config/retry", "Retry tuning updated");
  const setProxy = useCpaMutation("PUT", "/api/v1/admin/cpa/config/proxy-url", "Proxy URL set");
  const clearProxy = useCpaMutation(
    "DELETE",
    "/api/v1/admin/cpa/config/proxy-url",
    "Proxy URL cleared",
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
        <CardTitle className="text-sm font-medium">Routing &amp; flags</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <Label>Credential routing strategy</Label>
          <div className="flex flex-wrap gap-1.5">
            {CPA_ROUTING_STRATEGIES.map((s) => (
              <Button
                key={s}
                size="sm"
                variant="outline"
                aria-label={`Use ${s}`}
                onClick={() =>
                  confirm({
                    title: "Set routing strategy",
                    description: `Set the CPA credential routing strategy to "${s}"?`,
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
          <Label>Boolean config flags</Label>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {CPA_BOOL_FLAGS.map((flag) => (
              <div key={flag} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate font-mono text-xs">{flag}</span>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Set ${flag} on`}
                    onClick={() =>
                      confirm({
                        title: "Toggle CPA flag",
                        description: `Enable "${flag}" upstream?`,
                        action: () => flags.mutate({ flag, value: true }),
                      })
                    }
                  >
                    on
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Set ${flag} off`}
                    onClick={() =>
                      confirm({
                        title: "Toggle CPA flag",
                        description: `Disable "${flag}" upstream?`,
                        action: () => flags.mutate({ flag, value: false }),
                      })
                    }
                  >
                    off
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="space-y-1">
          <Label>Retry tuning (integers 0–1000, blank = leave unchanged)</Label>
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
                toast.error("Retry values must be integers between 0 and 1000");
                return;
              }
              confirm({
                title: "Update retry tuning",
                description: "Send the changed retry fields to the CPA management API?",
                action: () => retry.mutate(body),
              });
            }}
          >
            Apply retry tuning
          </Button>
        </div>
        <div className="space-y-1">
          <Label htmlFor="cpa-proxy-url">Upstream proxy URL (redirects all CPA traffic)</Label>
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
                  toast.error("Proxy URL must be an http(s) or socks5(h) URL");
                  return;
                }
                confirm({
                  title: "Set upstream proxy URL",
                  description: `All CPA upstream traffic will go through ${value}. ${danger}`,
                  action: () => setProxy.mutate({ value, confirm: true }),
                });
              }}
            >
              Set proxy URL
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={clearProxy.isPending}
              onClick={() =>
                confirm({
                  title: "Clear upstream proxy URL",
                  description: `CPA will connect directly again. ${danger}`,
                  action: () => clearProxy.mutate({ confirm: true }),
                })
              }
            >
              Clear proxy URL
            </Button>
          </div>
        </div>
        {dialog}
      </CardContent>
    </Card>
  );
}

// ── Client access keys (no read exists — write-only forms) ─────────────────

export function ApiKeysCard() {
  const { confirm, dialog } = useConfirm();
  const patch = useCpaMutation("PATCH", "/api/v1/admin/cpa/api-keys", "Access key updated");
  const del = useCpaMutation("DELETE", "/api/v1/admin/cpa/api-keys", "Access key deleted");
  const [keyNew, setKeyNew] = useState("");
  const [keyOld, setKeyOld] = useState("");
  const [keyIndex, setKeyIndex] = useState("");
  const [keyValue, setKeyValue] = useState("");
  const [deleteKey, setDeleteKey] = useState("");
  const runPatch = (input: Parameters<typeof apiKeyBody>[0]) => {
    const body = apiKeyBody(input);
    if (!body) {
      toast.error("Fill the key fields (non-empty key value, whole-number index)");
      return;
    }
    confirm({
      title: "Update client access keys",
      description: "This rewrites CPA's access.api-keys list via the management API.",
      action: () => patch.mutate(body),
    });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Client access keys</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Key values are secrets: they are sent upstream only and never listed back.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="cpa-key-new">New key value</Label>
            <Input
              id="cpa-key-new"
              type="password"
              autoComplete="off"
              value={keyNew}
              onChange={(e) => setKeyNew(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cpa-key-old">Old key value (rotation only)</Label>
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
            Add key
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={patch.isPending}
            onClick={() => runPatch({ mode: "rotate", key: keyNew, oldKey: keyOld })}
          >
            Rotate key
          </Button>
        </div>
        <div className="flex flex-wrap items-end gap-1.5">
          <div className="space-y-1">
            <Label htmlFor="cpa-key-index">Index</Label>
            <Input
              id="cpa-key-index"
              className="w-24"
              inputMode="numeric"
              value={keyIndex}
              onChange={(e) => setKeyIndex(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cpa-key-value">Replacement key value</Label>
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
            Set at index
          </Button>
        </div>
        <div className="flex flex-wrap items-end gap-1.5">
          <div className="space-y-1">
            <Label htmlFor="cpa-key-delete">Key value to delete</Label>
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
                toast.error("Enter the exact key value to delete");
                return;
              }
              confirm({
                title: "Delete client access key",
                description: `The key will stop working immediately. ${danger}`,
                action: () => del.mutate({ key, confirm: true }),
              });
            }}
          >
            Delete key
          </Button>
        </div>
        {dialog}
      </CardContent>
    </Card>
  );
}

// ── Auth files (no read exists — write-only forms) ─────────────────────────

function AuthFilesCard() {
  const { confirm, dialog } = useConfirm();
  const refresh = useCpaMutation(
    "POST",
    "/api/v1/admin/cpa/auth-files/refresh",
    "Auth-file refresh requested",
  );
  const status = useCpaMutation(
    "PATCH",
    "/api/v1/admin/cpa/auth-files/status",
    "Auth-file status updated",
  );
  const fields = useCpaMutation(
    "PATCH",
    "/api/v1/admin/cpa/auth-files/fields",
    "Auth-file fields updated",
  );
  const del = useCpaMutation("DELETE", "/api/v1/admin/cpa/auth-files", "Auth files deleted");
  const [name, setName] = useState("");
  const [authIndex, setAuthIndex] = useState("");
  const [fieldsJson, setFieldsJson] = useState("");
  const [deleteNames, setDeleteNames] = useState("");
  const setStatus = (disabled: boolean) => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Enter the auth-file name first");
      return;
    }
    const auth_index = authIndex.trim();
    confirm({
      title: disabled ? "Disable auth file" : "Enable auth file",
      description: `${disabled ? "Disable" : "Enable"} "${trimmed}" on the CPA management API?`,
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
        <CardTitle className="text-sm font-medium">Auth files (credentials)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <Label htmlFor="cpa-auth-name">Auth-file name</Label>
          <Input
            id="cpa-auth-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="gemini-credentials.json"
          />
        </div>
        <div className="flex flex-wrap items-end gap-1.5">
          <div className="space-y-1">
            <Label htmlFor="cpa-auth-index">Auth index (optional)</Label>
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
            Disable auth file
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={status.isPending}
            onClick={() => setStatus(false)}
          >
            Enable auth file
          </Button>
        </div>
        <div className="space-y-1">
          <Label htmlFor="cpa-auth-fields">
            Metadata fields (JSON object, e.g. &#123;&quot;project_id&quot;: &quot;…&quot;&#125;)
          </Label>
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
                toast.error("Enter the auth-file name first");
                return;
              }
              const parsed = parseAuthFields(fieldsJson);
              if (!parsed) {
                toast.error("Fields must be a JSON object with 1–32 keys");
                return;
              }
              confirm({
                title: "Patch auth-file fields",
                description: `Update metadata fields on "${trimmed}"? CPA validates the field names.`,
                action: () => fields.mutate({ name: trimmed, fields: parsed }),
              });
            }}
          >
            Patch auth fields
          </Button>
        </div>
        <div className="space-y-1">
          <Label htmlFor="cpa-auth-delete">Auth files to delete (one name per line)</Label>
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
                  toast.error("Enter 1–50 auth-file names");
                  return;
                }
                confirm({
                  title: "Delete auth files",
                  description: `Named files only (never the destructive all-files variant). ${danger}`,
                  action: () => del.mutate({ names, confirm: true }),
                });
              }}
            >
              Delete auth files
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={refresh.isPending}
              onClick={() =>
                confirm({
                  title: "Refresh auth files",
                  description: "Ask CPA to refresh token/credential state for all auth files?",
                  action: () => refresh.mutate(undefined),
                })
              }
            >
              Refresh auth files
            </Button>
          </div>
        </div>
        {dialog}
      </CardContent>
    </Card>
  );
}

// ── CPA models table (read: /cpa/models; moved here from the System page) ──

export function CpaModelsTable() {
  const models = useAdminQuery<{ data: CpaModel[] }>(
    ["admin", "cpa-models"],
    "/api/v1/admin/cpa/models",
  );
  const columns: ColumnDef<CpaModel, unknown>[] = [
    {
      accessorKey: "id",
      header: "Model",
      cell: (c) => <span className="font-mono text-xs">{c.getValue() as string}</span>,
    },
    {
      accessorKey: "owned_by",
      header: "Owned by",
      cell: (c) => (
        <span className="font-mono text-xs">{(c.getValue() as string | null) ?? "—"}</span>
      ),
    },
    {
      accessorKey: "mapped",
      header: "Mapped",
      cell: ({ row }) => {
        const ids = row.original.mapped_public_ids;
        return ids && ids.length > 0 ? (
          <span className="font-mono text-xs">{ids.join(", ")}</span>
        ) : (
          <Badge variant="outline">unmapped</Badge>
        );
      },
    },
  ];
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-medium">CPA models</h2>
      {models.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : models.error ? (
        <p className="flex items-center gap-2 text-sm text-destructive">
          <XCircle className="size-4" />
          {models.error instanceof Error ? models.error.message : "CPA unreachable"}
        </p>
      ) : (
        <DataTable columns={columns} data={models.data.data} empty="No CPA models" />
      )}
    </div>
  );
}

// ── Model mappings (writes: alias + exclusions) ───────────────────────────

interface CpaModel {
  id: string;
  owned_by: string | null;
  mapped: boolean;
  mapped_public_ids?: string[];
}

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
  const alias = useCpaMutation("PUT", "/api/v1/admin/cpa/model-alias", "Model aliases saved");
  const exclusions = useCpaMutation(
    "PUT",
    "/api/v1/admin/cpa/model-exclusions",
    "Model exclusions saved",
  );
  const [aliasChannel, setAliasChannel] = useState("");
  const [aliasJson, setAliasJson] = useState("");
  const [exclChannel, setExclChannel] = useState("");
  const [exclModels, setExclModels] = useState("");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Model mappings</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <Label>CPA upstream models</Label>
          {models.isPending ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : models.error ? (
            <p className="text-sm text-destructive">
              {models.error instanceof Error ? models.error.message : "CPA unreachable"}
            </p>
          ) : resolved.length === 0 ? (
            <p className="text-sm text-muted-foreground">No CPA models</p>
          ) : (
            <ul className="space-y-1">
              {resolved.map((model) => (
                <li key={model.id} className="flex items-center gap-2 text-sm">
                  <span className="font-mono text-xs">{model.id}</span>
                  {model.mapped_public_ids && model.mapped_public_ids.length > 0 ? (
                    <span className="font-mono text-xs text-muted-foreground">
                      → {model.mapped_public_ids.join(", ")}
                    </span>
                  ) : (
                    <Badge variant="outline">unmapped</Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          IDs are original upstream model names; configured aliases are resolved for display.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="cpa-alias-channel">Alias channel</Label>
            <Input
              id="cpa-alias-channel"
              value={aliasChannel}
              onChange={(e) => setAliasChannel(e.target.value)}
              placeholder="gemini"
            />
            <Label htmlFor="cpa-alias-json">Aliases JSON (empty array clears the channel)</Label>
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
                  toast.error("Enter the channel first");
                  return;
                }
                const parsed = parseAliasesJson(aliasJson);
                if (!parsed.ok) {
                  toast.error(parsed.error);
                  return;
                }
                confirm({
                  title: "Save model aliases",
                  description: `Replace all aliases for channel "${channel}"? An empty list clears the channel. ${danger}`,
                  action: () => alias.mutate({ channel, aliases: parsed.aliases }),
                });
              }}
            >
              Save aliases
            </Button>
          </div>
          <div className="space-y-1">
            <Label htmlFor="cpa-excl-channel">Exclusion channel</Label>
            <Input
              id="cpa-excl-channel"
              value={exclChannel}
              onChange={(e) => setExclChannel(e.target.value)}
              placeholder="codex"
            />
            <Label htmlFor="cpa-excl-models">Excluded models (one per line; empty clears)</Label>
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
                  toast.error("Enter the channel first");
                  return;
                }
                const parsed = parseExclusionModels(exclModels);
                if (!parsed) {
                  toast.error("At most 500 excluded models per channel");
                  return;
                }
                confirm({
                  title: "Save model exclusions",
                  description: `Replace the excluded models for channel "${channel}"? An empty list clears the channel. ${danger}`,
                  action: () => exclusions.mutate({ channel, models: parsed }),
                });
              }}
            >
              Save exclusions
            </Button>
          </div>
        </div>
        {dialog}
      </CardContent>
    </Card>
  );
}

export default function AdminCpaPage() {
  const health = useAdminQuery<unknown>(["admin", "cpa-health"], "/api/v1/admin/cpa/health");
  // Tabs keep each section inside a bounded scroll container so the page
  // itself never scrolls; every tab panel is keyboard-scrollable.
  const panelClass = "max-h-[calc(100vh-12rem)] space-y-4 overflow-y-auto pr-1";
  const tabs: { value: string; label: string; content: React.ReactNode }[] = [
    { value: "health", label: "Health", content: <CpaHealthCard /> },
    { value: "config", label: "Config", content: <ConfigCard /> },
    { value: "routing", label: "Routing", content: <RoutingCard /> },
    { value: "keys", label: "Access keys", content: <ApiKeysCard /> },
    { value: "auth", label: "Auth files", content: <AuthFilesCard /> },
    {
      value: "models",
      label: "Models",
      content: (
        <>
          <CpaModelsTable />
          <ModelMappingsCard />
        </>
      ),
    },
  ];
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden">
      <PageHeader
        title="CPA management"
        description="CLIProxyAPI health, config, routing, keys, credentials and model mappings."
      />
      <AdminGate query={health}>
        <Tabs defaultValue="health" className="flex min-h-0 flex-col">
          <TabsList aria-label="CPA management sections">
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
