import type { Database } from "bun:sqlite";
import { readMigrationFiles } from "drizzle-orm/migrator";

import { MAX_SAFE_INTEGER_MONEY } from "./schema";

const defaultMigrationsFolder = new URL("../drizzle", import.meta.url).pathname;

function preflight(db: Database): void {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
    name: string;
  }[];
  const names = new Set(tables.map(({ name }) => name));
  if (!names.has("users")) return;
  const columns = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  const count = Number((db.prepare("SELECT count(*) AS n FROM users").get() as { n: number }).n);
  if (count === 0 || columns.some(({ name }) => name === "email")) return;
  throw new Error(
    "Database migration preflight blocked: populated users lack compatible BetterAuth email schema; preserve DB and request owner approval.",
  );
}

export function migrate(db: Database, options?: { migrationsFolder?: string }): void {
  preflight(db);
  if (db.inTransaction)
    throw new Error(
      "Database migration refused: caller has an active transaction; no mutation performed.",
    );
  const fk = Number(
    (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys,
  );
  const migrations = readMigrationFiles({
    migrationsFolder: options?.migrationsFolder ?? defaultMigrationsFolder,
  });
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN");
    db.exec(
      "CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
    );
    const last = db
      .prepare("SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1")
      .get() as { created_at: number } | null;
    for (const migration of migrations) {
      if (!last || Number(last.created_at) < migration.folderMillis) {
        for (const statement of migration.sql) db.exec(statement);
        db.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(
          migration.hash,
          migration.folderMillis,
        );
      }
    }
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length) throw new Error("Migration aborted: foreign key check failed");
    db.exec("COMMIT");
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec(`PRAGMA foreign_keys = ${fk ? "ON" : "OFF"}`);
  }
}

export { MAX_SAFE_INTEGER_MONEY };
