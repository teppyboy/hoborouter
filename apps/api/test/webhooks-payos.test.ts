// Task 4: POST /webhooks/payments/payos — signature verify, 200 {success:true}
// for valid + idempotent replays, 400 for bad signature/amount mismatch,
// no wallet change on failure, 404 when payOS env missing.
import { describe, test, expect, beforeAll } from "bun:test";
import { createHmac } from "node:crypto";
import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import { createDb, migrate } from "@hoborouter/db";
import { payosWebhookRoutes } from "../src/routes/webhooks-payos";
import type { PayosWebhookConfig } from "@hoborouter/payments";

const KEY = "test-checksum-key";
const ws = "ws-payos-hook";

function body(
  dataOverrides: Record<string, unknown> = {},
  topOverrides: Record<string, unknown> = {},
) {
  const data = {
    orderCode: 123456789,
    amount: 50000,
    description: "topup",
    accountNumber: "123",
    reference: "ref-wh-1",
    transactionDateTime: "2026-09-30 12:00:00",
    currency: "VND",
    paymentLinkId: "plink-1",
    code: "00",
    desc: "Thành công",
    ...dataOverrides,
  };
  const sorted = Object.keys(data)
    .sort()
    .map((k) => `${k}=${(data as Record<string, unknown>)[k]}`)
    .join("&");
  const signature = createHmac("sha256", KEY).update(sorted).digest("hex");
  return JSON.stringify({
    code: "00",
    desc: "success",
    success: true,
    data,
    signature,
    ...topOverrides,
  });
}

function makeTestApp(db: Database, cfg: PayosWebhookConfig) {
  return new Elysia().use(payosWebhookRoutes(db, cfg));
}

function seedPayment(orderCode: string, amount: number) {
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at) VALUES (?,?,?,'pending','payos',?,?)",
  ).run(id, ws, amount, orderCode, Date.now());
  return id;
}

let db: Database;
let app: ReturnType<typeof makeTestApp>;

beforeAll(() => {
  db = createDb(":memory:");
  migrate(db);
  db.prepare("INSERT INTO workspaces (id, name, status, created_at) VALUES (?,?, 'active', ?)").run(
    ws,
    "ws",
    Date.now(),
  );
  db.prepare(
    "INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at) VALUES (?,?, 'VND', 0, 0, 0, ?)",
  ).run(`wal-${ws}`, ws, Date.now());
  app = makeTestApp(db, { available: true, checksumKey: KEY });
});

const post = (raw: string, app2 = app) =>
  app2.handle(
    new Request("http://localhost/webhooks/payments/payos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    }),
  );

const balance = () =>
  (db.prepare("SELECT balance FROM wallets WHERE workspace_id = ?").get(ws) as { balance: number })
    .balance;

describe("payos webhook route", () => {
  test("valid signed paid event -> 200 {success:true}, credited once", async () => {
    seedPayment("123456789", 50000);
    const res = await post(body());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(balance()).toBe(50000);
    expect(
      db.prepare("SELECT 1 FROM ledger_entries WHERE kind = 'topup' AND amount = 50000").all()
        .length,
    ).toBe(1);
  });

  test("idempotent replay -> 200, exactly one credit", async () => {
    const res = await post(body());
    expect(res.status).toBe(200);
    expect(balance()).toBe(50000);
    expect(
      db.prepare("SELECT 1 FROM payment_events WHERE provider_reference = 'ref-wh-1'").all().length,
    ).toBe(1);
  });

  test("bad signature -> 400, no credit", async () => {
    seedPayment("222333444", 10000);
    const before = balance();
    const res = await post(body({}, { signature: "0".repeat(64) }));
    expect(res.status).toBe(400);
    expect(balance()).toBe(before);
  });

  test("tampered amount (valid sig over wrong data) -> 400, no credit", async () => {
    seedPayment("333444555", 20000);
    const before = balance();
    const res = await post(body({ amount: 1 }));
    expect(res.status).toBe(400);
    expect(balance()).toBe(before);
  });

  test("amount mismatches stored payment -> 400, no credit", async () => {
    seedPayment("444555666", 30000);
    const before = balance();
    const res = await post(body({ amount: 29999 }));
    expect(res.status).toBe(400);
    expect(balance()).toBe(before);
  });

  test("cancelled event -> 200, no credit, payment not succeeded", async () => {
    const id = seedPayment("555666777", 40000);
    const before = balance();
    const res = await post(
      body(
        { code: "01", desc: "Người dùng hủy thanh toán" },
        { code: "01", desc: "cancelled", success: false },
      ),
    );
    expect(res.status).toBe(200);
    expect(balance()).toBe(before);
    expect(
      (db.prepare("SELECT status FROM payments WHERE id = ?").get(id) as { status: string }).status,
    ).toBe("pending");
  });

  test("malformed JSON -> 400", async () => {
    expect((await post("not json")).status).toBe(400);
  });

  test("unavailable provider config -> 404, no wallet change", async () => {
    const off = makeTestApp(db, { available: false, checksumKey: "" });
    const res = await post(body(), off);
    expect(res.status).toBe(404);
  });
});
