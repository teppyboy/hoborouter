// Dashboard ledger endpoint must include BOTH wallet kinds for a workspace:
// the old kind='topup' filter hid all subscription financial history. Each
// row carries an additive wallet_kind naming its source wallet; cross-workspace
// rows are excluded; existing topup row content is unchanged.
// Fixture cleanup is drop-DB only — ledger_entries is append-only, never DELETEd.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Elysia } from "elysia";
import { sql } from "drizzle-orm";
import { createTestDb, type Db } from "@hoborouter/db";
import { dashboardRoutes } from "../src/routes/dashboard";

const WS = "ws-led";
const OTHER_WS = "ws-led-other";
const NOW = 1_700_000_000_000;

const authAs = (userId: string) => ({
  handler: async () => new Response("", { status: 404 }),
  api: { getSession: async () => ({ user: { id: userId }, session: { id: "s", userId } }) },
});

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let app: ReturnType<typeof dashboardRoutes>;

interface LedgerRow {
  id: string;
  created_at: number;
  direction: "debit" | "credit";
  kind: string;
  amount: number;
  balance_after: number;
  memo: string | null;
  payment_id: string | null;
  request_id: string | null;
  wallet_kind: string;
}

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  await db.execute(
    sql`INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES ('u-led','U','u-led@t.test',true,${NOW},${NOW})`,
  );
  for (const w of [WS, OTHER_WS]) {
    await db.execute(
      sql`INSERT INTO workspaces (id, name, status, created_at) VALUES (${w},'ws','active',${NOW})`,
    );
    await db.execute(
      sql`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${w},'u-led','owner')`,
    );
    await db.execute(
      sql`INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at)
          VALUES (${"wal-top-" + w}, ${w}, 'VND', 50000, 0, 0, ${NOW})`,
    );
  }
  // Subscription wallet on the main workspace only.
  await db.execute(
    sql`INSERT INTO wallets (id, workspace_id, currency, kind, balance, reserved, version, created_at)
        VALUES ('wal-sub-led', ${WS}, 'VND', 'subscription', 0, 0, 0, ${NOW})`,
  );
  // Cross-workspace ledger entry that must never leak into WS's ledger.
  await db.execute(
    sql`INSERT INTO ledger_entries (id, wallet_id, direction, amount, kind, balance_after, memo, created_at)
        VALUES ('led-other', ${"wal-top-" + OTHER_WS}, 'credit', 999, 'topup', 999, 'other ws', ${NOW})`,
  );
  // Main workspace topup wallet credit (pre-existing content: must be unchanged).
  await db.execute(
    sql`INSERT INTO ledger_entries (id, wallet_id, direction, amount, kind, balance_after, memo, created_at)
        VALUES ('led-topup', ${"wal-top-" + WS}, 'credit', 50000, 'topup', 50000, 'seed', ${NOW + 1000})`,
  );
  // Subscription wallet history: funding credit, usage settle debit, refund credit, expiry forfeit debit.
  await db.execute(
    sql`INSERT INTO ledger_entries (id, wallet_id, direction, amount, kind, balance_after, memo, created_at)
        VALUES ('led-sub-credit', 'wal-sub-led', 'credit', 100000, 'adjustment', 100000, 'subscription credit', ${NOW + 2000})`,
  );
  await db.execute(
    sql`INSERT INTO ledger_entries (id, wallet_id, direction, amount, kind, balance_after, memo, created_at)
        VALUES ('led-sub-settle', 'wal-sub-led', 'debit', 78000, 'settle', 22000, 'test', ${NOW + 3000})`,
  );
  // Refund requires the original settle entry (ledger_refund_requires_original).
  await db.execute(
    sql`INSERT INTO ledger_entries (id, wallet_id, direction, amount, kind, original_ledger_entry_id, balance_after, memo, created_at)
        VALUES ('led-sub-refund', 'wal-sub-led', 'credit', 10000, 'refund', 'led-sub-settle', 32000, 'goodwill', ${NOW + 4000})`,
  );
  await db.execute(
    sql`INSERT INTO ledger_entries (id, wallet_id, direction, amount, kind, balance_after, memo, created_at)
        VALUES ('led-sub-expiry', 'wal-sub-led', 'debit', 32000, 'adjustment', 0, 'subscription expired', ${NOW + 5000})`,
  );
  app = new Elysia().use(dashboardRoutes(db, authAs("u-led")));
});

