// Regression: admin complete on a cancelled payment -> 409 INVALID_STATE (not 500).
import { describe, test, expect, beforeAll } from "bun:test";
import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import { createDb, migrate } from "@hoborouter/db";
import { adminExtraRoutes } from "../src/routes/admin-extra";

let db: Database;
const userId = "user-admin";

const authAs = (uid: string) => ({
  handler: async () => new Response("", { status: 404 }),
  api: { getSession: async () => ({ user: { id: uid }, session: { id: "s", userId: uid } }) },
});

beforeAll(() => {
  db = createDb(":memory:");
  migrate(db);
  const now = Date.now();
  db.prepare(
    "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?,?,?,1,?,?)",
  ).run(userId, "Admin", "admin@test.dev", now, now);
  db.prepare("INSERT INTO instance_admins (user_id, created_at) VALUES (?,?)").run(userId, now);
});

describe("admin payments complete", () => {
  test("cancelled payment -> 409 INVALID_STATE", async () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws-x','ws-x','active',?)",
    ).run(now);
    db.prepare(
      "INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at) VALUES ('pay-x','ws-x',1000,'cancelled','mock','MOCK-CXL-1',?)",
    ).run(now);
    const app = new Elysia().use(adminExtraRoutes(db, authAs(userId)));
    const res = await app.handle(
      new Request("http://localhost/api/v1/admin/payments/pay-x/complete", { method: "POST" }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("INVALID_STATE");
  });
});
