// Regression: fresh migrate to head, then row-level constraint checks for
// chat_attachments (0024) and member chat policy (0025), plus a populated
// 0023-era upgrade path (legacy rows survive, new columns default safely).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { eq } from "drizzle-orm";
import { createDb, closeDb, type Db } from "../src/client";
import { migrate } from "../src/migrate";
import {
  chatAttachments,
  chatConversations,
  memberChatUsage,
  users,
  workspaces,
  apiKeys,
  billingReservations,
  modelPrices,
  models,
  wallets,
  requests,
} from "../src/schema";
import { createTestDb, type TestDb } from "../src/testing";

const DEFAULT_TEST_URL = process.env.HBR_TEST_DATABASE_URL || "postgres://postgres:postgres@127.0.0.1:55432/postgres";

async function expectReject(p: PromiseLike<unknown>): Promise<void> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(Error);
}

function urlFolder(): string {
  return new URL("../drizzle", import.meta.url).pathname;
}

let t: TestDb;
let d: Db;

beforeAll(async () => {
  t = await createTestDb();
  d = t.db;
});

afterAll(async () => {
  await t.drop();
});

async function seedUserWorkspace(id: string): Promise<void> {
  await d.insert(users).values({ id, name: id, email: `${id}@t.local`, emailVerified: false, createdAt: new Date() });
  await d.insert(workspaces).values({ id: `ws-${id}`, name: id, created_at: 1 });
}

describe("0024 chat_attachments row checks", () => {
  test("valid row inserts; invalid kind/bytes rejected", async () => {
    await seedUserWorkspace("att-u");
    const base = {
      id: crypto.randomUUID(),
      user_id: "att-u",
      workspace_id: "ws-att-u",
      kind: "image" as const,
      name: "a.png",
      mime: "image/png",
      bytes: 100,
      created_at: 1,
      expires_at: 2,
    };
    await d.insert(chatAttachments).values(base);
    await expectReject(
      d.insert(chatAttachments).values({ ...base, id: crypto.randomUUID(), kind: "video" as never }),
    );
    await expectReject(
      d.insert(chatAttachments).values({ ...base, id: crypto.randomUUID(), bytes: 10 * 1024 * 1024 + 1 }),
    );
    await expectReject(
      d.insert(chatAttachments).values({ ...base, id: crypto.randomUUID(), bytes: 0 }),
    );
    // Tombstone (soft delete) keeps the row.
    await d.update(chatAttachments).set({ deleted_at: 5 }).where(eq(chatAttachments.id, base.id));
  });

  test("FK blocks hard user delete — identity removal must tombstone first", async () => {
    await seedUserWorkspace("att-fk");
    await d.insert(chatAttachments).values({
      id: crypto.randomUUID(),
      user_id: "att-fk",
      workspace_id: "ws-att-fk",
      kind: "text",
      name: "a.txt",
      mime: "text/plain",
      bytes: 10,
      created_at: 1,
      expires_at: 2,
    });
    await expectReject(d.delete(users).where(eq(users.id, "att-fk")));
  });
});

describe("0025 member chat policy row checks", () => {
  test("workspace policy columns default off/null; negative cap rejected", async () => {
    await seedUserWorkspace("pol-u");
    const rows = await d.select().from(workspaces).where(eq(workspaces.id, "ws-pol-u"));
    expect(rows[0]!.member_chat_enabled).toBe(false);
    expect(rows[0]!.member_chat_daily_cap_vnd).toBeNull();
    await expectReject(
      d.update(workspaces).set({ member_chat_daily_cap_vnd: -1 }).where(eq(workspaces.id, "ws-pol-u")),
    );
  });

  test("chat_member key requires owner; usage PK dedupes UTC period", async () => {
    await seedUserWorkspace("mc-u");
    await expectReject(
      d.insert(apiKeys).values({
        id: "k-nowner",
        workspace_id: "ws-mc-u",
        key_hash: "h1",
        key_prefix: "p1",
        name: "n",
        purpose: "chat_member",
        created_at: 1,
      }),
    );
    await d.insert(apiKeys).values({
      id: "k-owner",
      workspace_id: "ws-mc-u",
      key_hash: "h2",
      key_prefix: "p2",
      name: "n",
      purpose: "chat_member",
      owner_user_id: "mc-u",
      created_at: 1,
    });
    await d.insert(memberChatUsage).values({ workspace_id: "ws-mc-u", user_id: "mc-u", period_start: "2026-10-13", used_vnd: 100, created_at: 1, updated_at: 1 });
    await expectReject(
      d.insert(memberChatUsage).values({ workspace_id: "ws-mc-u", user_id: "mc-u", period_start: "2026-10-13", used_vnd: 0, created_at: 1, updated_at: 1 }),
    );
    await expectReject(
      d.insert(memberChatUsage).values({ workspace_id: "ws-mc-u", user_id: "mc-u", period_start: "2026-2-13", created_at: 1, updated_at: 1 }),
    );
  });

  test("billing_reservations member ticket pair + key period snapshot", async () => {
    await seedUserWorkspace("br-u");
    const ws = "ws-br-u";
    await d.insert(models).values({ id: "m-br", public_id: "p-br", slug: "s-br", display_name: "m", provider: "p", created_at: 1, updated_at: 1 });
    await d.insert(modelPrices).values({
      id: "mp-br",
      model_id: "m-br",
      input_usd_micro_per_1m: 1,
      output_usd_micro_per_1m: 1,
      cached_input_usd_micro_per_1m: 1,
      reasoning_usd_micro_per_1m: 1,
      markup_ppm: 1,
      effective_at: 1,
    });
    await d.insert(wallets).values({ id: "w-br", workspace_id: ws, balance: 0, reserved: 0, created_at: 1 });
    await d.insert(requests).values({
      id: "r-br",
      workspace_id: ws,
      endpoint: "/v1/chat/completions",
      mode: "stream",
      status: "pending",
      model_id: "m-br",
      created_at: 1,
    });
    const base = {
      id: "brk",
      wallet_id: "w-br",
      request_id: "r-br",
      model_id: "m-br",
      model_price_id: "mp-br",
      usd_vnd_exchange_rate: 1,
      markup_ppm: 1,
      cap_vnd: 100,
      status: "held" as const,
      created_at: 1,
    };
    await d.insert(billingReservations).values({ ...base, member_budget_user_id: "br-u", member_budget_period_start: "2026-10-13", key_budget_period_start: 123 });
    await d.insert(requests).values({
      id: "r-br2",
      workspace_id: ws,
      endpoint: "/v1/chat/completions",
      mode: "stream",
      status: "pending",
      model_id: "m-br",
      created_at: 1,
    });
    // Unpaired member ticket rejected.
    await expectReject(
      d.insert(billingReservations).values({ ...base, id: "brk2", request_id: "r-br2", member_budget_user_id: "br-u" }),
    );
  });
});

