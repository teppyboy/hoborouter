// GET /api/v1/admin/payments initiator enrichment: creator comes ONLY from
// audit_log action=payment.create (target=payment.id, matching workspace),
// joined to users — never from workspace ownership or the approving admin.
import { describe, expect, test } from "bun:test";
import {
  makeApp,
  signUp,
  req,
  createWorkspace,
  addMember,
  makeInstanceAdmin,
  userIdByEmail,
} from "./helpers";
import { sql } from "drizzle-orm";

type PaymentRow = {
  id: string;
  workspace_id: string;
  workspace_name: string;
  amount: number;
  status: string;
  provider: string;
  provider_order_code: string;
  created_at: number;
  expires_at: number | null;
  initiator: { id: string; name: string | null; email: string | null } | null;
};

async function listPayments(app: Awaited<ReturnType<typeof makeApp>>["app"], cookie?: string) {
  const res = await req(app, "/api/v1/admin/payments", { cookie });
  const body = (await res.json()) as { data?: PaymentRow[] };
  return { res, rows: body.data ?? [] };
}

/** Seed: owner A + member B in ws1, instance admin C (not in ws1). */
async function seed() {
  const made = await makeApp();
  const { db, app } = made;
  const cookieA = await signUp(app, "owner@test.dev", "Owner A");
  const cookieB = await signUp(app, "member@test.dev", "Member B");
  const cookieC = await signUp(app, "approver@test.dev", "Approver C");
  const idA = await userIdByEmail(db, "owner@test.dev");
  const idB = await userIdByEmail(db, "member@test.dev");
  const idC = await userIdByEmail(db, "approver@test.dev");
  await makeInstanceAdmin(db, idC);
  await createWorkspace(db, "ws1", idA, "WS One");
  await addMember(db, "ws1", idB, "member");
  await db.execute(
    sql`INSERT INTO wallets (id, workspace_id, balance, reserved, created_at) VALUES ('wal-ws1','ws1',0,0,${Date.now()})`,
  );
  return { made, db, app, cookieA, cookieB, cookieC, idA, idB, idC };
}

