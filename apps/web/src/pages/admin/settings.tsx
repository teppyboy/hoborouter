import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Switch } from "../../components/ui/switch";
import { Input } from "../../components/ui/input";
import { Button } from "../../components/ui/button";
import { Label } from "../../components/ui/label";
import { PageHeader } from "../../components/page";
import { api } from "../../lib/api";
import { AdminGate, useAdminQuery } from "./shared";

interface AdminSettings {
  prompt_caching_enabled: boolean;
  first_topup_bonus_enabled: boolean;
  first_topup_bonus_amount_vnd: number | null;
  payment_timeout_minutes: number;
  payment_max_amount_vnd: number;
  payment_usd_vnd_rate: number;
}

// Server bounds (packages/payments/src/payment-settings.ts); mirrored here so
// the form blocks out-of-range input before the PUT instead of round-tripping.
const PAYMENT_TIMEOUT_MIN = 1;
const PAYMENT_TIMEOUT_MAX = 1440;

/** Digits-only positive integer; returns null for empty/non-numeric/unsafe input. */
function parsePositiveIntegerField(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function PromptCachingCard({
  query,
}: {
  query: { data?: AdminSettings; isPending: boolean; error: unknown };
}) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (enabled: boolean) =>
      api<AdminSettings>("/api/v1/admin/settings", {
        method: "PUT",
        body: JSON.stringify({ prompt_caching_enabled: enabled }),
      }),
    onSuccess: () => {
      toast("Settings saved");
      void qc.invalidateQueries({ queryKey: ["admin", "settings"] });
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Prompt caching</CardTitle>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : query.error ? (
          <p className="text-sm text-destructive">
            {query.error instanceof Error ? query.error.message : "Failed to load settings"}
          </p>
        ) : query.data ? (
          <div className="flex items-center justify-between gap-4">
            {" "}
            <div className="grid gap-1">
              <Label htmlFor="prompt_caching">Prompt caching (all models)</Label>
              <p className="text-xs text-muted-foreground">
                When off, cached tokens are billed at the full input price. Requests are sent
                unchanged; providers may still cache.
              </p>
            </div>
            <Switch
              id="prompt_caching"
              checked={query.data.prompt_caching_enabled}
              onCheckedChange={(c) => mutation.mutate(c)}
              disabled={mutation.isPending}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function FirstTopupBonusCard({
  query,
}: {
  query: { data?: AdminSettings; isPending: boolean; error: unknown };
}) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (body: Partial<AdminSettings>) =>
      api<AdminSettings>("/api/v1/admin/settings", {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      toast("Settings saved");
      setAmount(null);
      void qc.invalidateQueries({ queryKey: ["admin", "settings"] });
    },
    onError: (e) => toast.error(e.message),
  });
  const current = query.data?.first_topup_bonus_amount_vnd ?? null;
  const parsed = amount === null ? null : Number(amount.trim());
  const amountValid =
    amount === null ||
    (amount.trim() !== "" && Number.isSafeInteger(parsed) && (parsed as number) > 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">First top-up bonus</CardTitle>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : query.error ? (
          <p className="text-sm text-destructive">
            {query.error instanceof Error ? query.error.message : "Failed to load settings"}
          </p>
        ) : query.data ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="grid gap-1">
                <Label htmlFor="first_topup_bonus">Bonus on a workspace's first paid top-up</Label>
                <p className="text-xs text-muted-foreground">
                  One-time extra credit when a workspace's first top-up payment succeeds.
                </p>
              </div>
              <Switch
                id="first_topup_bonus"
                checked={query.data.first_topup_bonus_enabled}
                onCheckedChange={(c) => mutation.mutate({ first_topup_bonus_enabled: c })}
                disabled={mutation.isPending}
              />
            </div>
            <div className="flex items-end gap-2">
              <div className="grid gap-1">
                <Label htmlFor="first_topup_bonus_amount">Bonus amount (VND)</Label>
                <Input
                  id="first_topup_bonus_amount"
                  value={amount ?? (current === null ? "" : String(current))}
                  onChange={(e) => setAmount(e.target.value)}
                  inputMode="numeric"
                  placeholder="20000"
                  aria-invalid={!amountValid}
                  className={!amountValid ? "border-destructive" : undefined}
                />
              </div>
              <Button
                variant="outline"
                disabled={amount === null || !amountValid || mutation.isPending}
                onClick={() =>
                  mutation.mutate({
                    first_topup_bonus_amount_vnd: parsed as number,
                  })
                }
              >
                Save amount
              </Button>
            </div>
            {current === null && (
              <p className="text-xs text-muted-foreground">
                No valid bonus amount is configured — first top-ups get no bonus until one is set.
              </p>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * Payment controls: timeout / max top-up / USD rate. Each field saves its own
 * single-key PUT (atomic per field — the backend validates the whole body and
 * never partially persists, so one field can never corrupt another).
 */
export function PaymentControlsCard({
  query,
}: {
  query: { data?: AdminSettings; isPending: boolean; error: unknown };
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Payment controls</CardTitle>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : query.error ? (
          <p className="text-sm text-destructive">
            {query.error instanceof Error ? query.error.message : "Failed to load settings"}
          </p>
        ) : query.data ? (
          <div className="space-y-6">
            <PaymentIntegerField
              field="payment_timeout_minutes"
              label="Payment timeout (minutes)"
              hint={`Pending payments expire after this many minutes (${PAYMENT_TIMEOUT_MIN}–${PAYMENT_TIMEOUT_MAX}).`}
              placeholder="30"
              current={query.data.payment_timeout_minutes}
              min={PAYMENT_TIMEOUT_MIN}
              max={PAYMENT_TIMEOUT_MAX}
            />
            <PaymentIntegerField
              field="payment_max_amount_vnd"
              label="Max top-up amount (VND)"
              hint="Largest single top-up accepted; larger requests are rejected."
              placeholder="100000000"
              current={query.data.payment_max_amount_vnd}
            />
            <PaymentIntegerField
              field="payment_usd_vnd_rate"
              label="USD → VND rate"
              hint="VND per 1 USD; converts USD top-up input into VND credit."
              placeholder="26000"
              current={query.data.payment_usd_vnd_rate}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** One bounded integer setting with local edit state and a per-field Save. */
function PaymentIntegerField({
  field,
  label,
  hint,
  placeholder,
  current,
  min,
  max,
}: {
  field: "payment_timeout_minutes" | "payment_max_amount_vnd" | "payment_usd_vnd_rate";
  label: string;
  hint: string;
  placeholder: string;
  current: number;
  min?: number;
  max?: number;
}) {
  const qc = useQueryClient();
  const [value, setValue] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (n: number) =>
      api<AdminSettings>("/api/v1/admin/settings", {
        method: "PUT",
        body: JSON.stringify({ [field]: n }),
      }),
    onSuccess: () => {
      toast("Settings saved");
      setValue(null);
      void qc.invalidateQueries({ queryKey: ["admin", "settings"] });
    },
    onError: (e) => toast.error(e.message),
  });
  const parsed = value === null ? null : parsePositiveIntegerField(value);
  const valid =
    value === null ||
    (parsed !== null &&
      (min === undefined || parsed >= min) &&
      (max === undefined || parsed <= max));
  return (
    <div className="space-y-1">
      <Label htmlFor={field}>{label}</Label>
      <p className="text-xs text-muted-foreground">{hint}</p>
      <div className="flex items-center gap-2">
        <Input
          id={field}
          value={value ?? String(current)}
          onChange={(e) => setValue(e.target.value)}
          inputMode="numeric"
          placeholder={placeholder}
          aria-invalid={!valid}
          className={!valid ? "border-destructive" : undefined}
        />
        <Button
          variant="outline"
          disabled={value === null || !valid || mutation.isPending}
          onClick={() => parsed !== null && mutation.mutate(parsed)}
        >
          {mutation.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

export default function AdminSettingsPage() {
  const query = useAdminQuery<AdminSettings>(["admin", "settings"], "/api/v1/admin/settings");
  return (
    // No p-6: router wrapper already pads the page; double padding starves 375px phones.
    <div className="mx-auto w-full max-w-4xl">
      <PageHeader title="Instance settings" description="Global platform settings." />
      <AdminGate query={query}>
        <div className="mt-6 space-y-4">
          <PromptCachingCard query={query} />
          <FirstTopupBonusCard query={query} />
          <PaymentControlsCard query={query} />
        </div>
      </AdminGate>
    </div>
  );
}
