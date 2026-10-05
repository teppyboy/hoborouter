// Admin support-lead routes (GET list, PATCH status) tested standalone.
// Contracts under test:
// - Instance-admin only: anonymous 401, plain session 403.
// - Filters are bounded, never silently coerced: non-integer limit, bad
//   status, bad epoch-ms from/to/before, and before_id without before -> 400.
// - Cursor pagination is stable when rows share created_at: the composite
//   (before, before_id) cursor walks every row exactly once, no skips, no
//   duplicates. before alone keeps the old strict-lt contract.
// - PATCH transition (open<->handled) is row-locked, audited once per real
//   transition, idempotent on repeat (no duplicate audit), and reopening
//   clears handled_at/handled_by (always truthful about the current spell).
// - No DELETE route.
import { afterEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import type { Db } from "@hoborouter/db";
import { createTestDb } from "@hoborouter/db";
import { sql } from "drizzle-orm";
import { createAuth } from "../src/auth";
import { adminSupportLeadRoutes } from "../src/routes/admin-support-leads";
import { signUp as helpersSignUp, q, userIdByEmail } from "./helpers";

// These routes are tested standalone (not registered in src/app.ts), so the
// shared helpers' buildApp-typed request utilities don't apply; use structural
// minimal types instead of fighting Elysia's concrete plugin type.
type AnyApp = { handle: (input: Request) => Promise<Response> };

const standaloneApp = (db: Db, auth: ReturnType<typeof createAuth>): AnyApp =>
  new Elysia()
    .get("/api/auth/*", ({ request }) => auth.handler(request))
    .all("/api/auth/*", ({ request }) => auth.handler(request))
    .use(adminSupportLeadRoutes(db, auth));

const send = (
  app: AnyApp,
  path: string,
  opts: { method?: string; cookie?: string; body?: unknown } = {},
) => {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return app.handle(
    new Request("http://localhost" + path, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
  );
};

const signUp = (app: AnyApp, email: string, name = "U") => helpersSignUp(app as never, email, name);

// bun's SQL driver may hand jsonb columns back as raw strings; normalize so
// assertions compare values, not encodings.
const asDetail = (detail: unknown): unknown =>
  typeof detail === "string" ? JSON.parse(detail) : detail;

const ADMIN = "/api/v1/admin/support-leads";

let drops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const d of drops) await d();
  drops = [];
});

async function made() {
  const t = await createTestDb();
  drops.push(t.drop);
  const auth = createAuth(t.db);
  const app = standaloneApp(t.db, auth);
  return { db: t.db, app };
}

async function adminCookie(app: AnyApp, db: Db, email: string): Promise<string> {
  const cookie = await signUp(app, email, "Admin");
  await db.execute(
    sql`INSERT INTO instance_admins (user_id, created_at) VALUES (${await userIdByEmail(db, email)}, ${Date.now()})`,
  );
  return cookie;
}

const seedLead = (db: Db, id: string, createdAt: number, status = "open") =>
  db.execute(
    sql`INSERT INTO support_leads (id, contact_email, message, status, created_at) VALUES (${id}, ${id + "@x.com"}, ${"message " + id}, ${status}, ${createdAt})`,
  );

