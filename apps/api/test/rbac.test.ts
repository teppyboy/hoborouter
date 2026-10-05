// Task 3B: route matrix RBAC (api-boundaries.md §2), cross-workspace denial,
// instance-admin independence, bootstrap idempotence, owner lockout.
import { beforeAll, describe, expect, test } from "bun:test";
import type { Db } from "@hoborouter/db";
import { sql } from "drizzle-orm";
import {
  makeApp,
  signUp,
  req,
  createWorkspace,
  addMember,
  makeInstanceAdmin,
  userIdByEmail,
} from "./helpers";
import { bootstrapInstanceAdmin } from "../src/instance-admin";

let ctx: Awaited<ReturnType<typeof makeApp>>;
let db: Db;
const A = "ws-a";
const B = "ws-b";

const OWNER = "owner@example.com";
const ADMIN = "admin@example.com";
const MEMBER = "member@example.com";
const OUTSIDER = "outsider@example.com";
const INST = "inst@example.com";
const NEWBIE = "newbie@example.com";

let owner: string, admin: string, member: string, outsider: string, inst: string, newbie: string;

beforeAll(async () => {
  ctx = await makeApp();
  db = ctx.db;
  const cookies: Record<string, string> = {};
  for (const [email, name] of [
    [OWNER, "O"],
    [ADMIN, "Ad"],
    [MEMBER, "M"],
    [OUTSIDER, "X"],
    [INST, "I"],
    [NEWBIE, "N"],
  ] as const) {
    cookies[email] = await signUp(ctx.app, email, name);
  }
  newbie = cookies[NEWBIE]!;
  owner = cookies[OWNER]!;
  admin = cookies[ADMIN]!;
  member = cookies[MEMBER]!;
  outsider = cookies[OUTSIDER]!;
  inst = cookies[INST]!;

  const ownerId = await userIdByEmail(db, OWNER);
  const adminId = await userIdByEmail(db, ADMIN);
  const memberId = await userIdByEmail(db, MEMBER);
  await createWorkspace(db, A, ownerId, "A");
  await addMember(db, A, adminId, "admin");
  await addMember(db, A, memberId, "member");
  const outsiderId = await userIdByEmail(db, OUTSIDER);
  await createWorkspace(db, B, outsiderId, "B");
  await makeInstanceAdmin(db, await userIdByEmail(db, INST));
});

