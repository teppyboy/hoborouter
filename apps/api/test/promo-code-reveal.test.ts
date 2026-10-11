// Promo code repeat view (unlike sk-hbr- API keys): the plaintext code is
// stored with authenticated encryption at rest (AES-256-GCM, key = HKDF-SHA256
// of the server-only auth secret, AAD binds the ciphertext to the promo row)
// so an instance admin can re-view a code without any plaintext-or-hash
// storage. Covers: ciphertext-not-plaintext at rest, reveal roundtrip, admin
// guards, CODE_UNAVAILABLE error policy (legacy rows / rotated secret /
// tampering), soft-deleted exclusion, audited reveal without secrets, and the
// safe list shape (code_available but never code_hash/code_encrypted).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Elysia } from "elysia";
import type { Db } from "@hoborouter/db";
import { createTestDb } from "@hoborouter/db";
import { sql } from "drizzle-orm";
import { adminPromotionsRoutes } from "../src/routes/admin-promotions";

const ADMIN = "user-admin";
const MEMBER = "user-member";

// >=32 chars; the same resolution the auth secret uses.
const SECRET = "promo-reveal-test-secret-0123456789abcdef";
const SECRET2 = "rotated-promo-reveal-test-secret-0123456789";
const env = (secret: string): Record<string, string> => ({ BETTER_AUTH_SECRET: secret });

let db: Db;
let drop: () => Promise<void>;

const session = (uid: string | null) => ({
  handler: async () => new Response("", { status: 404 }),
  api: {
    getSession: async () => (uid ? { user: { id: uid }, session: { id: "s", userId: uid } } : null),
  },
});

const appAs = (uid: string | null, secret: string = SECRET) =>
  new Elysia().use(adminPromotionsRoutes(db, session(uid), env(secret)));

// Loose app type: Elysia's chained generic type grows with every route and
// does not survive helper parameter positions (same approach as the other
// admin route suites).
type App = { handle: (req: Request) => Promise<Response> };

