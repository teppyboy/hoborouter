export type Metric = "requests" | "tokens" | "cost" | "errors";

export interface DailyPoint {
  day: string;
  requests: number;
  tokens: number;
  spend_vnd: number;
  errors: number;
}

/** UTC day string for an epoch-ms timestamp. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Zero-fill the API's sparse daily buckets over the full window: the last
 * `days` UTC days ending today, inclusive. Buckets are UTC days (backend
 * aggregates by UTC date), so no timezone shifting here.
 */
export function zeroFillDaily(daily: DailyPoint[], days: number): DailyPoint[] {
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const out: DailyPoint[] = [];
  const now = Date.now();
  for (let i = days - 1; i >= 0; i--) {
    const day = utcDay(now - i * 86_400_000);
    out.push(
      byDay.get(day) ?? { day, requests: 0, tokens: 0, spend_vnd: 0, errors: 0 },
    );
  }
  return out;
}

/** Value for one day under the selected metric. Cost stays in VND; formatted to USD at render. */
export function metricValue(p: DailyPoint, metric: Metric): number {
  switch (metric) {
    case "requests":
      return p.requests;
    case "tokens":
      return p.tokens;
    case "cost":
      return p.spend_vnd;
    case "errors":
      return p.errors;
  }
}

export function metricSeries(daily: DailyPoint[], days: number, metric: Metric) {
  return zeroFillDaily(daily, days).map((p) => ({ label: p.day, value: metricValue(p, metric) }));
}
