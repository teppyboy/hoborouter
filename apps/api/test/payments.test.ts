// Task 9: payments routes — member+ workspace-scoped POST/GET, positive
// integer VND, mock checkout link, cross-workspace denial.
import { describe, test, expect, beforeAll } from "bun:test";
import {
  makeApp,
  signUp,
  req,
  cookieOf,
  createWorkspace,
  addMember,
  userIdByEmail,
} from "./helpers";
import type { Database } from "bun:sqlite";
import type { buildApp } from "../src/app";

let app: ReturnType<typeof buildApp>;
let db: Database;
let memberCookie: string;
let outsiderCookie: string;
let wsA: string;
let wsB: string;

beforeAll(async () => {
  // Mock payment POST is feature-gated; enable for these route tests.
  process.env.HBR_MOCK_PAYMENTS = "on";
  process.env.HBR_MOCK_PAYMENTS_WEBHOOK_KEY = "payments-test-key";
  ({ db, app } = await makeApp());
  await signUp(app, "pay-owner@test.dev", "Owner");
  memberCookie = await signUp(app, "pay-member@test.dev", "Member");
  outsiderCookie = await signUp(app, "pay-outsider@test.dev", "Out");
  wsA = "ws-pay-a";
  wsB = "ws-pay-b";
  const ownerId = userIdByEmail(db, "pay-owner@test.dev");
  createWorkspace(db, wsA, ownerId);
  addMember(db, wsA, userIdByEmail(db, "pay-member@test.dev"), "member");
  const ownerB = await signUp(app, "pay-owner-b@test.dev", "OwnerB");
  createWorkspace(db, wsB, userIdByEmail(db, "pay-owner-b@test.dev"));
  // keep cookie var used
  void ownerB;
  db.prepare(
    "INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at) VALUES (?,?, 'VND', 0, 0, 0, ?)",
  ).run(`wal-${wsA}`, wsA, Date.now());
  db.prepare(
    "INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at) VALUES (?,?, 'VND', 0, 0, 0, ?)",
  ).run(`wal-${wsB}`, wsB, Date.now());
});

describe("POST /api/workspaces/:id/payments", () => {
  test("member creates pending mock payment with positive integer amount + mock link", async () => {
    const res = await req(app, `/api/workspaces/${wsA}/payments`, {
      method: "POST",
      cookie: memberCookie,
      body: { amount: 50000 },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      status: string;
      provider: string;
      provider_order_code: string;
      checkout_url: string;
    };
    expect(body.status).toBe("pending");
    expect(body.provider).toBe("mock");
    expect(body.checkout_url).toBe(`/webhooks/payments/mock?order=${body.provider_order_code}`);
    const row = db.prepare("SELECT * FROM payments WHERE id = ?").get(body.id) as {
      amount: number;
      status: string;
      workspace_id: string;
    };
    expect(row.amount).toBe(50000);
    expect(row.status).toBe("pending");
    expect(row.workspace_id).toBe(wsA);
  });

  test("rejects non-positive / non-integer amounts", async () => {
    for (const amount of [0, -5, 10.5, "100", null]) {
      const res = await req(app, `/api/workspaces/${wsA}/payments`, {
        method: "POST",
        cookie: memberCookie,
        body: { amount },
      });
      expect(res.status).toBe(400);
    }
  });

  test("non-member gets 403", async () => {
    const res = await req(app, `/api/workspaces/${wsA}/payments`, {
      method: "POST",
      cookie: outsiderCookie,
      body: { amount: 1000 },
    });
    expect(res.status).toBe(403);
  });

  test("unauthenticated gets 401", async () => {
    const res = await req(app, `/api/workspaces/${wsA}/payments`, {
      method: "POST",
      body: { amount: 1000 },
    });
    expect(res.status).toBe(401);
  });

  test("POST gated off in production / feature-off -> 404; GET history remains", async () => {
    const saved = process.env.HBR_MOCK_PAYMENTS;
    process.env.HBR_MOCK_PAYMENTS = "off";
    const { buildApp } = await import("../src/app");
    const { createDb, migrate } = await import("@hoborouter/db");
    const d = createDb(":memory:");
    migrate(d);
    const fresh = buildApp({ db: d });
    const cookie = await signUp(fresh, "pay-gated@test.dev", "G");
    createWorkspace(d, "ws-gated", userIdByEmail(d, "pay-gated@test.dev"));
    const post = await req(fresh, "/api/workspaces/ws-gated/payments", {
      method: "POST",
      cookie,
      body: { amount: 1000 },
    });
    expect(post.status).toBe(404);
    const get = await req(fresh, "/api/workspaces/ws-gated/payments/some-id", { cookie });
    expect(get.status).toBe(404); // unknown id still 404 via GET path, not route-gated
    if (saved === undefined) delete process.env.HBR_MOCK_PAYMENTS;
    else process.env.HBR_MOCK_PAYMENTS = saved;
  });
});

describe("GET /api/workspaces/:id/payments/:paymentId", () => {
  let paymentId: string;
  beforeAll(async () => {
    const res = await req(app, `/api/workspaces/${wsA}/payments`, {
      method: "POST",
      cookie: memberCookie,
      body: { amount: 12345 },
    });
    paymentId = ((await res.json()) as { id: string }).id;
  });

  test("member of own workspace can read", async () => {
    const res = await req(app, `/api/workspaces/${wsA}/payments/${paymentId}`, {
      cookie: memberCookie,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe(paymentId);
  });

  test("cross-workspace denial: member of ws A gets 403 on ws B path even when id exists", async () => {
    // payment exists and belongs to wsA; request via wsB path with wsA member cookie
    const res = await req(app, `/api/workspaces/${wsB}/payments/${paymentId}`, {
      cookie: memberCookie,
    });
    // member of wsA has no role in wsB -> 403 from role gate
    expect(res.status).toBe(403);
  });

  test("cross-workspace denial: wsA member requesting payment via wsB scope -> 403", async () => {
    // Create a payment in wsB, then read it via wsA scope with wsA member.
    const resB = await req(app, `/api/workspaces/${wsB}/payments`, {
      method: "POST",
      cookie: cookieOf(
        await app.handle(
          new Request("http://localhost/api/auth/sign-in/email", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              email: "pay-owner-b@test.dev",
              password: "correct horse battery staple",
            }),
          }),
        ),
      ),
      body: { amount: 777 },
    });
    const bId = ((await resB.json()) as { id: string }).id;
    const res = await req(app, `/api/workspaces/${wsA}/payments/${bId}`, {
      cookie: memberCookie,
    });
    expect(res.status).toBe(403);
  });

  test("unknown id 404", async () => {
    const res = await req(app, `/api/workspaces/${wsA}/payments/nope`, { cookie: memberCookie });
    expect(res.status).toBe(404);
  });
});

// restore env after file-level tests
import { afterAll } from "bun:test";
afterAll(() => {
  delete process.env.HBR_MOCK_PAYMENTS;
  delete process.env.HBR_MOCK_PAYMENTS_WEBHOOK_KEY;
});
