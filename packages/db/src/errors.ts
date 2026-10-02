/**
 * Postgres SQLSTATE code, unwrapping drizzle's DrizzleQueryError cause chain.
 * Bun SQL surfaces the SQLSTATE on `errno` (its `code` is an ERR_* string),
 * so both are checked at each level.
 */
export function pgErrorCode(e: unknown, depth = 3): string | undefined {
  if (typeof e !== "object" || e === null || depth <= 0) return undefined;
  const rec = e as { code?: unknown; errno?: unknown; cause?: unknown };
  if (typeof rec.code === "string" && /^\d{5}$/.test(rec.code)) return rec.code;
  if (typeof rec.errno === "string" && /^\d{5}$/.test(rec.errno)) return rec.errno;
  return pgErrorCode(rec.cause, depth - 1);
}

/** UNIQUE constraint violation (SQLSTATE 23505). */
export const isUniqueViolation = (e: unknown) => pgErrorCode(e) === "23505";
