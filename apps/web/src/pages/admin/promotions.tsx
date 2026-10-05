// Admin promo code management (safe subset of GET/POST/PATCH
// /api/v1/admin/promotions). Money and usage terms (amount_vnd, max_uses,
// expires_at) are fixed at creation — the PATCH boundary only accepts
// name/active, so the UI offers rename and activate/deactivate only, never
// delete and never term edits. The POST response carries the plaintext code
// exactly once; it lives in client memory only (never URL, localStorage, or
// logs) and is cleared the moment its dialog closes, so a later failure can
// never surface stale plaintext.
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
import { CopyButton, DataTable, PageHeader } from "../../components/page";
import { formatDate, formatVnd } from "../../lib/format";
import { ApiError, api } from "../../lib/api";
import { useT, type LocaleEntry } from "../../lib/i18n/t";
import { AdminGate, useAdminQuery } from "./shared";
import { parseIntVnd } from "./bundles";

export const promotionsDict = {
  title: { en: "Promo codes", vi: "Mã khuyến mãi" },
  description: {
    en: "Top-up promo codes. Amount, usage limit and expiry are fixed at creation; deactivate instead of deleting.",
    vi: "Mã khuyến mãi nạp tiền. Số tiền, giới hạn lượt dùng và hạn dùng cố định khi tạo; vô hiệu hoá thay vì xoá.",
  },
  name: { en: "Name", vi: "Tên" },
  amount: { en: "Amount (VND)", vi: "Số tiền (VND)" },
  maxUses: { en: "Max uses", vi: "Số lượt tối đa" },
  expires: { en: "Expires (optional)", vi: "Hạn dùng (tuỳ chọn)" },
  create: { en: "Create code", vi: "Tạo mã" },
  creating: { en: "Creating…", vi: "Đang tạo…" },
  errName: { en: "Enter a name.", vi: "Nhập tên." },
  errAmount: {
    en: "Enter a positive whole VND amount.",
    vi: "Nhập số tiền VND nguyên dương.",
  },
  errMaxUses: {
    en: "Enter a whole number of at least 1.",
    vi: "Nhập số nguyên từ 1 trở lên.",
  },
  errExpires: {
    en: "Expiry must be a future date.",
    vi: "Hạn dùng phải là ngày trong tương lai.",
  },
  colAmount: { en: "Amount", vi: "Số tiền" },
  colUses: { en: "Uses", vi: "Lượt dùng" },
  colExpires: { en: "Expires", vi: "Hết hạn" },
  colStatus: { en: "Status", vi: "Trạng thái" },
  colCreated: { en: "Created", vi: "Ngày tạo" },
  statusActive: { en: "Active", vi: "Đang hoạt động" },
  statusInactive: { en: "Inactive", vi: "Ngừng hoạt động" },
  rename: { en: "Rename", vi: "Đổi tên" },
  deactivate: { en: "Deactivate", vi: "Vô hiệu hoá" },
  reactivate: { en: "Reactivate", vi: "Kích hoạt lại" },
  renameA: { en: "Rename {name}", vi: "Đổi tên {name}" },
  deactivateA: { en: "Deactivate {name}", vi: "Vô hiệu hoá {name}" },
  reactivateA: { en: "Reactivate {name}", vi: "Kích hoạt lại {name}" },
  renameTitle: { en: "Rename promo", vi: "Đổi tên mã khuyến mãi" },
  immutableNote: {
    en: "Amount, usage limit and expiry are fixed at creation.",
    vi: "Số tiền, giới hạn lượt dùng và hạn dùng cố định khi tạo.",
  },
  newName: { en: "New name", vi: "Tên mới" },
  save: { en: "Save", vi: "Lưu" },
  cancel: { en: "Cancel", vi: "Huỷ" },
  codeTitle: { en: "Promo code created", vi: "Đã tạo mã khuyến mãi" },
  codeOnce: {
    en: "Copy this code now — it is shown only once and cannot be recovered.",
    vi: "Sao chép mã ngay — mã chỉ hiển thị một lần và không thể khôi phục.",
  },
  codeLabel: { en: "Promo code", vi: "Mã khuyến mãi" },
  copyA: { en: "Copy promo code", vi: "Sao chép mã khuyến mãi" },
  done: { en: "Done", vi: "Xong" },
  updated: { en: "Updated", vi: "Đã cập nhật" },
  empty: { en: "No promo codes yet", vi: "Chưa có mã khuyến mãi" },
  requestFailed: { en: "Request failed", vi: "Yêu cầu thất bại" },
} as const satisfies Record<string, LocaleEntry>;

/** Safe promo row: the API never returns code_hash or plaintext codes here. */
export interface AdminPromo {
  id: string;
  name: string;
  amount_vnd: number;
  max_uses: number;
  uses: number;
  expires_at: number | null;
  active: boolean;
  created_at: number;
}

export interface CreatePromoBody {
  name: string;
  amount_vnd: number;
  max_uses: number;
  expires_at: number | null;
}

export interface PromoFormInput {
  name: string;
  amount: string;
  maxUses: string;
  expiresDate: string;
}

