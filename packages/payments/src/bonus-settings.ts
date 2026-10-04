/**
 * Shared read rule for the first_topup_bonus_enabled instance setting:
 * missing key = enabled; only the exact string "false" disables.
 * Settlement (credit.ts) and the admin settings GET both read through this
 * so they cannot drift apart.
 */
export function isFirstTopupBonusEnabled(value: string | null | undefined): boolean {
  return value !== "false";
}
