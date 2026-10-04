/**
 * Shared display formatting: human labels for raw API enum-ish strings.
 * All format* functions are DISPLAY-ONLY: their output must never be sent
 * back to the API or compared against machine values.
 *
 * Ledger classification/sign helpers live in
 * apps/web/src/pages/billing/ledger-display.ts.
 */

/* ------------------------------------------------------------------ */
/* Display label contract (canonical)                                  */
/* ------------------------------------------------------------------ */

const LABELS: Record<string, string> = {
  mock: "Manual",
  manual: "Manual",
  topup: "Top-up",
  top_up: "Top-up",
  succeeded: "Succeeded",
  ok: "Succeeded",
  enabled: "Enabled",
};

/** Human label for a ledger kind. */
export function formatLedgerKindLabel(kind: string): string {
  const v = kind.trim().toLowerCase();
  if (LABELS[v]) return LABELS[v];
  switch (v) {
    case "settle":
      return "Usage settle";
    case "adjustment":
      return "Adjustment";
    case "refund":
      return "Refund";
    default:
      return readable(kind);
  }
}

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  google: "Google",
  "google-vertex": "Google Vertex",
  azure: "Azure",
  bedrock: "Bedrock",
  vietqr_manual: "VietQR (manual)",
  payos: "PayOS",
};

/** Human label for a provider string; unknown providers fall back to readable text. */
export function formatProviderLabel(provider: string): string {
  const v = provider.trim().toLowerCase();
  if (LABELS[v]) return LABELS[v];
  return PROVIDER_LABELS[v] ?? readable(provider);
}

/** Human label for a request/payment/key status. */
export function formatStatusLabel(status: string): string {
  const v = status.trim().toLowerCase();
  if (LABELS[v]) return LABELS[v];
  switch (v) {
    case "error":
      return "Error";
    case "timeout":
      return "Timeout";
    default:
      return readable(status);
  }
}

const MEMO_LABELS: Record<string, string> = {
  // Canonical memos are written by the settlement path (ledger_entries.memo,
  // kind = 'adjustment'); keys are lowercase exact matches.
  "bundle bonus": "Bundle bonus",
  "first topup bonus": "First top-up bonus",
  "subscription credit": "Subscription credit",
};

/** Human label for a ledger adjustment memo; unknown memos fall back to readable text. */
export function formatLedgerMemoLabel(memo: string): string {
  const v = memo.trim().toLowerCase();
  return MEMO_LABELS[v] ?? readable(memo);
}

function readable(value: string): string {
  const v = value.trim();
  if (!v) return "—";
  const words = v.split(/[\s_-]+/).filter(Boolean);
  if (words.length === 0) return v;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}