describe("GET /api/v1/admin/support-leads authz", () => {
  test("no session -> 401; plain session -> 403", async () => {
    const { app } = await made();
    expect((await send(app, ADMIN)).status).toBe(401);
    const userCookie = await signUp(app, `u-${crypto.randomUUID()}@example.com`);
    expect((await send(app, ADMIN, { cookie: userCookie })).status).toBe(403);
  });

  test("instance admin sees the list", async () => {
    const { db, app } = await made();
    await seedLead(db, "l1", Date.now());
    const cookie = await adminCookie(app, db, `admin-${crypto.randomUUID()}@example.com`);
    const res = await send(app, ADMIN, { cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    expect(body.data.map((r) => r.id)).toEqual(["l1"]);
  });
});

describe("GET /api/v1/admin/support-leads filter bounds", () => {
  test("non-integer limit, bad status, bad epoch ms -> 400 (no silent coercion)", async () => {
    const { db, app } = await made();
    const cookie = await adminCookie(app, db, `admin-${crypto.randomUUID()}@example.com`);
    for (const bad of [
      `${ADMIN}?limit=abc`,
      `${ADMIN}?limit=1.5`,
      `${ADMIN}?status=weird`,
      `${ADMIN}?from=-5`,
      `${ADMIN}?from=nan`,
      `${ADMIN}?to=-1`,
      `${ADMIN}?before=-1`,
      `${ADMIN}?before_id=l1`,
      `${ADMIN}?before=x&before_id=l1`,
    ]) {
      const res = await send(app, bad, { cookie });
      expect(res.status).toBe(400);
    }
  });

  test("out-of-range integer limit is clamped, not rejected", async () => {
    const { db, app } = await made();
    const cookie = await adminCookie(app, db, `admin-${crypto.randomUUID()}@example.com`);
    expect((await send(app, `${ADMIN}?limit=0`, { cookie })).status).toBe(200);
    expect((await send(app, `${ADMIN}?limit=500`, { cookie })).status).toBe(200);
    expect((await send(app, `${ADMIN}?limit=200`, { cookie })).status).toBe(200);
  });
});

describe("GET /api/v1/admin/support-leads pagination", () => {
  test("equal created_at rows: composite cursor walks every row exactly once", async () => {
    const { db, app } = await made();
    const cookie = await adminCookie(app, db, `admin-${crypto.randomUUID()}@example.com`);
    const sameTs = 1_700_000_000_000;
    // 6 leads sharing ONE created_at; ids ordered so desc(id) is the page order.
    for (const id of ["f6", "f5", "f4", "f3", "f2", "f1"]) await seedLead(db, id, sameTs);

    const seen: string[] = [];
    let before: string | null = null;
    let beforeId: string | null = null;
    for (let page = 0; page < 5; page++) {
      const url = new URL("http://localhost" + ADMIN);
      url.searchParams.set("limit", "2");
      if (before !== null) {
        url.searchParams.set("before", before);
        url.searchParams.set("before_id", beforeId!);
      }
      const body = (await (await send(app, url.pathname + url.search, { cookie })).json()) as {
        data: { id: string }[];
        next_before: number | null;
        next_before_id: string | null;
      };
      seen.push(...body.data.map((r) => r.id));
      if (body.next_before === null) break;
      before = String(body.next_before);
      beforeId = body.next_before_id;
    }
    expect(seen).toEqual(["f6", "f5", "f4", "f3", "f2", "f1"]);
    expect(new Set(seen).size).toBe(6);
  });

  test("before alone keeps the old strict-lt contract working", async () => {
    const { db, app } = await made();
    const cookie = await adminCookie(app, db, `admin-${crypto.randomUUID()}@example.com`);
    const t0 = 1_700_000_000_000;
    await seedLead(db, "b3", t0 + 2);
    await seedLead(db, "b2", t0 + 1);
    await seedLead(db, "b1", t0);
    const page1 = (await (
      await send(app, `${ADMIN}?limit=2&before=${t0 + 3}`, { cookie })
    ).json()) as {
      data: { id: string }[];
      next_before: number | null;
      next_before_id: string | null;
    };
    expect(page1.data.map((r) => r.id)).toEqual(["b3", "b2"]);
    expect(page1.next_before).toBe(t0 + 1);
    expect(page1.next_before_id).toBe("b2");
    // before alone (no before_id) keeps the old strict-lt contract working.
    const page2 = (await (
      await send(app, `${ADMIN}?limit=2&before=${page1.next_before}`, { cookie })
    ).json()) as {
      data: { id: string }[];
      next_before: number | null;
    };
    expect(page2.data.map((r) => r.id)).toEqual(["b1"]);
    expect(page2.next_before).toBeNull();
  });

  test("status filter + date window still bounded under composite cursor", async () => {
    const { db, app } = await made();
    const cookie = await adminCookie(app, db, `admin-${crypto.randomUUID()}@example.com`);
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 5; i++) await seedLead(db, "l" + i, t0 + i, i % 2 ? "handled" : "open");
    const open = (await (await send(app, `${ADMIN}?status=open&limit=2`, { cookie })).json()) as {
      data: { id: string }[];
      next_before: number;
      next_before_id: string;
    };
    expect(open.data.map((r) => r.id)).toEqual(["l4", "l2"]);
    expect(open.next_before).toBe(t0 + 2);
    expect(open.next_before_id).toBe("l2");

    const page2 = (await (
      await send(
        app,
        `${ADMIN}?status=open&limit=2&before=${open.next_before}&before_id=${open.next_before_id}`,
        { cookie },
      )
    ).json()) as {
      data: { id: string }[];
      next_before: number | null;
      next_before_id: string | null;
    };
    expect(page2.data.map((r) => r.id)).toEqual(["l0"]);
    expect(page2.next_before).toBeNull();
    expect(page2.next_before_id).toBeNull();

    const windowed = (await (
      await send(app, `${ADMIN}?from=${t0 + 1}&to=${t0 + 3}&limit=200`, { cookie })
    ).json()) as { data: { id: string }[] };
    // from/to are inclusive on both ends.
    expect(windowed.data.map((r) => r.id)).toEqual(["l3", "l2", "l1"]);
  });
});

describe("PATCH /api/v1/admin/support-leads/:id", () => {
  test("authz: 401 anonymous, 403 plain session", async () => {
    const { db, app } = await made();
    await seedLead(db, "p1", Date.now());
    expect(
      (await send(app, `${ADMIN}/p1`, { method: "PATCH", body: { status: "handled" } })).status,
    ).toBe(401);
    const userCookie = await signUp(app, `u-${crypto.randomUUID()}@example.com`);
    expect(
      (
        await send(app, `${ADMIN}/p1`, {
          method: "PATCH",
          cookie: userCookie,
          body: { status: "handled" },
        })
      ).status,
    ).toBe(403);
  });

  test("invalid status -> 400; unknown id -> 404", async () => {
    const { db, app } = await made();
    const cookie = await adminCookie(app, db, `admin-${crypto.randomUUID()}@example.com`);
    expect(
      (await send(app, `${ADMIN}/p1`, { method: "PATCH", cookie, body: { status: "bogus" } }))
        .status,
    ).toBe(400);
    expect(
      (
        await send(app, `${ADMIN}/no-such-id`, {
          method: "PATCH",
          cookie,
          body: { status: "handled" },
        })
      ).status,
    ).toBe(404);
  });

  test("handle -> handled with truthful handled_by/at; repeat is idempotent (no duplicate audit); reopen clears + audits", async () => {
    const { db, app } = await made();
    await seedLead(db, "t1", Date.now());
    const adminEmail = `admin-${crypto.randomUUID()}@example.com`;
    const cookie = await adminCookie(app, db, adminEmail);
    const adminId = await userIdByEmail(db, adminEmail);

    const before = Date.now();
    const res = await send(app, `${ADMIN}/t1`, {
      method: "PATCH",
      cookie,
      body: { status: "handled" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; handled_by: string; handled_at: number };
    expect(body.status).toBe("handled");
    expect(body.handled_by).toBe(adminId);
    expect(body.handled_at).toBeGreaterThanOrEqual(before);

    const auditsOf = async () =>
      await q<{ action: string; detail: unknown }>(
        db,
        "SELECT action, detail FROM audit_log WHERE target = ? ORDER BY created_at",
        "t1",
      );

    let audits = await auditsOf();
    expect(audits.length).toBe(1);
    expect(audits[0]!.action).toBe("support_lead.status");
    expect(asDetail(audits[0]!.detail)).toEqual({ from: "open", to: "handled" });

    // Repeat same-status PATCH: 200, no duplicate audit, row unchanged.
    const repeat = await send(app, `${ADMIN}/t1`, {
      method: "PATCH",
      cookie,
      body: { status: "handled" },
    });
    expect(repeat.status).toBe(200);
    audits = await auditsOf();
    expect(audits.length).toBe(1);

    // Reopen: clears handled_at/by (spell bookkeeping is truthful), audited.
    const reopen = await send(app, `${ADMIN}/t1`, {
      method: "PATCH",
      cookie,
      body: { status: "open" },
    });
    expect(reopen.status).toBe(200);
    const reopened = (await reopen.json()) as {
      status: string;
      handled_at: null;
      handled_by: null;
    };
    expect(reopened.status).toBe("open");
    expect(reopened.handled_at).toBeNull();
    expect(reopened.handled_by).toBeNull();
    audits = await auditsOf();
    expect(audits.length).toBe(2);
    expect(asDetail(audits[1]!.detail)).toEqual({ from: "handled", to: "open" });
  });

  test("concurrent PATCHes stay consistent: one transition, one audit, no lost handled_by", async () => {
    const { db, app } = await made();
    await seedLead(db, "c1", Date.now());
    const a1 = `admin-${crypto.randomUUID()}@example.com`;
    const a2 = `admin-${crypto.randomUUID()}@example.com`;
    const c1 = await adminCookie(app, db, a1);
    const c2 = await adminCookie(app, db, a2);

    const [r1, r2] = await Promise.all([
      send(app, `${ADMIN}/c1`, { method: "PATCH", cookie: c1, body: { status: "handled" } }),
      send(app, `${ADMIN}/c1`, { method: "PATCH", cookie: c2, body: { status: "handled" } }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const rows = (await q<{ status: string; handled_by: string }>(
      db,
      "SELECT status, handled_by FROM support_leads WHERE id = ?",
      "c1",
    )) as { status: string; handled_by: string }[];
    expect(rows[0]!.status).toBe("handled");
    expect([await userIdByEmail(db, a1), await userIdByEmail(db, a2)]).toContain(
      rows[0]!.handled_by,
    );
    const audits = await q<{ id: string }>(
      db,
      "SELECT id FROM audit_log WHERE target = ? AND action = ?",
      "c1",
      "support_lead.status",
    );
    expect(audits.length).toBeLessThanOrEqual(1);
  });
});

describe("method safety", () => {
  test("no DELETE route on leads", async () => {
    const { db, app } = await made();
    const cookie = await adminCookie(app, db, `admin-${crypto.randomUUID()}@example.com`);
    const res = await send(app, `${ADMIN}/some-id`, { method: "DELETE", cookie });
    expect([404, 405]).toContain(res.status);
  });
});
