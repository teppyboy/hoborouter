/**
 * Billing-local ledger classification/sign helpers for the Credits page.
 * Canonical ledger semantics (packages/db/src/schema.ts ledger_entries):
 * amount is always a positive integer; the sign lives in `direction`
 * ("debit" | "credit"). Sign is applied exactly once, here.
 */

export type LedgerDirection = "debit" | "credit";
export type LedgerKind = "topup" | "settle" | "adjustment" | "refund";

export interface LedgerLike {
  direction: LedgerDirection;
  /** Canonical kinds are topup/settle/adjustment/refund; unknown kinds fall into adjustments. */
  kind: string;
  amount: number;
}

/**
 * Signed amount in VND: debit is negative, credit is positive.
 * amount itself is always positive per the schema check `ledger_amount_positive`.
 */
export function signedLedgerAmount(entry: LedgerLike): number {
  return entry.direction === "debit" ? -entry.amount : entry.amount;
}

/** Model-usage deduction: a settle debit against a billing reservation. */
export function isUsageDebit(entry: LedgerLike): boolean {
  return entry.kind === "settle" && entry.direction === "debit";
}

export interface LedgerSections<T extends LedgerLike> {
  /** Usage deductions (settle debits) — separate from top-up history. */
  usage: T[];
  /** Top-ups (credit topup). */
  topups: T[];
  /** Manual adjustments and refunds — always visible, never dropped. */
  adjustments: T[];
}

/**
 * Partition ledger entries into display sections. Every entry lands in
 * exactly one section; unknown kinds fall into `adjustments` so no row is
 * ever dropped from view.
 */
export function partitionLedger<T extends LedgerLike>(entries: T[]): LedgerSections<T> {
  const sections: LedgerSections<T> = { usage: [], topups: [], adjustments: [] };
  for (const e of entries) {
    if (isUsageDebit(e)) sections.usage.push(e);
    else if (e.kind === "topup") sections.topups.push(e);
    else sections.adjustments.push(e);
  }
  return sections;
}
