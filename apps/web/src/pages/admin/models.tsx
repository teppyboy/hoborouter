import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { AlertTriangle, Plus } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, EmptyState, CopyButton, PageHeader } from "../../components/page";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Sheet, SheetContent } from "../../components/ui/sheet";
import { Switch } from "../../components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { api, ApiError } from "../../lib/api";
import { formatDate, formatUsdMicroPer1m } from "../../lib/format";
import { useT, type LocaleEntry } from "../../lib/i18n/t";
import {
  AdminGate,
  type AdminModel,
  parseCapabilities,
  usdPer1mToMicro,
  useAdminQuery,
} from "./shared";

// Catalog admin copy: keys name UI meaning (not the English sentence) so
// Vietnamese can follow its own syntax. Model IDs, provider names and numeric
// amounts are data — they stay untranslated at every call site.
export const adminModelsCopy = {
  title: { en: "Models", vi: "Mô hình" },
  description: {
    en: "Catalog models for this instance.",
    vi: "Các mô hình catalog của instance này.",
  },
  createModel: { en: "Create model", vi: "Tạo mô hình" },
  create: { en: "Create", vi: "Tạo" },
  save: { en: "Save", vi: "Lưu" },
  open: { en: "Open", vi: "Mở" },
  copyPublicId: { en: "Copy public ID", vi: "Sao chép Public ID" },
  createdToast: { en: "Model created", vi: "Đã tạo mô hình" },
  updatedToast: { en: "Model updated", vi: "Đã cập nhật mô hình" },
  routeSavedToast: { en: "Route saved", vi: "Đã lưu định tuyến" },
  priceRowAddedToast: { en: "Price row added", vi: "Đã thêm dòng giá" },

  // List table.
  colPublicId: { en: "Public ID", vi: "Public ID" },
  colRoutesTo: { en: "Routes to", vi: "Định tuyến tới" },
  colPrice: { en: "Price (in / out per 1M)", vi: "Giá (vào / ra mỗi 1M)" },
  colStatus: { en: "Status", vi: "Trạng thái" },
  noMapping: { en: "No mapping", vi: "Chưa có định tuyến" },
  noPrice: { en: "No price", vi: "Chưa có giá" },
  notInCpaList: {
    en: "Not in CPA's model list",
    vi: "Không có trong danh sách mô hình của CPA",
  },
  listed: { en: "Listed", vi: "Đã niêm yết" },
  hidden: { en: "Hidden", vi: "Bị ẩn" },
  hiddenDisabled: { en: "Hidden: disabled", vi: "Bị ẩn: đã tắt" },
  hiddenNotPublished: { en: "Hidden: not published", vi: "Bị ẩn: chưa xuất bản" },
  hiddenMissingRoute: { en: "Hidden: missing route", vi: "Bị ẩn: thiếu định tuyến" },
  hiddenMissingPrice: { en: "Hidden: missing price", vi: "Bị ẩn: thiếu giá" },
  hiddenReason: { en: "Hidden: {reason}", vi: "Bị ẩn: {reason}" },
  cacheBadge: { en: "cache: {mode}", vi: "cache: {mode}" },
  noModels: { en: "No models", vi: "Chưa có mô hình" },
  noModelsDescription: {
    en: "Create the first catalog model.",
    vi: "Tạo mô hình catalog đầu tiên.",
  },
  noModelsMatch: { en: "No models match", vi: "Không có mô hình khớp" },

  // Scroll-region labels (DataTable scroll prop): the accessible name of each
  // internally-scrollable table region.
  catalogScrollLabel: { en: "Catalog models", vi: "Mô hình catalog" },
  priceRowsScrollLabel: { en: "Price rows", vi: "Các dòng giá" },
  routeHistoryScrollLabel: { en: "Route history", vi: "Lịch sử định tuyến" },

  // Model sheet sections.
  modelSectionsAria: { en: "Model sections", vi: "Các phần của mô hình" },
  tabDetails: { en: "Details", vi: "Chi tiết" },
  tabRouting: { en: "Routing", vi: "Định tuyến" },
  tabPricing: { en: "Pricing", vi: "Giá" },

  // Details form.
  publicIdLabel: { en: "Public ID (what clients send)", vi: "Public ID (mà client gửi)" },
  displayNameLabel: { en: "Display name", vi: "Tên hiển thị" },
  vendorLabel: {
    en: "Vendor (shown to users)",
    vi: "Nhà cung cấp (hiển thị cho người dùng)",
  },
  descriptionLabel: { en: "Description", vi: "Mô tả" },
  capabilitiesLabel: {
    en: "Capabilities (comma-separated)",
    vi: "Khả năng (phân tách bằng dấu phẩy)",
  },
  contextWindowLabel: { en: "Context window", vi: "Cửa sổ ngữ cảnh" },
  enabledLabel: { en: "Enabled", vi: "Bật" },
  publishedLabel: { en: "Published", vi: "Xuất bản" },
  autoRoutingLabel: {
    en: "Auto routing (hoborouter/auto candidate)",
    vi: "Tự động định tuyến (ứng viên hoborouter/auto)",
  },
  promptCachingLabel: { en: "Prompt caching", vi: "Cache prompt" },
  inheritOption: { en: "Inherit (global)", vi: "Theo mặc định (toàn cục)" },
  onOption: { en: "On", vi: "Bật" },
  offOption: { en: "Off", vi: "Tắt" },
  slugPrefix: { en: "Slug:", vi: "Slug:" },
  renamingBanner: { en: "Renaming this model", vi: "Đang đổi tên mô hình này" },
  renameWarning: {
    en: "Clients and API keys' saved configs using {id} will stop working; usage history keeps the old name.",
    vi: "Các cấu hình đã lưu của client và API key dùng {id} sẽ ngừng hoạt động; lịch sử sử dụng vẫn giữ tên cũ.",
  },
  renameTo: { en: "Rename to {id}?", vi: "Đổi tên thành {id}?" },
  confirmRename: { en: "Confirm rename", vi: "Xác nhận đổi tên" },
  keepId: { en: "Keep {id}", vi: "Giữ {id}" },

  // Validation messages (zod + client checks). The English strings are
  // frozen by tests/admin-model-rename.test.tsx via RENAME_WARNING /
  // renameFieldError / schema; keep them byte-identical.
  publicIdFormat: {
    en: "Must be a lowercase slug or 'provider/name'",
    vi: "Phải là slug chữ thường hoặc 'provider/name'",
  },
  required: { en: "Required", vi: "Bắt buộc" },
  duplicatePublicId: {
    en: "Another model already uses this ID",
    vi: "Mô hình khác đã dùng ID này",
  },
  contextWindowPositive: {
    en: "Context window must be a positive integer",
    vi: "Cửa sổ ngữ cảnh phải là số nguyên dương",
  },

  // Routing section.
  routingIntro: {
    en: "Each model routes to one CPA model. CPA handles provider fallback and load balancing.",
    vi: "Mỗi mô hình định tuyến tới một mô hình CPA. CPA xử lý fallback nhà cung cấp và cân bằng tải.",
  },
  multipleRoutes: {
    en: "Multiple active routes — only the oldest is used",
    vi: "Nhiều định tuyến đang hoạt động — chỉ định tuyến cũ nhất được dùng",
  },
  keepThisOne: { en: "Keep this one", vi: "Giữ route này" },
  routeLabel: { en: "Route", vi: "Định tuyến" },
  upstreamLabel: {
    en: "Upstream model (sent to CPA)",
    vi: "Mô hình thượng nguồn (gửi tới CPA)",
  },
  providerOptionalLabel: {
    en: "Provider label (optional)",
    vi: "Nhãn nhà cung cấp (tuỳ chọn)",
  },
  labelOnlyHelp: {
    en: "Label only — requests always go to CPA.",
    vi: "Chỉ là nhãn — request luôn đi tới CPA.",
  },
  showHistory: { en: "Show route history ({count})", vi: "Xem lịch sử định tuyến ({count})" },
  hideHistory: { en: "Hide route history ({count})", vi: "Ẩn lịch sử định tuyến ({count})" },
  colUpstreamModel: { en: "Upstream model", vi: "Mô hình thượng nguồn" },
  colLabel: { en: "Label", vi: "Nhãn" },
  colAdded: { en: "Added", vi: "Đã thêm" },
  colEnabled: { en: "Enabled", vi: "Bật" },
  no: { en: "No", vi: "Không" },

  // Pricing section.
  addPrice: { en: "Add price", vi: "Thêm giá" },
  noPriceRows: { en: "No price rows yet.", vi: "Chưa có dòng giá nào." },
  colEffectiveAt: { en: "Effective at", vi: "Hiệu lực từ" },
  colInput: { en: "Input", vi: "Vào" },
  colOutput: { en: "Output", vi: "Ra" },
  colCachedInput: { en: "Cached input", vi: "Input đã cache" },
  colReasoning: { en: "Reasoning", vi: "Suy luận" },
  colMarkup: { en: "Markup", vi: "Markup" },
  currentBadge: { en: "current", vi: "hiện tại" },
  inputUsdLabel: { en: "Input USD / 1M tokens", vi: "Input USD / 1M token" },
  outputUsdLabel: { en: "Output USD / 1M tokens", vi: "Output USD / 1M token" },
  cachedInputUsdLabel: {
    en: "Cached input USD / 1M tokens",
    vi: "Input đã cache USD / 1M token",
  },
  reasoningUsdLabel: { en: "Reasoning USD / 1M tokens", vi: "Suy luận USD / 1M token" },
  markupLabel: { en: "Markup (×)", vi: "Markup (×)" },
  usdAmountError: {
    en: "{label}: enter a USD amount with up to 6 decimals",
    vi: "{label}: nhập số USD với tối đa 6 chữ số thập phân",
  },
  markupError: {
    en: "Markup must be a number like 1 or 1.25",
    vi: "Markup phải là số dạng 1 hoặc 1.25",
  },
} as const satisfies Record<string, LocaleEntry>;

