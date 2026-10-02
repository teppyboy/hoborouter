// Regression: admin complete on a cancelled payment -> 409 INVALID_STATE (not 500).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Elysia } from "elysia";
import type { Db } from "@hoborouter/db";
import { createTestDb } from "@hoborouter/db";
import { sql } from "drizzle-orm";
import { adminExtraRoutes } from "../src/routes/admin-extra";

let db: Db;
let drop: () => Promise<void>;
const userId = "user-admin";

const authAs = (uid: string) => ({
  handler: async () => new Response("", { status: 404 }),
  api: { getSession: async () => ({ user: { id: uid }, session: { id: "s", userId: uid } }) },
});

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  drop = t.drop;
  const now = Date.now();
  await db.execute(
    sql`INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (${userId}, 'Admin', 'admin@test.dev', true, ${now}, ${now})`,
  );
  await db.execute(sql`INSERT INTO instance_admins (user_id, created_at) VALUES (${userId}, ${now})`);
});

afterAll(async () => {
  await drop();
});

describe("admin payments complete", () => {
  test("cancelled payment -> 409 INVALID_STATE", async () => {
    const now = Date.now();
    await db.execute(
      sql`INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws-x','ws-x','active',${now})`,
    );
    await db.execute(
      sql`INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at) VALUES ('pay-x','ws-x',1000,'cancelled','mock','MOCK-CXL-1',${now})`,
    );
    const app = new Elysia().use(adminExtraRoutes(db, authAs(userId)));
    const res = await app.handle(
      new Request("http://localhost/api/v1/admin/payments/pay-x/complete", { method: "POST" }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("INVALID_STATE");
  });
});
