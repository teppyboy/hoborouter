// GET /api/v1/admin/users serialization contract: created_at must be a JSON
// number (epoch ms) and workspace_count a JSON number — Bun SQL returns PG
// bigint/count(*) as strings, which broke the web Joined column.
import { afterEach, describe, expect, test } from "bun:test";
import { makeApp, makeInstanceAdmin, req, signUp, userIdByEmail } from "./helpers";

async function makeAdmin(
  app: Awaited<ReturnType<typeof makeApp>>["app"],
  db: Awaited<ReturnType<typeof makeApp>>["db"],
): Promise<string> {
  const email = `admin-${crypto.randomUUID()}@example.com`;
  const cookie = await signUp(app, email, "Admin");
  await makeInstanceAdmin(db, await userIdByEmail(db, email));
  return cookie;
}

async function mkUser(
  app: Awaited<ReturnType<typeof makeApp>>["app"],
  cookie: string,
  email: string,
  name: string,
) {
  const res = await req(app, "/api/v1/admin/users", {
    method: "POST",
    cookie,
    body: { name, email, password: "Correct-Horse-Battery-Staple-1" },
  });
  if (res.status !== 201) throw new Error(`mkUser failed ${res.status}`);
}

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

  test("q matches email substring, name substring, and exact id; miss yields empty + total 0", async () => {
    const made = await makeApp();
    drops.push(made.close);
    const { db, app } = made;
    const cookie = await makeAdmin(app, db);
    const suffix = crypto.randomUUID().slice(0, 8);
    await mkUser(app, cookie, `zed-${suffix}@example.com`, "Zeta");
    await mkUser(app, cookie, `other-${suffix}@example.com`, "Zebra Alpha");
    const byEmail = await req(app, `/api/v1/admin/users?q=zed-${suffix}`, { cookie });
    const eBody = (await byEmail.json()) as { data: { email: string }[]; total: number };
    expect(eBody.total).toBe(1);
    expect(eBody.data[0]!.email).toBe(`zed-${suffix}@example.com`);
    const byName = await req(app, `/api/v1/admin/users?q=${encodeURIComponent("Zebra Alpha")}`, {
      cookie,
    });
    expect(((await byName.json()) as { total: number }).total).toBe(1);
    const targetId = await userIdByEmail(db, `zed-${suffix}@example.com`);
    const byId = await req(app, `/api/v1/admin/users?q=${targetId}`, { cookie });
    expect(((await byId.json()) as { total: number }).total).toBe(1);
    const miss = await req(app, "/api/v1/admin/users?q=nobody-here-xyz", { cookie });
    const mBody = (await miss.json()) as { data: unknown[]; total: number };
    expect(mBody.total).toBe(0);
    expect(mBody.data).toEqual([]);
  });

  test("role filter admin/member; sort email/name asc/desc with stable id tiebreak; limit/offset windows", async () => {
    const made = await makeApp();
    drops.push(made.close);
    const { db, app } = made;
    const cookie = await makeAdmin(app, db);
    const tag = crypto.randomUUID().slice(0, 8);
    await mkUser(app, cookie, `a-${tag}@example.com`, "Ada");
    await mkUser(app, cookie, `b-${tag}@example.com`, "Ben");
    const admins = await req(app, "/api/v1/admin/users?role=admin", { cookie });
    const aBody = (await admins.json()) as { data: { is_instance_admin: boolean }[]; total: number };
    expect(aBody.total).toBe(1);
    expect(aBody.data.every((u) => u.is_instance_admin)).toBe(true);
    const members = await req(app, `/api/v1/admin/users?role=member&sort=email&order=asc&limit=2`, {
      cookie,
    });
    const mBody = (await members.json()) as {
      data: { email: string; id: string }[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(mBody.total).toBeGreaterThanOrEqual(2);
    expect(mBody.limit).toBe(2);
    expect(mBody.data).toHaveLength(2);
    const emails = mBody.data.map((u) => u.email);
    expect([...emails].sort()).toEqual(emails); // asc
    // Stable pagination: same page repeats, next window continues.
    const page2 = await req(app, `/api/v1/admin/users?role=member&sort=email&order=asc&limit=2&offset=2`, {
      cookie,
    });
    const p2 = (await page2.json()) as { data: { id: string }[] };
    const ids1 = new Set(mBody.data.map((u) => u.id));
    expect(p2.data.every((u) => !ids1.has(u.id))).toBe(true);
    // desc reverses the same window.
    const descRes = await req(app, `/api/v1/admin/users?role=member&sort=email&order=desc&limit=2`, {
      cookie,
    });
    const dBody = (await descRes.json()) as { data: { email: string }[] };
    expect(dBody.data.map((u) => u.email)).toEqual([...emails].reverse());
  });

  test("unknown/invalid query params rejected 400; every other param also switches to paged shape", async () => {
    const made = await makeApp();
    drops.push(made.close);
    const { app } = made;
    const { db } = made;
    const cookie = await makeAdmin(app, db);
    const bad = await req(app, "/api/v1/admin/users?sort=id", { cookie });
    expect(bad.status).toBe(400);
    const badLimit = await req(app, "/api/v1/admin/users?limit=1000", { cookie });
    expect(badLimit.status).toBe(400);
    const unknown = await req(app, "/api/v1/admin/users?bogus=1", { cookie });
    expect(unknown.status).toBe(400);
    // Any valid param switches to the paged envelope.
    const paged = await req(app, "/api/v1/admin/users?limit=1", { cookie });
    const body = (await paged.json()) as { total: number; limit: number; offset: number };
    expect(paged.status).toBe(200);
    expect(body.limit).toBe(1);
    expect(typeof body.total).toBe("number");
    expect(typeof body.offset).toBe("number");
  });
});
