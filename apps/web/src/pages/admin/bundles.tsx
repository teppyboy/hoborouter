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
import { formatDate, formatUsdAmountText, formatVnd } from "../../lib/format";
import { ApiError, api } from "../../lib/api";
import { AdminGate, useAdminQuery } from "./shared";

interface Bundle {
  id: string;
  name: string;
  price_vnd: number;
  credit_vnd: number;
  bonus_vnd: number;
  /** Authored USD price text; null/absent for legacy VND-authored rows. */
  price_usd?: string | null;
  credit_usd?: string | null;
  bonus_usd?: string | null;
  active: boolean;
  created_at: number;
}

interface Plan {
  id: string;
  name: string;
  price_vnd: number;
  credit_per_period_vnd: number;
  price_usd?: string | null;
  credit_per_period_usd?: string | null;
  period_days: number;
  rate_limit_per_minute: number;
  active: boolean;
  created_at: number;
}

interface CatalogRow {
  id: string;
  name: string;
  price_vnd: number;
  price_usd?: string | null;
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

/**
 * Exact USD decimal text from a form field; null when not valid catalog
 * syntax (at most two decimals, no sign/exponent). The text is POSTed
 * verbatim — the server derives VND, never the client. Sign is the
 * caller's rule (price > 0, credit/bonus >= 0).
 */
export function parseUsdAmount(raw: string): string | null {
  const s = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return s;
}

function useCatalogMutation(path: string, key: readonly unknown[]) {
  const qc = useQueryClient();
  const onError = (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Request failed");
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
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: { name?: string; active?: boolean; rate_limit_per_minute?: number };
    }) => api<CatalogRow>(`${path}/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError,
  });
  return { create, update };
}

/** Currency mode toggle; USD is the default authoring currency, VND is legacy. */
function CurrencyToggle({
  value,
  onChange,
}: {
  value: "USD" | "VND";
  onChange: (c: "USD" | "VND") => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Currency</span>
      <div className="flex gap-1" role="group" aria-label="Catalog currency">
        {(["USD", "VND"] as const).map((c) => (
          <Button
            key={c}
            type="button"
            size="sm"
            variant={value === c ? "default" : "outline"}
            onClick={() => onChange(c)}
          >
            {c}
          </Button>
        ))}
      </div>
    </div>
  );
}

function CreateField({
  id,
  label,
  value,
  onChange,
  placeholder,
  invalid,
  decimal,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  invalid?: boolean;
  decimal?: boolean;
}) {
  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode={decimal ? "decimal" : "numeric"}
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
  extra,
}: {
  row: CatalogRow | null;
  onRename: (id: string, name: string) => void;
  onClose: () => void;
  /** Optional second editable field (plans: rate limit). */
  extra?: { label: string; value: string; onChange: (v: string) => void; invalid: boolean };
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
          id="rename-name"
          value={value}
          onChange={(e) => setName(e.target.value)}
          aria-label="New name"
          autoFocus
        />
        {extra && (
          <div className="grid gap-1">
            <Label htmlFor="rename-extra">{extra.label}</Label>
            <Input
              id="rename-extra"
              value={extra.value}
              onChange={(e) => extra.onChange(e.target.value)}
              inputMode="numeric"
              aria-invalid={extra.invalid}
              className={extra.invalid ? "border-destructive" : undefined}
            />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={value.trim().length === 0 || (extra?.invalid ?? false)}
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
  renameExtra,
}: {
  data: T[];
  detailLabel: string;
  detail: (row: T) => string;
  onRename: (id: string, name: string) => void;
  onSetActive: (row: T, active: boolean) => void;
  renaming: CatalogRow | null;
  setRenaming: (row: CatalogRow | null) => void;
  /** Optional second editable field in the rename dialog (plans: rate limit). */
  renameExtra?: { label: string; value: string; onChange: (v: string) => void; invalid: boolean };
}) {
  const columns: ColumnDef<T, unknown>[] = [
    { accessorKey: "name", header: "Name" },
    {
      accessorKey: "price_vnd",
      header: "Price",
      cell: (c) => {
        const row = c.row.original;
        if (row.price_usd) {
          // Authored USD price is the source of truth; VND shown as the
          // creation-time derived equivalent.
          return (
            <span className="font-mono text-xs">
              {formatUsdAmountText(row.price_usd)}
              <span className="block text-muted-foreground">{formatVnd(row.price_vnd)}</span>
            </span>
          );
        }
        return <span className="font-mono text-xs">{formatVnd(row.price_vnd)}</span>;
      },
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
        c.getValue<boolean>() ? <Badge>Active</Badge> : <Badge variant="secondary">Inactive</Badge>,
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
      <RenameDialog
        row={renaming}
        onRename={onRename}
        onClose={() => setRenaming(null)}
        extra={renameExtra}
      />
    </>
  );
}

function BundlesCard({ query }: { query: { data?: { data: Bundle[] } } }) {
  const { create, update } = useCatalogMutation("/api/v1/admin/bundles", ["admin", "bundles"]);
  const [currency, setCurrency] = useState<"USD" | "VND">("USD");
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [credit, setCredit] = useState("");
  const [bonus, setBonus] = useState("0");
  const [priceUsd, setPriceUsd] = useState("");
  const [creditUsd, setCreditUsd] = useState("");
  const [bonusUsd, setBonusUsd] = useState("0");
  const [renaming, setRenaming] = useState<CatalogRow | null>(null);

  const priceN = parseIntVnd(price);
  const creditN = parseIntVnd(credit);
  const bonusN = parseIntVnd(bonus);
  const priceUsdT = parseUsdAmount(priceUsd);
  const creditUsdT = parseUsdAmount(creditUsd);
  const bonusUsdT = parseUsdAmount(bonusUsd);
  const usdValid =
    name.trim().length > 0 &&
    priceUsdT !== null &&
    Number(priceUsdT) > 0 &&
    creditUsdT !== null &&
    bonusUsdT !== null;
  const vndValid =
    name.trim().length > 0 &&
    priceN !== null &&
    priceN > 0 &&
    creditN !== null &&
    creditN >= 0 &&
    bonusN !== null &&
    bonusN >= 0;
  const valid = currency === "USD" ? usdValid : vndValid;

  const reset = () => {
    setName("");
    setPrice("");
    setCredit("");
    setBonus("0");
    setPriceUsd("");
    setCreditUsd("");
    setBonusUsd("0");
  };
  const submit = () => {
    const body: Record<string, number | string> =
      currency === "USD"
        ? {
            name: name.trim(),
            price_usd: priceUsdT!,
            credit_usd: creditUsdT!,
            // Bonus defaults to "0" server-side; sent explicitly for clarity.
            bonus_usd: bonusUsdT ?? "0",
          }
        : { name: name.trim(), price_vnd: priceN!, credit_vnd: creditN!, bonus_vnd: bonusN! };
    create.mutate(body, { onSuccess: reset });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Credit bundles</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <CurrencyToggle value={currency} onChange={setCurrency} />
        <form
          className="grid gap-3 sm:grid-cols-5 sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) submit();
          }}
        >
          <CreateField
            id="bundle-name"
            label="Name"
            value={name}
            onChange={setName}
            placeholder="500k pack"
          />
          {currency === "USD" ? (
            <>
              <CreateField
                id="bundle-price-usd"
                label="Price (USD)"
                value={priceUsd}
                onChange={setPriceUsd}
                placeholder="9.99"
                decimal
                invalid={priceUsd !== "" && priceUsdT === null}
              />
              <CreateField
                id="bundle-credit-usd"
                label="Credit (USD)"
                value={creditUsd}
                onChange={setCreditUsd}
                placeholder="12"
                decimal
                invalid={creditUsd !== "" && creditUsdT === null}
              />
              <CreateField
                id="bundle-bonus-usd"
                label="Bonus (USD)"
                value={bonusUsd}
                onChange={setBonusUsd}
                placeholder="0"
                decimal
                invalid={bonusUsd !== "" && bonusUsdT === null}
              />
            </>
          ) : (
            <>
              <CreateField
                id="bundle-price-vnd"
                label="Price (VND)"
                value={price}
                onChange={setPrice}
                placeholder="500000"
                invalid={price !== "" && (priceN === null || priceN <= 0)}
              />
              <CreateField
                id="bundle-credit-vnd"
                label="Credit (VND)"
                value={credit}
                onChange={setCredit}
                placeholder="500000"
                invalid={credit !== "" && (creditN === null || creditN < 0)}
              />
              <CreateField
                id="bundle-bonus-vnd"
                label="Bonus (VND)"
                value={bonus}
                onChange={setBonus}
                placeholder="0"
                invalid={bonus !== "" && (bonusN === null || bonusN < 0)}
              />
            </>
          )}
          <Button type="submit" disabled={!valid || create.isPending}>
            {create.isPending ? "Creating…" : "Create bundle"}
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">
          USD prices are stored exactly as authored; the VND credit is derived once at creation and
          never recomputed.
        </p>
        <CatalogTable
          data={query.data?.data ?? []}
          detailLabel="Credit"
          detail={(b) => {
            if (b.credit_usd) {
              const grant =
                `${formatUsdAmountText(b.credit_usd)} credit · ${formatVnd(b.credit_vnd)} grant` +
                ` (fixed at creation)`;
              const bonusPart =
                b.bonus_usd && b.bonus_usd !== "0" && Number(b.bonus_usd) > 0
                  ? ` + ${formatUsdAmountText(b.bonus_usd)} bonus`
                  : "";
              return grant + bonusPart;
            }
            return (
              formatVnd(b.credit_vnd) +
              (b.bonus_vnd > 0 ? ` + ${formatVnd(b.bonus_vnd)} bonus` : "")
            );
          }}
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
  const { create, update } = useCatalogMutation("/api/v1/admin/subscription-plans", [
    "admin",
    "subscription-plans",
  ]);
  const [currency, setCurrency] = useState<"USD" | "VND">("USD");
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [credit, setCredit] = useState("");
  const [priceUsd, setPriceUsd] = useState("");
  const [creditUsd, setCreditUsd] = useState("");
  const [period, setPeriod] = useState("30");
  const [rateLimit, setRateLimit] = useState("15");
  const [renameLimit, setRenameLimit] = useState("");
  const [renaming, setRenaming] = useState<CatalogRow | null>(null);

  const priceN = parseIntVnd(price);
  const creditN = parseIntVnd(credit);
  const periodN = parseIntVnd(period);
  const rateN = parseIntVnd(rateLimit);
  const priceUsdT = parseUsdAmount(priceUsd);
  const creditUsdT = parseUsdAmount(creditUsd);
  const rateInvalid = (v: number | null) => v === null || v < 1 || v > 600;
  const usdValid =
    name.trim().length > 0 &&
    priceUsdT !== null &&
    Number(priceUsdT) > 0 &&
    creditUsdT !== null &&
    (period === "" || (periodN !== null && periodN >= 1)) &&
    (rateLimit === "" || !rateInvalid(rateN));
  const vndValid =
    name.trim().length > 0 &&
    priceN !== null &&
    priceN > 0 &&
    creditN !== null &&
    creditN >= 0 &&
    (period === "" || (periodN !== null && periodN >= 1)) &&
    (rateLimit === "" || !rateInvalid(rateN));
  const valid = currency === "USD" ? usdValid : vndValid;

  const reset = () => {
    setName("");
    setPrice("");
    setCredit("");
    setPriceUsd("");
    setCreditUsd("");
    setPeriod("30");
    setRateLimit("15");
  };
  const submit = () => {
    const body: Record<string, number | string> =
      currency === "USD"
        ? {
            name: name.trim(),
            price_usd: priceUsdT!,
            credit_per_period_usd: creditUsdT!,
          }
        : {
            name: name.trim(),
            price_vnd: priceN!,
            credit_per_period_vnd: creditN!,
          };
    if (period !== "") body.period_days = periodN!;
    if (rateLimit !== "") body.rate_limit_per_minute = rateN!;
    create.mutate(body, { onSuccess: reset });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Subscription plans</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <CurrencyToggle value={currency} onChange={setCurrency} />
        <form
          className="grid gap-3 sm:grid-cols-5 sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) submit();
          }}
        >
          <CreateField
            id="plan-name"
            label="Name"
            value={name}
            onChange={setName}
            placeholder="Monthly"
          />
          {currency === "USD" ? (
            <>
              <CreateField
                id="plan-price-usd"
                label="Price (USD)"
                value={priceUsd}
                onChange={setPriceUsd}
                placeholder="9.99"
                decimal
                invalid={priceUsd !== "" && priceUsdT === null}
              />
              <CreateField
                id="plan-credit-usd"
                label="Credit per period (USD)"
                value={creditUsd}
                onChange={setCreditUsd}
                placeholder="12"
                decimal
                invalid={creditUsd !== "" && creditUsdT === null}
              />
            </>
          ) : (
            <>
              <CreateField
                id="plan-price-vnd"
                label="Price (VND)"
                value={price}
                onChange={setPrice}
                placeholder="200000"
                invalid={price !== "" && (priceN === null || priceN <= 0)}
              />
              <CreateField
                id="plan-credit-vnd"
                label="Credit per period (VND)"
                value={credit}
                onChange={setCredit}
                placeholder="200000"
                invalid={credit !== "" && (creditN === null || creditN < 0)}
              />
            </>
          )}
          <CreateField
            id="plan-period"
            label="Period days"
            value={period}
            onChange={setPeriod}
            placeholder="30"
            invalid={period !== "" && (periodN === null || periodN < 1)}
          />
          <CreateField
            id="plan-rate"
            label="Rate limit (req/min)"
            value={rateLimit}
            onChange={setRateLimit}
            placeholder="15"
            invalid={rateLimit !== "" && rateInvalid(rateN)}
          />
          <Button type="submit" disabled={!valid || create.isPending}>
            {create.isPending ? "Creating…" : "Create plan"}
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">
          USD prices are stored exactly as authored; the VND credit is derived once at creation and
          never recomputed.
        </p>
        <CatalogTable
          data={query.data?.data ?? []}
          detailLabel="Credit/period"
          detail={(p) => {
            const credit = p.credit_per_period_usd
              ? `${formatUsdAmountText(p.credit_per_period_usd)} credit · ${formatVnd(
                  p.credit_per_period_vnd,
                )} grant (fixed at creation)`
              : formatVnd(p.credit_per_period_vnd);
            return `${credit} / ${p.period_days}d · ${p.rate_limit_per_minute}/min`;
          }}
          onRename={(id, n) =>
            update.mutate({
              id,
              body: { name: n, rate_limit_per_minute: parseIntVnd(renameLimit) ?? undefined },
            })
          }
          onSetActive={(row, active) => update.mutate({ id: row.id, body: { active } })}
          renaming={renaming}
          setRenaming={(row) => {
            setRenaming(row);
            setRenameLimit(row ? String((row as Plan).rate_limit_per_minute) : "");
          }}
          renameExtra={{
            label: "Rate limit (req/min)",
            value: renameLimit,
            onChange: setRenameLimit,
            invalid: rateInvalid(parseIntVnd(renameLimit)),
          }}
        />
      </CardContent>
    </Card>
  );
}

export default function AdminBundlesPage() {
  const bundles = useAdminQuery<{ data: Bundle[] }>(["admin", "bundles"], "/api/v1/admin/bundles");
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
