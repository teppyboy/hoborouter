import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Badge } from "../../components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { DataTable, PageHeader } from "../../components/page";
import { formatDate, formatVnd } from "../../lib/format";
import { ApiError, api } from "../../lib/api";
import { AdminGate, useAdminQuery } from "./shared";

interface Bundle {
  id: string;
  name: string;
  price_vnd: number;
  credit_vnd: number;
  bonus_vnd: number;
  active: boolean;
  created_at: number;
}

interface Plan {
  id: string;
  name: string;
  price_vnd: number;
  credit_per_period_vnd: number;
  period_days: number;
  active: boolean;
  created_at: number;
}

interface CatalogRow {
  id: string;
  name: string;
  price_vnd: number;
  active: boolean;
  created_at: number;
}

/** Integer VND from a text field; null when not a safe integer. Sign is the caller's rule. */
export function parseIntVnd(raw: string): number | null {
  const s = raw.trim();
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

function useCatalogMutation(path: string, key: readonly unknown[]) {
  const qc = useQueryClient();
  const onError = (e: unknown) =>
    toast.error(e instanceof ApiError ? e.message : "Request failed");
  const create = useMutation({
    mutationFn: (body: Record<string, number | string>) =>
      api<CatalogRow>(path, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      toast("Created");
      void qc.invalidateQueries({ queryKey: key });
    },
    onError,
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { name?: string; active?: boolean } }) =>
      api<CatalogRow>(`${path}/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError,
  });
  return { create, update };
}

function CreateField({
  label,
  value,
  onChange,
  placeholder,
  invalid,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  invalid?: boolean;
}) {
  return (
    <div className="grid gap-1">
      <Label>{label}</Label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode="numeric"
        aria-invalid={invalid}
        className={invalid ? "border-destructive" : undefined}
      />
    </div>
  );
}

function RenameDialog({
  row,
  onRename,
  onClose,
}: {
  row: CatalogRow | null;
  onRename: (id: string, name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState<string | null>(null);
  const value = name ?? row?.name ?? "";
  return (
    <Dialog
      open={row !== null}
      onOpenChange={(open) => {
        if (!open) {
          setName(null);
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename</DialogTitle>
          <DialogDescription>Amounts cannot be changed after creation.</DialogDescription>
        </DialogHeader>
        <Input
          value={value}
          onChange={(e) => setName(e.target.value)}
          aria-label="New name"
          autoFocus
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={value.trim().length === 0}
            onClick={() => {
              if (row) onRename(row.id, value.trim());
              setName(null);
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CatalogTable<T extends CatalogRow>({
  data,
  detailLabel,
  detail,
  onRename,
  onSetActive,
  renaming,
  setRenaming,
}: {
  data: T[];
  detailLabel: string;
  detail: (row: T) => string;
  onRename: (id: string, name: string) => void;
  onSetActive: (row: T, active: boolean) => void;
  renaming: CatalogRow | null;
  setRenaming: (row: CatalogRow | null) => void;
}) {
  const columns: ColumnDef<T, unknown>[] = [
    { accessorKey: "name", header: "Name" },
    {
      accessorKey: "price_vnd",
      header: "Price",
      cell: (c) => (
        <span className="font-mono text-xs">{formatVnd(c.getValue<number>())}</span>
      ),
    },
    {
      id: "detail",
      header: detailLabel,
      cell: (c) => <span className="font-mono text-xs">{detail(c.row.original)}</span>,
    },
    {
      accessorKey: "active",
      header: "Status",
      cell: (c) =>
        c.getValue<boolean>() ? (
          <Badge>Active</Badge>
        ) : (
          <Badge variant="secondary">Inactive</Badge>
        ),
    },
    {
      accessorKey: "created_at",
      header: "Created",
      cell: (c) => (
        <span className="font-mono text-xs">{formatDate(new Date(c.getValue<number>()))}</span>
      ),
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      cell: (c) => {
        const row = c.row.original;
        return (
          <span className="flex flex-wrap items-center gap-1">
            <Button size="sm" variant="outline" onClick={() => setRenaming(row)}>
              Rename
            </Button>
            <Button size="sm" variant="outline" onClick={() => onSetActive(row, !row.active)}>
              {row.active ? "Deactivate" : "Reactivate"}
            </Button>
          </span>
        );
      },
    },
  ];
  return (
    <>
      <DataTable
        columns={columns}
        data={data}
        empty={`No ${detailLabel.toLowerCase()} yet`}
        globalFilter=""
      />
      <RenameDialog row={renaming} onRename={onRename} onClose={() => setRenaming(null)} />
    </>
  );
}

function BundlesCard({ query }: { query: { data?: { data: Bundle[] } } }) {
  const { create, update } = useCatalogMutation("/api/v1/admin/bundles", ["admin", "bundles"]);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [credit, setCredit] = useState("");
  const [bonus, setBonus] = useState("0");
  const [renaming, setRenaming] = useState<CatalogRow | null>(null);
  const priceN = parseIntVnd(price);
  const creditN = parseIntVnd(credit);
  const bonusN = parseIntVnd(bonus);
  const valid = name.trim().length > 0 && priceN !== null && priceN > 0 &&
    creditN !== null && creditN >= 0 && bonusN !== null && bonusN >= 0;
  const submit = () => {
    create.mutate(
      { name: name.trim(), price_vnd: priceN!, credit_vnd: creditN!, bonus_vnd: bonusN! },
      {
        onSuccess: () => {
          setName("");
          setPrice("");
          setCredit("");
          setBonus("0");
        },
      },
    );
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Credit bundles</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="grid gap-3 sm:grid-cols-5 sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) submit();
          }}
        >
          <CreateField label="Name" value={name} onChange={setName} placeholder="500k pack" />
          <CreateField
            label="Price (VND)"
            value={price}
            onChange={setPrice}
            placeholder="500000"
            invalid={price !== "" && (priceN === null || priceN <= 0)}
          />
          <CreateField
            label="Credit (VND)"
            value={credit}
            onChange={setCredit}
            placeholder="500000"
            invalid={credit !== "" && (creditN === null || creditN < 0)}
          />
          <CreateField
            label="Bonus (VND)"
            value={bonus}
            onChange={setBonus}
            placeholder="0"
            invalid={bonus !== "" && (bonusN === null || bonusN < 0)}
          />
          <Button type="submit" disabled={!valid || create.isPending}>
            {create.isPending ? "Creating…" : "Create bundle"}
          </Button>
        </form>
        <CatalogTable
          data={query.data?.data ?? []}
          detailLabel="Credit"
          detail={(b) => formatVnd(b.credit_vnd) + (b.bonus_vnd > 0 ? ` + ${formatVnd(b.bonus_vnd)} bonus` : "")}
          onRename={(id, n) => update.mutate({ id, body: { name: n } })}
          onSetActive={(row, active) => update.mutate({ id: row.id, body: { active } })}
          renaming={renaming}
          setRenaming={setRenaming}
        />
      </CardContent>
    </Card>
  );
}

function PlansCard({ query }: { query: { data?: { data: Plan[] } } }) {
  const { create, update } = useCatalogMutation(
    "/api/v1/admin/subscription-plans",
    ["admin", "subscription-plans"],
  );
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [credit, setCredit] = useState("");
  const [period, setPeriod] = useState("30");
  const [renaming, setRenaming] = useState<CatalogRow | null>(null);
  const priceN = parseIntVnd(price);
  const creditN = parseIntVnd(credit);
  const periodN = parseIntVnd(period);
  const valid = name.trim().length > 0 && priceN !== null && priceN > 0 &&
    creditN !== null && creditN >= 0 && (period === "" || (periodN !== null && periodN >= 1));
  const submit = () => {
    const body: Record<string, number | string> = {
      name: name.trim(),
      price_vnd: priceN!,
      credit_per_period_vnd: creditN!,
    };
    if (period !== "") body.period_days = periodN!;
    create.mutate(body, {
      onSuccess: () => {
        setName("");
        setPrice("");
        setCredit("");
        setPeriod("30");
      },
    });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Subscription plans</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="grid gap-3 sm:grid-cols-5 sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) submit();
          }}
        >
          <CreateField label="Name" value={name} onChange={setName} placeholder="Monthly" />
          <CreateField
            label="Price (VND)"
            value={price}
            onChange={setPrice}
            placeholder="200000"
            invalid={price !== "" && (priceN === null || priceN <= 0)}
          />
          <CreateField
            label="Credit per period (VND)"
            value={credit}
            onChange={setCredit}
            placeholder="200000"
            invalid={credit !== "" && (creditN === null || creditN < 0)}
          />
          <CreateField
            label="Period days"
            value={period}
            onChange={setPeriod}
            placeholder="30"
            invalid={period !== "" && (periodN === null || periodN < 1)}
          />
          <Button type="submit" disabled={!valid || create.isPending}>
            {create.isPending ? "Creating…" : "Create plan"}
          </Button>
        </form>
        <CatalogTable
          data={query.data?.data ?? []}
          detailLabel="Credit/period"
          detail={(p) => `${formatVnd(p.credit_per_period_vnd)} / ${p.period_days}d`}
          onRename={(id, n) => update.mutate({ id, body: { name: n } })}
          onSetActive={(row, active) => update.mutate({ id: row.id, body: { active } })}
          renaming={renaming}
          setRenaming={setRenaming}
        />
      </CardContent>
    </Card>
  );
}

export default function AdminBundlesPage() {
  const bundles = useAdminQuery<{ data: Bundle[] }>(
    ["admin", "bundles"],
    "/api/v1/admin/bundles",
  );
  const plans = useAdminQuery<{ data: Plan[] }>(
    ["admin", "subscription-plans"],
    "/api/v1/admin/subscription-plans",
  );
  return (
    <div className="mx-auto w-full max-w-5xl space-y-4">
      <PageHeader
        title="Bundles & plans"
        description="Purchasable credit bundles and subscription plans. Amounts are fixed at creation; deactivate instead of deleting."
      />
      <AdminGate query={bundles}>
        <BundlesCard query={bundles} />
      </AdminGate>
      <AdminGate query={plans}>
        <PlansCard query={plans} />
      </AdminGate>
    </div>
  );
}
