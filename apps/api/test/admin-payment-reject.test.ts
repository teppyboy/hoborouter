// Admin payment reject: pending -> rejected (audited, no money movement),
// idempotent replay, 409 on terminal states, 401/403 guards, and regression
// that concurrent approve/reject serializes on the payment row lock so
// exactly one of the two wins with at most one credit.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Elysia } from "elysia";
import type { Db } from "@hoborouter/db";
import { createTestDb } from "@hoborouter/db";
import { sql } from "drizzle-orm";
import { adminExtraRoutes } from "../src/routes/admin-extra";
import { adminPaymentRejectRoutes } from "../src/routes/admin-payment-reject";

const ADMIN = "user-admin";
const MEMBER = "user-member";
const OWNER = "user-owner";

let db: Db;
let drop: () => Promise<void>;

const session = (uid: string | null) => ({
  handler: async () => new Response("", { status: 404 }),
  api: {
    getSession: async () =>
      uid ? { user: { id: uid }, session: { id: "s", userId: uid } } : null,
  },
});

const adminApp = () => new Elysia().use(adminPaymentRejectRoutes(db, session(ADMIN)));
const completeApp = () => new Elysia().use(adminExtraRoutes(db, session(ADMIN)));

let seed = 0;
async function seedPayment(status: string) {
  seed += 1;
  const id = `pay-${seed}`;
  await db.execute(
    sql`INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at)
        VALUES (${id}, 'ws-main', 1000, ${status}, 'mock', ${"MOCK-" + seed}, ${Date.now()})`,
  );
  return id;
}

async function countLedger(paymentId: string) {
  const r = await db.execute(
    sql`select count(*)::int as n from ledger_entries where payment_id = ${paymentId}`,
  );
  return (r[0] as { n: number }).n;
}

async function walletBalance() {
  const r = await db.execute(
    sql`select balance::text as b from wallets where workspace_id = 'ws-main'`,
  );
  return Number((r[0] as { b: string }).b);
}

async function paymentRow(id: string) {
  const r = await db.execute(
    sql`select status, amount::text as amount, workspace_id, provider_order_code from payments where id = ${id}`,
  );
  return r[0] as { status: string; amount: string; workspace_id: string; provider_order_code: string };
}

async function auditCount(action: string, target: string) {
  const r = await db.execute(
    sql`select count(*)::int as n from audit_log where action = ${action} and target = ${target}`,
  );
  return (r[0] as { n: number }).n;
}

const post = (app: { handle: (req: Request) => Promise<Response> }, url: string) =>
  app.handle(new Request(`http://localhost${url}`, { method: "POST" }));

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  drop = t.drop;
  const now = Date.now();
  await db.execute(
    sql`INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES
        (${ADMIN}, 'Admin', 'admin@test.dev', true, ${now}, ${now}),
        (${MEMBER}, 'Member', 'member@test.dev', true, ${now}, ${now}),
        (${OWNER}, 'Owner', 'owner@test.dev', true, ${now}, ${now})`,
  );
  await db.execute(sql`INSERT INTO instance_admins (user_id, created_at) VALUES (${ADMIN}, ${now})`);
  await db.execute(
    sql`INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws-main', 'ws-main', 'active', ${now})`,
  );
  await db.execute(
    sql`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
        ('ws-main', ${MEMBER}, 'member'),
        ('ws-main', ${OWNER}, 'owner')`,
  );
  await db.execute(
    sql`INSERT INTO wallets (id, workspace_id, balance, reserved, created_at) VALUES ('w-main', 'ws-main', 0, 0, ${now})`,
  );
});

afterAll(async () => {
  await drop();
});

