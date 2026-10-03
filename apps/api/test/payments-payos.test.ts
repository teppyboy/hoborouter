// payOS member create path + payment-methods + admin-complete payos guard.
// Fake payOS: injected fetch, never the internet. Money invariant: creating a
// payos payment never moves the wallet; only the webhook credits.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb } from "@hoborouter/db";
import { createAuth } from "../src/auth";
import { buildApp } from "../src/app";
import { payosRequestSignature } from "@hoborouter/payments";
import { q, trackDrop, signUp, req, createWorkspace, userIdByEmail } from "./helpers";
import type { buildApp as BuildApp } from "../src/app";

const BASE = "https://api.test";
const CLIENT_ID = "fake-client-id";
const API_KEY = "fake-api-key";
const CHECKSUM = "fake-checksum-key";

type App = Awaited<ReturnType<typeof BuildApp>>;

let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let app: App;
let appNoPayos: App;
let memberCookie: string;
let outsiderCookie: string;
let adminCookie: string;
let ws: string;

// Fake payOS server behavior, per-test.
let checkoutUrl: string | null;
let failCreate: boolean;
const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];

const fetchImpl = async (input: string | URL, init?: RequestInit) => {
  calls.push({
    url: String(input),
    headers: new Headers(init?.headers),
    body: JSON.parse(String(init?.body)),
  });
  if (failCreate || checkoutUrl === null) {
    return Response.json({ code: "011", desc: "error", data: null }, { status: 400 });
  }
  return Response.json({ code: "00", desc: "success", data: { checkoutUrl } });
};

beforeAll(async () => {
  process.env.BETTER_AUTH_URL = BASE;
  const t = await createTestDb();
  db = t.db;
  trackDrop(t.drop);
  const auth = createAuth(db);
  app = await buildApp({
    db,
    auth,
    payos: {
      cfg: { available: true, clientId: CLIENT_ID, apiKey: API_KEY, checksumKey: CHECKSUM },
      fetch: fetchImpl,
    },
  });
  appNoPayos = await buildApp({
    db,
    auth,
    payos: { cfg: { available: false, clientId: "", apiKey: "", checksumKey: "" } },
  });

  memberCookie = await signUp(app, "payos-member@test.dev", "M");
  outsiderCookie = await signUp(app, "payos-out@test.dev", "O");
  adminCookie = await signUp(app, "payos-admin@test.dev", "A");
  const ownerId = await userIdByEmail(db, "payos-member@test.dev");
  ws = "ws-payos-create";
  await createWorkspace(db, ws, ownerId);
  await q(
    db,
    "INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at) VALUES (?,?, 'VND', 0, 0, 0, ?)",
    `wal-${ws}`,
    ws,
    Date.now(),
  );
  await q(
    db,
    "INSERT INTO instance_admins (user_id, created_at) VALUES (?, ?)",
    await userIdByEmail(db, "payos-admin@test.dev"),
    Date.now(),
  );
});

afterAll(() => {
  delete process.env.BETTER_AUTH_URL;
});

const balance = async () => {
  const row = (await q(db, "SELECT balance FROM wallets WHERE workspace_id = ?", ws))[0] as {
    balance: number | string;
  };
  return Number(row.balance);
};

describe("GET /api/v1/payment-methods", () => {
  test("unauthenticated -> 401", async () => {
    expect((await req(app, "/api/v1/payment-methods")).status).toBe(401);
  });

  test("exposes {manual:true,payos:true} only, no secrets", async () => {
    const res = await req(app, "/api/v1/payment-methods", { cookie: memberCookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ manual: true, payos: true });
    expect(JSON.stringify(body)).not.toContain(CLIENT_ID);
  });

  test("unconfigured -> {manual:true,payos:false}", async () => {
    const res = await req(appNoPayos, "/api/v1/payment-methods", { cookie: memberCookie });
    expect(await res.json()).toEqual({ manual: true, payos: false });
  });
});

describe("POST payments: manual path preserved", () => {
  test("explicit provider:manual matches the omitted-provider response exactly", async () => {
    const omitted = await req(app, `/api/v1/workspaces/${ws}/payments`, {
      method: "POST",
      cookie: memberCookie,
      body: { amount: 1000 },
    });
    const explicit = await req(app, `/api/v1/workspaces/${ws}/payments`, {
      method: "POST",
      cookie: memberCookie,
      body: { amount: 1000, provider: "manual" },
    });
    expect(explicit.status).toBe(201);
    const a = (await omitted.json()) as Record<string, unknown>;
    const b = (await explicit.json()) as Record<string, unknown>;
    expect(b.provider).toBe(a.provider);
    expect(b.status).toBe(a.status);
    expect(b.provider_order_code).toBe(`MANUAL-${b.id}`);
    expect(b.checkout_url).toBe(`/billing/payments?payment=${b.id}`);
  });

  test("invalid provider value -> 400", async () => {
    const res = await req(app, `/api/v1/workspaces/${ws}/payments`, {
      method: "POST",
      cookie: memberCookie,
      body: { amount: 1000, provider: "stripe" },
    });
    expect(res.status).toBe(400);
  });
});

