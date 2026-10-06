import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, createDb, createTestDb, migrate } from "../packages/db/src/index";

// Two-phase migration (<0008 head, then current head) takes well over the
// 5s default on a cold fixture database.
test("USD catalog migration preserves rows created before migration 0008", async () => {
  const fixture = await createTestDb();
  await closeDb(fixture.db);
  const db = createDb(fixture.url);
  const folder = await mkdtemp(join(tmpdir(), "hbr-usd-upgrade-"));
  try {
    // Recreate only this disposable fixture so the normal migrator can exercise
    // the 0008-era state without touching deployment databases or history:
    // phase 1 migrates through 0008 only, snapshots rows, then migration 0009
    // must preserve them byte-identical before mixed groups become insertable.
    await db.$client.unsafe("DROP SCHEMA public CASCADE");
    await db.$client.unsafe("DROP SCHEMA drizzle CASCADE");
    await db.$client.unsafe("CREATE SCHEMA public");
    const source = new URL("../packages/db/drizzle/", import.meta.url).pathname;
    const journal = JSON.parse(await readFile(join(source, "meta/_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string }[];
    };
    journal.entries = journal.entries.filter((entry) => entry.idx < 9);
    await mkdir(join(folder, "meta"));
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify(journal));
    for (const entry of journal.entries) {
      await copyFile(join(source, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    }
    await migrate(db, { migrationsFolder: folder });
    // Rows as the 0008 all-or-nothing contract stored them.
    await db.$client.unsafe(
      "INSERT INTO credit_bundles (id,name,price_vnd,credit_vnd,bonus_vnd,created_at) VALUES ('old-b','Old bundle',100000,120000,5000,1)",
    );
    await db.$client.unsafe(
      "INSERT INTO subscription_plans (id,name,price_vnd,credit_per_period_vnd,created_at) VALUES ('old-p','Old plan',200000,250000,1)",
    );
    await db.$client.unsafe(
      "INSERT INTO credit_bundles (id,name,price_vnd,credit_vnd,bonus_vnd,created_at,price_usd,credit_usd,bonus_usd,creation_fx_rate_vnd_per_usd) VALUES ('usd8-b','USD8 bundle',259740,130005,0,1,'9.99','5','0','26001')",
    );
    await db.$client.unsafe(
      "INSERT INTO subscription_plans (id,name,price_vnd,credit_per_period_vnd,created_at,price_usd,credit_per_period_usd,creation_fx_rate_vnd_per_usd) VALUES ('usd8-p','USD8 plan',259750,312012,1,'9.99','12','26001')",
    );
    const legacyBundle = await db.$client.unsafe(
      "SELECT price_vnd::text,credit_vnd::text,bonus_vnd::text,price_usd,credit_usd,bonus_usd,creation_fx_rate_vnd_per_usd FROM credit_bundles WHERE id='old-b'",
    );
    const legacyPlan = await db.$client.unsafe(
      "SELECT price_vnd::text,credit_per_period_vnd::text,price_usd,credit_per_period_usd,creation_fx_rate_vnd_per_usd FROM subscription_plans WHERE id='old-p'",
    );
    const usdBundle = await db.$client.unsafe(
      "SELECT price_vnd::text,credit_vnd::text,bonus_vnd::text,price_usd,credit_usd,bonus_usd,creation_fx_rate_vnd_per_usd FROM credit_bundles WHERE id='usd8-b'",
    );
    const usdPlan = await db.$client.unsafe(
      "SELECT price_vnd::text,credit_per_period_vnd::text,price_usd,credit_per_period_usd,creation_fx_rate_vnd_per_usd FROM subscription_plans WHERE id='usd8-p'",
    );
    expect(legacyBundle).toEqual([
      {
        price_vnd: "100000",
        credit_vnd: "120000",
        bonus_vnd: "5000",
        price_usd: null,
        credit_usd: null,
        bonus_usd: null,
        creation_fx_rate_vnd_per_usd: null,
      },
    ]);
    expect(usdBundle).toEqual([
      {
        price_vnd: "259740",
        credit_vnd: "130005",
        bonus_vnd: "0",
        price_usd: "9.99",
        credit_usd: "5",
        bonus_usd: "0",
        creation_fx_rate_vnd_per_usd: "26001",
      },
    ]);
    await migrate(db);
    // After 0009: every 0008-era row is preserved identically (relaxed
    // constraint accepts them unchanged), and mixed groups are insertable.
    expect(
      await db.$client.unsafe(
        "SELECT price_vnd::text,credit_vnd::text,bonus_vnd::text,price_usd,credit_usd,bonus_usd,creation_fx_rate_vnd_per_usd FROM credit_bundles WHERE id='old-b'",
      ),
    ).toEqual(legacyBundle);
    expect(
      await db.$client.unsafe(
        "SELECT price_vnd::text,credit_per_period_vnd::text,price_usd,credit_per_period_usd,creation_fx_rate_vnd_per_usd FROM subscription_plans WHERE id='old-p'",
      ),
    ).toEqual(legacyPlan);
    expect(
      await db.$client.unsafe(
        "SELECT price_vnd::text,credit_vnd::text,bonus_vnd::text,price_usd,credit_usd,bonus_usd,creation_fx_rate_vnd_per_usd FROM credit_bundles WHERE id='usd8-b'",
      ),
    ).toEqual(usdBundle);
    expect(
      await db.$client.unsafe(
        "SELECT price_vnd::text,credit_per_period_vnd::text,price_usd,credit_per_period_usd,creation_fx_rate_vnd_per_usd FROM subscription_plans WHERE id='usd8-p'",
      ),
    ).toEqual(usdPlan);
    await db.$client.unsafe(
      "INSERT INTO credit_bundles (id,name,price_vnd,credit_vnd,bonus_vnd,created_at,price_usd,credit_usd,bonus_usd,creation_fx_rate_vnd_per_usd) VALUES ('mixed9-b','Mixed bundle',100000,130005,0,1,NULL,'5',NULL,'26001')",
    );
    const [mixed] = await db.$client.unsafe(
      "SELECT price_usd,credit_usd,bonus_usd,creation_fx_rate_vnd_per_usd FROM credit_bundles WHERE id='mixed9-b'",
    );
    expect(mixed).toEqual({
      price_usd: null,
      credit_usd: "5",
      bonus_usd: null,
      creation_fx_rate_vnd_per_usd: "26001",
    });
    // FX remains mandatory whenever any USD field is set.
    // Invoke the wrapper: expect().rejects needs a real Promise, not an
    // AsyncFunction or a BunSQL thenable.
    await expect(
      (async () => {
        await db.$client.unsafe(
          "INSERT INTO credit_bundles (id,name,price_vnd,credit_vnd,bonus_vnd,created_at,credit_usd) VALUES ('mixed9-bad','Bad',100000,130005,0,1,'5')",
        );
      })(),
    ).rejects.toThrow();
  } finally {
    await closeDb(db);
    await fixture.drop();
    await rm(folder, { recursive: true, force: true });
  }
}, 30000);