const handle = (app: App, req: Request) => app.handle(req);
const get = (app: App, url: string) => handle(app, new Request(`http://localhost${url}`));
const post = (app: App, url: string, body: unknown) =>
  handle(
    app,
    new Request(`http://localhost${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const createPromo = async (
  app: App,
  body: Record<string, unknown>,
): Promise<{ status: number; promo?: { id: string }; code?: string }> => {
  const res = await post(app, "/api/v1/admin/promotions", body);
  const j = (await res.json()) as { promo?: { id: string }; code?: string };
  return { status: res.status, promo: j.promo, code: j.code };
};

const rawRow = async (id: string) => {
  const r = await db.execute(
    sql`select code_hash, code_encrypted, name, deleted_at from promo_codes where id = ${id}`,
  );
  return r[0] as {
    code_hash: string;
    code_encrypted: string | null;
    name: string;
    deleted_at: number | null;
  };
};

const auditDetail = async (action: string, target: string) => {
  const r = await db.execute(
    sql`select detail from audit_log where action = ${action} and target = ${target} order by created_at desc limit 1`,
  );
  return (r[0] as { detail: unknown } | undefined)?.detail;
};

beforeAll(async () => {
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
}, 30000);

afterAll(async () => {
  await drop();
}, 30000);

describe("promo code encrypted at-rest storage", () => {
  test("create stores ciphertext (and hash), never the plaintext", async () => {
    const { status, promo, code } = await createPromo(appAs(ADMIN), {
      name: "At rest",
      amount_vnd: 50000,
      max_uses: 1,
      expires_at: null,
      code: " christmas-deal-42 ",
    });
    expect(status).toBe(201);
    expect(code).toBe("CHRISTMAS-DEAL-42");
    const row = await rawRow(promo!.id);
    expect(row.code_encrypted).not.toBeNull();
    expect(row.code_encrypted).not.toContain("CHRISTMAS-DEAL-42");
    expect(row.code_encrypted).not.toBe(row.code_hash);
  });

  test("reveal roundtrips the normalized plaintext", async () => {
    const { promo } = await createPromo(appAs(ADMIN), {
      name: "Reveal me",
      amount_vnd: 1000,
      max_uses: 1,
      expires_at: null,
      code: "roundtrip-7",
    });
    const res = await get(appAs(ADMIN), `/api/v1/admin/promotions/${promo!.id}/code`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: "ROUNDTRIP-7" });
  });

  test("generated code reveal roundtrips the create-response code", async () => {
    const { promo, code } = await createPromo(appAs(ADMIN), {
      name: "Generated",
      amount_vnd: 1000,
      max_uses: 1,
      expires_at: null,
    });
    expect(code).toMatch(/^[A-F0-9]{32}$/);
    const res = await get(appAs(ADMIN), `/api/v1/admin/promotions/${promo!.id}/code`);
    expect(await res.json()).toEqual({ code });
  });
});

describe("promo code reveal guards", () => {
  test("401 without session, 403 for non-admin", async () => {
    const { promo } = await createPromo(appAs(ADMIN), {
      name: "Guarded",
      amount_vnd: 1000,
      max_uses: 1,
      expires_at: null,
    });
    expect((await get(appAs(null), `/api/v1/admin/promotions/${promo!.id}/code`)).status).toBe(401);
    expect((await get(appAs(MEMBER), `/api/v1/admin/promotions/${promo!.id}/code`)).status).toBe(403);
  });
});

describe("reveal error policy", () => {
  test("legacy row (no ciphertext) answers 409 CODE_UNAVAILABLE, never a 500", async () => {
    const now = Date.now();
    const legacyId = crypto.randomUUID();
    await db.execute(
      sql`INSERT INTO promo_codes (id, code_hash, name, kind, amount_vnd, max_uses, uses, active, created_at)
          VALUES (${legacyId}, ${"f".repeat(64)}, 'Legacy', 'fixed', 1000, 1, 0, true, ${now})`,
    );
    const res = await get(appAs(ADMIN), `/api/v1/admin/promotions/${legacyId}/code`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "CODE_UNAVAILABLE",
    );
  });

  test("rotated server secret answers 409 CODE_UNAVAILABLE", async () => {
    const { promo } = await createPromo(appAs(ADMIN), {
      name: "Rotated",
      amount_vnd: 1000,
      max_uses: 1,
      expires_at: null,
    });
    const res = await get(appAs(ADMIN, SECRET2), `/api/v1/admin/promotions/${promo!.id}/code`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "CODE_UNAVAILABLE",
    );
  });

  test("tampered ciphertext answers 409, no partial plaintext", async () => {
    const { promo } = await createPromo(appAs(ADMIN), {
      name: "Tampered",
      amount_vnd: 1000,
      max_uses: 1,
      expires_at: null,
    });
    const row = await rawRow(promo!.id);
    const raw = Buffer.from(row.code_encrypted!, "base64");
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff;
    await db.execute(
      sql`update promo_codes set code_encrypted = ${raw.toString("base64")} where id = ${promo!.id}`,
    );
    const res = await get(appAs(ADMIN), `/api/v1/admin/promotions/${promo!.id}/code`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("CODE_UNAVAILABLE");
    expect(JSON.stringify(body)).not.toContain("TAMPERED");
  });

  test("soft-deleted code is not re-viewable (404)", async () => {
    const { promo } = await createPromo(appAs(ADMIN), {
      name: "Deleted view",
      amount_vnd: 1000,
      max_uses: 1,
      expires_at: null,
    });
    const del = await handle(
      appAs(ADMIN),
      new Request(`http://localhost/api/v1/admin/promotions/${promo!.id}`, { method: "DELETE" }),
    );
    expect(del.status).toBe(200);
    const res = await get(appAs(ADMIN), `/api/v1/admin/promotions/${promo!.id}/code`);
    expect(res.status).toBe(404);
  });
});

describe("reveal audit", () => {
  test("reveal is audited without plaintext, ciphertext, or hash", async () => {
    const { promo, code } = await createPromo(appAs(ADMIN), {
      name: "Audited reveal",
      amount_vnd: 1000,
      max_uses: 1,
      expires_at: null,
    });
    await get(appAs(ADMIN), `/api/v1/admin/promotions/${promo!.id}/code`);
    const detail = await auditDetail("promo.reveal_code", promo!.id);
    expect(detail).not.toBeUndefined();
    const s = JSON.stringify(detail);
    expect(s).toContain("Audited reveal");
    expect(s).not.toContain(code!);
    expect(s).not.toContain("code_encrypted");
  });
});

describe("safe list shape with code_available", () => {
  test("list carries code_available but never code_hash/code_encrypted", async () => {
    await createPromo(appAs(ADMIN), {
      name: "List shape",
      amount_vnd: 1000,
      max_uses: 1,
      expires_at: null,
    });
    const res = await get(appAs(ADMIN), "/api/v1/admin/promotions");
    const j = (await res.json()) as { data: Array<Record<string, unknown>> };
    const row = j.data.find((r) => r.name === "List shape")!;
    expect(row.code_available).toBe(true);
    expect("code_hash" in row).toBe(false);
    expect("code_encrypted" in row).toBe(false);
    const s = JSON.stringify(j);
    expect(s).not.toContain("List shape".toUpperCase());
    expect(s.toLowerCase()).not.toContain("code_hash");
  });
});
