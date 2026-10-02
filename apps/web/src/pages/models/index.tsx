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
import { allCapabilities, allProviders, useCatalogModels, type CatalogModel } from "./data";

export default function ModelsPage() {
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
      header: "Model",
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
      header: "Provider",
      cell: ({ row }: { row: { original: CatalogModel } }) => (
        <span className="font-mono text-sm">{row.original.provider}</span>
      ),
    },
    {
      id: "capabilities",
      header: "Capabilities",
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
      header: "Input / 1M",
      cell: ({ row }: { row: { original: CatalogModel } }) => (
        <span className="font-mono text-sm">
          {formatUsdMicroPer1m(row.original.price.input_usd_micro_per_1m)}
        </span>
      ),
    },
    {
      id: "price-output",
      header: "Output / 1M",
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
        title="Models"
        description="Published models and per-1M token prices. Prices are in USD."
      />
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search models…"
          className="h-8 w-56 rounded-md border border-border bg-transparent px-2 text-sm"
        />
        <Select value={provider} onValueChange={setProvider}>
          <SelectTrigger className="h-8 w-44">
            <SelectValue placeholder="Provider" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All providers</SelectItem>
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
              <SelectValue placeholder="Capability" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All capabilities</SelectItem>
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
          title="No models are available yet"
          description={
            models.length === 0
              ? isAdmin
                ? "A model needs to be published, mapped to a provider, and priced (Admin → Pricing)."
                : "The catalog is empty — check back later."
              : "Try a different search, provider, or capability filter."
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
