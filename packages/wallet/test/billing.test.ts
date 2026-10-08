// Task 3: canonical billing service — reserve/dispatch/settle/release/recover/refund.
// Pure DB over the canonical catalog tables (models, provider_model_mappings,
// model_prices, requests, billing_reservations, usage_logs, settlements,
// ledger_entries, wallets). No HTTP, no provider calls.
import { sql } from "drizzle-orm";
import { createDb } from "@hoborouter/db";
import type { Db } from "@hoborouter/db";
import {
  estimateCapVnd,
  reserveRequest,
  markDispatching,
  releaseRequest,
  settleRequest,
  recoverPending,
  refundCharge,
  WalletError,
  getWallet,
  creditWallet,
} from "../src/index";
import { describe, expect, test, afterEach } from "bun:test";
import { closeDb } from "@hoborouter/db";
import { makeDb, q, q1, NOW } from "./helpers";

interface CanonFixture {
  ws: string;
  key: string;
  wallet: string;
  model: string;
  mapping: string;
  mapping2: string;
  price: string;
}

async function seedCanon(db: Db): Promise<CanonFixture> {
  const f: CanonFixture = {
    ws: "ws-c",
    key: "key-c",
    wallet: "wallet-c",
    model: "model-c",
    mapping: "pm-c",
    mapping2: "pm-c2",
    price: "price-c",
  };
  await db.execute(
    sql`INSERT INTO users (id, name, email, created_at, updated_at) VALUES ('u-c','U','u-c@t.local',${NOW},${NOW})`,
  );
  await db.execute(
    sql`INSERT INTO workspaces (id, name, status, created_at) VALUES (${f.ws}, 'C', 'active', ${NOW})`,
  );
  await db.execute(
    sql`INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at) VALUES (${f.key}, ${f.ws}, 'hash-c', 'sk-hbr-c', 'key c', 'active', ${NOW})`,
  );
  await db.execute(
    sql`INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at) VALUES (${f.wallet}, ${f.ws}, 'VND', 0, 0, 0, ${NOW})`,
  );
  await db.execute(
    sql`INSERT INTO models (id, public_id, slug, display_name, provider, enabled, published, created_at, updated_at) VALUES (${f.model}, 'pub-c', 'slug-c', 'Model C', 'openai', true, true, ${NOW}, ${NOW})`,
  );
  const mappings: Array<[string, string]> = [
    [f.mapping, "upstream-c"],
    [f.mapping2, "upstream-c2"],
  ];
  for (const [id, upstream] of mappings) {
    await db.execute(
      sql`INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at) VALUES (${id}, ${f.model}, 'openai', ${upstream}, true, ${NOW}, ${NOW})`,
    );
  }
  // 1_000_000 usd micro per 1m input; fx 26000; markup 1e6 => 1x.
  await db.execute(
    sql`INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at) VALUES (${f.price}, ${f.model}, 1000000, 2000000, 500000, 3000000, 1000000, ${NOW})`,
  );
  return f;
}

async function topup(db: Db, walletId: string, amount: number, paymentId: string): Promise<void> {
  await db.execute(
    sql`INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at) VALUES (${paymentId}, 'ws-c', ${amount}, 'succeeded', 'mock', ${`order-${paymentId}`}, ${NOW})`,
  );
  await creditWallet(db, { walletId, amount, kind: "topup", paymentId, memo: "test topup" });
}

/** Wallet invariants: balance >= reserved >= 0; ledger sum == balance. */
async function assertInvariants(db: Db, walletId: string): Promise<void> {
  const w = await q1<{ balance: number; reserved: number }>(
    db,
    sql`SELECT balance, reserved FROM wallets WHERE id = ${walletId}`,
  );
  expect(Number(w.reserved)).toBeGreaterThanOrEqual(0);
  expect(Number(w.balance)).toBeGreaterThanOrEqual(Number(w.reserved));
  const sum = await q1<{ s: number }>(
    db,
    sql`SELECT COALESCE(SUM(CASE WHEN direction='credit' THEN amount ELSE -amount END),0)::int s FROM ledger_entries WHERE wallet_id = ${walletId}`,
  );
  expect(sum.s).toBe(Number(w.balance));
}