export type ModelsT = (
  key: keyof typeof adminModelsCopy,
  vars?: Record<string, string | number>,
) => string;

// Matches backend PUBLIC_ID_RE: bare lowercase slug or '<provider>/<name>'.
export const PUBLIC_ID_RE = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const RENAME_WARNING = (oldPublicId: string) =>
  `Clients and API keys' saved configs using ${oldPublicId} will stop working; usage history keeps the old name.`;

export const DUPLICATE_PUBLIC_ID_MESSAGE = "Another model already uses this ID";

export const slugFromPublicId = (publicId: string) => publicId.split("/").pop() ?? publicId;

/** Map a rename failure to a field error; null means show it at form root. */
export function renameFieldError(
  code: string,
  message: string,
): { field: "public_id"; message: string } | null {
  if (code === "DUPLICATE") return { field: "public_id", message: DUPLICATE_PUBLIC_ID_MESSAGE };
  if (code === "INVALID") return { field: "public_id", message };
  return null;
}

// Schema messages are fixed English strings (frozen by
// tests/admin-model-rename.test.tsx); translate the known ones at render time.
const SCHEMA_MESSAGE_KEYS: Partial<Record<string, keyof typeof adminModelsCopy>> = {
  "Must be a lowercase slug or 'provider/name'": "publicIdFormat",
  Required: "required",
};

