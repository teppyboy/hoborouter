// Prepaid throughput allowance: schema behavior on a real migrated PostgreSQL
// database + settlement through processMockPaymentEvent. A settled throughput
// payment activates a fixed-window gateway admission cap and grants NO wallet
// credit and NO ledger entry; replays stay idempotent; a second purchase
// chains after the incumbent window so active windows never overlap; expiry
// is lazy (status flips only when a check runs against a lapsed window).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, type Db } from "../packages/db/src/index";
import { processMockPaymentEvent } from "../packages/payments/src/credit";

const NOW = 1_700_000_000_000;
const DAY_MS = 86_400_000;

let db: Db;
let drop: () => Promise<void>;

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  drop = t.drop;
});

afterAll(async () => {
  await drop();
});

async function exec(text: string, params: unknown[] = []): Promise<void> {
  await db.$client.unsafe(text, params as never[]);
}

async function rows<T>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.$client.unsafe(text, params as never[])) as T[];
}

beforeAll(async () => {
  // Owner rule D2 first-topup bonus is a wallet credit; it is orthogonal to
  // the allowance product and disabled here to isolate the no-credit claim.
  await exec(
    `INSERT INTO instance_settings (key, value, updated_at) VALUES ('first_topup_bonus_enabled', 'false', $1)`,
    [NOW],
  );
});

async function seedWorkspace(id: string): Promise<void> {
  await exec(
    `INSERT INTO workspaces (id, name, status, created_at) VALUES ($1, $1, 'active', $2)`,
    [id, NOW],
  );
  await exec(
    `INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at)
     VALUES ($1, $2, 'VND', 0, 0, 0, $3)`,
    ["wal-" + id, id, NOW],
  );
}

async function seedProduct(
  id: string,
  overrides: {
    price?: number;
    rpm?: number;
    duration?: number;
    active?: boolean;
  } = {},
): Promise<void> {
  // Upsert: tests re-seed the same product id to change bounds between cases.
  await exec(
    `INSERT INTO throughput_products (id, name, price_vnd, requests_per_minute, duration_days, active, created_at)
     VALUES ($1, $1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET requests_per_minute = EXCLUDED.requests_per_minute,
       duration_days = EXCLUDED.duration_days, active = EXCLUDED.active`,
    [
      id,
      overrides.price ?? 150_000,
      overrides.rpm ?? 30,
      overrides.duration ?? 7,
      overrides.active ?? true,
      NOW,
    ],
  );
}

async function seedPayment(opts: {
  id: string;
  ws: string;
  amount: number;
  orderCode: string;
  productId: string;
  provider?: string;
}): Promise<void> {
  await exec(
    `INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at, throughput_product_id)
     VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7)`,
    [opts.id, opts.ws, opts.amount, opts.provider ?? "mock", opts.orderCode, NOW, opts.productId],
  );
}

const ev = (orderCode: string, ref: string, amount: number, provider = "mock") => ({
  provider,
  orderCode,
  providerReference: ref,
  amount,
  rawPayload: JSON.stringify({ orderCode, ref }),
});

