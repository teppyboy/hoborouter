// Task 3: canonical billing service — reserve/dispatch/settle/release/recover/refund.
// Pure DB over the canonical catalog tables (models, provider_model_mappings,
// model_prices, requests, billing_reservations, usage_logs, settlements,
// ledger_entries, wallets). No HTTP, no provider calls.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { createDb, migrate } from "@hoborouter/db";
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
import { NOW } from "./helpers";

function makeDb(): Database {
  const db = createDb(":memory:");
  migrate(db);
  return db;
}

interface CanonFixture {
  ws: string;
  key: string;
  wallet: string;
  model: string;
  mapping: string;
  mapping2: string;
  price: string;
}

function seedCanon(db: Database): CanonFixture {
  const f: CanonFixture = {
    ws: "ws-c",
    key: "key-c",
    wallet: "wallet-c",
    model: "model-c",
    mapping: "pm-c",
    mapping2: "pm-c2",
    price: "price-c",
  };
  db.prepare(
    "INSERT INTO users (id, name, email, created_at, updated_at) VALUES ('u-c','U','u-c@t.local',?,?)",
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO workspaces (id, name, status, created_at) VALUES (?, 'C', 'active', ?)",
  ).run(f.ws, NOW);
  db.prepare(
    "INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at) VALUES (?, ?, 'hash-c', 'sk-hbr-c', 'key c', 'active', ?)",
  ).run(f.key, f.ws, NOW);
  db.prepare(
    "INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at) VALUES (?, ?, 'VND', 0, 0, 0, ?)",
  ).run(f.wallet, f.ws, NOW);
  db.prepare(
    "INSERT INTO models (id, public_id, slug, display_name, provider, enabled, published, created_at, updated_at) VALUES (?, 'pub-c', 'slug-c', 'Model C', 'openai', 1, 1, ?, ?)",
  ).run(f.model, NOW, NOW);
  const pm = db.prepare(
    "INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at) VALUES (?, ?, 'openai', ?, 1, ?, ?)",
  );
  pm.run(f.mapping, f.model, "upstream-c", NOW, NOW);
  pm.run(f.mapping2, f.model, "upstream-c2", NOW, NOW);
  // 1_000_000 usd micro per 1m input; fx 26000; markup 1e6 => 1x.
  db.prepare(
    "INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at) VALUES (?, ?, 1000000, 2000000, 500000, 3000000, 1000000, ?)",
  ).run(f.price, f.model, NOW);
  return f;
}

function topup(db: Database, walletId: string, amount: number, paymentId: string): void {
  db.prepare(
    "INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at) VALUES (?, 'ws-c', ?, 'succeeded', 'mock', ?, ?)",
  ).run(paymentId, amount, `order-${paymentId}`, NOW);
  creditWallet(db, { walletId, amount, kind: "topup", paymentId, memo: "test topup" });
}

/** Wallet invariants: balance >= reserved >= 0; ledger sum == balance. */
function assertInvariants(db: Database, walletId: string): void {
  const w = db.prepare("SELECT balance, reserved FROM wallets WHERE id = ?").get(walletId) as {
    balance: number;
    reserved: number;
  };
  expect(w.reserved).toBeGreaterThanOrEqual(0);
  expect(w.balance).toBeGreaterThanOrEqual(w.reserved);
  const sum = db
    .prepare(
      "SELECT COALESCE(SUM(CASE WHEN direction='credit' THEN amount ELSE -amount END),0) s FROM ledger_entries WHERE wallet_id = ?",
    )
    .get(walletId) as { s: number };
  expect(sum.s).toBe(w.balance);
}

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

function reserveArgs(db: Database, f: CanonFixture, over: Partial<Record<string, unknown>> = {}) {
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
    db,
    f,
    ...over,
  };
}