// Each test gets a throwaway DB; afterEach drops it even on failure so the
// test Postgres never accumulates leaked connections/databases.
let cleanup: (() => Promise<void>) | null = null;
async function freshDb() {
  const t = await makeDb();
  cleanup = t.drop;
  return t;
}
afterEach(async () => {
  if (cleanup) {
    const d = cleanup;
    cleanup = null;
    await d();
  }
});

const ENDPOINT = "/v1/chat/completions" as const;

describe("estimateCapVnd", () => {
  test("regression: 1_000_000 usd micro, fx 26000, markup 1e6 => 26000 VND", () => {
    const cap = estimateCapVnd(
      { maxInputTokens: 1_000_000, maxOutputTokens: 1_000_000 },
      {
        inputUsdMicroPer1m: 1_000_000,
        outputUsdMicroPer1m: 0,
        cachedInputUsdMicroPer1m: 0,
        reasoningUsdMicroPer1m: 0,
      },
      26000,
      1_000_000,
    );
    expect(cap).toBe(26_000);
  });

  test("worst case: input at max(input,cached), output at max(output,reasoning)", () => {
    // 1m input at max(input=1_000_000, cached=500_000) = 1 usd;
    // 1m output at max(output=2_000_000, reasoning=3_000_000) = 3 usd;
    // 4 usd * 26000 * 1.0 = 104000
    const cap = estimateCapVnd(
      { maxInputTokens: 1_000_000, maxOutputTokens: 1_000_000 },
      {
        inputUsdMicroPer1m: 1_000_000,
        cachedInputUsdMicroPer1m: 500_000,
        reasoningUsdMicroPer1m: 3_000_000,
        outputUsdMicroPer1m: 2_000_000,
      },
      26000,
      1_000_000,
    );
    expect(cap).toBe(104_000);
  });

  test("overflow: calculateCharge money-bound RangeError maps to WalletError('overflow'), not RangeError", () => {
    // Bounded tokens (1e6) x price 8e15 µUSD/1M x fx 2e6 -> capVnd past
    // maxStoredMoney. The gateway maps WalletError to 400; an escaping
    // RangeError would surface as an unhandled 500.
    try {
      estimateCapVnd(
        { maxInputTokens: 1_000_000, maxOutputTokens: 4096 },
        {
          inputUsdMicroPer1m: 8_000_000_000_000_000,
          outputUsdMicroPer1m: 2_000_000,
          cachedInputUsdMicroPer1m: 500_000,
          reasoningUsdMicroPer1m: 3_000_000,
        },
        2_000_000,
        1_000_000,
      );
      throw new Error("expected estimateCapVnd to throw");
    } catch (err) {
      expect(err instanceof WalletError).toBe(true);
      expect((err as WalletError).code).toBe("overflow");
    }
  });

  test("rejects non-positive and unsafe bounds", () => {
    const price = {
      inputUsdMicroPer1m: 1,
      outputUsdMicroPer1m: 1,
      cachedInputUsdMicroPer1m: 0,
      reasoningUsdMicroPer1m: 0,
    };
    expect(() =>
      estimateCapVnd({ maxInputTokens: 0, maxOutputTokens: 1 }, price, 26000, 1_000_000),
    ).toThrow(WalletError);
    expect(() =>
      estimateCapVnd({ maxInputTokens: 1, maxOutputTokens: 1.5 }, price, 26000, 1_000_000),
    ).toThrow(WalletError);
    expect(() =>
      estimateCapVnd({ maxInputTokens: 1, maxOutputTokens: 1 }, price, 0, 1_000_000),
    ).toThrow(WalletError);
  });
});

function reserveArgs(f: CanonFixture, over: Partial<Record<string, unknown>> = {}) {
  return {
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    workspaceId: f.ws,
    apiKeyId: f.key,
    modelId: f.model,
    mappingId: f.mapping,
    modelPriceId: f.price,
    endpoint: ENDPOINT,
    mode: "stream" as const,
    fxRate: 26000,
    capVnd: 26_000,
    now: NOW,
    ...over,
  };
}

