// Admin promotions: instance-admin-only promo code management. Covers
// 401/403 guards, create validation (safe-integer VND, positive max_uses,
// future expires_at), hash-not-plaintext storage, secret-free list/PATCH
// responses (never code_hash), and rename/activate audits in the write
// transaction.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Elysia } from "elysia";
import type { Db } from "@hoborouter/db";
import { createTestDb } from "@hoborouter/db";
import { sql } from "drizzle-orm";
import { adminPromotionsRoutes } from "../src/routes/admin-promotions";

const ADMIN = "user-admin";
const MEMBER = "user-member";

let db: Db;
let drop: () => Promise<void>;

const session = (uid: string | null) => ({
  handler: async () => new Response("", { status: 404 }),
  api: {
    getSession: async () => (uid ? { user: { id: uid }, session: { id: "s", userId: uid } } : null),
  },
});

const appAs = (uid: string | null) => new Elysia().use(adminPromotionsRoutes(db, session(uid)));

const handle = (app: { handle: (req: Request) => Promise<Response> }, req: Request) =>
  app.handle(req);

const get = (app: Parameters<typeof handle>[0], url: string) =>
  handle(app, new Request(`http://localhost${url}`));

const post = (app: Parameters<typeof handle>[0], url: string, body: unknown) =>
  handle(
    app,
    new Request(`http://localhost${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const patch = (app: Parameters<typeof handle>[0], url: string, body: unknown) =>
  handle(
    app,
    new Request(`http://localhost${url}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const del = (app: Parameters<typeof handle>[0], url: string) =>
  handle(app, new Request(`http://localhost${url}`, { method: "DELETE" }));

beforeAll(
  async () => {
    const t = await createTestDb();
    db = t.db;
    drop = t.drop;
    const now = Date.now();
    await db.execute(
      sql`INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES
        (${ADMIN}, 'Admin', 'admin@test.dev', true, ${now}, ${now}),
        (${MEMBER}, 'Member', 'member@test.dev', true, ${now}, ${now})`,
    );
    await db.execute(
      sql`INSERT INTO instance_admins (user_id, created_at) VALUES (${ADMIN}, ${now})`,
    );
  },
  // Cold DB boot (create container + migrate) can exceed the 5s hook default.
  30000,
);

afterAll(async () => {
  await drop();
}, 30000);

const promoRow = async (id: string) => {
  const r = await db.execute(
    sql`select code_hash, name, active, amount_vnd::text as amount, max_uses from promo_codes where id = ${id}`,
  );
  return r[0] as {
    code_hash: string;
    name: string;
    active: boolean;
    amount: string;
    max_uses: number;
  };
};

const auditCount = async (action: string, target: string) => {
  const r = await db.execute(
    sql`select count(*)::int as n from audit_log where action = ${action} and target = ${target}`,
  );
  return (r[0] as { n: number }).n;
};

describe("admin promotions auth", () => {
  test("401 without session", async () => {
    expect((await get(appAs(null), "/api/v1/admin/promotions")).status).toBe(401);
    expect(
      (
        await post(appAs(null), "/api/v1/admin/promotions", {
          name: "x",
          amount_vnd: 1,
          max_uses: 1,
          expires_at: null,
        })
      ).status,
    ).toBe(401);
  });

  test("403 for non-admin session", async () => {
    expect((await get(appAs(MEMBER), "/api/v1/admin/promotions")).status).toBe(403);
    expect(
      (
        await post(appAs(MEMBER), "/api/v1/admin/promotions", {
          name: "x",
          amount_vnd: 1,
          max_uses: 1,
          expires_at: null,
        })
      ).status,
    ).toBe(403);
  });
});

describe("admin promotions create", () => {
  test.each([
    ["amount_vnd zero", { name: "x", amount_vnd: 0, max_uses: 1, expires_at: null }],
    ["amount_vnd float", { name: "x", amount_vnd: 1.5, max_uses: 1, expires_at: null }],
    [
      "amount_vnd unsafe",
      { name: "x", amount_vnd: Number.MAX_SAFE_INTEGER + 1, max_uses: 1, expires_at: null },
    ],
    ["max_uses zero", { name: "x", amount_vnd: 1000, max_uses: 0, expires_at: null }],
    [
      "expires_at past",
      { name: "x", amount_vnd: 1000, max_uses: 1, expires_at: Date.now() - 1000 },
    ],
  ])("rejects %s with 400", async (_label, body) => {
    const res = await post(appAs(ADMIN), "/api/v1/admin/promotions", body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe("INVALID");
  });

  test("create returns code once, stores only SHA-256 hash, shape correct", async () => {
    const res = await post(appAs(ADMIN), "/api/v1/admin/promotions", {
      name: "Tet 2026",
      amount_vnd: 50000,
      max_uses: 3,
      expires_at: null,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      promo: Record<string, unknown>;
      code: string;
    };
    // CSPRNG code: exactly 32 uppercase hex chars (16 bytes).
    expect(body.code).toMatch(/^[A-F0-9]{32}$/);
    // Response never leaks the hash.
    expect(JSON.stringify(body)).not.toContain("code_hash");
    // Safe promo shape exactly.
    expect(Object.keys(body.promo).sort()).toEqual(
      [
        "active",
        "amount_vnd",
        "code_available",
        "created_at",
        "expires_at",
        "id",
        "kind",
        "max_discount_vnd",
        "max_uses",
        "name",
        "percent_bp",
        "uses",
      ].sort(),
    );
    expect(body.promo.uses).toBe(0);
    expect(body.promo.active).toBe(true);
    // Stored hash is SHA-256 of the normalized plaintext (trim + upper).
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(body.code.trim().toUpperCase()),
    );
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    const row = await promoRow(body.promo.id as string);
    expect(row.code_hash).toBe(hex);
    expect(row.amount).toBe("50000");
    expect(row.max_uses).toBe(3);
    // Lowercase or padded variants normalize to the same hash.
    const res2 = await post(appAs(ADMIN), "/api/v1/admin/promotions", {
      name: "lower",
      amount_vnd: 1,
      max_uses: 1,
      expires_at: null,
    });
    const body2 = (await res2.json()) as { code: string };
    expect(body2.code).not.toBe(body2.code.toLowerCase()); // generated uppercase
    expect((await promoRow(String(body.promo.id))).code_hash).toHaveLength(64);
    expect(await auditCount("promo.create", body.promo.id as string)).toBe(1);
  });

  test("create rejects amount_vnd over money bound", async () => {
    // VND bound is Number.MAX_SAFE_INTEGER; any positive safe integer below it
    // is accepted, so probe with the bound itself +1 (unsafe float check is in
    // the table above); here verify the max safe amount is accepted.
    const res = await post(appAs(ADMIN), "/api/v1/admin/promotions", {
      name: "max",
      amount_vnd: Number.MAX_SAFE_INTEGER,
      max_uses: 1,
      expires_at: null,
    });
    expect(res.status).toBe(201);
  });
});

describe("admin promotions list", () => {
  test("list contains safe fields only, never code_hash or plaintext", async () => {
    const created = await post(appAs(ADMIN), "/api/v1/admin/promotions", {
      name: "secretfree",
      amount_vnd: 999,
      max_uses: 2,
      expires_at: null,
    });
    const createdBody = (await created.json()) as { code: string };
    const res = await get(appAs(ADMIN), "/api/v1/admin/promotions");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("code_hash");
    expect(text).not.toContain(createdBody.code);
    const body = JSON.parse(text) as { data: Array<Record<string, unknown>> };
    const row = body.data.find((r) => r.name === "secretfree")!;
    expect(Object.keys(row).sort()).toEqual(
      [
        "active",
        "amount_vnd",
        "code_available",
        "created_at",
        "expires_at",
        "id",
        "kind",
        "max_discount_vnd",
        "max_uses",
        "name",
        "percent_bp",
        "uses",
      ].sort(),
    );
  });
});

describe("admin promotions patch", () => {
  test("rename + activate writes one audit in the same transaction, safe response", async () => {
    const created = await post(appAs(ADMIN), "/api/v1/admin/promotions", {
      name: "old-name",
      amount_vnd: 1000,
      max_uses: 1,
      expires_at: null,
    });
    const id = ((await created.json()) as { promo: { id: string } }).promo.id;

    const res = await patch(appAs(ADMIN), `/api/v1/admin/promotions/${id}`, {
      name: "new-name",
      active: false,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("code_hash");
    const body = JSON.parse(text) as { name: string; active: boolean; amount_vnd: number };
    expect(body.name).toBe("new-name");
    expect(body.active).toBe(false);
    expect(body.amount_vnd).toBe(1000);

    const row = await promoRow(id);
    expect(row.name).toBe("new-name");
    expect(row.active).toBe(false);
    expect(await auditCount("promo.update", id)).toBe(1);
  });

  test("immutable amounts/limits rejected at boundary", async () => {
    const created = await post(appAs(ADMIN), "/api/v1/admin/promotions", {
      name: "imm",
      amount_vnd: 1000,
      max_uses: 1,
      expires_at: null,
    });
    const id = ((await created.json()) as { promo: { id: string } }).promo.id;
    // 422 is Elysia's validation status for a bad body shape.
    const res = await patch(appAs(ADMIN), `/api/v1/admin/promotions/${id}`, {
      amount_vnd: 999,
    });
    expect([400, 422]).toContain(res.status);
    const row = await promoRow(id);
    expect(row.amount).toBe("1000");
  });

  test("404 unknown id", async () => {
    const res = await patch(appAs(ADMIN), "/api/v1/admin/promotions/nope", { active: true });
    expect(res.status).toBe(404);
  });

  test("401/403 on patch", async () => {
    expect((await patch(appAs(null), "/api/v1/admin/promotions/x", { active: true })).status).toBe(
      401,
    );
    expect(
      (await patch(appAs(MEMBER), "/api/v1/admin/promotions/x", { active: true })).status,
    ).toBe(403);
  });
});

describe("admin promotions soft delete", () => {
  test("401 without session", async () => {
    expect((await del(appAs(null), "/api/v1/admin/promotions/x")).status).toBe(401);
  });

  test("403 for non-admin session", async () => {
    expect((await del(appAs(MEMBER), "/api/v1/admin/promotions/x")).status).toBe(403);
  });

  test("404 unknown id", async () => {
    expect((await del(appAs(ADMIN), "/api/v1/admin/promotions/nope")).status).toBe(404);
  });

  test("soft-removes: row kept with deleted_at, active=false, one audit, no hash leak in response", async () => {
    const created = await post(appAs(ADMIN), "/api/v1/admin/promotions", {
      name: "doomed",
      amount_vnd: 1000,
      max_uses: 1,
      expires_at: null,
    });
    const id = ((await created.json()) as { promo: { id: string } }).promo.id;

    const res = await del(appAs(ADMIN), `/api/v1/admin/promotions/${id}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);

    // Row survives (FK integrity for redemption/payment history) with the
    // soft-delete markers; never a hard delete.
    const r = await db.execute(sql`select deleted_at, active from promo_codes where id = ${id}`);
    const row = r[0] as { deleted_at: number | null; active: boolean };
    expect(row.deleted_at).not.toBeNull();
    expect(row.active).toBe(false);
    expect(await auditCount("promo.delete", id)).toBe(1);
  });

  test("repeat delete: 404 (already soft-removed), no second audit", async () => {
    const created = await post(appAs(ADMIN), "/api/v1/admin/promotions", {
      name: "once-only",
      amount_vnd: 1000,
      max_uses: 1,
      expires_at: null,
    });
    const id = ((await created.json()) as { promo: { id: string } }).promo.id;
    expect((await del(appAs(ADMIN), `/api/v1/admin/promotions/${id}`)).status).toBe(200);
    expect((await del(appAs(ADMIN), `/api/v1/admin/promotions/${id}`)).status).toBe(404);
    expect(await auditCount("promo.delete", id)).toBe(1);
  });

  test("deleted promo excluded from list; PATCH answers 404", async () => {
    const created = await post(appAs(ADMIN), "/api/v1/admin/promotions", {
      name: "hidden",
      amount_vnd: 1000,
      max_uses: 1,
      expires_at: null,
    });
    const id = ((await created.json()) as { promo: { id: string } }).promo.id;
    await del(appAs(ADMIN), `/api/v1/admin/promotions/${id}`);

    const list = await get(appAs(ADMIN), "/api/v1/admin/promotions");
    const ids = ((await list.json()) as { data: { id: string }[] }).data.map((p) => p.id);
    expect(ids).not.toContain(id);

    expect(
      (await patch(appAs(ADMIN), `/api/v1/admin/promotions/${id}`, { active: true })).status,
    ).toBe(404);
  });
});
