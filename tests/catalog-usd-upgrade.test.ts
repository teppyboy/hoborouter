import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, createDb, createTestDb, migrate } from "../packages/db/src/index";

test("USD catalog migration preserves rows created before migration 0008", async () => {
  const fixture = await createTestDb();
  await closeDb(fixture.db);
  const db = createDb(fixture.url);
  const folder = await mkdtemp(join(tmpdir(), "hbr-usd-upgrade-"));
  try {
    // Recreate only this disposable fixture so the normal migrator can exercise
    // the pre-0008 state without touching deployment databases or history.
    await db.$client.unsafe("DROP SCHEMA public CASCADE");
    await db.$client.unsafe("DROP SCHEMA drizzle CASCADE");
    await db.$client.unsafe("CREATE SCHEMA public");
    const source = new URL("../packages/db/drizzle/", import.meta.url).pathname;
    const journal = JSON.parse(await readFile(join(source, "meta/_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string }[];
    };
    journal.entries = journal.entries.filter((entry) => entry.idx < 8);
    await mkdir(join(folder, "meta"));
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify(journal));
    for (const entry of journal.entries) {
      await copyFile(join(source, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    }
    await migrate(db, { migrationsFolder: folder });
    await db.$client.unsafe(
      "INSERT INTO credit_bundles (id,name,price_vnd,credit_vnd,bonus_vnd,created_at) VALUES ('old-b','Old bundle',100000,120000,5000,1)",
    );
    await db.$client.unsafe(
      "INSERT INTO subscription_plans (id,name,price_vnd,credit_per_period_vnd,created_at) VALUES ('old-p','Old plan',200000,250000,1)",
    );
    const before = await db.$client.unsafe(
      "SELECT column_name FROM information_schema.columns WHERE table_name='credit_bundles' AND column_name='price_usd'",
    );
    expect(before).toHaveLength(0);
    await migrate(db);
    const [bundle] = await db.$client.unsafe(
      "SELECT price_vnd::text,credit_vnd::text,bonus_vnd::text,price_usd,credit_usd,bonus_usd,creation_fx_rate_vnd_per_usd FROM credit_bundles WHERE id='old-b'",
    );
    expect(bundle).toEqual({
      price_vnd: "100000",
      credit_vnd: "120000",
      bonus_vnd: "5000",
      price_usd: null,
      credit_usd: null,
      bonus_usd: null,
      creation_fx_rate_vnd_per_usd: null,
    });
    const [plan] = await db.$client.unsafe(
      "SELECT price_vnd::text,credit_per_period_vnd::text,price_usd,credit_per_period_usd,creation_fx_rate_vnd_per_usd FROM subscription_plans WHERE id='old-p'",
    );
    expect(plan).toEqual({
      price_vnd: "200000",
      credit_per_period_vnd: "250000",
      price_usd: null,
      credit_per_period_usd: null,
      creation_fx_rate_vnd_per_usd: null,
    });
  } finally {
    await closeDb(db);
    await fixture.drop();
    await rm(folder, { recursive: true, force: true });
  }
});