describe("reserveRequest", () => {
  test("inserts request+reservation, reserved += cap", async () => {
    const { db } = await freshDb();
    const f = await seedCanon(db);
    await topup(db, f.wallet, 100_000, "pay-r1");
    const args = reserveArgs(f);
    const r = await reserveRequest(db, args);
    const w = await getWallet(db, f.wallet);
    expect(w.reserved).toBe(26_000);
    const req = await q1(db, sql`SELECT * FROM requests WHERE id = ${r.requestId}`);
    expect(req.status).toBe("pending");
    expect(req.dispatch_state).toBe("reserved");
    expect(req.model_id).toBe(f.model);
    expect(req.provider_model_mapping_id).toBe(f.mapping);
    expect(req.model_binding_id).toBeNull();
    const res = await q1(
      db,
      sql`SELECT * FROM billing_reservations WHERE request_id = ${r.requestId}`,
    );
    expect(res.status).toBe("held");
    expect(Number(res.cap_vnd)).toBe(26_000);
    expect(Number(res.usd_vnd_exchange_rate)).toBe(26000);
    expect(Number(res.markup_ppm)).toBe(1_000_000);
    await assertInvariants(db, f.wallet);
  });

  test("insufficient balance: typed error, nothing written", async () => {
    const { db } = await freshDb();
    const f = await seedCanon(db);
    await topup(db, f.wallet, 25_999, "pay-r2");
    const args = reserveArgs(f);
    expect(reserveRequest(db, args)).rejects.toThrow(WalletError);
    expect((await q1<{ c: number }>(db, sql`SELECT count(*)::int c FROM requests`)).c).toBe(0);
    expect(
      (await q1<{ c: number }>(db, sql`SELECT count(*)::int c FROM billing_reservations`)).c,
    ).toBe(0);
    expect((await getWallet(db, f.wallet)).reserved).toBe(0);
  });
});

describe("markDispatching", () => {
  test("CAS reserved->dispatching; second call rejected", async () => {
    const { db } = await freshDb();
    const f = await seedCanon(db);
    await topup(db, f.wallet, 100_000, "pay-md");
    const r = await reserveRequest(db, reserveArgs(f));
    await markDispatching(db, r.requestId, NOW + 1);
    const req = await q1(db, sql`SELECT * FROM requests WHERE id = ${r.requestId}`);
    expect(req.dispatch_state).toBe("dispatching");
    expect(Number(req.dispatched_at)).toBe(NOW + 1);
    expect(markDispatching(db, r.requestId, NOW + 2)).rejects.toThrow(WalletError);
  });
});

describe("releaseRequest", () => {
  test("only pre-dispatch: reserved released, terminal, no ledger; idempotent", async () => {
    const { db } = await freshDb();
    const f = await seedCanon(db);
    await topup(db, f.wallet, 100_000, "pay-rl");
    const r = await reserveRequest(db, reserveArgs(f));
    await releaseRequest(db, r.requestId, NOW + 1);
    const res = await q1<{ id: string }>(
      db,
      sql`SELECT id FROM billing_reservations WHERE request_id = ${r.requestId}`,
    );
    expect((await getWallet(db, f.wallet)).reserved).toBe(0);
    const req = await q1(db, sql`SELECT * FROM requests WHERE id = ${r.requestId}`);
    expect(req.dispatch_state).toBe("terminal");
    const ledgerCount = (
      await q1<{ c: number }>(
        db,
        sql`SELECT count(*)::int c FROM ledger_entries WHERE billing_reservation_id = ${res.id}`,
      )
    ).c;
    expect(ledgerCount).toBe(0);
    await releaseRequest(db, r.requestId, NOW + 2); // idempotent
    expect((await getWallet(db, f.wallet)).reserved).toBe(0);
  });

  test("post-dispatch release rejected", async () => {
    const { db } = await freshDb();
    const f = await seedCanon(db);
    await topup(db, f.wallet, 100_000, "pay-rl2");
    const r = await reserveRequest(db, reserveArgs(f));
    await markDispatching(db, r.requestId, NOW + 1);
    expect(releaseRequest(db, r.requestId, NOW + 2)).rejects.toThrow(WalletError);
  });
});

