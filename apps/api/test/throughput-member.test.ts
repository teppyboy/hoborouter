// Prepaid throughput allowance API surface: admin product CRUD is
// instance-admin-only and deactivation (never delete) stops new purchases;
// the member catalog lists active products; purchase creates a pending
// payment at the SERVER-side price carrying throughput_product_id with no
// wallet movement; the status endpoint reports the current allowance window
// (null without one) and reflects lazy expiry. Settlement behavior (window
// activation, no wallet credit, replay) is covered by
// tests/throughput-allowance.test.ts; gateway admission by
// apps/api/test/throughput-gateway.test.ts.
import { describe, test, expect, beforeAll } from "bun:test";
import {
  q,
  makeApp,
  signUp,
  req,
  createWorkspace,
  userIdByEmail,
  makeInstanceAdmin,
} from "./helpers";
import type { buildApp } from "../src/app";

let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof makeApp>>["db"];
let adminCookie: string;
let memberCookie: string;
let outsiderCookie: string;
let ws: string;

beforeAll(async () => {
  ({ db, app } = await makeApp());
  adminCookie = await signUp(app, "tp-admin@test.dev", "A");
  await makeInstanceAdmin(db, await userIdByEmail(db, "tp-admin@test.dev"));
  memberCookie = await signUp(app, "tp-member@test.dev", "M");
  outsiderCookie = await signUp(app, "tp-out@test.dev", "O");
  ws = "ws-tp";
  await createWorkspace(db, ws, await userIdByEmail(db, "tp-member@test.dev"));
  await q(
    db,
    "INSERT INTO wallets (id, workspace_id, kind, currency, balance, reserved, version, created_at) VALUES (?,?, 'topup', 'VND', 50000, 0, 0, ?)",
    `wal-${ws}`,
    ws,
    Date.now(),
  );
});

const createProduct = async (over: Record<string, unknown> = {}) => {
  const res = await req(app, "/api/v1/admin/throughput-products", {
    method: "POST",
    cookie: adminCookie,
    body: {
      name: "Turbo 30",
      price_vnd: 150000,
      requests_per_minute: 30,
      duration_days: 7,
      ...over,
    },
  });
  return { res, body: (await res.json()) as Record<string, unknown> };
};

describe("admin throughput product routes", () => {
  test("instance admin creates a product with frozen bounds", async () => {
    const { res, body } = await createProduct();
    expect(res.status).toBe(201);
    expect(body.price_vnd).toBe(150000);
    expect(body.requests_per_minute).toBe(30);
    expect(body.duration_days).toBe(7);
    expect(body.active).toBe(true);
  });

  test("creation validates bounds and VND price", async () => {
    expect((await createProduct({ requests_per_minute: 0 })).res.status).toBe(400);
    expect((await createProduct({ requests_per_minute: 601 })).res.status).toBe(400);
    expect((await createProduct({ duration_days: 0 })).res.status).toBe(400);
    expect((await createProduct({ price_vnd: 0 })).res.status).toBe(400);
    expect((await createProduct({ price_vnd: 1.5 })).res.status).toBe(400);
  });

  test("non-admin cannot create or list (403)", async () => {
    const create = await req(app, "/api/v1/admin/throughput-products", {
      method: "POST",
      cookie: memberCookie,
      body: { name: "X", price_vnd: 1000, requests_per_minute: 10, duration_days: 1 },
    });
    expect(create.status).toBe(403);
    const list = await req(app, "/api/v1/admin/throughput-products", { cookie: memberCookie });
    expect(list.status).toBe(403);
  });

  test("admin lists all products; deactivation stops purchase with 409", async () => {
    const { body: product } = await createProduct({ name: "Shortlived" });
    const list = await req(app, "/api/v1/admin/throughput-products", { cookie: adminCookie });
    expect(list.status).toBe(200);
    const listed = ((await list.json()) as { data: { id: string }[] }).data;
    expect(listed.some((p) => p.id === product.id)).toBe(true);

    const deact = await req(app, `/api/v1/admin/throughput-products/${product.id}/deactivate`, {
      method: "POST",
      cookie: adminCookie,
    });
    expect(deact.status).toBe(200);
    // Idempotent: deactivating twice stays 200.
    expect(
      (
        await req(app, `/api/v1/admin/throughput-products/${product.id}/deactivate`, {
          method: "POST",
          cookie: adminCookie,
        })
      ).status,
    ).toBe(200);

    const buy = await req(
      app,
      `/api/v1/workspaces/${ws}/throughput-products/${product.id}/purchase`,
      {
        method: "POST",
        cookie: memberCookie,
        body: { provider: "manual" },
      },
    );
    expect(buy.status).toBe(409);
    // Unknown id 404s on deactivate.
    expect(
      (
        await req(app, "/api/v1/admin/throughput-products/nope/deactivate", {
          method: "POST",
          cookie: adminCookie,
        })
      ).status,
    ).toBe(404);
  });
});

