import { drizzle, type BunSQLDatabase } from "drizzle-orm/bun-sql";
import type { SQL } from "bun";
import * as schema from "./schema";

// BunSQLDatabase's declared type omits $client (only the drizzle() return
// type carries it); add it back so closeDb works on any Db.
export type Db = BunSQLDatabase<typeof schema> & { $client: SQL };
/** Transaction handle — the value `db.transaction(async (tx) => ...)` hands to its callback. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Open a lazy Bun-SQL drizzle connection. Sync; no I/O until first query.
 */
export function createDb(
  url: string = process.env.DATABASE_URL ?? "",
  opts: { max?: number } = {},
): Db {
  // Guard against silent SQLite fallback: Bun SQL opens SQLite for non-postgres
  // URLs (empty string, ":memory:"), which then fails confusingly on pg-only SQL.
  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new Error(
      `createDb requires a PostgreSQL URL (postgres://...), got: ${url || "(empty DATABASE_URL)"}`,
    );
  }
  return drizzle({ connection: { url, max: opts.max ?? 10 }, schema }) as Db;
}

export async function closeDb(db: Db): Promise<void> {
  await db.$client.close();
}