/** Member B creates a payment through the real route; returns payment id. */
async function memberCreatesPayment(
  app: Awaited<ReturnType<typeof makeApp>>["app"],
  cookieB: string,
) {
  const res = await req(app, "/api/v1/workspaces/ws1/payments", {
    method: "POST",
    cookie: cookieB,
    body: { amount: 50000 },
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  return body.id;
}

describe("GET /api/v1/admin/payments initiator", () => {
  test("initiator is the member who created the payment, not the approving admin; fields unchanged", async () => {
    const { made, app, cookieB, cookieC, idB } = await seed();
    const payId = await memberCreatesPayment(app, cookieB);
    const done = await req(app, `/api/v1/admin/payments/${payId}/complete`, {
      method: "POST",
      cookie: cookieC,
    });
    expect(done.status).toBe(200);
    const { res, rows } = await listPayments(app, cookieC);
    expect(res.status).toBe(200);
    const row = rows.find((r) => r.id === payId)!;
    expect(row).toBeDefined();
    expect(row.initiator).toEqual({
      id: idB,
      name: "Member B",
      email: "member@test.dev",
    });
    expect(row.workspace_id).toBe("ws1");
    expect(row.workspace_name).toBe("WS One");
    expect(row.amount).toBe(50000);
    expect(row.status).toBe("succeeded");
    expect(row.provider).toBe("manual");
    expect(row.provider_order_code).toBe(`MANUAL-${payId}`);
    expect(typeof row.created_at).toBe("number");
    made.close();
  });

  test("old payment with no creation audit has null initiator; unrelated audits ignored", async () => {
    const { made, db, app, cookieC, idA } = await seed();
    const now = Date.now();
    await db.execute(
      sql`INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at) VALUES ('pay-old','ws1',1000,'pending','manual','MANUAL-pay-old',${now})`,
    );
    // Unrelated actions targeting the payment id must not resolve a creator.
    await db.execute(
      sql`INSERT INTO audit_log (id, actor_user_id, workspace_id, action, target, created_at) VALUES ('au1',${idA},'ws1','payment.admin_complete','pay-old',${now + 1})`,
    );
    await db.execute(
      sql`INSERT INTO audit_log (id, actor_user_id, workspace_id, action, target, created_at) VALUES ('au2',${idA},'ws1','key.create','pay-old',${now + 2})`,
    );
    const { rows } = await listPayments(app, cookieC);
    const row = rows.find((r) => r.id === "pay-old")!;
    expect(row.initiator).toBeNull();
    made.close();
  });

  test("creation audit with null actor yields null initiator", async () => {
    const { made, db, app, cookieC } = await seed();
    const now = Date.now();
    await db.execute(
      sql`INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at) VALUES ('pay-null','ws1',1000,'pending','manual','MANUAL-pay-null',${now})`,
    );
    await db.execute(
      sql`INSERT INTO audit_log (id, actor_user_id, workspace_id, action, target, created_at) VALUES ('au-null',NULL,'ws1','payment.create','pay-null',${now + 1})`,
    );
    const { rows } = await listPayments(app, cookieC);
    expect(rows.find((r) => r.id === "pay-null")!.initiator).toBeNull();
    made.close();
  });

  test("creation audit for a different workspace is ignored", async () => {
    const { made, db, app, cookieC, idA } = await seed();
    const now = Date.now();
    await db.execute(
      sql`INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws-other','Other','active',${now})`,
    );
    await db.execute(
      sql`INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at) VALUES ('pay-ws','ws1',1000,'pending','manual','MANUAL-pay-ws',${now})`,
    );
    await db.execute(
      sql`INSERT INTO audit_log (id, actor_user_id, workspace_id, action, target, created_at) VALUES ('au-ws',${idA},'ws-other','payment.create','pay-ws',${now + 1})`,
    );
    const { rows } = await listPayments(app, cookieC);
    expect(rows.find((r) => r.id === "pay-ws")!.initiator).toBeNull();
    made.close();
  });

  test("duplicate creation audits: earliest (created_at, then id) wins deterministically", async () => {
    const { made, db, app, cookieC, idA, idB } = await seed();
    const now = Date.now();
    await db.execute(
      sql`INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at) VALUES ('pay-dup','ws1',1000,'pending','manual','MANUAL-pay-dup',${now})`,
    );
    // Later-timestamp audit points at B; earliest at A -> A wins.
    await db.execute(
      sql`INSERT INTO audit_log (id, actor_user_id, workspace_id, action, target, created_at) VALUES ('b-later',${idB},'ws1','payment.create','pay-dup',${now + 10})`,
    );
    await db.execute(
      sql`INSERT INTO audit_log (id, actor_user_id, workspace_id, action, target, created_at) VALUES ('a-early',${idA},'ws1','payment.create','pay-dup',${now + 5})`,
    );
    const { rows } = await listPayments(app, cookieC);
    expect(rows.find((r) => r.id === "pay-dup")!.initiator?.id).toBe(idA);

    // Same timestamp: lexicographically smallest audit id wins.
    await db.execute(
      sql`INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at) VALUES ('pay-tie','ws1',2000,'pending','manual','MANUAL-pay-tie',${now + 1})`,
    );
    await db.execute(
      sql`INSERT INTO audit_log (id, actor_user_id, workspace_id, action, target, created_at) VALUES ('z-tie',${idA},'ws1','payment.create','pay-tie',${now + 20})`,
    );
    await db.execute(
      sql`INSERT INTO audit_log (id, actor_user_id, workspace_id, action, target, created_at) VALUES ('a-tie',${idB},'ws1','payment.create','pay-tie',${now + 20})`,
    );
    const again = await listPayments(app, cookieC);
    expect(again.rows.find((r) => r.id === "pay-tie")!.initiator?.id).toBe(idB);
    made.close();
  });

  test("unauthenticated 401, non-admin 403", async () => {
    const { made, app, cookieB } = await seed();
    expect((await req(app, "/api/v1/admin/payments")).status).toBe(401);
    expect((await req(app, "/api/v1/admin/payments", { cookie: cookieB })).status).toBe(403);
    made.close();
  });
});
