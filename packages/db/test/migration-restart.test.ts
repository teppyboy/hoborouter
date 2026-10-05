import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { createDb, closeDb, type Db } from "../src/client";
import { migrate } from "../src/migrate";

const DEFAULT_TEST_URL = "postgres://postgres:postgres@127.0.0.1:55432/postgres";

function drizzleFolder(): string {
  return new URL("../drizzle", import.meta.url).pathname;
}

/**
 * Journal `when` values as they existed before the 0004 delta: a dev database
 * already has 0000-0003 applied, with 0003 at its original applied timestamp.
 * Migrate compares journal `when` against __drizzle_migrations.created_at, so
 * the simulated folder must reproduce those exact timestamps.
 */
const PRE_0004_JOURNAL = [
  { idx: 0, version: "7", when: 1790958908090, tag: "0000_baseline", breakpoints: true },
  { idx: 1, version: "7", when: 1791048280723, tag: "0001_chat_conversations", breakpoints: true },
  {
    idx: 2,
    version: "7",
    when: 1791075737874,
    tag: "0002_bundles_subscriptions",
    breakpoints: true,
  },
  {
    idx: 3,
    version: "7",
    when: 1791083037023,
    tag: "0003_wallet_kinds_subscription_expiries",
    breakpoints: true,
  },
];

async function createThrowawayDb(): Promise<{ db: Db; adminUrl: string; name: string }> {
  const base = process.env.HBR_TEST_DATABASE_URL || DEFAULT_TEST_URL;
  const u = new URL(base);
  const adminUrl = `${u.protocol}//${u.username}:${u.password}@${u.host}/postgres`;
  const name = `hbr_t_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = new SQL(adminUrl);
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    admin.close();
  }
  return {
    db: createDb(`${u.protocol}//${u.username}:${u.password}@${u.host}/${name}`, { max: 4 }),
    adminUrl,
    name,
  };
}

async function dropDb(adminUrl: string, name: string): Promise<void> {
  const admin = new SQL(adminUrl);
  try {
    await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
  } finally {
    admin.close();
  }
}

/**
 * Simulate the pre-0004 deployment: a database migrated with 0000-0003 (0003
 * being the original single-column-PK SQL), then migrate with the updated
 * real folder twice — the 0004 PK swap must apply once, then be a no-op.
 */
describe("migrate restart on pre-0004 database", () => {
  let dir: string;
  let db: Db;
  let adminUrl: string;
  let name: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "hbr-pre0004-"));
    mkdirSync(join(dir, "meta"));
    for (const entry of PRE_0004_JOURNAL) {
      copyFileSync(join(drizzleFolder(), `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
    }
    writeFileSync(
      join(dir, "meta", "_journal.json"),
      JSON.stringify({ version: "7", dialect: "postgresql", entries: PRE_0004_JOURNAL }),
    );

    const created = await createThrowawayDb();
    db = created.db;
    adminUrl = created.adminUrl;
    name = created.name;
    await migrate(db, { migrationsFolder: dir });
  });

  afterAll(async () => {
    await closeDb(db);
    await dropDb(adminUrl, name);
    rmSync(dir, { recursive: true, force: true });
  });

  test("pre-0004 state: subscription_expiries has the original single-column pkey", async () => {
    const r = await db.execute<{ conname: string }>(
      sql`SELECT conname FROM pg_constraint WHERE conrelid = 'subscription_expiries'::regclass AND contype = 'p'`,
    );
    expect(r).toEqual([{ conname: "subscription_expiries_pkey" }]);
  });

  test("migrating updated folder twice: 0004 applies once, second run is a no-op", async () => {
    await migrate(db, { migrationsFolder: drizzleFolder() });

    const r = await db.execute<{ conname: string; def: string }>(
      sql`SELECT conname, pg_get_constraintdef(oid) def FROM pg_constraint WHERE conrelid = 'subscription_expiries'::regclass AND contype = 'p'`,
    );
    expect(r).toEqual([
      {
        conname: "subscription_expiries_subscription_id_period_end_pk",
        def: "PRIMARY KEY (subscription_id, period_end)",
      },
    ]);

    // Data written before the restart survives the PK swap.
    const rows = await db.execute<{ count: string }>(
      sql`SELECT count(*)::text count FROM subscription_expiries`,
    );
    expect(rows[0]!.count).toBe("0");

    await expect(migrate(db, { migrationsFolder: drizzleFolder() })).resolves.toBeUndefined();
  });
});

/** Fresh database: complete migrate twice, no error, final PK is composite. */
describe("migrate fresh database twice", () => {
  test("complete migration is idempotent", async () => {
    const { db: fresh, adminUrl, name } = await createThrowawayDb();
    try {
      await migrate(fresh);
      await expect(migrate(fresh)).resolves.toBeUndefined();

      const r = await fresh.execute<{ conname: string; def: string }>(
        sql`SELECT conname, pg_get_constraintdef(oid) def FROM pg_constraint WHERE conrelid = 'subscription_expiries'::regclass AND contype = 'p'`,
      );
      expect(r).toEqual([
        {
          conname: "subscription_expiries_subscription_id_period_end_pk",
          def: "PRIMARY KEY (subscription_id, period_end)",
        },
      ]);
    } finally {
      await closeDb(fresh);
      await dropDb(adminUrl, name);
    }
  });
});