export interface PromoFormState {
  valid: boolean;
  nameInvalid: boolean;
  amountInvalid: boolean;
  maxUsesInvalid: boolean;
  expiresInvalid: boolean;
  body: CreatePromoBody | null;
}

/**
 * End of the selected local day: the last moment that calendar date is still
 * in the future. Calendar rollover (e.g. 2026-02-31) is rejected, not shifted.
 */
export function promoExpiryMs(dateStr: string, now: number): number | null | "invalid" {
  const s = dateStr.trim();
  if (s === "") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return "invalid";
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = new Date(y, mo - 1, d, 23, 59, 59, 999).getTime();
  const dt = new Date(ms);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return "invalid";
  return ms > now ? ms : "invalid";
}

/** Pure create-form state shared by the form and its validation tests. */
export function promoFormState(input: PromoFormInput, now: number): PromoFormState {
  const name = input.name.trim();
  const amountN = parseIntVnd(input.amount);
  const maxUsesN = parseIntVnd(input.maxUses);
  const expiry = promoExpiryMs(input.expiresDate, now);
  const nameInvalid = name.length === 0;
  const amountInvalid = amountN === null || amountN <= 0;
  const maxUsesInvalid = maxUsesN === null || maxUsesN < 1;
  const expiresInvalid = expiry === "invalid";
  const valid = !nameInvalid && !amountInvalid && !maxUsesInvalid && !expiresInvalid;
  return {
    valid,
    nameInvalid,
    amountInvalid,
    maxUsesInvalid,
    expiresInvalid,
    body: valid
      ? {
          name,
          amount_vnd: amountN as number,
          max_uses: maxUsesN as number,
          expires_at: expiry === null ? null : (expiry as number),
        }
      : null,
  };
}