function formMessage(message: string | undefined, t: ModelsT): string | undefined {
  if (!message) return message;
  const key = SCHEMA_MESSAGE_KEYS[message];
  return key ? t(key) : message;
}

export const schema = z.object({
  public_id: z.string().trim().regex(PUBLIC_ID_RE, "Must be a lowercase slug or 'provider/name'"),
  display_name: z.string().min(1, "Required"),
  provider: z.string().min(1, "Required"),
  description: z.string().optional(),
  capabilities: z.string().optional(), // comma-separated
  context_window: z.string().optional(), // empty = null
  enabled: z.boolean(),
  published: z.boolean(),
  // Backend tolerates an absent auto_eligible (update keeps current value,
  // create defaults false); keep the form schema equally permissive.
  auto_eligible: z.boolean().optional(),
  prompt_caching: z.enum(["inherit", "on", "off"]),
});
type Values = z.infer<typeof schema>;

/**
 * Details-form defaults. The Postgres-backed API returns real booleans here;
 * truthy coercion (never `=== 1`) also tolerates legacy 1/0 rows.
 */
export function detailsDefaults(model: AdminModel): Values {
  return {
    public_id: model.public_id,
    display_name: model.display_name,
    provider: model.provider,
    description: model.description ?? "",
    capabilities: model.capabilities ? JSON.parse(model.capabilities).join(", ") : "",
    context_window: model.context_window == null ? "" : String(model.context_window),
    enabled: !!model.enabled,
    published: !!model.published,
    auto_eligible: !!model.auto_eligible,
    prompt_caching:
      model.prompt_caching === "on" || model.prompt_caching === "off"
        ? model.prompt_caching
        : "inherit",
  };
}

/** Price history row from GET /models/:id/prices. */
interface PriceRow {
  id: string;
  effective_at: number;
  input_usd_micro_per_1m: number;
  output_usd_micro_per_1m: number;
  cached_input_usd_micro_per_1m: number;
  reasoning_usd_micro_per_1m: number;
  markup_ppm: number;
  current: boolean;
}

/** Mapping row from GET /models/:id/mappings; id may be absent on older API. */
interface MappingRow {
  id?: string;
  provider: string;
  upstream_model: string;
  enabled: boolean;
  created_at: number;
}

