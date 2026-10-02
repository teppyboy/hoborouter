// Shared typed Drizzle handle over a raw bun:sqlite Database.
// Cached per-connection (WeakMap) so each Database gets exactly one drizzle
// instance; drizzle query builders hold no transaction state, so using them
// inside existing BEGIN IMMEDIATE wrappers on the same connection is safe.
import type { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

export type Orm = BunSQLiteDatabase<typeof schema>;

const cache = new WeakMap<Database, Orm>();

export function orm(db: Database): Orm {
  let instance = cache.get(db);
  if (!instance) {
    instance = drizzle(db, { schema });
    cache.set(db, instance);
  }
  return instance;
}

// Drizzle types bun-sqlite run() results as `void`, but the runtime value is
// bun:sqlite's Changes ({ changes, lastInsertRowid }). Centralized re-type of
// that runtime value so CAS `changes` checks stay typed.
export function runChanges(stmt: { run(): unknown }): { changes: number } {
  return stmt.run() as { changes: number };
}
