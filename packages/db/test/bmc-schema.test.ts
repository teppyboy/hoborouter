import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SQL } from "bun";
import { createTestDb, type TestDb } from "../src/testing";
import { isUniqueViolation, pgErrorCode } from "../src/errors";
import { createDb, closeDb, type Db } from "../src/client";
import { migrate } from "../src/migrate";
import {
  MAX_SAFE_INTEGER_MONEY,
  ledgerEntries,
  promoCodes,
  promoRedemptions,
  supportLeads,
  users,
  wallets,
  workspaces,
} from "../src/schema";

const DEFAULT_TEST_URL = "postgres://postgres:postgres@127.0.0.1:55432/postgres";

function drizzleFolder(): string {
  return new URL("../drizzle", import.meta.url).pathname;
}

/**
 * Drizzle query builders are thenable but not Promise instances; Bun's
 * `.rejects` requires a real Promise, so wrap rejections manually.
 */
async function expectReject(p: PromiseLike<unknown>): Promise<unknown> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(Error);
  return err;
}

let t: TestDb;
let d: TestDb["db"];

beforeAll(async () => {
  t = await createTestDb();
  d = t.db;
});

afterAll(async () => {
  await t.drop();
});

/** Additive 0005 on a database that only has the 0000 baseline applied. */
describe("0005 bmc migration on baseline-only database", () => {
  let db: Db;
  let adminUrl: string;
  let name: string;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "hbr-bmc-base-"));
    mkdirSync(join(dir, "meta"));
    copyFileSync(join(drizzleFolder(), "0000_baseline.sql"), join(dir, "0000_baseline.sql"));
    writeFileSync(
      join(dir, "meta", "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [
          { idx: 0, version: "7", when: 1790958908090, tag: "0000_baseline", breakpoints: true },
        ],
      }),
    );

    const base = process.env.HBR_TEST_DATABASE_URL || DEFAULT_TEST_URL;
    const u = new URL(base);
    adminUrl = `${u.protocol}//${u.username}:${u.password}@${u.host}/postgres`;
    name = `hbr_t_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const admin = new SQL(adminUrl);
    try {
      await admin.unsafe(`CREATE DATABASE ${name}`);
    } finally {
      admin.close();
    }
    db = createDb(`${u.protocol}//${u.username}:${u.password}@${u.host}/${name}`, { max: 4 });
    await migrate(db, { migrationsFolder: dir });

    // Pre-existing rows the 0005 delta must not touch: a model, and a ledger
    // entry behind wallet + workspace.
    await db.execute(
      sql`INSERT INTO models (id, public_id, slug, display_name, provider, created_at, updated_at) VALUES ('m-pre','pub-pre','slug-pre','Pre','prov',1,1)`,
    );
    await db.execute(
      sql`INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws-pre','ws','active',1)`,
    );
    await db.execute(
      sql`INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at) VALUES ('w-pre','ws-pre','VND',100,0,0,1)`,
    );
    await db.execute(
      sql`INSERT INTO ledger_entries (id, wallet_id, direction, amount, kind, balance_after, created_at) VALUES ('l-pre','w-pre','credit',100,'topup',100,1)`,
    );

    await migrate(db, { migrationsFolder: drizzleFolder() });
  });

  afterAll(async () => {
    await closeDb(db);
    const admin = new SQL(adminUrl);
    try {
      await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
    } finally {
      admin.close();
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("auto_eligible column added to models with default false, existing row untouched", async () => {
    const rows = await db.execute<{ auto_eligible: boolean }>(
      sql`SELECT auto_eligible FROM models WHERE id = 'm-pre'`,
    );
    expect(rows).toEqual([{ auto_eligible: false }]);
  });

  test("ledger row survives the migration (no DELETE/TRUNCATE)", async () => {
    const rows = await db.execute<{ id: string; amount: string; balance_after: string }>(
      sql`SELECT id, amount::text amount, balance_after::text balance_after FROM ledger_entries WHERE id = 'l-pre'`,
    );
    expect(rows).toEqual([{ id: "l-pre", amount: "100", balance_after: "100" }]);
  });

  test("second migrate is a no-op and data is still intact", async () => {
    await expect(migrate(db, { migrationsFolder: drizzleFolder() })).resolves.toBeUndefined();
    const rows = await db.execute<{ count: string }>(
      sql`SELECT count(*)::text count FROM ledger_entries`,
    );
    expect(rows[0]!.count).toBe("1");
  });
});

describe("models.auto_eligible (fresh database)", () => {
  test("defaults to false when omitted", async () => {
    await d.execute(
      sql`INSERT INTO models (id, public_id, slug, display_name, provider, created_at, updated_at) VALUES ('m-ae','pub-ae','slug-ae','AE','prov',1,1)`,
    );
    const rows = await d.execute<{ auto_eligible: boolean }>(
      sql`SELECT auto_eligible FROM models WHERE id = 'm-ae'`,
    );
    expect(rows).toEqual([{ auto_eligible: false }]);
  });
});

describe("promo_codes constraints", () => {
  function promoRow(
    id: string,
    over: Partial<typeof promoCodes.$inferInsert> = {},
  ): typeof promoCodes.$inferInsert {
    return {
      id,
      code_hash: `hash-${id}`,
      name: "Promo",
      amount_vnd: 50000,
      max_uses: 10,
      created_at: 1,
      ...over,
    };
  }

  test("valid insert round-trips with defaults", async () => {
    await d.insert(promoCodes).values(promoRow("pc-ok"));
    const row = await d.select().from(promoCodes).where(eq(promoCodes.id, "pc-ok"));
    expect(row).toHaveLength(1);
    expect(row[0]!.uses).toBe(0);
    expect(row[0]!.active).toBe(true);
    expect(row[0]!.expires_at).toBeNull();
  });

  test("code_hash is unique", async () => {
    await d.insert(promoCodes).values(promoRow("pc-u1"));
    const err = await expectReject(
      d.insert(promoCodes).values(promoRow("pc-u2", { code_hash: "hash-pc-u1" })),
    );
    expect(isUniqueViolation(err)).toBe(true);
    expect(pgErrorCode(err)).toBe("23505");
  });

  test("amount_vnd must be positive and <= MAX_SAFE_INTEGER_MONEY", async () => {
    await expectReject(d.insert(promoCodes).values(promoRow("pc-zero", { amount_vnd: 0 })));
    await expectReject(d.insert(promoCodes).values(promoRow("pc-neg", { amount_vnd: -1 })));
    await expectReject(
      d.insert(promoCodes).values(promoRow("pc-big", { amount_vnd: MAX_SAFE_INTEGER_MONEY + 1 })),
    );
  });

  test("max_uses must be >= 1", async () => {
    await expectReject(d.insert(promoCodes).values(promoRow("pc-mu0", { max_uses: 0 })));
  });

  test("uses stays within [0, max_uses]", async () => {
    await expectReject(
      d.insert(promoCodes).values(promoRow("pc-over", { uses: 11, max_uses: 10 })),
    );
    await expectReject(d.insert(promoCodes).values(promoRow("pc-under", { uses: -1 })));
    // Boundary is legal.
    await d.insert(promoCodes).values(promoRow("pc-boundary", { uses: 10, max_uses: 10 }));
  });
});

describe("promo_redemptions idempotency (one per code per workspace)", () => {
  async function seedRedeemable(codeId: string): Promise<void> {
    await d
      .insert(workspaces)
      .values({ id: `ws-${codeId}`, name: "ws", status: "active", created_at: 1 });
    await d.insert(wallets).values({
      id: `w-${codeId}`,
      workspace_id: `ws-${codeId}`,
      currency: "VND",
      kind: "topup",
      balance: 100,
      reserved: 0,
      version: 0,
      created_at: 1,
    });
    await d.insert(ledgerEntries).values({
      id: `l-${codeId}`,
      wallet_id: `w-${codeId}`,
      direction: "credit",
      amount: 50000,
      kind: "adjustment",
      balance_after: 50100,
      memo: `promo:${codeId}`,
      created_at: 1,
    });
    await d.insert(promoCodes).values({
      id: codeId,
      code_hash: `rh-${codeId}`,
      name: "P",
      amount_vnd: 50000,
      max_uses: 5,
      created_at: 1,
    });
  }

  test("valid redemption inserts; duplicate (code, workspace) rejected", async () => {
    await seedRedeemable("rc1");
    await d.insert(promoRedemptions).values({
      id: "pr-ok",
      promo_code_id: "rc1",
      workspace_id: "ws-rc1",
      ledger_entry_id: "l-rc1",
      created_at: 1,
    });
    const err = await expectReject(
      d.insert(promoRedemptions).values({
        id: "pr-dup",
        promo_code_id: "rc1",
        workspace_id: "ws-rc1",
        ledger_entry_id: "l-rc1",
        created_at: 2,
      }),
    );
    expect(pgErrorCode(err)).toBe("23505");
  });

  test("same code for a different workspace is allowed", async () => {
    await d
      .insert(workspaces)
      .values({ id: "ws-rc1b", name: "ws", status: "active", created_at: 1 });
    await d.insert(wallets).values({
      id: "w-rc1b",
      workspace_id: "ws-rc1b",
      currency: "VND",
      kind: "topup",
      balance: 0,
      reserved: 0,
      version: 0,
      created_at: 1,
    });
    await d.insert(ledgerEntries).values({
      id: "l-rc1b",
      wallet_id: "w-rc1b",
      direction: "credit",
      amount: 50000,
      kind: "adjustment",
      balance_after: 50000,
      memo: "promo:rc1",
      created_at: 1,
    });
    await d.insert(promoRedemptions).values({
      id: "pr-ws2",
      promo_code_id: "rc1",
      workspace_id: "ws-rc1b",
      ledger_entry_id: "l-rc1b",
      created_at: 1,
    });
  });

  test("ledger_entry_id FK enforced", async () => {
    await d.insert(promoCodes).values({
      id: "rc2",
      code_hash: "rh-rc2",
      name: "P",
      amount_vnd: 1,
      max_uses: 1,
      created_at: 1,
    });
    await d
      .insert(workspaces)
      .values({ id: "ws-rc2", name: "ws", status: "active", created_at: 1 });
    await expectReject(
      d.insert(promoRedemptions).values({
        id: "pr-orphan",
        promo_code_id: "rc2",
        workspace_id: "ws-rc2",
        ledger_entry_id: "no-such-ledger",
        created_at: 1,
      }),
    );
  });
});

describe("support_leads", () => {
  test("valid insert defaults to open; handled update with handler works", async () => {
    await d.insert(supportLeads).values({
      id: "sl1",
      contact_email: "a@b.c",
      message: "help integrate",
      created_at: 1,
    });
    let row = await d.select().from(supportLeads).where(eq(supportLeads.id, "sl1"));
    expect(row[0]!.status).toBe("open");

    await d.insert(users).values({
      id: "u-admin",
      name: "Admin",
      email: "admin@example.com",
      emailVerified: true,
      createdAt: new Date(1),
      updatedAt: new Date(1),
    });
    await d
      .update(supportLeads)
      .set({ status: "handled", handled_at: 2, handled_by: "u-admin" })
      .where(eq(supportLeads.id, "sl1"));
    row = await d.select().from(supportLeads).where(eq(supportLeads.id, "sl1"));
    expect(row[0]!.status).toBe("handled");
    expect(row[0]!.handled_by).toBe("u-admin");
    expect(row[0]!.handled_at).toBe(2);
  });

  test("status limited to open/handled", async () => {
    // Type-level enum already rejects invalid values; assert the DB CHECK too
    // via raw SQL.
    await expectReject(
      d.execute(
        sql`INSERT INTO support_leads (id, contact_email, message, status, created_at) VALUES ('sl-bad','x@y.z','m','bogus',1)`,
      ),
    );
  });

  test("workspace FK enforced when present", async () => {
    await expectReject(
      d.insert(supportLeads).values({
        id: "sl-orphan",
        contact_email: "x@y.z",
        workspace_id: "no-such-ws",
        message: "m",
        created_at: 1,
      }),
    );
  });
});
