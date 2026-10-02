const vnd = new Intl.NumberFormat("vi-VN", {
  style: "decimal",
  maximumFractionDigits: 0,
});

/** VND integers: 20000 -> "20.000 ₫" */
export function formatVnd(amount: number | null | undefined): string {
  if (amount == null) return "—";
  return `${vnd.format(amount)} ₫`;
}

/** USD micro units per 1M tokens: 1500 -> "$0.0015" (up to 6 decimals). */
export function formatUsdMicroPer1m(micro: number | null | undefined): string {
  if (micro == null) return "—";
  const usd = micro / 1_000_000;
  const s = usd.toPrecision(6).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
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
