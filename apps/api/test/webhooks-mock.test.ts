// Task 9: guarded mock payment webhook — signature verification, idempotent
// top-up, amount validation, feature gating (404 when off / production).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { signMockPayload } from "@hoborouter/payments";
import { q, makeApp, signUp, createWorkspace, userIdByEmail } from "./helpers";
import type { buildApp } from "../src/app";

const WEBHOOK = "/webhooks/payments/mock";
// Secret is generated per test run — never stored in source.
const KEY = crypto.getRandomValues(new Uint8Array(32)).toString();

let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof makeApp>>["db"];
let memberCookie = "";
const wsA = "ws-hook-a";
const order = "MOCK-HOOK-1";
const ref = "evt-hook-1";

async function seedPayment(db: Awaited<ReturnType<typeof makeApp>>["db"], orderCode: string, amount: number, wsId = wsA) {
  const id = crypto.randomUUID();
  await q(db, 
    "INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at) VALUES (?,?,?,'pending','mock',?,?)",
id, wsId, amount, orderCode, Date.now());
  return id;
}

async function walletBalance(db: Awaited<ReturnType<typeof makeApp>>["db"], wsId: string) {
  return (
    (await q(db, "SELECT balance FROM wallets WHERE workspace_id = ?", wsId))[0] as {
      balance: number;
    }
  ).balance;
}

async function signedBody(ev: Record<string, unknown>) {
  const { signature: _omit, ...rest } = ev as { signature?: unknown };
  void _omit;
  const sig = await signMockPayload(rest, KEY);
  return JSON.stringify({ ...rest, signature: sig });
}

