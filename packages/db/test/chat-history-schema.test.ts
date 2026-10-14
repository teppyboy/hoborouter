import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { createDb, closeDb, type Db } from "../src/client";
import { migrate } from "../src/migrate";
import { createTestDb, type TestDb } from "../src/testing";
import {
  chatConversations,
  ledgerEntries,
  payments,
  users,
  wallets,
} from "../src/schema";

const DEFAULT_TEST_URL = "postgres://postgres:postgres@127.0.0.1:55432/postgres";

function drizzleFolder(): string {
  return new URL("../drizzle", import.meta.url).pathname;
}

async function expectReject(p: PromiseLike<unknown>): Promise<void> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(Error);
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

function convoRow(
  id: string,
  over: Partial<typeof chatConversations.$inferInsert> = {},
): typeof chatConversations.$inferInsert {
  return {
    id,
    user_id: "u-chat",
    workspace_id: "ws-chat",
    title: "New chat",
    model: null,
    messages: [{ role: "user", content: "hi" }],
    version: 1,
    created_at: 1,
    updated_at: 1,
    archived_at: null,
    ...over,
  };
}

async function seedChatOwner(db: Db): Promise<void> {
  await db
    .insert(users)
    .values({
      id: "u-chat",
      name: "u",
      email: "chat@test.local",
      emailVerified: true,
      createdAt: new Date(1),
      updatedAt: new Date(1),
    })
    .onConflictDoNothing();
  // Raw SQL with explicit pre-0001 columns: the drizzle schema object now
  // carries post-0025 workspace policy columns that the baseline table lacks.
  await db.execute(
    sql`INSERT INTO "workspaces" ("id", "name", "status", "created_at") VALUES ('ws-chat', 'ws', 'active', 1) ON CONFLICT DO NOTHING`,
  );
}

describe("chat_conversations schema", () => {
  test("table exists with all columns after full migration", async () => {
    const cols = await d.execute<{ column_name: string }>(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'chat_conversations' ORDER BY column_name`,
    );
    expect(cols.map((r) => r.column_name)).toEqual([
      "archived_at",
      "created_at",
      "id",
      "messages",
      "model",
      "title",
      "updated_at",
      "user_id",
      "version",
      "workspace_id",
    ]);
  });

  test("defaults: messages '[]' and version 1", async () => {
    await seedChatOwner(d);
    await d.insert(chatConversations).values({
      id: "cc-def",
      user_id: "u-chat",
      workspace_id: "ws-chat",
      title: "New chat",
      created_at: 1,
      updated_at: 1,
    });
    const row = await d
      .select()
      .from(chatConversations)
      .where(sql`${chatConversations.id} = 'cc-def'`);
    expect(row).toHaveLength(1);
    expect(row[0]!.messages).toEqual([]);
    expect(row[0]!.version).toBe(1);
    expect(row[0]!.model).toBeNull();
    expect(row[0]!.archived_at).toBeNull();
  });

  test("version CHECK rejects values below 1", async () => {
    await expectReject(d.insert(chatConversations).values(convoRow("cc-v0", { version: 0 })));
    await expectReject(d.insert(chatConversations).values(convoRow("cc-vneg", { version: -1 })));
  });

  test("timestamp CHECKs reject negative epoch-ms", async () => {
    await expectReject(d.insert(chatConversations).values(convoRow("cc-c", { created_at: -1 })));
    await expectReject(d.insert(chatConversations).values(convoRow("cc-u", { updated_at: -1 })));
    await expectReject(d.insert(chatConversations).values(convoRow("cc-a", { archived_at: -1 })));
  });

  test("FKs protect against orphan conversations", async () => {
    await expectReject(
      d.insert(chatConversations).values(convoRow("cc-fk1", { user_id: "no-such-user" })),
    );
    await expectReject(
      d.insert(chatConversations).values(convoRow("cc-fk2", { workspace_id: "no-such-ws" })),
    );
  });

  test("list index (user_id, workspace_id, archived_at, updated_at, id) exists", async () => {
    const idx = await d.execute<{ indexdef: string }>(
      sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'chat_conversations_list_idx'`,
    );
    expect(idx).toHaveLength(1);
    expect(idx[0]!.indexdef).toContain("user_id");
    expect(idx[0]!.indexdef).toContain("workspace_id");
    expect(idx[0]!.indexdef).toContain("archived_at");
    expect(idx[0]!.indexdef).toContain("updated_at");
    expect(idx[0]!.indexdef).toContain(", id");
  });
});