function Field({
  id,
  label,
  error,
  errorId,
  invalid,
  children,
}: {
  id: string;
  label: string;
  error: string;
  errorId: string;
  invalid: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {invalid && (
        <p id={errorId} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function RenameDialog({
  row,
  onClose,
  onSubmit,
  pending,
}: {
  row: AdminPromo | null;
  onClose: () => void;
  onSubmit: (id: string, name: string) => void;
  pending: boolean;
}) {
  const t = useT(promotionsDict);
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
          <DialogTitle>{t("renameTitle")}</DialogTitle>
          <DialogDescription>{t("immutableNote")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1">
          <Label htmlFor="promo-rename-name">{t("newName")}</Label>
          <Input
            id="promo-rename-name"
            value={value}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            className="pointer-coarse:h-11"
            onClick={() => {
              setName(null);
              onClose();
            }}
          >
            {t("cancel")}
          </Button>
          <Button
            className="pointer-coarse:h-11"
            disabled={value.trim().length === 0 || pending}
            onClick={() => {
              if (row) onSubmit(row.id, value.trim());
              setName(null);
            }}
          >
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One-time plaintext reveal. Kept in component state (memory) only. */
function CodeDialog({ code, onClose }: { code: string | null; onClose: () => void }) {
  const t = useT(promotionsDict);
  return (
    <Dialog
      open={code !== null}
      onOpenChange={(open) => {
        // Closing always clears the plaintext from memory.
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("codeTitle")}</DialogTitle>
          <DialogDescription>{t("codeOnce")}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
          <code className="min-w-0 flex-1 font-mono text-sm break-all" aria-label={t("codeLabel")}>
            {code}
          </code>
          <CopyButton value={code ?? ""} label={t("copyA")} />
        </div>
        <DialogFooter>
          <Button className="pointer-coarse:h-11" onClick={onClose}>
            {t("done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PromotionsCard({ data }: { data: AdminPromo[] }) {
  const t = useT(promotionsDict);
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [maxUses, setMaxUses] = useState("");
  const [expiresDate, setExpiresDate] = useState("");
  const [renaming, setRenaming] = useState<AdminPromo | null>(null);
  // Plaintext code lives here and nowhere else; null whenever no dialog is open.
  const [revealedCode, setRevealedCode] = useState<string | null>(null);

  const onError = (e: unknown) =>
    toast.error(e instanceof ApiError ? e.message : t("requestFailed"));

  const create = useMutation({
    mutationFn: (body: CreatePromoBody) =>
      api<{ promo: AdminPromo; code: string }>("/api/v1/admin/promotions", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: ({ code }) => {
      setRevealedCode(code);
      setName("");
      setAmount("");
      setMaxUses("");
      setExpiresDate("");
      toast.success(t("codeTitle"));
      void qc.invalidateQueries({ queryKey: ["admin", "promotions"] });
    },
    onError,
  });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { name?: string; active?: boolean } }) =>
      api<AdminPromo>(`/api/v1/admin/promotions/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      toast.success(t("updated"));
      void qc.invalidateQueries({ queryKey: ["admin", "promotions"] });
    },
    onError,
  });

  const form = promoFormState({ name, amount, maxUses, expiresDate }, Date.now());

  const columns: ColumnDef<AdminPromo, unknown>[] = [
    { accessorKey: "name", header: t("name") },
    {
      accessorKey: "amount_vnd",
      header: t("colAmount"),
      cell: (c) => <span className="font-mono text-xs">{formatVnd(c.getValue<number>())}</span>,
    },
    {
      id: "uses",
      header: t("colUses"),
      cell: (c) => (
        <span className="font-mono text-xs">
          {c.row.original.uses} / {c.row.original.max_uses}
        </span>
      ),
    },
    {
      accessorKey: "expires_at",
      header: t("colExpires"),
      cell: (c) => (
        <span className="font-mono text-xs">{formatDate(c.getValue<number | null>())}</span>
      ),
    },
    {
      accessorKey: "active",
      header: t("colStatus"),
      cell: (c) =>
        c.getValue<boolean>() ? (
          <Badge>{t("statusActive")}</Badge>
        ) : (
          <Badge variant="secondary">{t("statusInactive")}</Badge>
        ),
    },
    {
      accessorKey: "created_at",
      header: t("colCreated"),
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
            <Button
              size="sm"
              variant="outline"
              className="pointer-coarse:h-11"
              aria-label={t("renameA", { name: row.name })}
              onClick={() => setRenaming(row)}
            >
              {t("rename")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="pointer-coarse:h-11"
              aria-label={
                row.active
                  ? t("deactivateA", { name: row.name })
                  : t("reactivateA", { name: row.name })
              }
              disabled={update.isPending}
              onClick={() => {
                if (!update.isPending) update.mutate({ id: row.id, body: { active: !row.active } });
              }}
            >
              {row.active ? t("deactivate") : t("reactivate")}
            </Button>
          </span>
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
        <form
          className="grid gap-3 sm:grid-cols-5 sm:items-start"
          onSubmit={(e) => {
            e.preventDefault();
            if (form.body && !create.isPending) create.mutate(form.body);
          }}
        >
          <Field
            id="promo-name"
            label={t("name")}
            error={t("errName")}
            errorId="promo-name-error"
            invalid={form.nameInvalid}
          >
            <Input
              id="promo-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="SUMMER2026"
              aria-invalid={form.nameInvalid}
              aria-describedby={form.nameInvalid ? "promo-name-error" : undefined}
              className={form.nameInvalid ? "border-destructive" : undefined}
            />
          </Field>
          <Field
            id="promo-amount"
            label={t("amount")}
            error={t("errAmount")}
            errorId="promo-amount-error"
            invalid={form.amountInvalid}
          >
            <Input
              id="promo-amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="500000"
              inputMode="numeric"
              aria-invalid={form.amountInvalid}
              aria-describedby={form.amountInvalid ? "promo-amount-error" : undefined}
              className={form.amountInvalid ? "border-destructive" : undefined}
            />
          </Field>
          <Field
            id="promo-max-uses"
            label={t("maxUses")}
            error={t("errMaxUses")}
            errorId="promo-max-uses-error"
            invalid={form.maxUsesInvalid}
          >
            <Input
              id="promo-max-uses"
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value)}
              placeholder="10"
              inputMode="numeric"
              aria-invalid={form.maxUsesInvalid}
              aria-describedby={form.maxUsesInvalid ? "promo-max-uses-error" : undefined}
              className={form.maxUsesInvalid ? "border-destructive" : undefined}
            />
          </Field>
          <Field
            id="promo-expires"
            label={t("expires")}
            error={t("errExpires")}
            errorId="promo-expires-error"
            invalid={form.expiresInvalid}
          >
            <Input
              id="promo-expires"
              type="date"
              value={expiresDate}
              onChange={(e) => setExpiresDate(e.target.value)}
              aria-invalid={form.expiresInvalid}
              aria-describedby={form.expiresInvalid ? "promo-expires-error" : undefined}
              className={form.expiresInvalid ? "border-destructive" : undefined}
            />
          </Field>
          <Button
            type="submit"
            className="pointer-coarse:h-11"
            disabled={!form.valid || create.isPending}
          >
            {create.isPending ? t("creating") : t("create")}
          </Button>
        </form>
        <DataTable columns={columns} data={data} empty={t("empty")} globalFilter="" />
      </CardContent>
      <RenameDialog
        row={renaming}
        onClose={() => setRenaming(null)}
        onSubmit={(id, n) => update.mutate({ id, body: { name: n } })}
        pending={update.isPending}
      />
      <CodeDialog code={revealedCode} onClose={() => setRevealedCode(null)} />
    </Card>
  );
}

/** Pure view: no router or layout coupling; route/nav wiring lands separately. */
export default function AdminPromotionsPage() {
  const t = useT(promotionsDict);
  const query = useAdminQuery<{ data: AdminPromo[] }>(
    ["admin", "promotions"],
    "/api/v1/admin/promotions",
  );
  return (
    <div className="mx-auto w-full max-w-5xl space-y-4">
      <PageHeader title={t("title")} description={t("description")} />
      <AdminGate query={query}>
        <PromotionsCard data={query.data?.data ?? []} />
      </AdminGate>
    </div>
  );
}