beforeAll(async () => {
  process.env.HBR_MOCK_PAYMENTS = "on";
  process.env.HBR_MOCK_PAYMENTS_WEBHOOK_KEY = KEY;
  delete process.env.NODE_ENV;
  ({ db, app } = await makeApp());
  memberCookie = await signUp(app, "hook-member@test.dev", "M");
  void memberCookie;
  await createWorkspace(db, wsA, await userIdByEmail(db, "hook-member@test.dev"));
  await q(db, 
    "INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at) VALUES (?,?, 'VND', 0, 0, 0, ?)",
`wal-${wsA}`, wsA, Date.now());
  // Disable the default-on first-topup bonus: these tests assert exact plain
  // top-up balances and are about webhook behavior, not the bonus.
  await q(db,
    "INSERT INTO instance_settings (key, value, updated_at) VALUES ('first_topup_bonus_enabled','false',?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    Date.now());
});

afterAll(() => {
  delete process.env.HBR_MOCK_PAYMENTS;
  delete process.env.HBR_MOCK_PAYMENTS_WEBHOOK_KEY;
  delete process.env.NODE_ENV;
});

async function postWebhook(raw: string) {
  return app.handle(
    new Request(`http://localhost${WEBHOOK}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    }),
  );
}

describe("mock webhook — happy path & idempotency", () => {
  test("valid signed event: credited exactly amount, ledger topup row, payment succeeded", async () => {
    await seedPayment(db, order, 50000);
    const res = await postWebhook(
      await signedBody({ provider_order_code: order, provider_reference: ref, amount: 50000 }),
    );
    expect(res.status).toBe(200);
    expect(await walletBalance(db, wsA)).toBe(50000);
    const ledger = await q(db, 
        "SELECT kind, amount, payment_id FROM ledger_entries WHERE payment_id = ? AND kind = 'topup'",
(
          (await q(db, "SELECT id FROM payments WHERE provider_order_code = ?", order))[0] as {
            id: string;
          }
        ).id,) as { kind: string; amount: number; payment_id: string }[];
    expect(ledger.length).toBe(1);
    if (ledger[0]) expect(ledger[0].amount).toBe(50000);
    const pay = (await q(db, "SELECT status FROM payments WHERE provider_order_code = ?", order))[0] as {
      status: string;
    };
    expect(pay.status).toBe("succeeded");
  });

  test("duplicate replay: 2xx, exactly ONE credit total", async () => {
    const res = await postWebhook(
      await signedBody({ provider_order_code: order, provider_reference: ref, amount: 50000 }),
    );
    expect(res.status).toBe(200);
    expect(await walletBalance(db, wsA)).toBe(50000); // unchanged
    const pay = (
      (await q(db, "SELECT id FROM payments WHERE provider_order_code = ?", order))[0] as {
        id: string;
      }
    ).id;
    const ledger = await q(db, "SELECT 1 FROM ledger_entries WHERE payment_id = ? AND kind = 'topup'", pay);
    expect(ledger.length).toBe(1);
    expect(
      (await q(db, "SELECT 1 FROM payment_events WHERE provider = 'mock' AND provider_reference = ?", ref)).length,
    ).toBe(1);
  });

  test("payment_events UNIQUE(provider, provider_reference) enforced at DB level", async () => {
    const payId = (
      (await q(db, "SELECT id FROM payments WHERE provider_order_code = ?", order))[0] as {
        id: string;
      }
    ).id;
    await expect(
      q(db, "INSERT INTO payment_events (id, payment_id, provider, provider_reference, processed_at) VALUES (?,?,?,?,?)",
        crypto.randomUUID(), payId, "mock", ref, Date.now()),
    ).rejects.toThrow();
  });
});

describe("mock webhook — rejections, no credit", () => {
  test("invalid signature -> 400, no event insert, no credit", async () => {
    await seedPayment(db, "MOCK-BADSIG", 1000);
    const raw = JSON.stringify({
      provider_order_code: "MOCK-BADSIG",
      provider_reference: "evt-badsig",
      amount: 1000,
      signature: "deadbeef".repeat(8),
    });
    const res = await postWebhook(raw);
    expect(res.status).toBe(400);
    expect(await walletBalance(db, wsA)).toBe(50000);
    expect(
      (await q(db, "SELECT 1 FROM payment_events WHERE provider_reference = 'evt-badsig'")).length,
    ).toBe(0);
  });

  test("wrong signed event amount (event != payments row) -> 400, no credit, not succeeded", async () => {
    await seedPayment(db, "MOCK-AMT", 2000);
    const res = await postWebhook(
      await signedBody({
        provider_order_code: "MOCK-AMT",
        provider_reference: "evt-amt",
        amount: 9999,
      }),
    );
    expect(res.status).toBe(400);
    expect(await walletBalance(db, wsA)).toBe(50000);
    const pay = (await q(db, "SELECT status FROM payments WHERE provider_order_code = 'MOCK-AMT'"))[0] as {
      status: string;
    };
    expect(pay.status).toBe("pending");
    expect(
      (await q(db, "SELECT 1 FROM payment_events WHERE provider_reference = 'evt-amt'")).length,
    ).toBe(0);
  });

  test("unknown order code -> 400, no credit", async () => {
    const res = await postWebhook(
      await signedBody({
        provider_order_code: "MOCK-UNKNOWN",
        provider_reference: "evt-unknown",
        amount: 100,
      }),
    );
    expect(res.status).toBe(400);
    expect(await walletBalance(db, wsA)).toBe(50000);
  });
});

describe("mock webhook — feature gating", () => {
  test("flag off -> 404", async () => {
    const saved = process.env.HBR_MOCK_PAYMENTS;
    process.env.HBR_MOCK_PAYMENTS = "off";
    const { buildApp } = await import("../src/app");
    const { createTestDb } = await import("@hoborouter/db");
    const d = (await createTestDb()).db;
    const fresh = await buildApp({ db: d });
    const res = await fresh.handle(
      new Request(`http://localhost${WEBHOOK}`, { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(404);
    if (saved === undefined) delete process.env.HBR_MOCK_PAYMENTS;
    else process.env.HBR_MOCK_PAYMENTS = saved;
  });

  test("webhook key unset -> 404 (NODE_ENV irrelevant)", async () => {
    const savedEnv = process.env.NODE_ENV;
    const savedSecret = process.env.BETTER_AUTH_SECRET;
    process.env.NODE_ENV = "production";
    // production now asserts a >=32 char auth secret at startup
    process.env.BETTER_AUTH_SECRET = "test-secret-0123456789abcdef0123456789abcdef";
    process.env.HBR_BASE_URL = process.env.HBR_BASE_URL || "http://localhost:3000";
    const savedKey = process.env.HBR_MOCK_PAYMENTS_WEBHOOK_KEY;
    delete process.env.HBR_MOCK_PAYMENTS_WEBHOOK_KEY;
    const { buildApp } = await import("../src/app");
    const { createTestDb } = await import("@hoborouter/db");
    const d = (await createTestDb()).db;
    const fresh = await buildApp({ db: d });
    const res = await fresh.handle(
      new Request(`http://localhost${WEBHOOK}`, { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(404);
    if (savedEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv;
    if (savedSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = savedSecret;
    if (savedKey === undefined) delete process.env.HBR_MOCK_PAYMENTS_WEBHOOK_KEY;
    else process.env.HBR_MOCK_PAYMENTS_WEBHOOK_KEY = savedKey;
  });
});

describe("mock webhook — error funnel hardening (P1)", () => {
  test("non-UNIQUE insert failure propagates, no already_processed, no credit", async () => {
    const { processMockPaymentEvent, MockPaymentError } = await import("@hoborouter/payments");
    await seedPayment(db, "MOCK-BOOM", 6000);
    const before = await walletBalance(db, wsA);
    await q(db,
    "CREATE FUNCTION payment_events_boom_fn() RETURNS trigger AS 'BEGIN RAISE EXCEPTION ''boom''; END' LANGUAGE plpgsql");
    await q(db,
      "CREATE TRIGGER payment_events_boom BEFORE INSERT ON payment_events FOR EACH ROW EXECUTE FUNCTION payment_events_boom_fn()");
    try {
      let caught: unknown;
      try {
        await processMockPaymentEvent(db, {
          orderCode: "MOCK-BOOM",
          providerReference: "evt-boom",
          amount: 6000,
          rawPayload: "{}",
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(MockPaymentError);
      expect(String(caught)).toContain("boom");
    } finally {
      await q(db, "DROP TRIGGER payment_events_boom ON payment_events");
      await q(db, "DROP FUNCTION payment_events_boom_fn");
    }
    expect(await walletBalance(db, wsA)).toBe(before);
    expect(
      (
        (await q(db, "SELECT status FROM payments WHERE provider_order_code = 'MOCK-BOOM'"))[0] as {
          status: string;
        }
      ).status,
    ).toBe("pending");
    // Recovery after trigger removal: full credit works.
    const res = await postWebhook(
      await signedBody({
        provider_order_code: "MOCK-BOOM",
        provider_reference: "evt-boom",
        amount: 6000,
      }),
    );
    expect(res.status).toBe(200);
    expect(await walletBalance(db, wsA)).toBe(before + 6000);
  });

  test("same provider_reference on a DIFFERENT payment -> invalid error, no credit", async () => {
    const { processMockPaymentEvent, MockPaymentError } = await import("@hoborouter/payments");
    await seedPayment(db, "MOCK-DUPB", 5000);
    const before = await walletBalance(db, wsA);
    // evt-hook-1 already belongs to payment MOCK-HOOK-1 (same provider 'mock').
    expect(() =>
      processMockPaymentEvent(db, {
        orderCode: "MOCK-DUPB",
        providerReference: "evt-hook-1",
        amount: 5000,
        rawPayload: "{}",
      }),
    ).toThrow(MockPaymentError);
    expect(await walletBalance(db, wsA)).toBe(before);
    expect(
      (
        (await q(db, "SELECT status FROM payments WHERE provider_order_code = 'MOCK-DUPB'"))[0] as {
          status: string;
        }
      ).status,
    ).toBe("pending");
  });

  test("succeeded payment + DISTINCT reference -> 400, no second credit, no unaudited event", async () => {
    const before = await walletBalance(db, wsA);
    const res = await postWebhook(
      await signedBody({
        provider_order_code: order,
        provider_reference: "evt-hook-1-distinct",
        amount: 50000,
      }),
    );
    expect(res.status).toBe(400);
    expect(await walletBalance(db, wsA)).toBe(before);
    expect(
      (await q(db, "SELECT 1 FROM payment_events WHERE provider_reference = 'evt-hook-1-distinct'")).length,
    ).toBe(0);
  });

  test("succeeded payment + CHANGED amount -> 400 even with same reference", async () => {
    const before = await walletBalance(db, wsA);
    const res = await postWebhook(
      await signedBody({
        provider_order_code: order,
        provider_reference: ref,
        amount: 99999,
      }),
    );
    expect(res.status).toBe(400);
    expect(await walletBalance(db, wsA)).toBe(before);
  });
});

describe("transaction composition — late failure rolls back credit", () => {
  test("failure after creditWallet rolls back event + credit + status (atomicity)", async () => {
    const { processMockPaymentEvent } = await import("@hoborouter/payments");
    await seedPayment(db, "MOCK-LATEFAIL", 3000);
    const before = await walletBalance(db, wsA);
    // Caller wraps processing in its own transaction and fails AFTER the credit
    // (simulating a late audit/event write failure). Everything must roll back.
    await expect(
      db.transaction(async (tx) => {
        const r = await processMockPaymentEvent(tx, {
          orderCode: "MOCK-LATEFAIL",
          providerReference: "evt-latefail",
          amount: 3000,
          rawPayload: "{}",
        });
        expect(r.outcome).toBe("credited");
        throw new Error("late audit failure");
      }),
    ).rejects.toThrow("late audit failure");
    expect(await walletBalance(db, wsA)).toBe(before);
    expect(
      (await q(db, "SELECT 1 FROM payment_events WHERE provider_reference = 'evt-latefail'"))
        .length,
    ).toBe(0);
    const pay = (await q(db, "SELECT status FROM payments WHERE provider_order_code = 'MOCK-LATEFAIL'"))[0] as {
      status: string;
    };
    expect(pay.status).toBe("pending");
    // Wallet remains usable; retry succeeds exactly once.
    const retry = await postWebhook(
      await signedBody({
        provider_order_code: "MOCK-LATEFAIL",
        provider_reference: "evt-latefail-retry",
        amount: 3000,
      }),
    );
    expect(retry.status).toBe(200);
    expect(await walletBalance(db, wsA)).toBe(before + 3000);
  });

  test("race-safe idempotency: sequential serialized replays credit once", async () => {
    const { processMockPaymentEvent } = await import("@hoborouter/payments");
    await seedPayment(db, "MOCK-RACE", 4000);
    const before = await walletBalance(db, wsA);
    const ev = {
      orderCode: "MOCK-RACE",
      providerReference: "evt-race",
      amount: 4000,
      rawPayload: "{}",
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        Promise.resolve()
          .then(() => processMockPaymentEvent(db, ev))
          .catch((e: unknown) => ({ error: String(e) })),
      ),
    );
    const credited = results.filter((r) => "outcome" in r && r.outcome === "credited");
    const already = results.filter((r) => "outcome" in r && r.outcome === "already_processed");
    expect(credited.length).toBe(1);
    expect(already.length).toBe(7);
    expect(await walletBalance(db, wsA)).toBe(before + 4000);
  });
});