describe("reserveRequest", () => {
  test("inserts request+reservation, reserved += cap", () => {
    const db = makeDb();
    const f = seedCanon(db);
    topup(db, f.wallet, 100_000, "pay-r1");
    const args = reserveArgs(db, f);
    const r = reserveRequest(db, args);
    const w = getWallet(db, f.wallet);
    expect(w.reserved).toBe(26_000);
    const req = db.prepare("SELECT * FROM requests WHERE id = ?").get(r.requestId) as Record<
      string,
      unknown
    >;
    expect(req.status).toBe("pending");
    expect(req.dispatch_state).toBe("reserved");
    expect(req.model_id).toBe(f.model);
    expect(req.provider_model_mapping_id).toBe(f.mapping);
    expect(req.model_binding_id).toBeNull();
    const res = db
      .prepare("SELECT * FROM billing_reservations WHERE request_id = ?")
      .get(r.requestId) as Record<string, unknown>;
    expect(res.status).toBe("held");
    expect(res.cap_vnd).toBe(26_000);
    expect(res.usd_vnd_exchange_rate).toBe(26000);
    expect(res.markup_ppm).toBe(1_000_000);
    assertInvariants(db, f.wallet);
  });

  test("insufficient balance: typed error, nothing written", () => {
    const db = makeDb();
    const f = seedCanon(db);
    topup(db, f.wallet, 25_999, "pay-r2");
    const args = reserveArgs(db, f);
    expect(() => reserveRequest(db, args)).toThrow(WalletError);
    expect((db.prepare("SELECT count(*) c FROM requests").get() as { c: number }).c).toBe(0);
    expect(
      (db.prepare("SELECT count(*) c FROM billing_reservations").get() as { c: number }).c,
    ).toBe(0);
    expect(getWallet(db, f.wallet).reserved).toBe(0);
  });
});

describe("markDispatching", () => {
  test("CAS reserved->dispatching; second call rejected", () => {
    const db = makeDb();
    const f = seedCanon(db);
    topup(db, f.wallet, 100_000, "pay-md");
    const r = reserveRequest(db, reserveArgs(db, f));
    markDispatching(db, r.requestId, NOW + 1);
    const req = db.prepare("SELECT * FROM requests WHERE id = ?").get(r.requestId) as Record<
      string,
      unknown
    >;
    expect(req.dispatch_state).toBe("dispatching");
    expect(req.dispatched_at).toBe(NOW + 1);
    expect(() => markDispatching(db, r.requestId, NOW + 2)).toThrow(WalletError);
  });
});

describe("releaseRequest", () => {
  test("only pre-dispatch: reserved released, terminal, no ledger; idempotent", () => {
    const db = makeDb();
    const f = seedCanon(db);
    topup(db, f.wallet, 100_000, "pay-rl");
    const r = reserveRequest(db, reserveArgs(db, f));
    releaseRequest(db, r.requestId, NOW + 1);
    const res = db
      .prepare("SELECT id FROM billing_reservations WHERE request_id = ?")
      .get(r.requestId) as { id: string };
    expect(getWallet(db, f.wallet).reserved).toBe(0);
    const req = db.prepare("SELECT * FROM requests WHERE id = ?").get(r.requestId) as Record<
      string,
      unknown
    >;
    expect(req.dispatch_state).toBe("terminal");
    const ledgerCount = (
      db
        .prepare("SELECT count(*) c FROM ledger_entries WHERE billing_reservation_id = ?")
        .get(res.id) as { c: number }
    ).c;
    expect(ledgerCount).toBe(0);
    releaseRequest(db, r.requestId, NOW + 2); // idempotent
    expect(getWallet(db, f.wallet).reserved).toBe(0);
  });

  test("post-dispatch release rejected", () => {
    const db = makeDb();
    const f = seedCanon(db);
    topup(db, f.wallet, 100_000, "pay-rl2");
    const r = reserveRequest(db, reserveArgs(db, f));
    markDispatching(db, r.requestId, NOW + 1);
    expect(() => releaseRequest(db, r.requestId, NOW + 2)).toThrow(WalletError);
  });
});