/**
 * Simulate a pre-0001 deployment: copy the applied 0000 baseline + its journal
 * (entry 0 only) into a temp migrations folder, migrate a fresh throwaway DB
 * with it, seed money rows, then apply the real folder (which adds 0001) and
 * verify the seed survived and re-running migrate is idempotent.
 */
describe("additive migration from pre-0001 baseline", () => {
  let dir: string;
  let db: Db;
  let name: string;
  let adminUrl: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "hbr-pre0001-"));
    mkdirSync(join(dir, "meta"));
    copyFileSync(join(drizzleFolder(), "0000_baseline.sql"), join(dir, "0000_baseline.sql"));
    copyFileSync(
      join(drizzleFolder(), "meta", "0000_snapshot.json"),
      join(dir, "meta", "0000_snapshot.json"),
    );
    // Journal as it existed before 0001: baseline entry only.
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

  test("seed user/workspace/wallet/payment/ledger before 0001", async () => {
    await seedChatOwner(db);
    // Raw SQL with explicit pre-0001 columns: the drizzle schema object now
    // carries post-0003 wallet columns (kind) that the baseline table lacks.
    await db.execute(sql`INSERT INTO "wallets" ("id", "workspace_id", "currency", "balance", "reserved", "version", "created_at")
      VALUES ('w-pre', 'ws-chat', 'VND', 50000, 0, 0, 1)`);
    // Raw SQL with explicit pre-0001 columns: the drizzle schema object now
    // carries post-0002 payment columns that the baseline table lacks.
    await db.execute(sql`INSERT INTO "payments" ("id", "workspace_id", "amount", "status", "provider", "provider_order_code", "created_at")
      VALUES ('p-pre', 'ws-chat', 50000, 'succeeded', 'manual', 'pre-1', 1)`);
    await db.execute(sql`INSERT INTO "ledger_entries" ("id", "wallet_id", "direction", "amount", "kind", "payment_id", "balance_after", "created_at")
      VALUES ('l-pre', 'w-pre', 'credit', 50000, 'topup', 'p-pre', 50000, 1)`);
  });

  test("applying 0001 preserves money rows, then migrate is idempotent", async () => {
    await migrate(db, { migrationsFolder: drizzleFolder() });

    const walletsAfter = await db.select().from(wallets);
    expect(walletsAfter).toHaveLength(1);
    expect(walletsAfter[0]!.balance).toBe(50000);
    const ledgerAfter = await db.select().from(ledgerEntries);
    expect(ledgerAfter).toHaveLength(1);
    expect(ledgerAfter[0]!.amount).toBe(50000);
    const paymentsAfter = await db.select().from(payments);
    expect(paymentsAfter).toHaveLength(1);

    // Conversation rows are writable after the migration.
    await db.insert(chatConversations).values({
      id: "cc-post",
      user_id: "u-chat",
      workspace_id: "ws-chat",
      title: "New chat",
      created_at: 2,
      updated_at: 2,
    });
    const convos = await db.select().from(chatConversations);
    expect(convos).toHaveLength(1);
    expect(convos[0]!.messages).toEqual([]);

    // Re-running the full migration is a no-op.
    await expect(migrate(db, { migrationsFolder: drizzleFolder() })).resolves.toBeUndefined();
    expect(await db.select().from(chatConversations)).toHaveLength(1);
  });
});