describe("settleRequest", () => {
  async function setup() {
    const t = await freshDb();
    const f = await seedCanon(t.db);
    await topup(t.db, f.wallet, 1_000_000, "pay-st");
    const r = await reserveRequest(t.db, reserveArgs(f));
    await markDispatching(t.db, r.requestId, NOW + 1);
    return { db: t.db, f, r };
  }

  test("usage exact charge + ledger + balances + reserved restored", async () => {
    const { db, f, r } = await setup();
    const before = await getWallet(db, f.wallet);
    const res = await q1<{ id: string; cap_vnd: number }>(
      db,
      sql`SELECT id, cap_vnd FROM billing_reservations WHERE request_id = ${r.requestId}`,
    );
    const resId: string = res.id;
    // 1m input at 1_000_000 micro = 1 usd; fx 26000, markup 1x => 26000 = cap.
    const out = await settleRequest(
      db,
      r.requestId,
      {
        kind: "usage",
        usage: {
          inputTokens: 1_000_000n,
          outputTokens: 0n,
          cachedInputTokens: 0n,
          reasoningTokens: 0n,
        },
        upstreamModel: "upstream-c",
        provider: "openai",
        publicModel: "pub-c",
        latencyMs: 120,
        ttftMs: 40,
        httpStatus: 200,
      },
      NOW + 2,
    );
    expect(out.chargedVnd).toBe(26_000);
    expect(out.status).toBe("settled");
    const w = await getWallet(db, f.wallet);
    expect(w.balance).toBe(before.balance - 26_000);
    expect(w.reserved).toBe(before.reserved - Number(res.cap_vnd));
    const ul = await q1(db, sql`SELECT * FROM usage_logs WHERE request_id = ${r.requestId}`);
    expect(ul.idempotency_key).toBe(r.requestId);
    expect(Number(ul.charged_vnd)).toBe(26_000);
    // P1: upstream_cost_usd_micro is the real unclamped USD micro cost.
    expect(Number(ul.upstream_cost_usd_micro)).toBe(1_000_000);
    const s = await q1(db, sql`SELECT * FROM settlements WHERE billing_reservation_id = ${resId}`);
    expect(Number(s.charged_vnd)).toBe(26_000);
    expect(s.usage_log_id).toBe(ul.id);
    const le = await q1(
      db,
      sql`SELECT * FROM ledger_entries WHERE billing_reservation_id = ${resId} AND kind = 'settle'`,
    );
    expect(Number(le.amount)).toBe(26_000);
    expect(le.direction).toBe("debit");
    expect(Number(le.balance_after)).toBe(w.balance);
    const req = await q1(db, sql`SELECT * FROM requests WHERE id = ${r.requestId}`);
    expect(req.dispatch_state).toBe("terminal");
    expect(req.status).toBe("ok");
    await assertInvariants(db, f.wallet);
  });

  test("zero charge skips ledger row, still settles", async () => {
    const { db, f, r } = await setup();
    const res = await q1<{ id: string }>(
      db,
      sql`SELECT id FROM billing_reservations WHERE request_id = ${r.requestId}`,
    );
    const resId: string = res.id;
    const out = await settleRequest(
      db,
      r.requestId,
      {
        kind: "usage",
        usage: { inputTokens: 0n, outputTokens: 0n, cachedInputTokens: 0n, reasoningTokens: 0n },
        upstreamModel: "upstream-c",
        provider: "openai",
        publicModel: "pub-c",
      },
      NOW + 2,
    );
    expect(out.chargedVnd).toBe(0);
    const le = (
      await q1<{ c: number }>(
        db,
        sql`SELECT count(*)::int c FROM ledger_entries WHERE billing_reservation_id = ${resId}`,
      )
    ).c;
    expect(le).toBe(0);
    const w = await getWallet(db, f.wallet);
    expect(w.reserved).toBe(0);
    await assertInvariants(db, f.wallet);
  });

  test("above-cap usage: cap debited, mapping disabled, audits", async () => {
    const { db, f, r } = await setup();
    const res = await q1<{ id: string; cap_vnd: number }>(
      db,
      sql`SELECT id, cap_vnd FROM billing_reservations WHERE request_id = ${r.requestId}`,
    );
    const before = await getWallet(db, f.wallet);
    const out = await settleRequest(
      db,
      r.requestId,
      {
        kind: "usage",
        usage: {
          inputTokens: 10_000_000n,
          outputTokens: 0n,
          cachedInputTokens: 0n,
          reasoningTokens: 0n,
        },
        upstreamModel: "upstream-c",
        provider: "openai",
        publicModel: "pub-c",
      },
      NOW + 2,
    );
    expect(out.status).toBe("settled_full_hold");
    expect(out.chargedVnd).toBe(Number(res.cap_vnd));
    const capLog = await q1(db, sql`SELECT * FROM usage_logs WHERE request_id = ${r.requestId}`);
    // P1: above-cap stores the UNCLAMPED USD cost (10m input at 1_000_000 micro = 10 usd), charged_vnd stays the cap.
    expect(Number(capLog.upstream_cost_usd_micro)).toBe(10_000_000);
    expect(Number(capLog.charged_vnd)).toBe(Number(res.cap_vnd));
    const w = await getWallet(db, f.wallet);
    expect(w.balance).toBe(before.balance - Number(res.cap_vnd));
    const mapping = await q1<{ enabled: boolean }>(
      db,
      sql`SELECT enabled FROM provider_model_mappings WHERE id = ${f.mapping}`,
    );
    expect(mapping.enabled).toBe(false);
    const audits = await q<{ action: string }>(
      db,
      sql`SELECT action FROM audit_log WHERE target = ${res.id} ORDER BY action`,
    );
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("billing.cap_exceeded");
    const req = await q1(db, sql`SELECT * FROM requests WHERE id = ${r.requestId}`);
    expect(req.status).toBe("ok");
    await assertInvariants(db, f.wallet);
  });

  test("full_hold debits cap, status per reason", async () => {
    const { db, f, r } = await setup();
    const res = await q1<{ id: string; cap_vnd: number }>(
      db,
      sql`SELECT id, cap_vnd FROM billing_reservations WHERE request_id = ${r.requestId}`,
    );
    const before = await getWallet(db, f.wallet);
    const out = await settleRequest(
      db,
      r.requestId,
      { kind: "full_hold", reason: "client_abort" },
      NOW + 2,
    );
    expect(out.status).toBe("settled_full_hold");
    expect(out.chargedVnd).toBe(Number(res.cap_vnd));
    const w = await getWallet(db, f.wallet);
    expect(w.balance).toBe(before.balance - Number(res.cap_vnd));
    expect(w.reserved).toBe(0);
    const req = await q1(db, sql`SELECT * FROM requests WHERE id = ${r.requestId}`);
    expect(req.status).toBe("client_abort");
    await assertInvariants(db, f.wallet);
  });

  test("idempotent: second settle returns stored result, never double debit", async () => {
    const { db, f, r } = await setup();
    const first = await settleRequest(
      db,
      r.requestId,
      {
        kind: "usage",
        usage: {
          inputTokens: 1_000_000n,
          outputTokens: 0n,
          cachedInputTokens: 0n,
          reasoningTokens: 0n,
        },
        upstreamModel: "upstream-c",
        provider: "openai",
        publicModel: "pub-c",
      },
      NOW + 2,
    );
    const balAfterFirst = (await getWallet(db, f.wallet)).balance;
    const second = await settleRequest(
      db,
      r.requestId,
      { kind: "full_hold", reason: "unknown" },
      NOW + 3,
    );
    expect(second.chargedVnd).toBe(first.chargedVnd);
    expect(second.status).toBe(first.status);
    expect(second.alreadySettled).toBe(true);
    expect((await getWallet(db, f.wallet)).balance).toBe(balAfterFirst);
    const settleCount = (await q1<{ c: number }>(db, sql`SELECT count(*)::int c FROM settlements`))
      .c;
    expect(settleCount).toBe(1);
    await assertInvariants(db, f.wallet);
  });
});

