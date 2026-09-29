import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate as drizzleMigrate } from "drizzle-orm/bun-sqlite/migrator";

/**
 * Apply pending Drizzle migrations from packages/db/drizzle.
 * Idempotent: already-applied migrations are skipped by the journal.
 */
export function migrate(db: Database): void {
  drizzleMigrate(drizzle(db), {
    migrationsFolder: new URL("../drizzle", import.meta.url).pathname,
  });
}
