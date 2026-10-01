// Task 4: POST /api/v1/dev/payments/:id/complete — dev-only completion fixture.
// Gated: NODE_ENV !== 'production' AND HBR_DEV_PAYMENTS === '1', else 404.
// Instance admin or workspace owner; credits through the same idempotent path.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import { createDb, migrate } from "@hoborouter/db";
import { devPaymentsRoutes } from "../src/routes/dev-payments";

const ws = "ws-dev";
let db: Database;

const authAs = (userId: string) => ({
  handler: async () => new Response("", { status: 404 }),
  api: { getSession: async () => ({ user: { id: userId }, session: { id: "s", userId } }) },
});
let userId = "user-dev";
let ownerId = userId;

function seedPayment(provider: string, orderCode: string, amount: number, wsId = ws) {
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at) VALUES (?,?,?,'pending',?,?,?)",
  ).run(id, wsId, amount, provider, orderCode, Date.now());
  return id;
}

function buildApp() {
  return new Elysia().use(devPaymentsRoutes(db, authAs(ownerId)));
}

const POST = (app: ReturnType<typeof buildApp>, id: string) =>
  app.handle(
    new Request(`http://localhost/api/v1/dev/payments/${id}/complete`, { method: "POST" }),
  );

beforeAll(() => {
  db = createDb(":memory:");
  migrate(db);
  db.prepare(
    "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?,?,?,1,?,?)",
  ).run(ownerId, "Owner", "owner@dev.test", Date.now(), Date.now());
  db.prepare("INSERT INTO workspaces (id, name, status, created_at) VALUES (?,?,'active',?)").run(
    ws,
    "ws",
    Date.now(),
  );
  db.prepare(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?,?,'owner')",
  ).run(ws, ownerId);
  db.prepare(
    "INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at) VALUES (?,?, 'VND', 0, 0, 0, ?)",
  ).run(`wal-${ws}`, ws, Date.now());
});

afterAll(() => {
  delete process.env.HBR_DEV_PAYMENTS;
});

const balance = () =>
  (db.prepare("SELECT balance FROM wallets WHERE workspace_id = ?").get(ws) as { balance: number })
    .balance;

describe("dev payments completion gate", () => {
  test("flag off -> 404, no credit", async () => {
    process.env.HBR_DEV_PAYMENTS = "0";
    delete process.env.NODE_ENV;
    const id = seedPayment("mock", "MOCK-DEV-1", 1000);
    const res = await POST(buildApp(), id);
    expect(res.status).toBe(404);
    expect(balance()).toBe(0);
  });

  test("NODE_ENV=production -> 404 even with flag on", async () => {
    process.env.HBR_DEV_PAYMENTS = "1";
    process.env.NODE_ENV = "production";
    const id = seedPayment("mock", "MOCK-DEV-2", 1000);
    const res = await POST(buildApp(), id);
    expect(res.status).toBe(404);
    expect(balance()).toBe(0);
    delete process.env.NODE_ENV;
  });

  test("flag on, non-production -> owner can complete a mock payment, credited once", async () => {
    process.env.HBR_DEV_PAYMENTS = "1";
    delete process.env.NODE_ENV;
    const id = seedPayment("mock", "MOCK-DEV-3", 5000);
    const res = await POST(buildApp(), id);
    expect(res.status).toBe(200);
    expect(balance()).toBe(5000);
    expect(
      (db.prepare("SELECT status FROM payments WHERE id = ?").get(id) as { status: string }).status,
    ).toBe("succeeded");
    // replay: still 200, no second credit
    const res2 = await POST(buildApp(), id);
    expect(res2.status).toBe(200);
    expect(balance()).toBe(5000);
  });

  test("works for payos payments too (same idempotent path)", async () => {
    process.env.HBR_DEV_PAYMENTS = "1";
    const id = seedPayment("payos", "999888777666", 7000);
    const res = await POST(buildApp(), id);
    expect(res.status).toBe(200);
    expect(balance()).toBe(12000);
  });

  test("unknown payment -> 404", async () => {
    process.env.HBR_DEV_PAYMENTS = "1";
    expect((await POST(buildApp(), "nope")).status).toBe(404);
  });
});
