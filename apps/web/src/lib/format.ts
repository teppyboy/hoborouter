import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

const vnd = new Intl.NumberFormat("vi-VN", {
  style: "decimal",
  maximumFractionDigits: 0,
});

/** FX rate from the workspace wallet endpoint; undefined when unavailable (older backend) -> VND fallback. */
export function useUsdVndRate(workspaceId: string | null | undefined) {
  return useQuery({
    queryKey: ["wallet", workspaceId, "rate"],
    queryFn: () => api<{ usd_vnd_rate?: number }>(`/api/v1/workspaces/${workspaceId}/wallet`),
    select: (d) => d.usd_vnd_rate,
    enabled: !!workspaceId,
    retry: false,
    staleTime: 60_000,
  });
}

/** USD from VND using the backend-provided FX rate. Returns null when rate unavailable (fall back to VND). */
export function formatUsdFromVnd(
  vnd: number | null | undefined,
  rate: number | undefined,
): string | null {
  if (vnd == null || !rate || !Number.isFinite(rate) || rate <= 0) return null;
  const usd = vnd / rate;
  if (usd === 0) return "$0.00";
  if (Math.abs(usd) < 0.01) {
    // Tiny per-request costs: up to 6 decimals so they don't read as $0.00.
    const s = Math.abs(usd).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
    return `${usd < 0 ? "-" : ""}$${s}`;
  }
  return `${usd < 0 ? "-" : ""}$${Math.abs(usd).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** VND integers: 20000 -> "20.000 ₫" */
export function formatVnd(amount: number | null | undefined): string {
  if (amount == null) return "—";
  return `${vnd.format(amount)} ₫`;
}

/** USD micro units per 1M tokens: 1500 -> "$0.0015" (up to 6 decimals). */
export function formatUsdMicroPer1m(micro: number | null | undefined): string {
  if (micro == null) return "—";
  const usd = micro / 1_000_000;
  const s = usd
    .toPrecision(6)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
  return `$${s}`;
}

/** Compact token counts: 1234567 -> "1.23M". */
export function formatTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Timestamp (ms epoch, ISO string, or Date) -> readable date/time. */
export function formatDate(iso: string | number | Date | null | undefined): string {
  if (iso == null) return "—";
  const d = iso instanceof Date ? iso : new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : vndFormatDate(d);
}

function vndFormatDate(d: Date): string {
  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}
