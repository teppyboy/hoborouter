// GET /api/v1/admin/users serialization contract: created_at must be a JSON
// number (epoch ms) and workspace_count a JSON number — Bun SQL returns PG
// bigint/count(*) as strings, which broke the web Joined column.
import { afterEach, describe, expect, test } from "bun:test";
import { makeApp, makeInstanceAdmin, req, signUp, userIdByEmail } from "./helpers";

let drops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const d of drops) await d();
  drops = [];
});

describe("GET /api/v1/admin/users", () => {
  test("created_at and workspace_count are JSON numbers", async () => {
    const made = await makeApp();
    drops.push(made.close);
    const { db, app } = made;
    const email = `admin-${crypto.randomUUID()}@example.com`;
    const before = Date.now();
    const cookie = await signUp(app, email, "Admin");
    await makeInstanceAdmin(db, await userIdByEmail(db, email));

    const res = await req(app, "/api/v1/admin/users", { cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { email: string; created_at: unknown; workspace_count: unknown }[];
    };
    const row = body.data.find((u) => u.email === email);
    expect(row).toBeDefined();
    expect(typeof row!.created_at).toBe("number");
    expect(row!.created_at as number).toBeGreaterThanOrEqual(before);
    expect(row!.created_at as number).toBeLessThanOrEqual(Date.now());
    expect(typeof row!.workspace_count).toBe("number");
    expect(row!.workspace_count).toBe(0);
  });

  test("non-admin 403", async () => {
    const made = await makeApp();
    drops.push(made.close);
    const { app } = made;
    const cookie = await signUp(app, `u-${crypto.randomUUID()}@example.com`);
    const res = await req(app, "/api/v1/admin/users", { cookie });
    expect(res.status).toBe(403);
  });
});