describe("POST payments: provider=payos", () => {
  test("unconfigured -> 503 PROVIDER_UNAVAILABLE, no row", async () => {
    const res = await req(appNoPayos, `/api/v1/workspaces/${ws}/payments`, {
      method: "POST",
      cookie: memberCookie,
      body: { amount: 1000, provider: "payos" },
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "PROVIDER_UNAVAILABLE",
    );
    expect((await q(db, "SELECT 1 FROM payments WHERE provider = 'payos'")).length).toBe(0);
  });

  test("unauthenticated -> 401, non-member -> 403", async () => {
    const un = await req(app, `/api/v1/workspaces/${ws}/payments`, {
      method: "POST",
      body: { amount: 1000, provider: "payos" },
    });
    expect(un.status).toBe(401);
    const denied = await req(app, `/api/v1/workspaces/${ws}/payments`, {
      method: "POST",
      cookie: outsiderCookie,
      body: { amount: 1000, provider: "payos" },
    });
    expect(denied.status).toBe(403);
    expect(calls.length).toBe(0);
  });

  test("happy path: 201 with payOS checkout_url, pending row, atomic audit, signed request", async () => {
    checkoutUrl = "https://pay.test/checkout/abc123";
    failCreate = false;
    const res = await req(app, `/api/v1/workspaces/${ws}/payments`, {
      method: "POST",
      cookie: memberCookie,
      body: { amount: 50000, provider: "payos" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      status: string;
      provider: string;
      provider_order_code: string;
      checkout_url: string;
    };
    expect(body.provider).toBe("payos");
    expect(body.status).toBe("pending");
    expect(body.checkout_url).toBe(checkoutUrl);
    const code = Number(body.provider_order_code);
    expect(Number.isSafeInteger(code)).toBe(true);
    expect(code).toBeGreaterThanOrEqual(1_000_000_000);
    expect(code).toBeLessThan(10_000_000_000);

    const row = (await q(db, "SELECT * FROM payments WHERE id = ?", body.id))[0] as {
      provider: string;
      status: string;
      amount: number;
      provider_order_code: string;
    };
    expect(row.provider).toBe("payos");
    expect(row.status).toBe("pending");
    expect(String(row.provider_order_code)).toBe(body.provider_order_code);

    // Atomic audit for the creation.
    expect(
      (
        await q(
          db,
          "SELECT 1 FROM audit_log WHERE action = 'payment.create' AND target = ?",
          body.id,
        )
      ).length,
    ).toBe(1);

    // Signed request to payOS with server-built return/cancel URLs.
    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.url).toContain("/v2/payment-requests");
    expect(call.headers.get("x-client-id")).toBe(CLIENT_ID);
    expect(call.headers.get("x-api-key")).toBe(API_KEY);
    const redirect = `${BASE}/billing/payments?payment=${body.id}`;
    expect(call.body.returnUrl).toBe(redirect);
    expect(call.body.cancelUrl).toBe(redirect);
    expect(call.body.signature).toBe(
      payosRequestSignature(
        {
          amount: 50000,
          cancelUrl: redirect,
          description: call.body.description as string,
          orderCode: call.body.orderCode as number,
          returnUrl: redirect,
        },
        CHECKSUM,
      ),
    );
    // Creating never moves money.
    expect(await balance()).toBe(0);
  });

  test("unique numeric order codes across creates", async () => {
    checkoutUrl = "https://pay.test/x";
    const codes = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const res = await req(app, `/api/v1/workspaces/${ws}/payments`, {
        method: "POST",
        cookie: memberCookie,
        body: { amount: 2000, provider: "payos" },
      });
      expect(res.status).toBe(201);
      codes.add(((await res.json()) as { provider_order_code: string }).provider_order_code);
    }
    expect(codes.size).toBe(3);
  });

  test("remote create failure -> row failed, safe 502, no secret/upstream leak", async () => {
    failCreate = true;
    const before = calls.length;
    const res = await req(app, `/api/v1/workspaces/${ws}/payments`, {
      method: "POST",
      cookie: memberCookie,
      body: { amount: 3000, provider: "payos" },
    });
    expect(res.status).toBe(502);
    expect(calls.length).toBe(before + 1);
    const text = await res.text();
    expect(text).not.toContain(CLIENT_ID);
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(CHECKSUM);
    expect(text).not.toContain("https://pay.test");
    const body = JSON.parse(text) as { error: { code: string } };
    expect(body.error.code).toBe("PROVIDER_UNAVAILABLE");
    const row = (
      await q(db, "SELECT status FROM payments ORDER BY created_at DESC LIMIT 1")
    )[0] as { status: string };
    expect(row.status).toBe("failed");
    expect(await balance()).toBe(0);
  });
});

describe("admin complete guard for payos", () => {
  test("admin complete of a payos payment -> 409, no credit", async () => {
    const now = Date.now();
    await q(
      db,
      "INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at) VALUES ('pay-payos-admin', ?, 5000, 'pending', 'payos', '999888777', ?)",
      ws,
      now,
    );
    const res = await req(app, "/api/v1/admin/payments/pay-payos-admin/complete", {
      method: "POST",
      cookie: adminCookie,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_STATE");
    expect(await balance()).toBe(0);
    expect(
      (
        (await q(db, "SELECT status FROM payments WHERE id = 'pay-payos-admin'"))[0] as {
          status: string;
        }
      ).status,
    ).toBe("pending");
  });
});