describe("recoverPending", () => {
  test("matrix: reserved released, dispatching full-held, terminal untouched", async () => {
    const { db } = await freshDb();
    const f = await seedCanon(db);
    await topup(db, f.wallet, 1_000_000, "pay-rc");
    const r1 = await reserveRequest(db, reserveArgs(f));
    const r2 = await reserveRequest(db, reserveArgs(f));
    await markDispatching(db, r2.requestId, NOW + 1);
    const r3 = await reserveRequest(db, reserveArgs(f));
    await markDispatching(db, r3.requestId, NOW + 1);
    await settleRequest(db, r3.requestId, { kind: "full_hold", reason: "upstream_error" }, NOW + 2);

    const counts = await recoverPending(db, NOW + 3);
    expect(counts.released).toBe(1);
    expect(counts.fullHeld).toBe(1);
    const st1 = await q1<{ status: string }>(
      db,
      sql`SELECT br.status FROM billing_reservations br JOIN requests rq ON rq.id = br.request_id WHERE rq.id = ${r1.requestId}`,
    );
    expect(st1.status).toBe("released");
    const st2 = await q1<{ status: string; cap_vnd: number }>(
      db,
      sql`SELECT br.status, br.cap_vnd FROM billing_reservations br JOIN requests rq ON rq.id = br.request_id WHERE rq.id = ${r2.requestId}`,
    );
    expect(st2.status).toBe("settled_full_hold");
    const w = await getWallet(db, f.wallet);
    // 3 caps reserved; r1 released, r2 charged, r3 already charged.
    expect(w.balance).toBe(1_000_000 - 2 * Number(st2.cap_vnd));
    expect(w.reserved).toBe(0);
    const counts2 = await recoverPending(db, NOW + 4); // idempotent
    expect(counts2.released).toBe(0);
    expect(counts2.fullHeld).toBe(0);
    await assertInvariants(db, f.wallet);
  });
});

