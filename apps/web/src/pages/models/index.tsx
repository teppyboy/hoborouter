import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { PageHeader, DataTable, EmptyState, ErrorState } from "../../components/page";
import { Boxes } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { formatUsdMicroPer1m } from "../../lib/format";
import { useIsAdmin } from "../../components/app-shell";
// Created by shell writer; route is splat "/models/$".
import { modelHref } from "../../lib/models";
import { formatProviderLabel } from "../../lib/display";
import { allCapabilities, allProviders, useCatalogModels, type CatalogModel } from "./data";
import { useT } from "../../lib/i18n/t";

// Models catalog copy: inline LocaleEntry set (see lib/i18n/common.ts).
// Model IDs, provider names and capability values stay verbatim.
const modelsCopy = {
  modelCol: { en: "Model", vi: "Mô hình" },
  providerCol: { en: "Provider", vi: "Nhà cung cấp" },
  capabilitiesCol: { en: "Capabilities", vi: "Năng lực" },
  inputPrice: { en: "Input / 1M", vi: "Input / 1M" },
  outputPrice: { en: "Output / 1M", vi: "Output / 1M" },
  title: { en: "Models", vi: "Mô hình" },
  description: {
    en: "Published models and per-1M token prices. Prices are in USD.",
    vi: "Các mô hình đã xuất bản và giá trên 1M token. Giá tính bằng USD.",
  },
  searchPlaceholder: { en: "Search models…", vi: "Tìm mô hình…" },
  providerPlaceholder: { en: "Provider", vi: "Nhà cung cấp" },
  allProviders: { en: "All providers", vi: "Tất cả nhà cung cấp" },
  capabilityPlaceholder: { en: "Capability", vi: "Năng lực" },
  allCapabilities: { en: "All capabilities", vi: "Tất cả năng lực" },
  noneAvailable: { en: "No models are available yet", vi: "Chưa có mô hình nào" },
  noneAdmin: {
    en: "A model needs to be published, mapped to a provider, and priced (Admin → Pricing).",
    vi: "Một mô hình cần được xuất bản, ánh xạ tới nhà cung cấp và định giá (Quản trị → Định giá).",
  },
  noneEmpty: {
    en: "The catalog is empty — check back later.",
    vi: "Danh mục đang trống — vui lòng quay lại sau.",
  },
  noneFiltered: {
    en: "Try a different search, provider, or capability filter.",
    vi: "Hãy thử tìm kiếm, nhà cung cấp hoặc bộ lọc năng lực khác.",
  },
} as const;

export default function ModelsPage() {
  const t = useT(modelsCopy);
  const { models, loading, error } = useCatalogModels();
  const navigate = useNavigate();
  // Router types only register public routes (protectedRoute isn't generic), so navigate untyped.
  // SAFETY: "/models/$" is registered at runtime in router.tsx via protectedRoute;
  // its generic route types are not exposed through the Register interface.
  const openModel = (publicId: string) =>
    navigate({
      to: modelHref(publicId),
    } as unknown as Parameters<typeof navigate>[0]);
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState("all");
  const [cap, setCap] = useState("all");
  const isAdmin = useIsAdmin();

  const providers = useMemo(() => allProviders(models), [models]);
  const caps = useMemo(() => allCapabilities(models), [models]);

  const filtered = useMemo(
    () =>
      models.filter(
        (m) =>
          (provider === "all" || m.provider === provider) &&
          (cap === "all" || m.capabilities.includes(cap)) &&
          (search === "" ||
            `${m.publicId} ${m.displayName ?? ""}`.toLowerCase().includes(search.toLowerCase())),
      ),
    [models, provider, cap, search],
  );

  const columns = [
    {
      accessorKey: "publicId",
      header: t("modelCol"),
      cell: ({ row }: { row: { original: CatalogModel } }) => (
        <div>
          <button
            onClick={() => openModel(row.original.publicId)}
            className="font-mono text-sm hover:underline"
          >
            {row.original.publicId}
          </button>
          {row.original.displayName && (
            <div className="text-xs text-muted-foreground">{row.original.displayName}</div>
          )}
        </div>
      ),
    },
    {
      accessorKey: "provider",
      header: t("providerCol"),
      cell: ({ row }: { row: { original: CatalogModel } }) => (
        <span className="font-mono text-sm">{formatProviderLabel(row.original.provider)}</span>
      ),
    },
    {
      id: "capabilities",
      header: t("capabilitiesCol"),
      enableSorting: false,
      cell: ({ row }: { row: { original: CatalogModel } }) => {
        const cs = row.original.capabilities;
        if (cs.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
        return (
          <div className="flex flex-wrap gap-1">
            {cs.map((c) => (
              <Badge key={c} variant="secondary" className="font-mono text-xs">
                {c}
              </Badge>
            ))}
          </div>
        );
      },
    },
    {
      id: "price-input",
      header: t("inputPrice"),
      cell: ({ row }: { row: { original: CatalogModel } }) => (
        <span className="font-mono text-sm">
          {formatUsdMicroPer1m(row.original.price.input_usd_micro_per_1m)}
        </span>
      ),
    },
    {
      id: "price-output",
      header: t("outputPrice"),
      cell: ({ row }: { row: { original: CatalogModel } }) => (
        <span className="font-mono text-sm">
          {formatUsdMicroPer1m(row.original.price.output_usd_micro_per_1m)}
        </span>
      ),
    },
  ];

  if (error) return <ErrorState message={error} />;

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("title")}
        description={t("description")}
      />
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("searchPlaceholder")}
          className="h-8 w-56 rounded-md border border-border bg-transparent px-2 text-sm"
        />
        <Select value={provider} onValueChange={setProvider}>
          <SelectTrigger className="h-8 w-44">
            <SelectValue placeholder={t("providerPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("allProviders")}</SelectItem>
            {providers.map((p) => (
              <SelectItem key={p} value={p}>
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {caps.length > 0 && (
          <Select value={cap} onValueChange={setCap}>
            <SelectTrigger className="h-8 w-44">
              <SelectValue placeholder={t("capabilityPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("allCapabilities")}</SelectItem>
              {caps.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-9 animate-pulse rounded bg-muted" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title={t("noneAvailable")}
          description={
            models.length === 0
              ? isAdmin
                ? t("noneAdmin")
                : t("noneEmpty")
              : t("noneFiltered")
          }
        />
      ) : (
        <div className="rounded-lg border border-border">
          <DataTable columns={columns} data={filtered} />
        </div>
      )}
    </div>
  );
}