describe("settleRequest", () => {
  function setup() {
    const db = makeDb();
    const f = seedCanon(db);
    topup(db, f.wallet, 1_000_000, "pay-st");
    const r = reserveRequest(db, reserveArgs(db, f));
    markDispatching(db, r.requestId, NOW + 1);
    return { db, f, r };
  }

  test("usage exact charge + ledger + balances + reserved restored", () => {
    const { db, f, r } = setup();
    const before = getWallet(db, f.wallet);
    const res = db
      .prepare("SELECT id, cap_vnd FROM billing_reservations WHERE request_id = ?")
      .get(r.requestId) as { id: string; cap_vnd: number };
    const resId: string = res.id;
    // 1m input at 1_000_000 micro = 1 usd; fx 26000, markup 1x => 26000 = cap.
    const out = settleRequest(
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
    const w = getWallet(db, f.wallet);
    expect(w.balance).toBe(before.balance - 26_000);
    expect(w.reserved).toBe(before.reserved - res.cap_vnd);
    const ul = db
      .prepare("SELECT * FROM usage_logs WHERE request_id = ?")
      .get(r.requestId) as Record<string, unknown>;
    expect(ul.idempotency_key).toBe(r.requestId);
    expect(ul.charged_vnd).toBe(26_000);
    // P1: upstream_cost_usd_micro is the real unclamped USD micro cost.
    expect(ul.upstream_cost_usd_micro).toBe(1_000_000);
    const s = db
      .prepare("SELECT * FROM settlements WHERE billing_reservation_id = ?")
      .get(resId) as Record<string, unknown>;
    expect(s.charged_vnd).toBe(26_000);
    expect(s.usage_log_id).toBe(ul.id);
    const le = db
      .prepare("SELECT * FROM ledger_entries WHERE billing_reservation_id = ? AND kind = 'settle'")
      .get(resId) as Record<string, unknown>;
    expect(le.amount).toBe(26_000);
    expect(le.direction).toBe("debit");
    expect(le.balance_after).toBe(w.balance);
    const req = db.prepare("SELECT * FROM requests WHERE id = ?").get(r.requestId) as Record<
      string,
      unknown
    >;
    expect(req.dispatch_state).toBe("terminal");
    expect(req.status).toBe("ok");
    assertInvariants(db, f.wallet);
  });

  test("zero charge skips ledger row, still settles", () => {
    const { db, f, r } = setup();
    const res = db
      .prepare("SELECT id FROM billing_reservations WHERE request_id = ?")
      .get(r.requestId) as { id: string };
    const resId: string = res.id;
    const out = settleRequest(
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
    const le = db
      .prepare("SELECT count(*) c FROM ledger_entries WHERE billing_reservation_id = ?")
      .get(resId) as { c: number };
    expect(le.c).toBe(0);
    const w = getWallet(db, f.wallet);
    expect(w.reserved).toBe(0);
    assertInvariants(db, f.wallet);
  });

  test("above-cap usage: cap debited, mapping disabled, audits", () => {
    const { db, f, r } = setup();
    const res = db
      .prepare("SELECT id, cap_vnd FROM billing_reservations WHERE request_id = ?")
      .get(r.requestId) as { id: string; cap_vnd: number };
    const before = getWallet(db, f.wallet);
    const out = settleRequest(
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
    expect(out.chargedVnd).toBe(res.cap_vnd);
    const capLog = db
      .prepare("SELECT * FROM usage_logs WHERE request_id = ?")
      .get(r.requestId) as Record<string, unknown>;
    // P1: above-cap stores the UNCLAMPED USD cost (10m input at 1_000_000 micro = 10 usd), charged_vnd stays the cap.
    expect(capLog.upstream_cost_usd_micro).toBe(10_000_000);
    expect(capLog.charged_vnd).toBe(res.cap_vnd);
    const w = getWallet(db, f.wallet);
    expect(w.balance).toBe(before.balance - res.cap_vnd);
    const mapping = db
      .prepare("SELECT enabled FROM provider_model_mappings WHERE id = ?")
      .get(f.mapping) as { enabled: number };
    expect(mapping.enabled).toBe(0);
    const audits = db
      .prepare("SELECT action FROM audit_log WHERE target = ? ORDER BY action")
      .all(String(res.id)) as { action: string }[];
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("billing.cap_exceeded");
    const req = db.prepare("SELECT * FROM requests WHERE id = ?").get(r.requestId) as Record<
      string,
      unknown
    >;
    expect(req.status).toBe("ok");
    assertInvariants(db, f.wallet);
  });

  test("full_hold debits cap, status per reason", () => {
    const { db, f, r } = setup();
    const res = db
      .prepare("SELECT id, cap_vnd FROM billing_reservations WHERE request_id = ?")
      .get(r.requestId) as { id: string; cap_vnd: number };
    const before = getWallet(db, f.wallet);
    const out = settleRequest(
      db,
      r.requestId,
      { kind: "full_hold", reason: "client_abort" },
      NOW + 2,
    );
    expect(out.status).toBe("settled_full_hold");
    expect(out.chargedVnd).toBe(res.cap_vnd);
    const w = getWallet(db, f.wallet);
    expect(w.balance).toBe(before.balance - res.cap_vnd);
    expect(w.reserved).toBe(0);
    const req = db.prepare("SELECT * FROM requests WHERE id = ?").get(r.requestId) as Record<
      string,
      unknown
    >;
    expect(req.status).toBe("client_abort");
    assertInvariants(db, f.wallet);
  });

  test("idempotent: second settle returns stored result, never double debit", () => {
    const { db, f, r } = setup();
    const first = settleRequest(
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
    const balAfterFirst = getWallet(db, f.wallet).balance;
    const second = settleRequest(
      db,
      r.requestId,
      { kind: "full_hold", reason: "unknown" },
      NOW + 3,
    );
    expect(second.chargedVnd).toBe(first.chargedVnd);
    expect(second.status).toBe(first.status);
    expect(second.alreadySettled).toBe(true);
    expect(getWallet(db, f.wallet).balance).toBe(balAfterFirst);
    const settleCount = (db.prepare("SELECT count(*) c FROM settlements").get() as { c: number }).c;
    expect(settleCount).toBe(1);
    assertInvariants(db, f.wallet);
  });
});

describe("recoverPending", () => {
  test("matrix: reserved released, dispatching full-held, terminal untouched", () => {
    const db = makeDb();
    const f = seedCanon(db);
    topup(db, f.wallet, 1_000_000, "pay-rc");
    const r1 = reserveRequest(db, reserveArgs(db, f));
    const r2 = reserveRequest(db, reserveArgs(db, f));
    markDispatching(db, r2.requestId, NOW + 1);
    const r3 = reserveRequest(db, reserveArgs(db, f));
    markDispatching(db, r3.requestId, NOW + 1);
    settleRequest(db, r3.requestId, { kind: "full_hold", reason: "upstream_error" }, NOW + 2);

    const counts = recoverPending(db, NOW + 3);
    expect(counts.released).toBe(1);
    expect(counts.fullHeld).toBe(1);
    const st1 = db
      .prepare(
        "SELECT br.status FROM billing_reservations br JOIN requests rq ON rq.id = br.request_id WHERE rq.id = ?",
      )
      .get(r1.requestId) as { status: string };
    expect(st1.status).toBe("released");
    const st2 = db
      .prepare(
        "SELECT br.status, br.cap_vnd FROM billing_reservations br JOIN requests rq ON rq.id = br.request_id WHERE rq.id = ?",
      )
      .get(r2.requestId) as { status: string; cap_vnd: number };
    expect(st2.status).toBe("settled_full_hold");
    const w = getWallet(db, f.wallet);
    // 3 caps reserved; r1 released, r2 charged, r3 already charged.
    expect(w.balance).toBe(1_000_000 - 2 * st2.cap_vnd);
    expect(w.reserved).toBe(0);
    const counts2 = recoverPending(db, NOW + 4); // idempotent
    expect(counts2.released).toBe(0);
    expect(counts2.fullHeld).toBe(0);
    assertInvariants(db, f.wallet);
  });
});

describe("refundCharge", () => {
  function settledForRefund() {
    const db = makeDb();
    const f = seedCanon(db);
    topup(db, f.wallet, 1_000_000, "pay-rf");
    const r = reserveRequest(db, reserveArgs(db, f));
    markDispatching(db, r.requestId, NOW + 1);
    settleRequest(
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
    const le = db
      .prepare("SELECT id, amount FROM ledger_entries WHERE wallet_id = ? AND kind = 'settle'")
      .get(f.wallet) as { id: string; amount: number };
    return { db, f, le };
  }

  test("credit capped at original, wallet balance restored, audit", () => {
    const { db, f, le } = settledForRefund();
    const before = getWallet(db, f.wallet);
    refundCharge(db, {
      originalLedgerEntryId: le.id,
      amount: 10_000,
      actorUserId: "u-c",
      reason: "goodwill",
      now: NOW + 3,
    });
    const w = getWallet(db, f.wallet);
    expect(w.balance).toBe(before.balance + 10_000);
    const rf = db
      .prepare(
        "SELECT * FROM ledger_entries WHERE original_ledger_entry_id = ? AND kind = 'refund'",
      )
      .get(le.id) as Record<string, unknown>;
    expect(rf.amount).toBe(10_000);
    expect(rf.direction).toBe("credit");
    assertInvariants(db, f.wallet);
  });

  test("reject amount above original", () => {
    const { db, le } = settledForRefund();
    expect(() =>
      refundCharge(db, {
        originalLedgerEntryId: le.id,
        amount: le.amount + 1,
        actorUserId: "u-c",
        reason: "x",
        now: NOW + 3,
      }),
    ).toThrow(WalletError);
  });

  test("idempotent same amount; conflicting amount typed error", () => {
    const { db, f, le } = settledForRefund();
    const first = refundCharge(db, {
      originalLedgerEntryId: le.id,
      amount: 5_000,
      actorUserId: "u-c",
      reason: "x",
      now: NOW + 3,
    });
    const bal = getWallet(db, f.wallet).balance;
    const again = refundCharge(db, {
      originalLedgerEntryId: le.id,
      amount: 5_000,
      actorUserId: "u-c",
      reason: "x",
      now: NOW + 4,
    });
    expect(again.alreadyRefunded).toBe(true);
    expect(getWallet(db, f.wallet).balance).toBe(bal);
    expect(() =>
      refundCharge(db, {
        originalLedgerEntryId: le.id,
        amount: 6_000,
        actorUserId: "u-c",
        reason: "x",
        now: NOW + 5,
      }),
    ).toThrow(WalletError);
    expect(first.ledgerEntryId).toBeTruthy();
    assertInvariants(db, f.wallet);
  });
});

describe("concurrency: two connections, one cap", () => {
  test("exactly one reserve succeeds under real contention", () => {
    const dir = mkdtempSync(join(tmpdir(), "billing-"));
    const path = join(dir, "billing.db");
    const dbA = createDb(path);
    migrate(dbA);
    const f = seedCanon(dbA);
    topup(dbA, f.wallet, 26_000, "pay-cc");
    const dbB = createDb(path);
    const mk = (id: string) => ({
      requestId: id,
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
    });
    const attempt = (db: Database, id: string) => {
      try {
        return reserveRequest(db, mk(id));
      } catch (err) {
        return { error: String(err) };
      }
    };
    const a = attempt(dbA, "req-cc-a");
    const b = attempt(dbB, "req-cc-b");
    const ok = [a, b].filter((r) => !(r as { error?: string }).error).length;
    expect(ok).toBe(1);
    const w = dbA.prepare("SELECT reserved FROM wallets WHERE id = ?").get(f.wallet) as {
      reserved: number;
    };
    expect(w.reserved).toBe(26_000);
  });
});