/** Add-price form shared by the model sheet and the standalone Pricing page. */
export function AddPriceFields({
  modelId,
  onDone,
  onOpenChange,
}: {
  modelId: string;
  onDone: () => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const [usd, setUsd] = useState<Record<string, string>>({});
  const qc = useQueryClient();
  // Markup entered as a multiple (1 = sell at cost). 1,000,000 ppm = 1×.
  // 0 markup would make every gateway request fail (positive charge cap).
  const [markupX, setMarkupX] = useState("1");
  const [error, setError] = useState<string | null>(null);
  const PRICE_INPUTS = [
    { key: "input_usd_micro_per_1m", labelKey: "inputUsdLabel" },
    { key: "output_usd_micro_per_1m", labelKey: "outputUsdLabel" },
    { key: "cached_input_usd_micro_per_1m", labelKey: "cachedInputUsdLabel" },
    { key: "reasoning_usd_micro_per_1m", labelKey: "reasoningUsdLabel" },
  ] as const;
  const t = useT(adminModelsCopy);

  const mutation = useMutation({
    mutationFn: () => {
      const body: Record<string, number> = {};
      for (const f of PRICE_INPUTS) {
        const micro = usdPer1mToMicro(usd[f.key] ?? "");
        if (micro === null) throw new Error(t("usdAmountError", { label: t(f.labelKey) }));
        body[f.key] = micro;
      }
      const ppm = usdPer1mToMicro(markupX);
      if (ppm === null) throw new Error(t("markupError"));
      body.markup_ppm = ppm;
      return api(`/api/v1/admin/catalog/models/${modelId}/prices`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      toast(t("priceRowAddedToast"));
      void qc.invalidateQueries({ queryKey: ["admin", "prices", modelId] });
      void qc.invalidateQueries({ queryKey: ["admin", "models"] });
      setUsd({});
      setMarkupX("1");
      setError(null);
      onDone();
      onOpenChange?.(false);
    },
    onError: (e) => setError(e.message),
  });

  return (
    <form
      id={`add-price-${modelId}`}
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate();
      }}
    >
      {PRICE_INPUTS.map((f) => (
        <div key={f.key} className="grid gap-1.5">
          <Label htmlFor={`${f.key}-${modelId}`}>{t(f.labelKey)}</Label>
          <Input
            id={`${f.key}-${modelId}`}
            className="font-mono"
            inputMode="decimal"
            placeholder="0.001500"
            value={usd[f.key] ?? ""}
            onChange={(e) => setUsd((s) => ({ ...s, [f.key]: e.target.value }))}
          />
        </div>
      ))}
      <div className="grid gap-1.5">
        <Label htmlFor={`markup-${modelId}`}>{t("markupLabel")}</Label>
        <Input
          id={`markup-${modelId}`}
          className="font-mono"
          inputMode="decimal"
          value={markupX}
          onChange={(e) => setMarkupX(e.target.value)}
        />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div>
        <Button type="submit" size="sm" disabled={mutation.isPending}>
          {t("addPrice")}
        </Button>
      </div>
    </form>
  );
}

function PriceHistorySection({ model }: { model: AdminModel }) {
  const t = useT(adminModelsCopy);
  const prices = useAdminQuery<PriceRow[]>(
    ["admin", "prices", model.id],
    `/api/v1/admin/catalog/models/${model.id}/prices`,
  );
  // Built here (not module scope) so headers translate; mirrors the columns
  // pattern in admin/users.tsx.
  const priceColumns: ColumnDef<PriceRow, unknown>[] = [
    {
      header: t("colEffectiveAt"),
      accessorKey: "effective_at",
      cell: (c) => formatDate(c.getValue() as number),
    },
    {
      header: t("colInput"),
      accessorKey: "input_usd_micro_per_1m",
      cell: (c) => formatUsdMicroPer1m(c.getValue() as number),
    },
    {
      header: t("colOutput"),
      accessorKey: "output_usd_micro_per_1m",
      cell: (c) => formatUsdMicroPer1m(c.getValue() as number),
    },
    {
      header: t("colCachedInput"),
      accessorKey: "cached_input_usd_micro_per_1m",
      cell: (c) => formatUsdMicroPer1m(c.getValue() as number),
    },
    {
      header: t("colReasoning"),
      accessorKey: "reasoning_usd_micro_per_1m",
      cell: (c) => formatUsdMicroPer1m(c.getValue() as number),
    },
    {
      header: t("colMarkup"),
      accessorKey: "markup_ppm",
      cell: (c) => `${((c.getValue() as number) / 1_000_000).toFixed(2)}×`,
    },
    {
      id: "current",
      header: "",
      cell: ({ row }) => (row.original.current ? <Badge>{t("currentBadge")}</Badge> : null),
    },
  ];
  return (
    <div className="space-y-3">
      <AdminGate query={prices}>
        <DataTable
          columns={priceColumns}
          data={prices.data ?? []}
          empty={t("noPriceRows")}
          scroll={{ label: t("priceRowsScrollLabel") }}
        />
      </AdminGate>
      <h3 className="text-sm font-medium">{t("addPrice")}</h3>
      <AddPriceFields modelId={model.id} onDone={() => {}} />
    </div>
  );
}

