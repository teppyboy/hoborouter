import { migrate as pgMigrate } from "drizzle-orm/bun-sql/migrator";
import type { Db } from "./client";

const defaultMigrationsFolder = new URL("../drizzle", import.meta.url).pathname;

export async function migrate(db: Db, options?: { migrationsFolder?: string }): Promise<void> {
  await pgMigrate(db, {
    migrationsFolder: options?.migrationsFolder ?? defaultMigrationsFolder,
  });
}

export { MAX_SAFE_INTEGER_MONEY } from "./schema";