describe("member throughput routes", () => {
  test("catalog lists only active products", async () => {
    const res = await req(app, "/api/v1/throughput-products", { cookie: memberCookie });
    expect(res.status).toBe(200);
    const data = ((await res.json()) as { data: { name: string }[] }).data;
    expect(data.some((p) => p.name === "Turbo 30")).toBe(true);
    expect(data.some((p) => p.name === "Shortlived")).toBe(false);
  });

  test("status endpoint returns null without an allowance", async () => {
    const res = await req(app, `/api/v1/workspaces/${ws}/throughput-allowance`, {
      cookie: memberCookie,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { allowance: unknown }).allowance).toBeNull();
  });

  test("manual purchase creates a pending payment at the server price with no wallet movement", async () => {
    const product = (await createProduct({ name: "Buyable 60", requests_per_minute: 60 })).body;
    const res = await req(
      app,
      `/api/v1/workspaces/${ws}/throughput-products/${product.id}/purchase`,
      {
        method: "POST",
        cookie: memberCookie,
        body: { provider: "manual" },
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; amount: number; status: string };
    expect(body.amount).toBe(150000); // server-side price, never client-supplied
    expect(body.status).toBe("pending");
    const rows = await q<{ throughput_product_id: string; amount: number; status: string }>(
      db,
      "SELECT throughput_product_id, amount, status FROM payments WHERE id = ?",
      body.id,
    );
    expect(rows[0]!.throughput_product_id).toBe(String(product.id));
    expect(rows[0]!.amount).toBe(150000);
    expect(rows[0]!.status).toBe("pending");
    // Purchase moved no money: wallet untouched, no ledger rows.
    const ledger = await q(
      db,
      "SELECT * FROM ledger_entries le JOIN wallets w ON w.id = le.wallet_id WHERE w.workspace_id = ?",
      ws,
    );
    expect(ledger.length).toBe(0);
  });

  test("non-member and outsider get 404 (workspace existence not revealed)", async () => {
    const product = (await createProduct({ name: "Hidden" })).body;
    for (const cookie of [outsiderCookie]) {
      const res = await req(
        app,
        `/api/v1/workspaces/${ws}/throughput-products/${product.id}/purchase`,
        { method: "POST", cookie, body: { provider: "manual" } },
      );
      expect(res.status).toBe(404);
    }
    const status = await req(app, `/api/v1/workspaces/${ws}/throughput-allowance`, {
      cookie: outsiderCookie,
    });
    expect(status.status).toBe(404);
  });

  test("settled payment surfaces on the status endpoint; lapsed window reads expired", async () => {
    // Activate directly via the settlement code (already covered in depth in
    // tests/throughput-allowance.test.ts); here: member-visible state.
    const product = (
      await createProduct({ name: "Status 45", requests_per_minute: 45, duration_days: 7 })
    ).body;
    const paymentId = `pay-status-${product.id}`;
    const now = Date.now();
    await q(
      db,
      "INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at, throughput_product_id) VALUES (?,?,?,'succeeded','mock',?,?,?)",
      paymentId,
      ws,
      150000,
      `ORD-${paymentId}`,
      now,
      product.id,
    );
    await q(
      db,
      `INSERT INTO throughput_allowances (id, workspace_id, payment_id, product_id, requests_per_minute, starts_at, ends_at, status, created_at)
       VALUES (?,?,?,?,?, ?, ?, 'active', ?)`,
      `ta-${paymentId}`,
      ws,
      paymentId,
      product.id,
      45,
      now - 1000,
      now + 7 * 86400000,
      now,
    );
    const res = await req(app, `/api/v1/workspaces/${ws}/throughput-allowance`, {
      cookie: memberCookie,
    });
    const body = (await res.json()) as {
      allowance: { requests_per_minute: number; limiting: boolean } | null;
    };
    expect(body.allowance).not.toBeNull();
    expect(body.allowance!.requests_per_minute).toBe(45);
    expect(body.allowance!.limiting).toBe(true);

    // Lapse the window: the next status read flips it to expired and reports null.
    await q(
      db,
      "UPDATE throughput_allowances SET ends_at = starts_at + 1 WHERE id = ?",
      `ta-${paymentId}`,
    );
    const lapsed = await req(app, `/api/v1/workspaces/${ws}/throughput-allowance`, {
      cookie: memberCookie,
    });
    expect(((await lapsed.json()) as { allowance: unknown }).allowance).toBeNull();
    const statuses = await q<{ status: string }>(
      db,
      "SELECT status FROM throughput_allowances WHERE id = ?",
      `ta-${paymentId}`,
    );
    expect(statuses[0]!.status).toBe("expired");
  });
});
