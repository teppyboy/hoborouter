// Gateway funding selection (O3) through reserveRequest's funding arg:
// subscription wallet first (active unexpired + available >= cap + under the
// per-minute limit), else topup; lazy expiry runs inside the same transaction;
// settle/release/refund return money to the reservation wallet; concurrent
// reserves never violate balance >= reserved on either wallet.
import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { createTestDb, type Db } from "../packages/db/src/index";
import {
  reserveRequest,
  markDispatching,
  settleRequest,
  refundCharge,
  releaseRequest,
  getWallet,
  applySubscriptionExpiry,
  runInImmediate,
  creditWallet,
  ensureSubscriptionWallet,
  extendOrCreateSubscription,
  WalletError,
} from "../packages/wallet/src/index";

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

async function q<T>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.$client.unsafe(text, params as never[])) as T[];
}

interface Fixture {
  ws: string;
  key: string;
  topup: string;
  model: string;
  mapping: string;
  price: string;
}

const FIX: Fixture = {
  ws: "ws-fund",
  key: "key-fund",
  topup: "wal-topup-fund",
  model: "model-fund",
  mapping: "pm-fund",
  price: "price-fund",
};

async function seed(): Promise<void> {
  await db.$client.unsafe(
    `INSERT INTO users (id, name, email, created_at, updated_at) VALUES ('u-fund','U','u-fund@t.local',$1,$1)`,
    [NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO workspaces (id, name, status, created_at) VALUES ($1,'F','active',$2)`,
    [FIX.ws, NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at)
     VALUES ($1,$2,'hash-fund','sk-hbr-f','key f','active',$3)`,
    [FIX.key, FIX.ws, NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at)
     VALUES ($1,$2,'VND',0,0,0,$3)`,
    [FIX.topup, FIX.ws, NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO models (id, public_id, slug, display_name, provider, enabled, published, created_at, updated_at)
     VALUES ($1,'pub-f','slug-f','Model F','openai',true,true,$2,$2)`,
    [FIX.model, NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at)
     VALUES ($1,$2,'openai','upstream-f',true,$3,$3)`,
    [FIX.mapping, FIX.model, NOW] as never[],
  );
  await db.$client.unsafe(
    `INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at)
     VALUES ($1,$2,1000000,2000000,500000,3000000,1000000,$3)`,
    [FIX.price, FIX.model, NOW] as never[],
  );
}

beforeAll(async () => {
  await seed();
  await db.$client.unsafe(
    `INSERT INTO subscription_plans (id, name, price_vnd, credit_per_period_vnd, period_days, active, created_at)
     VALUES ('plan-fund','plan-fund',100000,100000,30,true,$1)`,
    [NOW] as never[],
  );
});

async function seedSubscriptionWallet(balance: number): Promise<string> {
  await db.$client.unsafe(
    `INSERT INTO wallets (id, workspace_id, currency, kind, balance, reserved, version, created_at)
     VALUES ('wal-sub-fund',$1,'VND','subscription',$2,0,0,$3)`,
    [FIX.ws, balance, NOW] as never[],
  );
  return "wal-sub-fund";
}

async function seedSubscription(periodEnd: number): Promise<void> {
  await db.$client.unsafe(
    `INSERT INTO subscriptions (id, workspace_id, plan_id, status, current_period_start, current_period_end, created_at)
     VALUES ('sub-fund',$1,'plan-fund','active',$2,$3,$2)`,
    [FIX.ws, NOW - DAY_MS, periodEnd] as never[],
  );
}

async function creditTopup(amount: number, paymentId: string): Promise<void> {
  await db.$client.unsafe(
    `INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at)
     VALUES (${`'${paymentId}'`}, ${`'${FIX.ws}'`}, ${amount}, 'succeeded', 'mock', ${`'order-${paymentId}'`}, ${NOW})`,
  );
  await db.$client.unsafe(
    `UPDATE wallets SET balance = balance + ${amount} WHERE id = '${FIX.topup}'`,
  );
  await db.$client.unsafe(
    `INSERT INTO ledger_entries (id, wallet_id, direction, amount, kind, payment_id, balance_after, memo, created_at)
     VALUES ('led-${paymentId}', '${FIX.topup}', 'credit', ${amount}, 'topup', '${paymentId}', ${amount}, 'test', ${NOW})`,
  );
}

// Seed the subscription wallet's opening balance AS a ledger credit so the
// balance == sum(ledger) invariant holds for the tests that pin it.
async function seedSubscriptionCredit(balance: number, ledgerId: string): Promise<void> {
  await seedSubscriptionWallet(balance);
  await db.$client.unsafe(
    `INSERT INTO ledger_entries (id, wallet_id, direction, amount, kind, balance_after, memo, created_at)
     VALUES ($1,'wal-sub-fund','credit',$2,'topup',$3,'test seed',$4)`,
    [ledgerId, balance, balance, NOW] as never[],
  );
}

let reqSeq = 0;
function reserveArgs(over: Partial<Parameters<typeof reserveRequest>[1]> = {}) {
  reqSeq += 1;
  return {
    requestId: `req-fund-${reqSeq}`,
    workspaceId: FIX.ws,
    apiKeyId: FIX.key,
    modelId: FIX.model,
    mappingId: FIX.mapping,
    modelPriceId: FIX.price,
    endpoint: "/v1/chat/completions" as const,
    mode: "stream" as const,
    fxRate: 26_000,
    capVnd: 5_000,
    now: NOW,
    ...over,
  };
}

async function walletOf(id: string): Promise<{ balance: number; reserved: number }> {
  const w = await getWallet(db, id);
  return { balance: w.balance, reserved: w.reserved };
}

afterEach(async () => {
  // Tests share one DB: reset the mutable billing tables between cases.
  await db.$client.unsafe(
    `TRUNCATE requests, billing_reservations, settlements, usage_logs, ledger_entries,
     subscription_expiries, subscriptions, audit_log, wallets CASCADE`,
  );
  await db.$client.unsafe(`DELETE FROM payments`);
  await db.$client.unsafe(
    `INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at)
     VALUES ($1, $2, 'VND', 0, 0, 0, $3)`,
    [FIX.topup, FIX.ws, NOW] as never[],
  );
});

describe("funding selection", () => {
  test("picks the subscription wallet when active, unexpired, available >= cap, under limit", async () => {
    const subId = await seedSubscriptionWallet(100_000);
    await seedSubscription(NOW + 30 * DAY_MS);
    const r = await reserveRequest(db, reserveArgs({ funding: { underLimit: true } }));
    expect(r.walletKind).toBe("subscription");
    const br = await q<{ wallet_id: string }>(
      `SELECT wallet_id FROM billing_reservations WHERE id = $1`,
      [r.reservationId],
    );
    expect(br[0]!.wallet_id).toBe(subId);
    expect((await walletOf(subId)).reserved).toBe(5_000);
    expect((await walletOf(FIX.topup)).reserved).toBe(0);
  });

  test("falls back to the topup wallet when the subscription cannot cover the cap", async () => {
    await creditTopup(100_000, "pay-fund-t1");
    await seedSubscriptionWallet(3_000);
    await seedSubscription(NOW + 30 * DAY_MS);
    const r = await reserveRequest(db, reserveArgs({ funding: { underLimit: true } }));
    expect(r.walletKind).toBe("topup");
    const br = await q<{ wallet_id: string }>(
      `SELECT wallet_id FROM billing_reservations WHERE id = $1`,
      [r.reservationId],
    );
    expect(br[0]!.wallet_id).toBe(FIX.topup);
    expect((await walletOf("wal-sub-fund")).reserved).toBe(0);
  });

  test("over the per-minute limit: topup funds even with an ample subscription", async () => {
    await creditTopup(100_000, "pay-fund-t2");
    await seedSubscriptionWallet(100_000);
    await seedSubscription(NOW + 30 * DAY_MS);
    const r = await reserveRequest(db, reserveArgs({ funding: { underLimit: false } }));
    expect(r.walletKind).toBe("topup");
  });

  test("expired subscription: lazy expiry forfeits once in the same txn, then topup funds", async () => {
    await creditTopup(100_000, "pay-fund-t3");
    await seedSubscriptionWallet(100_000);
    await seedSubscription(NOW - 1_000);
    const r = await reserveRequest(db, reserveArgs({ funding: { underLimit: true } }));
    expect(r.walletKind).toBe("topup");
    // Expiry forfeited the full 100_000 exactly once as an adjustment debit.
    const forfeits = await q<{ amount: string; memo: string }>(
      `SELECT l.amount, l.memo FROM ledger_entries l
       JOIN wallets w ON w.id = l.wallet_id WHERE w.kind = 'subscription' AND l.kind = 'adjustment'`,
    );
    expect(forfeits).toEqual([{ amount: "100000", memo: "subscription expired" }]);
    expect((await walletOf("wal-sub-fund")).balance).toBe(0);
    const gate = await q<{ c: string }>(
      `SELECT COUNT(*) c FROM subscription_expiries WHERE subscription_id = 'sub-fund'`,
    );
    expect(Number(gate[0]!.c)).toBe(1);
  });

  test("no subscription at all: topup funds (legacy behavior)", async () => {
    await creditTopup(100_000, "pay-fund-t4");
    const r = await reserveRequest(db, reserveArgs({ funding: { underLimit: true } }));
    expect(r.walletKind).toBe("topup");
  });

  test("both wallets below cap: insufficient, nothing written (402 path)", async () => {
    await seedSubscriptionWallet(1_000);
    await seedSubscription(NOW + 30 * DAY_MS);
    let err: unknown;
    try {
      await reserveRequest(db, reserveArgs({ funding: { underLimit: true } }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WalletError);
    expect((err as WalletError).code).toBe("insufficient");
    const counts = await q<{ requests: string; brs: string; ledger: string }>(
      `SELECT (SELECT COUNT(*) FROM requests) requests,
              (SELECT COUNT(*) FROM billing_reservations) brs,
              (SELECT COUNT(*) FROM ledger_entries) ledger`,
    );
    expect(counts[0]).toEqual({ requests: "0", brs: "0", ledger: "0" });
  });
});

describe("settle/refund symmetry on the funding wallet", () => {
  test("settle debits and refund credits the subscription wallet; topup untouched", async () => {
    const subId = await seedSubscriptionWallet(100_000);
    await seedSubscription(NOW + 30 * DAY_MS);
    await creditTopup(50_000, "pay-fund-s1");
    const args = reserveArgs({ capVnd: 100_000, funding: { underLimit: true } });
    const r = await reserveRequest(db, args);
    expect(r.walletKind).toBe("subscription");
    await markDispatching(db, args.requestId, NOW);
    const settle = await settleRequest(
      db,
      args.requestId,
      {
        kind: "usage",
        usage: {
          inputTokens: 1_000_000n,
          cachedInputTokens: 0n,
          outputTokens: 1_000_000n,
          reasoningTokens: 0n,
        },
        upstreamModel: "upstream-f",
        provider: "openai",
        publicModel: "pub-f",
      },
      NOW,
    );
    expect(settle.status).toBe("settled");
    expect(settle.chargedVnd).toBe(78_000); // (1M in + 2M out) usd micro x 26000 / 1e6, markup 1x, under the 100_000 cap
    const sub = await walletOf(subId);
    expect(sub.balance).toBe(22_000); // 100_000 - 78_000
    expect(sub.reserved).toBe(0);
    // The settle debit lives on the subscription wallet.
    const settleRows = await q<{ wallet_id: string; kind: string; direction: string }>(
      `SELECT wallet_id, kind, direction FROM ledger_entries WHERE kind = 'settle'`,
    );
    expect(settleRows).toEqual([{ wallet_id: subId, kind: "settle", direction: "debit" }]);
    // Refund follows the original settle debit's wallet.
    const refund = await refundCharge(db, {
      originalLedgerEntryId: (
        await q<{ id: string }>(`SELECT id FROM ledger_entries WHERE kind = 'settle'`)
      )[0]!.id,
      amount: 10_000,
      actorUserId: "u-fund",
      reason: "goodwill",
      now: NOW,
    });
    expect(refund.alreadyRefunded).toBe(false);
    expect((await walletOf(subId)).balance).toBe(32_000);
    const refundRows = await q<{ wallet_id: string }>(
      `SELECT wallet_id FROM ledger_entries WHERE kind = 'refund'`,
    );
    expect(refundRows).toEqual([{ wallet_id: subId }]);
    expect((await walletOf(FIX.topup)).balance).toBe(50_000); // untouched
  });
});

describe("expiry with reserved holds (O5)", () => {
  test("credit freed by a release after expiry is forfeited before use/renewal", async () => {
    const subId = await seedSubscriptionWallet(100_000);
    await seedSubscription(NOW + 30 * DAY_MS);
    const args = reserveArgs({ capVnd: 20_000, funding: { underLimit: true } });
    const r = await reserveRequest(db, args);
    expect(r.walletKind).toBe("subscription");
    // Period lapses with the hold in place: only unreserved credit forfeits.
    await db.$client.unsafe(
      `UPDATE subscriptions SET current_period_start = $1, current_period_end = $2 WHERE id = 'sub-fund'`,
      [NOW - 40 * DAY_MS, NOW - 5_000] as never[],
    );
    const forfeited1 = await runInImmediate(db, (tx) =>
      applySubscriptionExpiry(tx, FIX.ws, NOW),
    );
    expect(forfeited1).toBe(80_000);
    // Hold releases: the freed 20_000 is still expired-period credit.
    await releaseRequest(db, args.requestId, NOW);
    expect(await walletOf(subId)).toEqual({ balance: 20_000, reserved: 0 });
    const forfeited2 = await runInImmediate(db, (tx) =>
      applySubscriptionExpiry(tx, FIX.ws, NOW),
    );
    expect(forfeited2).toBe(20_000);
    expect(await walletOf(subId)).toEqual({ balance: 0, reserved: 0 });
    // Idempotent: further applications forfeit nothing.
    expect(await runInImmediate(db, (tx) => applySubscriptionExpiry(tx, FIX.ws, NOW))).toBe(0);
    // Gate row recorded exactly once for the period; forfeit debits are
    // append-only ledger rows (one per real forfeit event).
    const gate = await q<{ c: string }>(
      `SELECT COUNT(*) c FROM subscription_expiries WHERE subscription_id = 'sub-fund' AND period_end = $1`,
      [NOW - 5_000],
    );
    expect(Number(gate[0]!.c)).toBe(1);
    const debits = await q<{ amount: string }>(
      `SELECT l.amount FROM ledger_entries l JOIN wallets w ON w.id = l.wallet_id
       WHERE w.kind = 'subscription' AND l.kind = 'adjustment' AND l.direction = 'debit'
       ORDER BY l.amount`,
    );
    expect(debits.map((d) => Number(d.amount))).toEqual([20_000, 80_000]);
  });
});

describe("expiry vs renewal with in-flight holds (O5 pin)", () => {
  test("renewal while hold in flight: forfeit is balance-minus-reserved; freed hold stays available under the unexpired new period", async () => {
    await seedSubscriptionCredit(100_000, "led-sub-pin-1");
    await seedSubscription(NOW + 30 * DAY_MS);
    const args = reserveArgs({ capVnd: 20_000, funding: { underLimit: true } });
    const r = await reserveRequest(db, args);
    expect(r.walletKind).toBe("subscription");
    expect(await walletOf("wal-sub-fund")).toEqual({ balance: 100_000, reserved: 20_000 });

    // Period lapses with the hold in place (start < end constraint respected).
    await db.$client.unsafe(
      `UPDATE subscriptions SET current_period_start = $1, current_period_end = $2 WHERE id = 'sub-fund'`,
      [NOW - 40 * DAY_MS, NOW - 5_000] as never[],
    );
    // Literal spec pin: the forfeit is exactly balance minus reserved (the
    // available credit), never touching the reserved hold.
    const forfeited = await runInImmediate(db, (tx) => applySubscriptionExpiry(tx, FIX.ws, NOW));
    expect(forfeited).toBe(100_000 - 20_000);
    expect(await walletOf("wal-sub-fund")).toEqual({ balance: 20_000, reserved: 20_000 });

    // Renewal while the hold is still in flight: the production plan-payment
    // sequence (lazy expiry, then extend, then credit the new period).
    await runInImmediate(db, async (tx) => {
      const w = await ensureSubscriptionWallet(tx, FIX.ws, NOW);
      // Available is 0 (balance 20k fully reserved), so expiry forfeits nothing.
      expect(await applySubscriptionExpiry(tx, FIX.ws, NOW)).toBe(0);
      await extendOrCreateSubscription(tx, FIX.ws, "plan-fund", 30, NOW);
      await creditWallet(tx, {
        walletId: w.id,
        amount: 100_000,
        kind: "topup",
        paymentId: null,
        memo: "test renewal",
      });
    });
    expect(await walletOf("wal-sub-fund")).toEqual({ balance: 120_000, reserved: 20_000 });

    // Old hold releases after renewal: the freed 20_000 is new-period credit.
    await releaseRequest(db, args.requestId, NOW);
    expect(await walletOf("wal-sub-fund")).toEqual({ balance: 120_000, reserved: 0 });
    // No expiry debit after renewal: the new period is unexpired, so expiry
    // application is a no-op — unlike the no-renewal path, which forfeits it.
    expect(await runInImmediate(db, (tx) => applySubscriptionExpiry(tx, FIX.ws, NOW))).toBe(0);
    expect(await walletOf("wal-sub-fund")).toEqual({ balance: 120_000, reserved: 0 });

    // Exactly one forfeit debit (the 80_000), and the ledger still sums to the
    // wallet balance: 100k seed - 80k forfeit + 100k renewal = 120k.
    const debits = await q<{ amount: string }>(
      `SELECT l.amount FROM ledger_entries l JOIN wallets w ON w.id = l.wallet_id
       WHERE w.kind = 'subscription' AND l.kind = 'adjustment' AND l.direction = 'debit'`,
    );
    expect(debits.map((d) => Number(d.amount))).toEqual([80_000]);
    const ledgerSum = await q<{ s: string }>(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END), 0) s
       FROM ledger_entries WHERE wallet_id = 'wal-sub-fund'`,
    );
    expect(Number(ledgerSum[0]!.s)).toBe(120_000);
  });

  test("partial settle of the pre-expiry hold after renewal keeps balance == ledger sum", async () => {
    await seedSubscriptionCredit(100_000, "led-sub-pin-2");
    await seedSubscription(NOW + 30 * DAY_MS);
    const args = reserveArgs({ capVnd: 20_000, funding: { underLimit: true } });
    const r = await reserveRequest(db, args);
    expect(r.walletKind).toBe("subscription");
    await db.$client.unsafe(
      `UPDATE subscriptions SET current_period_start = $1, current_period_end = $2 WHERE id = 'sub-fund'`,
      [NOW - 40 * DAY_MS, NOW - 5_000] as never[],
    );
    expect(await runInImmediate(db, (tx) => applySubscriptionExpiry(tx, FIX.ws, NOW))).toBe(80_000);
    await runInImmediate(db, async (tx) => {
      const w = await ensureSubscriptionWallet(tx, FIX.ws, NOW);
      expect(await applySubscriptionExpiry(tx, FIX.ws, NOW)).toBe(0);
      await extendOrCreateSubscription(tx, FIX.ws, "plan-fund", 30, NOW);
      await creditWallet(tx, {
        walletId: w.id,
        amount: 100_000,
        kind: "topup",
        paymentId: null,
        memo: "test renewal",
      });
    });

    // The old request settles for actual usage below its hold: no double
    // spend — one settle debit of the charged amount, hold fully released.
    await markDispatching(db, args.requestId, NOW);
    const settle = await settleRequest(
      db,
      args.requestId,
      {
        kind: "usage",
        usage: {
          inputTokens: 100_000n,
          cachedInputTokens: 0n,
          outputTokens: 100_000n,
          reasoningTokens: 0n,
        },
        upstreamModel: "upstream-f",
        provider: "openai",
        publicModel: "pub-f",
      },
      NOW,
    );
    expect(settle.status).toBe("settled");
    expect(settle.chargedVnd).toBe(7_800); // (100k in + 200k out usd micro) x 26000 / 1e6, markup 1x
    expect(await walletOf("wal-sub-fund")).toEqual({ balance: 112_200, reserved: 0 });
    // Same ledger invariant: 100k seed - 80k forfeit + 100k renewal - 7.8k settle.
    const ledgerSum = await q<{ s: string }>(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END), 0) s
       FROM ledger_entries WHERE wallet_id = 'wal-sub-fund'`,
    );
    expect(Number(ledgerSum[0]!.s)).toBe(112_200);
    // Still exactly one expiry debit — the renewed period never gets debited.
    const debits = await q<{ amount: string }>(
      `SELECT l.amount FROM ledger_entries l JOIN wallets w ON w.id = l.wallet_id
       WHERE w.kind = 'subscription' AND l.kind = 'adjustment' AND l.direction = 'debit'`,
    );
    expect(debits.map((d) => Number(d.amount))).toEqual([80_000]);
  });
});

describe("concurrency", () => {
  test("parallel reserves never make balance < reserved on either wallet", async () => {
    const subId = await seedSubscriptionWallet(50_000);
    await seedSubscription(NOW + 30 * DAY_MS);
    await creditTopup(50_000, "pay-fund-c1");
    const CAP = 20_000;
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        reserveRequest(db, reserveArgs({ capVnd: CAP, funding: { underLimit: true } })),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter(
      (r) => r.status === "rejected" && (r.reason as WalletError).code === "insufficient",
    ).length;
    expect(ok + failed).toBe(10);
    // Available: 50_000 per wallet, cap 20_000 => exactly 2 succeed per wallet.
    expect(ok).toBe(4);
    expect(failed).toBe(6);
    for (const id of [subId, FIX.topup]) {
      const w = await walletOf(id);
      expect(w.balance).toBeGreaterThanOrEqual(w.reserved);
      expect(w.reserved).toBe(40_000);
    }
    // Ledger unchanged by holds (holds are not cash movements).
    const ledgerCount = await q<{ c: string }>(`SELECT COUNT(*) c FROM ledger_entries`);
    expect(Number(ledgerCount[0]!.c)).toBe(1); // only the seed topup credit
  });
});