describe("refundCharge", () => {
  async function settledForRefund() {
    const t = await freshDb();
    const f = await seedCanon(t.db);
    await topup(t.db, f.wallet, 1_000_000, "pay-rf");
    const r = await reserveRequest(t.db, reserveArgs(f));
    await markDispatching(t.db, r.requestId, NOW + 1);
    await settleRequest(
      t.db,
      r.requestId,
      {
        kind: "usage",
        usage: {
          inputTokens: 1_000_000n,
          outputTokens: 0n,
          cachedInputTokens: 0n,
          reasoningTokens: 0n,
        },
        upstreamModel: "upstream-c",
        provider: "openai",
        publicModel: "pub-c",
      },
      NOW + 2,
    );
    const le = await q1<{ id: string; amount: number }>(
      t.db,
      sql`SELECT id, amount FROM ledger_entries WHERE wallet_id = ${f.wallet} AND kind = 'settle'`,
    );
    return { db: t.db, f, le };
  }

  test("credit capped at original, wallet balance restored, audit", async () => {
    const { db, f, le } = await settledForRefund();
    const before = await getWallet(db, f.wallet);
    await refundCharge(db, {
      originalLedgerEntryId: le.id,
      amount: 10_000,
      actorUserId: "u-c",
      reason: "goodwill",
      now: NOW + 3,
    });
    const w = await getWallet(db, f.wallet);
    expect(w.balance).toBe(before.balance + 10_000);
    const rf = await q1(
      db,
      sql`SELECT * FROM ledger_entries WHERE original_ledger_entry_id = ${le.id} AND kind = 'refund'`,
    );
    expect(Number(rf.amount)).toBe(10_000);
    expect(rf.direction).toBe("credit");
    await assertInvariants(db, f.wallet);
  });

  test("reject amount above original", async () => {
    const { db, le } = await settledForRefund();
    expect(
      refundCharge(db, {
        originalLedgerEntryId: le.id,
        amount: le.amount + 1,
        actorUserId: "u-c",
        reason: "x",
        now: NOW + 3,
      }),
    ).rejects.toThrow(WalletError);
  });

  test("idempotent same amount; conflicting amount typed error", async () => {
    const { db, f, le } = await settledForRefund();
    const first = await refundCharge(db, {
      originalLedgerEntryId: le.id,
      amount: 5_000,
      actorUserId: "u-c",
      reason: "x",
      now: NOW + 3,
    });
    const bal = (await getWallet(db, f.wallet)).balance;
    const again = await refundCharge(db, {
      originalLedgerEntryId: le.id,
      amount: 5_000,
      actorUserId: "u-c",
      reason: "x",
      now: NOW + 4,
    });
    expect(again.alreadyRefunded).toBe(true);
    expect((await getWallet(db, f.wallet)).balance).toBe(bal);
    expect(
      refundCharge(db, {
        originalLedgerEntryId: le.id,
        amount: 6_000,
        actorUserId: "u-c",
        reason: "x",
        now: NOW + 5,
      }),
    ).rejects.toThrow(WalletError);
    expect(first.ledgerEntryId).toBeTruthy();
    await assertInvariants(db, f.wallet);
  });
});

