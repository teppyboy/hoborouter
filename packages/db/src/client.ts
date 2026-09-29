import { Database } from "bun:sqlite";

/**
 * Open a SQLite database with the foundation's per-connection guarantees:
 * WAL journal mode, 5s busy timeout, foreign key enforcement ON.
 */
export function createDb(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}
