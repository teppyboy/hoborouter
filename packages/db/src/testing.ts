import { SQL } from "bun";
import { createDb, closeDb, type Db } from "./client";
import { migrate } from "./migrate";

const DEFAULT_TEST_URL = "postgres://postgres:postgres@127.0.0.1:55432/postgres";

export type TestDb = { db: Db; url: string; drop: () => Promise<void> };

/**
 * Create an isolated throwaway database (hbr_t_<random>) on the test Postgres,
 * migrate it, and return a handle whose drop() closes the pool and removes it.
 */
export async function createTestDb(): Promise<TestDb> {
  const base = process.env.HBR_TEST_DATABASE_URL || DEFAULT_TEST_URL;
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    throw new Error(`HBR_TEST_DATABASE_URL is not a valid URL: ${base}`);
  }
  const adminUrl = `${u.protocol}//${u.username}:${u.password}@${u.host}/postgres`;
  const name = `hbr_t_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const url = `${u.protocol}//${u.username}:${u.password}@${u.host}/${name}`;

  const admin = new SQL(adminUrl);
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await admin.close();
  }

  // Small pool: test files run 4-way parallel against one server.
  const db = createDb(url, { max: 4 });
  await migrate(db);
  return {
    db,
    url,
    drop: async () => {
      await closeDb(db);
      const admin = new SQL(adminUrl);
      try {
        await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
      } finally {
        await admin.close();
      }
    },
  };
}