afterAll(async () => {
  await t.drop();
});

const get = (path: string) => app.handle(new Request(`http://localhost${path}`));

describe("GET /workspaces/:id/ledger includes both wallet kinds", () => {
  test("all own rows from topup and subscription wallets, each with wallet_kind; cross-workspace excluded", async () => {
    const res = await get(`/api/v1/workspaces/${WS}/ledger`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: LedgerRow[] };
    const rows = body.data;
    // All 5 own rows visible, the cross-workspace row excluded.
    expect(rows.map((r) => r.id).sort()).toEqual(
      ["led-sub-credit", "led-sub-expiry", "led-sub-refund", "led-sub-settle", "led-topup"].sort(),
    );
    expect(rows.some((r) => r.id === "led-other")).toBe(false);
    // wallet_kind names the source wallet for every row.
    const kinds = Object.fromEntries(rows.map((r) => [r.id, r.wallet_kind]));
    expect(kinds["led-topup"]).toBe("topup");
    expect(kinds["led-sub-credit"]).toBe("subscription");
    expect(kinds["led-sub-settle"]).toBe("subscription");
    expect(kinds["led-sub-refund"]).toBe("subscription");
    expect(kinds["led-sub-expiry"]).toBe("subscription");
  });

  test("existing topup row content is unchanged (additive wallet_kind only)", async () => {
    const res = await get(`/api/v1/workspaces/${WS}/ledger`);
    const body = (await res.json()) as { data: LedgerRow[] };
    const row = body.data.find((r) => r.id === "led-topup");
    expect(row).toMatchObject({
      direction: "credit",
      kind: "topup",
      amount: 50000,
      balance_after: 50000,
      memo: "seed",
      payment_id: null,
      request_id: null,
      wallet_kind: "topup",
    });
  });

  test("balance_after belongs to the row's own wallet, never an aggregate", async () => {
    const res = await get(`/api/v1/workspaces/${WS}/ledger`);
    const body = (await res.json()) as { data: LedgerRow[] };
    const rows = Object.fromEntries(body.data.map((r) => [r.id, r]));
    // Subscription chain steps within its own wallet: 100000 -> 22000 -> 32000 -> 0.
    expect(rows["led-sub-credit"]!.balance_after).toBe(100000);
    expect(rows["led-sub-settle"]!.balance_after).toBe(22000);
    expect(rows["led-sub-refund"]!.balance_after).toBe(32000);
    expect(rows["led-sub-expiry"]!.balance_after).toBe(0);
    // The topup wallet snapshot is independent of the subscription chain.
    expect(rows["led-topup"]!.balance_after).toBe(50000);
  });

  test("order and limit preserved: newest first, limit honored", async () => {
    const res = await get(`/api/v1/workspaces/${WS}/ledger?limit=3`);
    const body = (await res.json()) as { data: LedgerRow[] };
    expect(body.data.length).toBe(3);
    const ats = body.data.map((r) => r.created_at);
    expect([...ats].sort((a, b) => b - a)).toEqual(ats);
    expect(body.data[0]!.id).toBe("led-sub-expiry");
  });

  test("cross-workspace ledger endpoint stays isolated", async () => {
    const res = await get(`/api/v1/workspaces/${OTHER_WS}/ledger`);
    const body = (await res.json()) as { data: LedgerRow[] };
    expect(body.data.map((r) => r.id)).toEqual(["led-other"]);
    expect(body.data[0]!.wallet_kind).toBe("topup");
  });
});