describe("populated 0023 -> head upgrade", () => {
  test("legacy rows survive migration with safe defaults", async () => {
    const admin = new SQL(DEFAULT_TEST_URL.replace(/\/postgres$/, "/postgres"));
    const name = `hbr_t_up_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const url = DEFAULT_TEST_URL.replace(/\/postgres$/, `/${name}`);
    try {
      await admin.unsafe(`CREATE DATABASE ${name}`);
      const legacy = createDb(url, { max: 2 });
      // Migrate only through 0023 by truncating the journal inside a copy of the folder.
      const tmp = `${urlFolder()}`;
      const fs = await import("node:fs");
      const path = await import("node:path");
      const os = await import("node:os");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hbr-mig-"));
      for (const f of fs.readdirSync(tmp)) {
        if (f === "meta") continue;
        if (f.startsWith("0024") || f.startsWith("0025")) continue;
        fs.copyFileSync(path.join(tmp, f), path.join(dir, f));
      }
      fs.mkdirSync(path.join(dir, "meta"));
      const journal = JSON.parse(fs.readFileSync(path.join(tmp, "meta", "_journal.json"), "utf8"));
      journal.entries = journal.entries.filter((e: { tag: string }) => !e.tag.startsWith("0024") && !e.tag.startsWith("0025"));
      fs.writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify(journal));

      await migrate(legacy, { migrationsFolder: dir });
      await closeDb(legacy);
      // Populate legacy-shaped rows via a raw 0023-schema-compatible SQL
      // connection: the drizzle schema already knows the post-0025 columns,
      // which this 0023-era DB does not have.
      const seedConn = new SQL(url);
      await seedConn.unsafe(
        `INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES ('up-u', 'u', 'up@t.local', false, 1, 1)`,
      );
      await seedConn.unsafe(`INSERT INTO workspaces (id, name, created_at) VALUES ('ws-up', 'u', 1)`);
      await seedConn.unsafe(
        `INSERT INTO chat_conversations (id, user_id, workspace_id, title, messages, version, created_at, updated_at) VALUES ('c-up', 'up-u', 'ws-up', 'legacy', '[{"role":"user","content":"hi"}]'::jsonb, 1, 1, 1)`,
      );
      await seedConn.unsafe(
        `INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, purpose, created_at) VALUES ('k-up', 'ws-up', 'hu', 'pu', 'n', 'chat', 1)`,
      );
      await seedConn.close();

      // Upgrade to head.
      const upgraded = createDb(url, { max: 2 });
      await migrate(upgraded, { migrationsFolder: urlFolder() });
      const ws = await upgraded.select().from(workspaces).where(eq(workspaces.id, "ws-up"));
      expect(ws[0]!.member_chat_enabled).toBe(false);
      const k = await upgraded.select().from(apiKeys).where(eq(apiKeys.id, "k-up"));
      expect(k[0]!.owner_user_id).toBeNull();
      const c = await upgraded.select().from(chatConversations).where(eq(chatConversations.id, "c-up"));
      expect(c[0]!.messages).toEqual([{ role: "user", content: "hi" }]);
      await closeDb(upgraded);
    } finally {
      await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.close();
    }
  });
});