describe("admin payment reject", () => {
  test("reject pending -> 200, status rejected, one audit, zero credit", async () => {
    const id = await seedPayment("pending");
    const res = await post(adminApp(), `/api/v1/admin/payments/${id}/reject`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { success: boolean }).success).toBe(true);
    const row = await paymentRow(id);
    expect(row.status).toBe("rejected");
    // Only the status changed; no amount/workspace/order mutation.
    expect(row.amount).toBe("1000");
    expect(row.workspace_id).toBe("ws-main");
    expect(row.provider_order_code).toBe("MOCK-1");
    expect(await countLedger(id)).toBe(0);
    expect(await walletBalance()).toBe(0);
    expect(await auditCount("payment.admin_reject", id)).toBe(1);
  });

  test("reject already-rejected is idempotent 200 with no duplicate audit", async () => {
    const id = await seedPayment("pending");
    await post(adminApp(), `/api/v1/admin/payments/${id}/reject`);
    const res = await post(adminApp(), `/api/v1/admin/payments/${id}/reject`);
    expect(res.status).toBe(200);
    expect(await auditCount("payment.admin_reject", id)).toBe(1);
  });

  test.each(["succeeded", "failed", "expired", "cancelled"])(
    "reject %s -> 409 INVALID_STATE",
    async (status) => {
      const id = await seedPayment(status);
      const res = await post(adminApp(), `/api/v1/admin/payments/${id}/reject`);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe(
        "INVALID_STATE",
      );
      expect(await auditCount("payment.admin_reject", id)).toBe(0);
    },
  );

  test("unknown payment -> 404", async () => {
    const res = await post(adminApp(), "/api/v1/admin/payments/pay-nope/reject");
    expect(res.status).toBe(404);
  });

  test("no auth -> 401; member and owner -> 403", async () => {
    const id = await seedPayment("pending");
    const anon = await post(new Elysia().use(adminPaymentRejectRoutes(db, session(null))), `/api/v1/admin/payments/${id}/reject`);
    expect(anon.status).toBe(401);
    const member = await post(new Elysia().use(adminPaymentRejectRoutes(db, session(MEMBER))), `/api/v1/admin/payments/${id}/reject`);
    expect(member.status).toBe(403);
    const owner = await post(new Elysia().use(adminPaymentRejectRoutes(db, session(OWNER))), `/api/v1/admin/payments/${id}/reject`);
    expect(owner.status).toBe(403);
    // Still pending, untouched.
    expect((await paymentRow(id)).status).toBe("pending");
  });

  test("approve then reject -> 409; payment stays succeeded with exactly one credit", async () => {
    const id = await seedPayment("pending");
    const done = await post(completeApp(), `/api/v1/admin/payments/${id}/complete`);
    expect(done.status).toBe(200);
    const rej = await post(adminApp(), `/api/v1/admin/payments/${id}/reject`);
    expect(rej.status).toBe(409);
    expect(((await rej.json()) as { error?: { code?: string } }).error?.code).toBe("INVALID_STATE");
    expect((await paymentRow(id)).status).toBe("succeeded");
    expect(await countLedger(id)).toBe(1);
    expect(await walletBalance()).toBe(1000);
  });

  test("reject then complete -> 409 INVALID_STATE and exact zero credit", async () => {
    const id = await seedPayment("pending");
    const before = await walletBalance();
    await post(adminApp(), `/api/v1/admin/payments/${id}/reject`);
    const done = await post(completeApp(), `/api/v1/admin/payments/${id}/complete`);
    expect(done.status).toBe(409);
    expect(((await done.json()) as { error?: { code?: string } }).error?.code).toBe(
      "INVALID_STATE",
    );
    expect(await countLedger(id)).toBe(0);
    expect(await walletBalance()).toBe(before);
    expect((await paymentRow(id)).status).toBe("rejected");
  });

  test("concurrent approve/reject: exactly one 200, one 409, at most one credit", async () => {
    for (let i = 0; i < 5; i++) {
      const id = await seedPayment("pending");
      const before = await walletBalance();
      const [rejectRes, completeRes] = await Promise.all([
        post(adminApp(), `/api/v1/admin/payments/${id}/reject`),
        post(completeApp(), `/api/v1/admin/payments/${id}/complete`),
      ]);
      const statuses = [rejectRes.status, completeRes.status].sort();
      expect(statuses).toEqual([200, 409]);
      // Exactly one side won: rejected (0 credits) or succeeded (1 credit).
      const credits = await countLedger(id);
      const row = await paymentRow(id);
      if (row.status === "succeeded") {
        expect(credits).toBe(1);
        expect(await walletBalance()).toBe(before + 1000);
      } else {
        expect(row.status).toBe("rejected");
        expect(credits).toBe(0);
        expect(await walletBalance()).toBe(before);
      }
      // Reject never duplicates its audit across replays.
      expect(await auditCount("payment.admin_reject", id)).toBeLessThanOrEqual(1);
    }
  });
});