async function allowance(ws: string): Promise<{
  rpm: number;
  start: number;
  end: number;
  status: string;
} | null> {
  const r = (
    await rows<{ rpm: string; start: string; end: string; status: string }>(
      `SELECT requests_per_minute rpm, starts_at start, ends_at end, status
       FROM throughput_allowances WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [ws],
    )
  )[0];
  return r
    ? { rpm: Number(r.rpm), start: Number(r.start), end: Number(r.end), status: r.status }
    : null;
}

describe("throughput allowance schema", () => {
  test("product bounds: rpm 1..600, duration 1..3650, positive VND price", async () => {
    await seedProduct("tp-ok");
    for (const [col, val] of [
      ["requests_per_minute", 0],
      ["requests_per_minute", 601],
      ["duration_days", 0],
      ["duration_days", 3651],
      ["price_vnd", 0],
    ] as const) {
      await expect(
        exec(
          `INSERT INTO throughput_products (id, name, price_vnd, requests_per_minute, duration_days, active, created_at)
           VALUES ($1, $1, $2, $3, $4, true, $5)`,
          [
            "tp-bad-" + col + val,
            col === "price_vnd" ? val : 1000,
            col === "requests_per_minute" ? val : 30,
            col === "duration_days" ? val : 7,
            NOW,
          ],
        ),
      ).rejects.toBeInstanceOf(Error);
    }
    await exec(`DELETE FROM throughput_products WHERE id = 'tp-ok'`);
  });

  test("allowance window must be ordered [starts_at, ends_at)", async () => {
    await expect(
      exec(
        `INSERT INTO throughput_allowances (id, workspace_id, payment_id, product_id, requests_per_minute, starts_at, ends_at, status, created_at)
         VALUES ('ta-bad', 'ws-x', 'pay-x', 'prod-x', 30, $1, $1, 'active', $1)`,
        [NOW],
      ),
    ).rejects.toBeInstanceOf(Error);
  });

  test("payment rows cannot reference a missing throughput product (FK)", async () => {
    await seedWorkspace("ws-orphan");
    await expect(
      seedPayment({
        id: "pay-orphan",
        ws: "ws-orphan",
        amount: 1000,
        orderCode: "ORD-TP-X",
        productId: "tp-missing",
      }),
    ).rejects.toBeInstanceOf(Error);
    expect((await rows(`SELECT 1 FROM payments WHERE id = 'pay-orphan'`)).length).toBe(0);
  });

  test("at most one active allowance per workspace; another workspace is unaffected", async () => {
    await seedWorkspace("ws-uniq");
    await seedProduct("tp-uniq");
    await exec(
      `INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at, throughput_product_id)
       VALUES ('pay-u1', 'ws-uniq', 1000, 'pending', 'mock', 'U1', $1, 'tp-uniq')`,
      [NOW],
    );
    await exec(
      `INSERT INTO throughput_allowances (id, workspace_id, payment_id, product_id, requests_per_minute, starts_at, ends_at, status, created_at)
       VALUES ('ta-u1', 'ws-uniq', 'pay-u1', 'tp-uniq', 30, $1, $2, 'active', $1)`,
      [NOW, NOW + DAY_MS],
    );
    await expect(
      exec(
        `INSERT INTO throughput_allowances (id, workspace_id, payment_id, product_id, requests_per_minute, starts_at, ends_at, status, created_at)
         VALUES ('ta-u2', 'ws-uniq', 'pay-u1', 'tp-uniq', 60, $1, $2, 'active', $1)`,
        [NOW, NOW + DAY_MS],
      ),
    ).rejects.toBeInstanceOf(Error);
    // A second active row is fine on ANOTHER workspace.
    await seedWorkspace("ws-uniq2");
    await exec(
      `INSERT INTO throughput_allowances (id, workspace_id, payment_id, product_id, requests_per_minute, starts_at, ends_at, status, created_at)
       VALUES ('ta-u3', 'ws-uniq2', 'pay-u1', 'tp-uniq', 30, $1, $2, 'active', $1)`,
      [NOW, NOW + DAY_MS],
    );
  });

  test("payments carry at most one purchase kind (bundle/plan/throughput)", async () => {
    await seedProduct("tp-mix");
    await expect(
      exec(
        `INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at, bundle_id, throughput_product_id)
         VALUES ('pay-mix', 'ws-uniq', 1000, 'pending', 'mock', 'M1', $1, 'tp-mix', 'tp-mix')`,
        [NOW],
      ),
    ).rejects.toBeInstanceOf(Error);
  });
});

describe("throughput allowance settlement", () => {
  test("settled payment activates the window, grants NO wallet credit, NO ledger", async () => {
    await seedWorkspace("ws-settle");
    await seedProduct("tp-settle", { price: 150_000, rpm: 30, duration: 7 });
    await seedPayment({
      id: "pay-s1",
      ws: "ws-settle",
      amount: 150_000,
      orderCode: "ORD-TP-1",
      productId: "tp-settle",
    });
    const r = await processMockPaymentEvent(db, ev("ORD-TP-1", "evt-tp-1", 150_000));
    expect(r.outcome).toBe("credited");
    const a = await allowance("ws-settle");
    expect(a).not.toBeNull();
    expect(a!.rpm).toBe(30);
    expect(a!.end - a!.start).toBe(7 * DAY_MS);
    // NO wallet credit of any kind: topup balance unchanged, no subscription
    // wallet created, no ledger entry references the payment.
    const bal = Number(
      (
        await rows<{ balance: string }>(
          `SELECT balance FROM wallets WHERE workspace_id = 'ws-settle' AND kind = 'topup'`,
        )
      )[0]!.balance,
    );
    expect(bal).toBe(0);
    const subWallets = await rows(
      `SELECT 1 FROM wallets WHERE workspace_id = 'ws-settle' AND kind = 'subscription'`,
    );
    expect(subWallets.length).toBe(0);
    const ledger = await rows(`SELECT 1 FROM ledger_entries WHERE payment_id = 'pay-s1'`);
    expect(ledger.length).toBe(0);
  });

  test("replay of the settled event is idempotent: one allowance row, no second window", async () => {
    const r = await processMockPaymentEvent(db, ev("ORD-TP-1", "evt-tp-1", 150_000));
    expect(r.outcome).toBe("already_processed");
    const all = await rows(`SELECT 1 FROM throughput_allowances WHERE workspace_id = 'ws-settle'`);
    expect(all.length).toBe(1);
    // A DIFFERENT reference on the same succeeded payment also never settles twice.
    await expect(
      processMockPaymentEvent(db, ev("ORD-TP-1", "evt-tp-1-other", 150_000)),
    ).rejects.toBeInstanceOf(Error);
    expect(
      (await rows(`SELECT 1 FROM throughput_allowances WHERE workspace_id = 'ws-settle'`)).length,
    ).toBe(1);
  });

  test("second purchase queues behind the incumbent window (no overlapping active windows)", async () => {
    await seedProduct("tp-settle", { price: 150_000, rpm: 60, duration: 7 });
    await seedPayment({
      id: "pay-s2",
      ws: "ws-settle",
      amount: 150_000,
      orderCode: "ORD-TP-2",
      productId: "tp-settle",
    });
    const before = await allowance("ws-settle");
    const r = await processMockPaymentEvent(db, ev("ORD-TP-2", "evt-tp-2", 150_000));
    expect(r.outcome).toBe("credited");
    const a = await allowance("ws-settle");
    expect(a!.start).toBe(before!.end);
    expect(a!.rpm).toBe(60);
    expect(a!.status).toBe("scheduled");
    // The incumbent stays the only active row.
    const actives = await rows(
      `SELECT 1 FROM throughput_allowances WHERE workspace_id = 'ws-settle' AND status = 'active'`,
    );
    expect(actives.length).toBe(1);
  });

  test("lazy transition: lapsed active expires, queued scheduled promotes exactly once", async () => {
    // ws-lazy: first purchase active and already lapsed; second purchase
    // queued to start right after the lapsed window.
    await seedWorkspace("ws-lazy");
    await seedProduct("tp-lazy", { rpm: 10, duration: 7 });
    await seedPayment({
      id: "pay-l1",
      ws: "ws-lazy",
      amount: 150_000,
      orderCode: "ORD-L1",
      productId: "tp-lazy",
    });
    await processMockPaymentEvent(db, ev("ORD-L1", "evt-l1", 150_000));
    await seedPayment({
      id: "pay-l2",
      ws: "ws-lazy",
      amount: 150_000,
      orderCode: "ORD-L2",
      productId: "tp-lazy",
    });
    await processMockPaymentEvent(db, ev("ORD-L2", "evt-l2", 150_000));
    // Lapse the active window AND pull the queued window into the past
    // (windows stay ordered), so the settlement below must expire the
    // lapsed row AND the already-lapsed queued row before activating the
    // new purchase.
    await exec(
      `UPDATE throughput_allowances SET ends_at = starts_at + 1 WHERE workspace_id = 'ws-lazy' AND status = 'active'`,
    );
    await exec(
      `UPDATE throughput_allowances SET starts_at = starts_at - 604799998, ends_at = starts_at - 604799996 WHERE workspace_id = 'ws-lazy' AND status = 'scheduled'`,
    );
    // The lapsed row still reads 'active' — status flips only lazily.
    expect(
      (
        await rows<{ n: string }>(
          `SELECT COUNT(*) n FROM throughput_allowances WHERE workspace_id = 'ws-lazy' AND status = 'active'`,
        )
      )[0]!.n,
    ).toBe("1");
    // Third purchase: settlement's lazy transition expires the lapsed window
    // and promotes the queued one before chaining the new purchase.
    await seedPayment({
      id: "pay-l3",
      ws: "ws-lazy",
      amount: 150_000,
      orderCode: "ORD-L3",
      productId: "tp-lazy",
    });
    await processMockPaymentEvent(db, ev("ORD-L3", "evt-l3", 150_000));
    const all = await rows<{ status: string; start: string; end: string; rpm: string }>(
      `SELECT status, starts_at start, ends_at end, requests_per_minute rpm
       FROM throughput_allowances WHERE workspace_id = 'ws-lazy' ORDER BY starts_at ASC`,
    );
    expect(all.length).toBe(3);
    // Both earlier windows (the lapsed active and the queued one whose whole
    // window lapsed while queued) end expired; the new purchase is active.
    expect(all[0]!.status).toBe("expired");
    expect(all[1]!.status).toBe("expired");
    expect(all[2]!.status).toBe("active");
    // Chaining kept windows ordered and non-overlapping.
    expect(Number(all[1]!.start)).toBeGreaterThanOrEqual(Number(all[0]!.end));
    expect(Number(all[2]!.start)).toBeGreaterThanOrEqual(Number(all[1]!.end));
  });

  test("concurrent settlement of two purchases activates exactly one and queues the other", async () => {
    await seedWorkspace("ws-race");
    await seedProduct("tp-race", { rpm: 30, duration: 7 });
    await seedPayment({
      id: "pay-r1",
      ws: "ws-race",
      amount: 150_000,
      orderCode: "ORD-R1",
      productId: "tp-race",
    });
    await seedPayment({
      id: "pay-r2",
      ws: "ws-race",
      amount: 150_000,
      orderCode: "ORD-R2",
      productId: "tp-race",
    });
    const results = await Promise.allSettled([
      processMockPaymentEvent(db, ev("ORD-R1", "evt-r1", 150_000)),
      processMockPaymentEvent(db, ev("ORD-R2", "evt-r2", 150_000)),
    ]);
    const credited = results.filter((r) => r.status === "fulfilled").length;
    expect(credited).toBe(2);
    const all = await rows<{ status: string; start: string; end: string }>(
      `SELECT status, starts_at start, ends_at end FROM throughput_allowances WHERE workspace_id = 'ws-race' ORDER BY starts_at ASC`,
    );
    expect(all.length).toBe(2);
    const actives = all.filter((r) => r.status === "active");
    expect(actives.length).toBe(1);
    // No overlap: the queued window starts exactly at the first window's end.
    expect(Number(all[1]!.start)).toBeGreaterThanOrEqual(Number(all[0]!.end));
  });

  test("lazy expiry via settlement: lapsed window flips to expired, exactly one active remains", async () => {
    // Force the newest window to be lapsed and pull the queued window into
    // the past (windows stay ordered) before the settlement that runs the
    // lazy transition.
    await exec(
      `UPDATE throughput_allowances SET ends_at = starts_at + 1 WHERE workspace_id = 'ws-settle' AND status = 'active'`,
    );
    await exec(
      `UPDATE throughput_allowances SET starts_at = starts_at - 604799998, ends_at = starts_at - 604799996 WHERE workspace_id = 'ws-settle' AND status = 'scheduled'`,
    );
    // The lapsed row still reads 'active' — status flips only lazily.
    expect(
      (
        await rows<{ n: string }>(
          `SELECT COUNT(*) n FROM throughput_allowances WHERE workspace_id = 'ws-settle' AND status = 'active'`,
        )
      )[0]!.n,
    ).toBe("1");
    // Settlement expiry pass (third purchase on a fresh product).
    await seedProduct("tp-lapse", { duration: 7 });
    await seedPayment({
      id: "pay-s3",
      ws: "ws-settle",
      amount: 150_000,
      orderCode: "ORD-TP-3",
      productId: "tp-lapse",
    });
    await processMockPaymentEvent(db, ev("ORD-TP-3", "evt-tp-3", 150_000));
    const expired = await rows<{ status: string }>(
      `SELECT status FROM throughput_allowances WHERE workspace_id = 'ws-settle' ORDER BY created_at ASC`,
    );
    // All earlier windows resolved as expired; the new purchase is the only
    // active window.
    const actives = expired.filter((r) => r.status === "active");
    expect(expired.length).toBeGreaterThanOrEqual(2);
    expect(actives.length).toBe(1);
    expect(expired[0]!.status).toBe("expired");
    expect(expired[1]!.status).toBe("expired");
  });

  test("settlement reads bounds from the product at settle time", async () => {
    // Products are immutable-by-convention but not enforced by storage; the
    // settlement contract is that the CURRENT product bounds define the
    // activated window (same settle-time read as bundle credit_vnd).
    await seedWorkspace("ws-det");
    await seedProduct("tp-det", { rpm: 30, duration: 7 });
    await seedPayment({
      id: "pay-det",
      ws: "ws-det",
      amount: 150_000,
      orderCode: "ORD-DET",
      productId: "tp-det",
    });
    await seedProduct("tp-det", { rpm: 45, duration: 3 });
    await processMockPaymentEvent(db, ev("ORD-DET", "evt-det", 150_000));
    const a = await allowance("ws-det");
    expect(a!.rpm).toBe(45);
    expect(a!.end - a!.start).toBe(3 * DAY_MS);
  });
});