describe("concurrency: two connections, one cap", () => {
  test("exactly one reserve succeeds under real contention (no double spend)", async () => {
    const t = await freshDb();
    const f = await seedCanon(t.db);
    await topup(t.db, f.wallet, 26_000, "pay-cc");
    // Two SEPARATE connections; both reserves race truly concurrently via
    // Promise.all and serialize only on the wallets row lock / CAS.
    const dbA: Db = createDb(t.url);
    const dbB: Db = createDb(t.url);
    const mk = (id: string) => reserveArgs(f, { requestId: id });
    const [a, b] = await Promise.allSettled([
      reserveRequest(dbA, mk("req-cc-a")),
      reserveRequest(dbB, mk("req-cc-b")),
    ]);
    const ok = [a, b].filter((r) => r.status === "fulfilled").length;
    expect(ok).toBe(1);
    const w = await q1<{ reserved: number }>(
      t.db,
      sql`SELECT reserved FROM wallets WHERE id = ${f.wallet}`,
    );
    expect(Number(w.reserved)).toBe(26_000);
    await assertInvariants(t.db, f.wallet);
    await closeDb(dbA);
    await closeDb(dbB);
  });

  test("concurrent settle of the same request: charged exactly once", async () => {
    const t = await freshDb();
    const f = await seedCanon(t.db);
    await topup(t.db, f.wallet, 1_000_000, "pay-ccs");
    const r = await reserveRequest(t.db, reserveArgs(f));
    await markDispatching(t.db, r.requestId, NOW + 1);
    const dbA: Db = createDb(t.url);
    const dbB: Db = createDb(t.url);
    const outcome = {
      kind: "usage" as const,
      usage: {
        inputTokens: 1_000_000n,
        outputTokens: 0n,
        cachedInputTokens: 0n,
        reasoningTokens: 0n,
      },
      upstreamModel: "upstream-c",
      provider: "openai",
      publicModel: "pub-c",
    };
    const [a, b] = await Promise.allSettled([
      settleRequest(dbA, r.requestId, outcome, NOW + 2),
      settleRequest(dbB, r.requestId, outcome, NOW + 2),
    ]);
    // Both may report (idempotent second call), but the money moved once.
    const fulfilled = [a, b].filter((x) => x.status === "fulfilled") as PromiseFulfilledResult<{
      chargedVnd: number;
      alreadySettled: boolean;
    }>[];
    expect(fulfilled.length).toBe(2);
    expect(fulfilled.some((x) => !x.value.alreadySettled)).toBe(true);
    const w = await q1<{ balance: number; reserved: number }>(
      t.db,
      sql`SELECT balance, reserved FROM wallets WHERE id = ${f.wallet}`,
    );
    expect(Number(w.balance)).toBe(1_000_000 - 26_000);
    expect(Number(w.reserved)).toBe(0);
    const settleCount = (
      await q1<{ c: number }>(t.db, sql`SELECT count(*)::int c FROM settlements`)
    ).c;
    expect(settleCount).toBe(1);
    await assertInvariants(t.db, f.wallet);
    await closeDb(dbA);
    await closeDb(dbB);
  });
});