// POST /api/v1/workspaces — any authenticated user ✓
describe("workspace create/list", () => {
  test("member can create own workspace (becomes owner)", async () => {
    const res = await req(ctx.app, "/api/v1/workspaces", {
      method: "POST",
      cookie: member,
      body: { name: "M's ws" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    const rows = (await db.execute(
      sql`SELECT role FROM workspace_members WHERE workspace_id = ${body.id} AND user_id = ${await userIdByEmail(db, MEMBER)}`,
    )) as unknown as { role: string }[];
    expect(rows[0]!.role).toBe("owner");
  });

  test("list shows only own memberships", async () => {
    const res = await req(ctx.app, "/api/v1/workspaces", { cookie: member });
    const list = (await res.json()) as { id: string }[];
    expect(list.map((w) => w.id)).toContain(A);
    expect(list.length).toBe(2);
  });
});

// Detail/delete: member ✓ detail, — delete; instance admin — on ws-scoped
describe("workspace detail + delete", () => {
  test("member GET detail → 200", async () => {
    expect((await req(ctx.app, `/api/v1/workspaces/${A}`, { cookie: member })).status).toBe(200);
  });

  test("member DELETE → 403", async () => {
    expect(
      (await req(ctx.app, `/api/v1/workspaces/${A}`, { method: "DELETE", cookie: member })).status,
    ).toBe(403);
  });

  test("admin DELETE → 403", async () => {
    expect(
      (await req(ctx.app, `/api/v1/workspaces/${A}`, { method: "DELETE", cookie: admin })).status,
    ).toBe(403);
  });

  test("owner DELETE → 200", async () => {
    const res = await req(ctx.app, `/api/v1/workspaces/${B}`, {
      method: "DELETE",
      cookie: outsider,
    });
    expect(res.status).toBe(200);
  });

  test("instance admin GET ws detail → 403 (no implicit workspace role)", async () => {
    expect((await req(ctx.app, `/api/v1/workspaces/${A}`, { cookie: inst })).status).toBe(403);
  });

  test("cross-workspace: member of A GET ws B (recreated) → 403", async () => {
    await createWorkspace(db, B, await userIdByEmail(db, OUTSIDER), "B2");
    expect((await req(ctx.app, `/api/v1/workspaces/${B}`, { cookie: member })).status).toBe(403);
  });

  test("unrelated user DELETE someone else's ws → 403", async () => {
    expect(
      (await req(ctx.app, `/api/v1/workspaces/${A}`, { method: "DELETE", cookie: outsider }))
        .status,
    ).toBe(403);
  });
});

// Members CRUD + role mutation: owner-only per matrix
describe("members CRUD", () => {
  test("member GET members → 200", async () => {
    expect((await req(ctx.app, `/api/v1/workspaces/${A}/members`, { cookie: member })).status).toBe(
      200,
    );
  });

  test("member POST member → 403", async () => {
    expect(
      (
        await req(ctx.app, `/api/v1/workspaces/${A}/members`, {
          method: "POST",
          cookie: member,
          body: { email: NEWBIE, role: "member" },
        })
      ).status,
    ).toBe(403);
  });

  test("admin POST member → 403", async () => {
    expect(
      (
        await req(ctx.app, `/api/v1/workspaces/${A}/members`, {
          method: "POST",
          cookie: admin,
          body: { email: NEWBIE, role: "member" },
        })
      ).status,
    ).toBe(403);
  });

  test("owner POST member → 200, role persisted", async () => {
    const res = await req(ctx.app, `/api/v1/workspaces/${A}/members`, {
      method: "POST",
      cookie: owner,
      body: { email: NEWBIE, role: "member" },
    });
    expect(res.status).toBe(201);
  });

  test("POST member with unknown email → 404", async () => {
    expect(
      (
        await req(ctx.app, `/api/v1/workspaces/${A}/members`, {
          method: "POST",
          cookie: owner,
          body: { email: "ghost@example.com", role: "member" },
        })
      ).status,
    ).toBe(404);
  });

  test("instance admin POST member → 403 (no implicit role)", async () => {
    expect(
      (
        await req(ctx.app, `/api/v1/workspaces/${A}/members`, {
          method: "POST",
          cookie: inst,
          body: { email: NEWBIE, role: "admin" },
        })
      ).status,
    ).toBe(403);
  });

  test("owner PATCH member role → 200; audit written", async () => {
    const newbieId = await userIdByEmail(db, NEWBIE);
    const res = await req(ctx.app, `/api/v1/workspaces/${A}/members/${newbieId}`, {
      method: "PATCH",
      cookie: owner,
      body: { role: "admin" },
    });
    expect(res.status).toBe(200);
    const roleRows = (await db.execute(
      sql`SELECT role FROM workspace_members WHERE workspace_id = ${A} AND user_id = ${newbieId}`,
    )) as unknown as { role: string }[];
    expect(roleRows[0]!.role).toBe("admin");
    const auditRows = (await db.execute(
      sql`SELECT count(*) AS c FROM audit_log WHERE workspace_id = ${A} AND action LIKE 'member.%'`,
    )) as unknown as { c: string }[];
    expect(Number(auditRows[0]!.c)).toBeGreaterThan(0);
  });

  test("cross-workspace: owner of A PATCH member of B → 403", async () => {
    const outsiderId = await userIdByEmail(db, OUTSIDER);
    expect(
      (
        await req(ctx.app, `/api/v1/workspaces/${A}/members/${outsiderId}`, {
          method: "PATCH",
          cookie: owner,
          body: { role: "member" },
        })
      ).status,
    ).toBe(403);
  });

  test("no owner lockout: demoting the ONLY owner → 409; removing → 409", async () => {
    const ownerId = await userIdByEmail(db, OWNER);
    expect(
      (
        await req(ctx.app, `/api/v1/workspaces/${A}/members/${ownerId}`, {
          method: "PATCH",
          cookie: owner,
          body: { role: "member" },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await req(ctx.app, `/api/v1/workspaces/${A}/members/${ownerId}`, {
          method: "DELETE",
          cookie: owner,
        })
      ).status,
    ).toBe(409);
  });

  test("owner can demote THEMSELVES when another owner exists", async () => {
    const ownerId = await userIdByEmail(db, OWNER);
    await req(ctx.app, `/api/v1/workspaces/${A}/members/${await userIdByEmail(db, NEWBIE)}`, {
      method: "PATCH",
      cookie: owner,
      body: { role: "owner" },
    });
    const res = await req(ctx.app, `/api/v1/workspaces/${A}/members/${ownerId}`, {
      method: "PATCH",
      cookie: owner,
      body: { role: "admin" },
    });
    expect(res.status).toBe(200);
    // restore via the other owner (actor keeps owner rights)
    await req(ctx.app, `/api/v1/workspaces/${A}/members/${ownerId}`, {
      method: "PATCH",
      cookie: newbie,
      body: { role: "owner" },
    });
  });

  test("owner DELETE member → 200", async () => {
    const res = await req(
      ctx.app,
      `/api/v1/workspaces/${A}/members/${await userIdByEmail(db, NEWBIE)}`,
      {
        method: "DELETE",
        cookie: owner,
      },
    );
    expect(res.status).toBe(200);
    const rows = (await db.execute(
      sql`SELECT count(*) AS c FROM workspace_members WHERE user_id = ${await userIdByEmail(db, NEWBIE)} AND workspace_id = ${A}`,
    )) as unknown as { c: string }[];
    expect(Number(rows[0]!.c)).toBe(0);
  });
});

// PATCH /api/v1/workspaces/:id — owner-only rename per matrix
describe("workspace rename (PATCH)", () => {
  test("unauthenticated PATCH → 401", async () => {
    const res = await req(ctx.app, `/api/v1/workspaces/${A}`, {
      method: "PATCH",
      body: { name: "x" },
    });
    expect(res.status).toBe(401);
  });

  test("member PATCH → 403; cross-workspace outsider PATCH → 403", async () => {
    expect(
      (
        await req(ctx.app, `/api/v1/workspaces/${A}`, {
          method: "PATCH",
          cookie: member,
          body: { name: "Nope" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await req(ctx.app, `/api/v1/workspaces/${A}`, {
          method: "PATCH",
          cookie: outsider,
          body: { name: "Nope" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await db.execute(sql`SELECT name FROM workspaces WHERE id = ${A}`)) as unknown as unknown[],
    ).toEqual([{ name: "A" }]);
  });

  test("blank/whitespace name → 400; unknown ws → 404", async () => {
    expect(
      (
        await req(ctx.app, `/api/v1/workspaces/${A}`, {
          method: "PATCH",
          cookie: owner,
          body: { name: "   " },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await req(ctx.app, "/api/v1/workspaces/ws-nope", {
          method: "PATCH",
          cookie: owner,
          body: { name: "x" },
        })
      ).status,
    ).toBe(403); // not a member of unknown ws → authz denial first
  });

  test("owner PATCH → 200, name trimmed, audit written", async () => {
    const res = await req(ctx.app, `/api/v1/workspaces/${B}`, {
      method: "PATCH",
      cookie: outsider,
      body: { name: "  Renamed  " },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: B, name: "Renamed", status: "active" });
    expect(
      (await db.execute(sql`SELECT name FROM workspaces WHERE id = ${B}`)) as unknown as unknown[],
    ).toEqual([
      {
        name: "Renamed",
      },
    ]);
    const auditRows = (await db.execute(
      sql`SELECT count(*) AS c FROM audit_log WHERE workspace_id = ${B} AND action = 'workspace.rename'`,
    )) as unknown as { c: string }[];
    expect(Number(auditRows[0]!.c)).toBeGreaterThan(0);
  });
});

// Members POST: 409 only for real duplicate membership; other DB errors → 500
describe("members POST error handling", () => {
  test("duplicate membership → 409", async () => {
    const res = await req(ctx.app, `/api/v1/workspaces/${A}/members`, {
      method: "POST",
      cookie: owner,
      body: { email: ADMIN, role: "member" },
    });
    expect(res.status).toBe(409);
  });

  test("unexpected DB error → 500 (not masked as 409)", async () => {
    // pg equivalent of the old SQLite RAISE(ABORT) trigger: reject inserts for NEWBIE
    await db.execute(
      // pg: subqueries are not allowed in WHEN conditions, so the check lives in the function body
      sql`CREATE FUNCTION boom_before_member() RETURNS trigger AS $fn$ BEGIN IF new.user_id = (SELECT id FROM users WHERE email = ${sql.raw(`'${NEWBIE}'`)}) THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $fn$ LANGUAGE plpgsql`,
    );
    await db.execute(
      sql`CREATE TRIGGER boom_before_member_ins BEFORE INSERT ON workspace_members FOR EACH ROW EXECUTE FUNCTION boom_before_member()`,
    );
    try {
      const res = await req(ctx.app, `/api/v1/workspaces/${A}/members`, {
        method: "POST",
        cookie: owner,
        body: { email: NEWBIE, role: "member" },
      });
      expect(res.status).toBe(500);
    } finally {
      await db.execute(sql`DROP TRIGGER boom_before_member_ins ON workspace_members`);
      await db.execute(sql`DROP FUNCTION boom_before_member()`);
    }
  });
});

// Audit read: admin/owner own ws ✓, member —, instance admin global ✓
describe("audit read", () => {
  test("member → 403", async () => {
    expect((await req(ctx.app, `/api/v1/audit?workspace_id=${A}`, { cookie: member })).status).toBe(
      403,
    );
  });

  test("admin own ws → 200", async () => {
    expect((await req(ctx.app, `/api/v1/audit?workspace_id=${A}`, { cookie: admin })).status).toBe(
      200,
    );
  });

  test("admin other ws → 403", async () => {
    expect((await req(ctx.app, `/api/v1/audit?workspace_id=${B}`, { cookie: admin })).status).toBe(
      403,
    );
  });

  test("owner own ws → 200", async () => {
    expect((await req(ctx.app, `/api/v1/audit?workspace_id=${A}`, { cookie: owner })).status).toBe(
      200,
    );
  });

  test("instance admin global (no workspace_id) → 200", async () => {
    expect((await req(ctx.app, "/api/v1/audit", { cookie: inst })).status).toBe(200);
  });

  test("non-instance-admin without workspace_id → 403", async () => {
    expect((await req(ctx.app, "/api/v1/audit", { cookie: owner })).status).toBe(403);
  });
});

// Bootstrap: idempotent, independent of workspace roles
describe("instance admin bootstrap", () => {
  test("idempotent upsert", async () => {
    const email = "boot@example.com";
    await signUp(ctx.app, email, "Boot");
    const first = await bootstrapInstanceAdmin(db, email);
    expect(first.inserted).toBe(true);
    const second = await bootstrapInstanceAdmin(db, email);
    expect(second.inserted).toBe(false);
    const adminRows = (await db.execute(
      sql`SELECT count(*) AS c FROM instance_admins`,
    )) as unknown as { c: string }[];
    expect(Number(adminRows[0]!.c)).toBe(2); // inst + boot
  });

  test("unknown email → error", () => {
    expect(bootstrapInstanceAdmin(db, "nobody@example.com")).rejects.toThrow();
  });

  test("workspace owner is NOT instance admin (roles independent)", async () => {
    const rows = (await db.execute(
      sql`SELECT count(*) AS c FROM instance_admins WHERE user_id = ${await userIdByEmail(db, OWNER)}`,
    )) as unknown as { c: string }[];
    expect(Number(rows[0]!.c)).toBe(0);
  });
});