function RoutingSection({ model }: { model: AdminModel }) {
  const t = useT(adminModelsCopy);
  const qc = useQueryClient();
  const mappings = useAdminQuery<MappingRow[]>(
    ["admin", "mappings", model.id],
    `/api/v1/admin/catalog/models/${model.id}/mappings`,
  );
  const cpaModels = useAdminQuery<{ data: { id: string }[] }>(
    ["admin", "cpa-models"],
    "/api/v1/admin/cpa/models",
  );
  const cpaIds = (cpaModels.data?.data ?? []).map((m) => m.id);
  const rows = mappings.data ?? [];
  const enabled = rows.filter((r) => r.enabled);
  const history = rows.filter((r) => !r.enabled);
  const current = enabled[0] ?? null;
  const [provider, setProvider] = useState(current?.provider ?? "");
  const [upstreamModel, setUpstreamModel] = useState(current?.upstream_model ?? "");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["admin", "mappings", model.id] });
    void qc.invalidateQueries({ queryKey: ["admin", "models"] });
  };

  const save = useMutation({
    mutationFn: () =>
      api(`/api/v1/admin/catalog/models/${model.id}/route`, {
        method: "PUT",
        body: JSON.stringify({
          ...(provider.trim() ? { provider: provider.trim() } : {}),
          upstream_model: upstreamModel.trim(),
        }),
      }),
    onSuccess: () => {
      toast(t("routeSavedToast"));
      setError(null);
      invalidate();
    },
    onError: (e) => setError(e.message),
  });

  // Data cleanup for pre-existing multi-route models: keep only the picked one.
  const keep = useMutation({
    mutationFn: (row: MappingRow) =>
      api(`/api/v1/admin/catalog/models/${model.id}/route`, {
        method: "PUT",
        body: JSON.stringify({ provider: row.provider, upstream_model: row.upstream_model }),
      }),
    onSuccess: () => {
      toast(t("routeSavedToast"));
      invalidate();
    },
    onError: (e) => toast(e.message),
  });

  if (mappings.isLoading) return null;
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t("routingIntro")}</p>
      {enabled.length > 1 && (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm">
          <p className="flex items-center gap-1 font-medium text-destructive">
            <AlertTriangle className="size-3" /> {t("multipleRoutes")}
          </p>
          <div className="mt-2 space-y-1">
            {enabled.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs">
                  {r.upstream_model} ({r.provider})
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={keep.isPending}
                  onClick={() => keep.mutate(r)}
                >
                  {t("keepThisOne")}
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
      <AdminGate query={mappings}>
        <form
          className="grid gap-3 rounded-md border border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <p className="text-sm font-medium">{t("routeLabel")}</p>
          <div className="grid gap-1.5">
            <Label htmlFor={`upstream-${model.id}`}>{t("upstreamLabel")}</Label>
            <Input
              id={`upstream-${model.id}`}
              className="font-mono"
              list={`cpa-models-${model.id}`}
              placeholder="z-ai/glm-5.3-flash"
              value={upstreamModel}
              onChange={(e) => setUpstreamModel(e.target.value)}
              required
            />
            <datalist id={`cpa-models-${model.id}`}>
              {cpaIds.map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
            {upstreamModel.trim() &&
              cpaIds.length > 0 &&
              !cpaIds.includes(upstreamModel.trim()) && (
                <p className="flex items-center gap-1 text-xs text-destructive">
                  <AlertTriangle className="size-3" /> {t("notInCpaList")}
                </p>
              )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`provider-${model.id}`}>{t("providerOptionalLabel")}</Label>
            <Input
              id={`provider-${model.id}`}
              className="font-mono"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t("labelOnlyHelp")}</p>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div>
            <Button type="submit" size="sm" disabled={save.isPending}>
              {t("save")}
            </Button>
          </div>
        </form>
      </AdminGate>
      {history.length > 0 && (
        <div>
          <Button type="button" size="sm" variant="ghost" onClick={() => setHistoryOpen((v) => !v)}>
            {historyOpen
              ? t("hideHistory", { count: history.length })
              : t("showHistory", { count: history.length })}
          </Button>
          {historyOpen && (
            <DataTable
              columns={[
                {
                  header: t("colUpstreamModel"),
                  accessorKey: "upstream_model",
                  cell: (c) => <span className="font-mono text-xs">{c.getValue() as string}</span>,
                },
                { header: t("colLabel"), accessorKey: "provider" },
                {
                  header: t("colAdded"),
                  accessorKey: "created_at",
                  cell: (c) => formatDate(c.getValue() as number),
                },
                { id: "enabled", header: t("colEnabled"), cell: () => t("no") },
              ]}
              data={history}
              empty=""
              scroll={{ label: t("routeHistoryScrollLabel") }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function DetailsSection({ model, onSaved }: { model: AdminModel; onSaved: () => void }) {
  const t = useT(adminModelsCopy);
  const qc = useQueryClient();
  const [confirmRename, setConfirmRename] = useState(false);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: detailsDefaults(model),
  });

  const mutation = useMutation({
    mutationFn: (v: Values) => {
      const ctx_window = v.context_window?.trim() ? Number(v.context_window) : null;
      if (ctx_window !== null && (!Number.isSafeInteger(ctx_window) || ctx_window <= 0))
        throw new Error(t("contextWindowPositive"));
      return api(`/api/v1/admin/catalog/models/${model.id}`, {
        method: "PUT",
        body: JSON.stringify({
          public_id: v.public_id.trim(),
          slug: slugFromPublicId(v.public_id.trim()),
          display_name: v.display_name,
          provider: v.provider,
          description: v.description || null,
          capabilities: parseCapabilities(v.capabilities ?? ""),
          context_window: ctx_window,
          enabled: v.enabled,
          published: v.published,
          auto_eligible: v.auto_eligible,
          prompt_caching: v.prompt_caching,
        }),
      });
    },
    onSuccess: () => {
      toast(t("updatedToast"));
      setConfirmRename(false);
      void qc.invalidateQueries({ queryKey: ["admin", "models"] });
      void qc.invalidateQueries({ queryKey: ["admin", "model", model.id] });
      onSaved();
    },
    onError: (e) => {
      const mapped = e instanceof ApiError ? renameFieldError(e.code, e.message) : null;
      if (mapped) {
        // The DUPLICATE message is our own fixed copy (translated); INVALID
        // passes the server's format message through as-is.
        form.setError(mapped.field, {
          message:
            mapped.message === DUPLICATE_PUBLIC_ID_MESSAGE
              ? t("duplicatePublicId")
              : mapped.message,
        });
      } else form.setError("root", { message: e.message });
    },
  });

  const publicId = form.watch("public_id").trim();
  const renamed = publicId !== model.public_id;
  const submit = form.handleSubmit((v) => {
    // Confirm step: first Save with a changed ID arms the confirm row instead
    // of saving, so an accidental rename can't happen in one click.
    if (renamed && !confirmRename) {
      setConfirmRename(true);
      return;
    }
    mutation.mutate(v);
  });

  return (
    <form onSubmit={submit} className="grid gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="public_id">{t("publicIdLabel")}</Label>
        <Input
          id="public_id"
          className="font-mono"
          {...form.register("public_id", { onChange: () => setConfirmRename(false) })}
        />
        {form.formState.errors.public_id && (
          <p className="text-xs text-destructive">
            {formMessage(form.formState.errors.public_id.message, t)}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {t("slugPrefix")} <span className="font-mono">{slugFromPublicId(publicId)}</span>
        </p>
        {renamed && (
          <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm">
            <p className="flex items-center gap-1 font-medium text-destructive">
              <AlertTriangle className="size-3" /> {t("renamingBanner")}
            </p>
            <p className="mt-1 text-destructive">{t("renameWarning", { id: model.public_id })}</p>
          </div>
        )}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="display_name">{t("displayNameLabel")}</Label>
        <Input id="display_name" {...form.register("display_name")} />
        {form.formState.errors.display_name && (
          <p className="text-xs text-destructive">
            {formMessage(form.formState.errors.display_name.message, t)}
          </p>
        )}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="provider">{t("vendorLabel")}</Label>
        <Input id="provider" className="font-mono" {...form.register("provider")} />
        {form.formState.errors.provider && (
          <p className="text-xs text-destructive">
            {formMessage(form.formState.errors.provider.message, t)}
          </p>
        )}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="description">{t("descriptionLabel")}</Label>
        <Textarea id="description" rows={2} {...form.register("description")} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="capabilities">{t("capabilitiesLabel")}</Label>
        <Input
          id="capabilities"
          placeholder="chat, tools, vision"
          {...form.register("capabilities")}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="context_window">{t("contextWindowLabel")}</Label>
        <Input id="context_window" type="number" min={1} {...form.register("context_window")} />
      </div>
      <div className="flex items-center justify-between">
        <Label htmlFor="enabled">{t("enabledLabel")}</Label>
        <Switch
          id="enabled"
          checked={form.watch("enabled")}
          onCheckedChange={(c) => form.setValue("enabled", c)}
        />
      </div>
      <div className="flex items-center justify-between">
        <Label htmlFor="published">{t("publishedLabel")}</Label>
        <Switch
          id="published"
          checked={form.watch("published")}
          onCheckedChange={(c) => form.setValue("published", c)}
        />
      </div>
      <div className="flex items-center justify-between">
        <Label htmlFor="auto_eligible">{t("autoRoutingLabel")}</Label>
        <Switch
          id="auto_eligible"
          checked={form.watch("auto_eligible")}
          onCheckedChange={(c) => form.setValue("auto_eligible", c)}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="prompt_caching">{t("promptCachingLabel")}</Label>
        <Select
          value={form.watch("prompt_caching")}
          onValueChange={(v) => form.setValue("prompt_caching", v as Values["prompt_caching"])}
        >
          <SelectTrigger id="prompt_caching">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">{t("inheritOption")}</SelectItem>
            <SelectItem value="on">{t("onOption")}</SelectItem>
            <SelectItem value="off">{t("offOption")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {form.formState.errors.root && (
        <p className="text-xs text-destructive">{form.formState.errors.root.message}</p>
      )}
      {renamed && confirmRename ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">{t("renameTo", { id: publicId })}</span>
          <Button type="submit" size="sm" disabled={mutation.isPending}>
            {t("confirmRename")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setConfirmRename(false);
              form.setValue("public_id", model.public_id);
            }}
          >
            {t("keepId", { id: model.public_id })}
          </Button>
        </div>
      ) : (
        <div>
          <Button type="submit" disabled={mutation.isPending}>
            {t("save")}
          </Button>
        </div>
      )}
    </form>
  );
}

function ModelSheet({
  model,
  open,
  onOpenChange,
}: {
  model: AdminModel;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [section, setSection] = useState<"details" | "routing" | "pricing">("details");
  const t = useT(adminModelsCopy);
  const tabs = [
    ["details", t("tabDetails")],
    ["routing", t("tabRouting")],
    ["pricing", t("tabPricing")],
  ] as const;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full max-w-xl overflow-y-auto">
        <h2 className="flex items-center gap-1 font-mono text-sm font-medium">
          {model.public_id}
          <CopyButton value={model.public_id} label={t("copyPublicId")} />
        </h2>
        <div className="flex gap-1" role="tablist" aria-label={t("modelSectionsAria")}>
          {tabs.map(([key, label]) => (
            <Button
              key={key}
              size="sm"
              variant={section === key ? "default" : "ghost"}
              onClick={() => setSection(key)}
            >
              {label}
            </Button>
          ))}
        </div>
        {section === "details" && <DetailsSection model={model} onSaved={() => {}} />}
        {section === "routing" && <RoutingSection model={model} />}
        {section === "pricing" && <PriceHistorySection model={model} />}
      </SheetContent>
    </Sheet>
  );
}

function CreateModelDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT(adminModelsCopy);
  const qc = useQueryClient();
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      public_id: "",
      display_name: "",
      provider: "",
      description: "",
      capabilities: "",
      context_window: "",
      enabled: true,
      published: false,
      auto_eligible: false,
      prompt_caching: "inherit",
    },
  });

  const mutation = useMutation({
    mutationFn: (v: Values) => {
      const ctx_window = v.context_window?.trim() ? Number(v.context_window) : null;
      if (ctx_window !== null && (!Number.isSafeInteger(ctx_window) || ctx_window <= 0))
        throw new Error(t("contextWindowPositive"));
      return api("/api/v1/admin/catalog/models", {
        method: "POST",
        body: JSON.stringify({
          public_id: v.public_id,
          slug: v.public_id.split("/").pop(),
          display_name: v.display_name,
          provider: v.provider,
          description: v.description || null,
          capabilities: parseCapabilities(v.capabilities ?? ""),
          context_window: ctx_window,
          enabled: v.enabled,
          published: v.published,
          auto_eligible: v.auto_eligible,
          prompt_caching: v.prompt_caching,
        }),
      });
    },
    onSuccess: () => {
      toast(t("createdToast"));
      void qc.invalidateQueries({ queryKey: ["admin", "models"] });
      onOpenChange(false);
    },
    onError: (e) => form.setError("root", { message: e.message }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("createModel")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit((v) => mutation.mutate(v))} className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="public_id">{t("publicIdLabel")}</Label>
            <Input
              id="public_id"
              className="font-mono"
              placeholder="hoborouter/auto"
              {...form.register("public_id")}
            />
            {form.formState.errors.public_id && (
              <p className="text-xs text-destructive">
                {formMessage(form.formState.errors.public_id.message, t)}
              </p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="display_name">{t("displayNameLabel")}</Label>
            <Input id="display_name" {...form.register("display_name")} />
            {form.formState.errors.display_name && (
              <p className="text-xs text-destructive">
                {formMessage(form.formState.errors.display_name.message, t)}
              </p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="provider">{t("vendorLabel")}</Label>
            <Input id="provider" className="font-mono" {...form.register("provider")} />
            {form.formState.errors.provider && (
              <p className="text-xs text-destructive">
                {formMessage(form.formState.errors.provider.message, t)}
              </p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="description">{t("descriptionLabel")}</Label>
            <Textarea id="description" rows={2} {...form.register("description")} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="capabilities">{t("capabilitiesLabel")}</Label>
            <Input
              id="capabilities"
              placeholder="chat, tools, vision"
              {...form.register("capabilities")}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="context_window">{t("contextWindowLabel")}</Label>
            <Input id="context_window" type="number" min={1} {...form.register("context_window")} />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="enabled">{t("enabledLabel")}</Label>
            <Switch
              id="enabled"
              checked={form.watch("enabled")}
              onCheckedChange={(c) => form.setValue("enabled", c)}
            />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="published">{t("publishedLabel")}</Label>
            <Switch
              id="published"
              checked={form.watch("published")}
              onCheckedChange={(c) => form.setValue("published", c)}
            />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="auto_eligible">{t("autoRoutingLabel")}</Label>
            <Switch
              id="auto_eligible"
              checked={form.watch("auto_eligible")}
              onCheckedChange={(c) => form.setValue("auto_eligible", c)}
            />
          </div>
          {form.formState.errors.root && (
            <p className="text-xs text-destructive">{form.formState.errors.root.message}</p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={mutation.isPending}>
              {t("create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminModelsPage() {
  const t = useT(adminModelsCopy);
  const query = useAdminQuery<AdminModel[]>(["admin", "models"], "/api/v1/admin/catalog/models");
  const cpaModels = useAdminQuery<{ data: { id: string }[] }>(
    ["admin", "cpa-models"],
    "/api/v1/admin/cpa/models",
  );
  const cpaIds = new Set((cpaModels.data?.data ?? []).map((m) => m.id));
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<AdminModel | null>(null);
  // Keep the sheet contents stable while it is open (list refetches swap objects).
  const sheetModel = selected
    ? ((query.data ?? []).find((m) => m.id === selected.id) ?? selected)
    : null;

  const columns: ColumnDef<AdminModel, unknown>[] = [
    {
      id: "public_id",
      header: t("colPublicId"),
      accessorFn: (m) => m.public_id,
      cell: ({ row }) => (
        <span className="flex flex-col">
          <span className="flex items-center gap-1 font-mono text-xs">
            {row.original.public_id}
            <CopyButton value={row.original.public_id} label={t("copyPublicId")} />
          </span>
          <span className="text-xs text-muted-foreground">{row.original.display_name}</span>
        </span>
      ),
    },
    {
      id: "routes_to",
      header: t("colRoutesTo"),
      cell: ({ row }) => {
        const m = row.original;
        const upstream = m.mapping?.upstream_model;
        const unknown = upstream !== undefined && cpaIds.size > 0 && !cpaIds.has(upstream);
        return (
          <span className="flex items-center gap-1 font-mono text-xs">
            {upstream ?? <span className="text-muted-foreground">{t("noMapping")}</span>}
            {unknown && (
              <span title={t("notInCpaList")}>
                <AlertTriangle className="size-3.5 text-destructive" />
              </span>
            )}
          </span>
        );
      },
    },
    {
      id: "price",
      header: t("colPrice"),
      cell: ({ row }) => {
        const p = row.original.current_price;
        return p ? (
          <span className="font-mono text-xs">
            {formatUsdMicroPer1m(p.input_usd_micro_per_1m)} /{" "}
            {formatUsdMicroPer1m(p.output_usd_micro_per_1m)}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">{t("noPrice")}</span>
        );
      },
    },
    {
      id: "status",
      header: t("colStatus"),
      cell: ({ row }) => {
        const m = row.original;
        const listed = !!m.listed;
        const hiddenText: Record<NonNullable<AdminModel["hidden_reason"]>, string> = {
          disabled: t("hiddenDisabled"),
          not_published: t("hiddenNotPublished"),
          missing_mapping: t("hiddenMissingRoute"),
          missing_price: t("hiddenMissingPrice"),
        };
        const hidden = listed
          ? null
          : m.hidden_reason != null
            ? (hiddenText[m.hidden_reason] ?? t("hiddenReason", { reason: m.hidden_reason }))
            : t("hidden");
        return (
          <>
            <Badge variant={hidden ? "secondary" : "default"}>{hidden ?? t("listed")}</Badge>
            {(m.prompt_caching ?? "inherit") !== "inherit" && (
              <Badge variant="outline">
                {t("cacheBadge", { mode: m.prompt_caching ?? "inherit" })}
              </Badge>
            )}
          </>
        );
      },
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      cell: ({ row }) => (
        <Button variant="ghost" size="sm" onClick={() => setSelected(row.original)}>
          {t("open")}
        </Button>
      ),
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" /> {t("createModel")}
          </Button>
        }
      />
      <AdminGate query={query}>
        {query.data && query.data.length === 0 ? (
          <EmptyState title={t("noModels")} description={t("noModelsDescription")} />
        ) : (
          <DataTable
            columns={columns}
            data={query.data ?? []}
            empty={t("noModelsMatch")}
            scroll={{ label: t("catalogScrollLabel"), fill: true }}
          />
        )}
      </AdminGate>
      <CreateModelDialog open={createOpen} onOpenChange={setCreateOpen} />
      {sheetModel && (
        <ModelSheet
          model={sheetModel}
          open={!!selected}
          onOpenChange={(o) => !o && setSelected(null)}
        />
      )}
    </div>
  );
}
