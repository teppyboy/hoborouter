// Admin wallet adjustment (owner decision lane): domain contract tests.
// adjustWalletBalance is the Db-only transaction owner: wallet role/workspace
// validation, signed-delta balance math, CAS snapshot, positive-amount ledger
// entry, admin-private audit reason, and the (actor, idempotency_key) receipt
// — ALL inside ONE transaction; a replay returns the ORIGINAL receipt; any
// failure (audit, unique race) rolls back every write.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { isUniqueViolation, type Db } from "@hoborouter/db";
import {
  adjustWalletBalance,
  WalletError,
  createReservation,
  reserveRequest,
  settleRequest,
  type AdminAdjustmentReceipt,
} from "../src/index";
import { NOW, makeDb, q, q1, seedFixture, type Fixture } from "./helpers";

let db: Db;
let drop: () => Promise<void>;
let f: Fixture;

const ACTOR = "u1";

function args(over: Partial<Parameters<typeof adjustWalletBalance>[1]> = {}) {
  return {
    actorUserId: ACTOR,
    idempotencyKey: `idem-${Math.random().toString(36).slice(2)}-0123456789`,
    workspaceId: f.wsA,
    walletId: f.walletA,
    delta: 50_000,
    reason: "goodwill credit",
    ...over,
  };
}

beforeAll(async () => {
  const t = await makeDb();
  db = t.db;
  drop = t.drop;
  f = await seedFixture(db);
});

afterAll(async () => {
  await drop();
});

/** Unwrap an Error cause chain (bounded) into one text blob for assertions. */
function errorChainText(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; cur instanceof Error && i < 10; i++) {
    parts.push(cur.message);
    cur = (cur as { cause?: unknown }).cause;
  }
  if (typeof cur === "string") parts.push(cur);
  return parts.join("\n");
}

async function walletRow(walletId: string) {
  return q1<{ balance: number; reserved: number; version: number }>(
    db,
    sql`select balance::int as balance, reserved::int as reserved, version::int as version from wallets where id = ${walletId}`,
  );
}

describe("adjustWalletBalance — credit", () => {
  test("credits wallet, writes positive-amount ledger entry + full receipt", async () => {
    const before = await walletRow(f.walletA);
    const r = await adjustWalletBalance(db, args({ delta: 123_456 }));
    expect(r.delta).toBe(123_456);
    expect(r.replayed).toBe(false);
    expect(r.balanceBefore).toBe(before.balance);
    expect(r.balanceAfter).toBe(before.balance + 123_456);
    expect(r.reserved).toBe(before.reserved);
    // wallet snapshot updated, version bumped exactly once
    const after = await walletRow(f.walletA);
    expect(after.balance).toBe(r.balanceAfter);
    expect(after.version).toBe(before.version + 1);
    // ledger: direction/amount/balance_after/memo — memo is generic, never the private reason
    const ledger = await q1<{
      direction: string;
      amount: number;
      balance_after: number;
      memo: string | null;
      kind: string;
    }>(
      db,
      sql`select direction, amount::int as amount, balance_after::int as balance_after, memo, kind from ledger_entries where id = ${r.ledgerEntryId}`,
    );
    expect(ledger.direction).toBe("credit");
    expect(ledger.amount).toBe(123_456);
    expect(ledger.balance_after).toBe(r.balanceAfter);
    expect(ledger.kind).toBe("adjustment");
    expect(ledger.memo).not.toBe(r.reason);
    // receipt stored with the private reason + canonical request payload
    const receipt = await q1<{ reason: string; request_payload: unknown; ledger_entry_id: string }>(
      db,
      sql`select reason, request_payload, ledger_entry_id from admin_wallet_adjustments where id = ${r.id}`,
    );
    expect(receipt.reason).toBe("goodwill credit");
    expect(receipt.ledger_entry_id).toBe(r.ledgerEntryId);
    expect(receipt.request_payload).toEqual({
      workspaceId: f.wsA,
      delta: 123_456,
      reason: "goodwill credit",
    });
    // audit row written in the same txn (same tx committed both)
    const audit = await q<{ action: string }>(
      db,
      sql`select action from audit_log where target = ${f.walletA} and actor_user_id = ${ACTOR}`,
    );
    expect(audit.length).toBe(1);
    // Canonical admin audit action — the exclusion filter (admin.* domain)
    // and downstream tooling key off this exact name.
    expect(audit[0]!.action).toBe("admin.wallet.adjust");
  });
});

describe("adjustWalletBalance — replay idempotency", () => {
  test("same actor+key+payload returns the ORIGINAL receipt, no second ledger entry", async () => {
    const a = args({ delta: 77_000 });
    const first = await adjustWalletBalance(db, a);
    const ledgerCount = await q<{ n: number }>(
      db,
      sql`select count(*)::int as n from ledger_entries where wallet_id = ${f.walletA} and kind = 'adjustment'`,
    );
    const second = await adjustWalletBalance(db, a);
    expect(second.id).toBe(first.id);
    expect(second.ledgerEntryId).toBe(first.ledgerEntryId);
    expect(second.balanceAfter).toBe(first.balanceAfter);
    expect(second.replayed).toBe(true);
    const ledgerCount2 = await q<{ n: number }>(
      db,
      sql`select count(*)::int as n from ledger_entries where wallet_id = ${f.walletA} and kind = 'adjustment'`,
    );
    expect(ledgerCount2[0]!.n).toBe(ledgerCount[0]!.n);
  });

  test("replay returns original receipt even if the wallet changed since", async () => {
    const a = args({ delta: 500 });
    const first = await adjustWalletBalance(db, a);
    // unrelated later movement on the same wallet
    await adjustWalletBalance(db, args({ delta: 9_000 }));
    const replay = await adjustWalletBalance(db, a);
    expect(replay.balanceAfter).toBe(first.balanceAfter);
    expect(replay.replayed).toBe(true);
  });

  test("same key with different delta/reason/workspace is idempotency_mismatch", async () => {
    const a = args({ delta: 1_000 });
    await adjustWalletBalance(db, a);
    for (const over of [{ delta: 2_000 }, { reason: "different reason" }, { workspaceId: f.wsB }]) {
      await expect(adjustWalletBalance(db, { ...a, ...over })).rejects.toMatchObject({
        code: "idempotency_mismatch",
      });
    }
  });

  test("unique race loser rolls back ALL writes, then reads the winner outside the aborted tx", async () => {
    // Two different wallets, same (actor, key): exactly one may commit. The
    // loser's wallet write must roll back, and its post-abort read must return
    // the winner's receipt.
    const key = `race-${Math.random().toString(36).slice(2)}-0123456789`;
    const beforeB = await walletRow(f.walletB);
    const results = await Promise.allSettled([
      adjustWalletBalance(db, args({ idempotencyKey: key, delta: 111, walletId: f.walletA })),
      adjustWalletBalance(
        db,
        args({ idempotencyKey: key, delta: 222, walletId: f.walletB, workspaceId: f.wsB }),
      ),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBe(1);
    const winner = (fulfilled[0] as PromiseFulfilledResult<AdminAdjustmentReceipt>).value;
    // loser wallet untouched
    const afterB = await walletRow(f.walletB);
    if (winner.walletId === f.walletA) {
      expect(afterB.balance).toBe(beforeB.balance);
      expect(afterB.version).toBe(beforeB.version);
    }
    // exactly one receipt for the key
    const receipts = await q<{ n: number }>(
      db,
      sql`select count(*)::int as n from admin_wallet_adjustments where actor_user_id = ${ACTOR} and idempotency_key = ${key}`,
    );
    expect(receipts[0]!.n).toBe(1);
    // re-running the losing request is a MISMATCH (different payload under a
    // used key); re-running the WINNER's request replays the original receipt.
    const losingArgs =
      winner.walletId === f.walletA
        ? args({ idempotencyKey: key, delta: 222, walletId: f.walletB, workspaceId: f.wsB })
        : args({ idempotencyKey: key, delta: 111, walletId: f.walletA });
    await expect(adjustWalletBalance(db, losingArgs)).rejects.toMatchObject({
      code: "idempotency_mismatch",
    });
    const winnerArgs =
      winner.walletId === f.walletA
        ? args({ idempotencyKey: key, delta: 111, walletId: f.walletA })
        : args({ idempotencyKey: key, delta: 222, walletId: f.walletB, workspaceId: f.wsB });
    const replay = await adjustWalletBalance(db, winnerArgs);
    expect(replay.id).toBe(winner.id);
    expect(replay.replayed).toBe(true);
  });
});

describe("adjustWalletBalance — balance guards", () => {
  test("debit below reserved is insufficient and writes nothing", async () => {
    // walletA has a 400 hold via createReservation; balance 0 + holds
    const bal = await walletRow(f.walletA);
    // give balance then reserve against it
    await adjustWalletBalance(db, args({ delta: 1_000 }));
    const res = await createReservation(db, {
      workspaceId: f.wsA,
      walletId: f.walletA,
      apiKeyId: f.keyA,
      modelBindingId: f.mbA,
      endpoint: "/v1/chat/completions",
      mode: "non-stream",
      priceSnapshotId: f.snapA,
      capAmount: 400,
      estimatedInputTokens: 0,
      gatewayRequestId: `req-${Math.random().toString(36).slice(2)}`,
      now: NOW,
    });
    if (!("reservationId" in res)) throw new Error("reservation should succeed");
    const held = await walletRow(f.walletA);
    expect(held.reserved).toBe(400);
    await expect(
      adjustWalletBalance(db, args({ delta: -(bal.balance + 1_000 - 300) })),
    ).rejects.toMatchObject({ code: "insufficient" });
    const after = await walletRow(f.walletA);
    expect(after.balance).toBe(held.balance);
    expect(after.version).toBe(held.version);
  });

  test("credit overflow is rejected", async () => {
    // UNIQUE(workspace, kind='topup'): every extra topup wallet needs its own workspace.
    await db.execute(
      sql`insert into workspaces (id, name, status, created_at) values ('ws-ovf', 'O', 'active', ${NOW})`,
    );
    const MAX = 9_007_199_254_740_991;
    const w = "wallet-overflow";
    await db.execute(
      sql`insert into wallets (id, workspace_id, currency, kind, balance, reserved, version, created_at) values (${w}, 'ws-ovf', 'VND', 'topup', ${MAX - 5}, 0, 0, ${NOW})`,
    );
    await expect(
      adjustWalletBalance(db, args({ walletId: w, workspaceId: "ws-ovf", delta: 100 })),
    ).rejects.toMatchObject({ code: "overflow" });
  });

  test("delta must be a non-zero safe integer within bounds", async () => {
    for (const delta of [0, 1.5, Number.NaN, 9_007_199_254_740_992, -9_007_199_254_740_992]) {
      await expect(adjustWalletBalance(db, args({ delta }))).rejects.toMatchObject({
        code: "invalid",
      });
    }
  });

  test("idempotencyKey length and reason length validated", async () => {
    await expect(adjustWalletBalance(db, args({ idempotencyKey: "short" }))).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(adjustWalletBalance(db, args({ reason: "" }))).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(adjustWalletBalance(db, args({ reason: "x".repeat(501) }))).rejects.toMatchObject({
      code: "invalid",
    });
  });
});

describe("adjustWalletBalance — resolution guards", () => {
  test("wallet outside the explicit workspace is ownership", async () => {
    await expect(adjustWalletBalance(db, args({ walletId: f.walletB }))).rejects.toMatchObject({
      code: "ownership",
    });
  });

  test("subscription wallet is unreachable", async () => {
    const sub = "wallet-sub";
    await db.execute(
      sql`insert into wallets (id, workspace_id, currency, kind, balance, reserved, version, created_at) values (${sub}, ${f.wsA}, 'VND', 'subscription', 0, 0, 0, ${NOW})`,
    );
    await expect(adjustWalletBalance(db, args({ walletId: sub }))).rejects.toMatchObject({
      code: "invalid",
    });
  });

  test("unknown wallet / unknown actor is not_found", async () => {
    await expect(adjustWalletBalance(db, args({ walletId: "nope" }))).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(adjustWalletBalance(db, args({ actorUserId: "no-user" }))).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("adjustWalletBalance — atomicity under failure", () => {
  test("audit failure rolls back ledger, receipt, and wallet snapshot", async () => {
    await db.execute(
      sql`insert into workspaces (id, name, status, created_at) values ('ws-auditfail', 'F', 'active', ${NOW})`,
    );
    const w = "wallet-auditfail";
    await db.execute(
      sql`insert into wallets (id, workspace_id, currency, kind, balance, reserved, version, created_at) values (${w}, 'ws-auditfail', 'VND', 'topup', 0, 0, 0, ${NOW})`,
    );
    // Deterministic audit failure: throwaway test DB only — a trigger makes
    // the audit_log insert fail so the whole transaction must roll back.
    await db.execute(sql`
      create function hbr_test_audit_bomb() returns trigger as $$
      begin raise exception 'audit exploded'; end $$ language plpgsql
    `);
    await db.execute(
      sql`create trigger hbr_test_audit_bomb before insert on audit_log for each row execute function hbr_test_audit_bomb()`,
    );
    try {
      let failed: unknown;
      try {
        await adjustWalletBalance(
          db,
          args({ walletId: w, workspaceId: "ws-auditfail", delta: 5_000 }),
        );
      } catch (e) {
        failed = e;
      }
      // drizzle wraps the driver error ("Failed query: ...") — the pg trigger
      // message lives in the cause chain, so assert on the unwrapped chain.
      expect(failed).toBeDefined();
      expect(errorChainText(failed)).toContain("audit exploded");
    } finally {
      await db.execute(sql`drop trigger hbr_test_audit_bomb on audit_log`);
      await db.execute(sql`drop function hbr_test_audit_bomb()`);
    }
    const after = await walletRow(w);
    expect(after.balance).toBe(0);
    expect(after.version).toBe(0);
    const rows = await q<{ n: number }>(
      db,
      sql`select
            (select count(*)::int from ledger_entries where wallet_id = ${w}) +
            (select count(*)::int from admin_wallet_adjustments where wallet_id = ${w}) as n`,
    );
    expect(rows[0]!.n).toBe(0);
  });
});

describe("adjustWalletBalance — concurrency with reserve/settle", () => {
  test("no double spend: debit adjust vs reservation hold serialize on the locked row", async () => {
    await db.execute(
      sql`insert into workspaces (id, name, status, created_at) values ('ws-conc', 'C', 'active', ${NOW})`,
    );
    const w = "wallet-conc";
    await db.execute(
      sql`insert into wallets (id, workspace_id, currency, kind, balance, reserved, version, created_at) values (${w}, 'ws-conc', 'VND', 'topup', 1000, 0, 0, ${NOW})`,
    );
    // createReservation validates key/binding workspace ownership: per-test
    // keys for the isolated workspaces + the global published binding.
    await db.execute(
      sql`insert into api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at) values ('key-conc', 'ws-conc', 'hash-conc', 'sk-hbr-x', 'k', 'active', ${NOW})`,
    );
    const res = await createReservation(db, {
      workspaceId: "ws-conc",
      walletId: w,
      apiKeyId: "key-conc",
      modelBindingId: f.mbGlobal,
      endpoint: "/v1/chat/completions",
      mode: "non-stream",
      priceSnapshotId: f.snapGlobal,
      capAmount: 800,
      estimatedInputTokens: 0,
      gatewayRequestId: `req-${Math.random().toString(36).slice(2)}`,
      now: NOW,
    });
    if (!("reservationId" in res)) throw new Error("reservation should succeed");
    // Concurrent: debit 500 (valid: 1000-500=500 >= 800 is FALSE → insufficient)
    // against a wallet holding 800. The adjust must see the held row.
    // args() defaults to the fixture workspace; the concurrency wallets live
    // in their own per-test workspaces, so pass the MATCHING workspace — the
    // ownership check must stay satisfied, not bypassed.
    await expect(
      adjustWalletBalance(db, args({ walletId: w, workspaceId: "ws-conc", delta: -500 })),
    ).rejects.toMatchObject({ code: "insufficient" });
    // and a valid debit of 100 keeps the hold intact (matching workspace)
    await adjustWalletBalance(db, args({ walletId: w, workspaceId: "ws-conc", delta: -100 }));
    const row = await walletRow(w);
    expect(row.balance).toBe(900);
    expect(row.reserved).toBe(800);
  });

  test("credit adjust and settle both land exactly once under parallel execution", async () => {
    await db.execute(
      sql`insert into workspaces (id, name, status, created_at) values ('ws-conc2', 'D', 'active', ${NOW})`,
    );
    const w = "wallet-conc2";
    await db.execute(
      sql`insert into wallets (id, workspace_id, currency, kind, balance, reserved, version, created_at) values (${w}, 'ws-conc2', 'VND', 'topup', 2000, 0, 0, ${NOW})`,
    );
    await db.execute(
      sql`insert into api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at) values ('key-conc2', 'ws-conc2', 'hash-conc2', 'sk-hbr-x', 'k', 'active', ${NOW})`,
    );
    // settleRequest settles a BILLING reservation (billing_reservations), not
    // a wallet hold — seed the canonical model/mapping/price rows and reserve
    // via reserveRequest, matching the real request pipeline.
    await db.execute(
      sql`insert into models (id, public_id, slug, display_name, provider, enabled, published, created_at, updated_at) values ('model-conc2', 'pub-conc2', 'slug-conc2', 'Model C2', 'openai', true, true, ${NOW}, ${NOW})`,
    );
    await db.execute(
      sql`insert into provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at) values ('pm-conc2', 'model-conc2', 'openai', 'upstream-conc2', true, ${NOW}, ${NOW})`,
    );
    await db.execute(
      sql`insert into model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at) values ('price-conc2', 'model-conc2', 1000000, 2000000, 500000, 3000000, 1000000, ${NOW})`,
    );
    const res = await reserveRequest(db, {
      requestId: `req-${Math.random().toString(36).slice(2)}`,
      workspaceId: "ws-conc2",
      apiKeyId: "key-conc2",
      modelId: "model-conc2",
      mappingId: "pm-conc2",
      modelPriceId: "price-conc2",
      endpoint: "/v1/chat/completions",
      mode: "non-stream",
      fxRate: 26000,
      capVnd: 700,
      now: NOW,
    });
    await db.execute(
      sql`update requests set dispatch_state = 'dispatching' where id = ${res.requestId}`,
    );
    const [adjust, settle] = await Promise.all([
      adjustWalletBalance(db, args({ walletId: w, workspaceId: "ws-conc2", delta: 300 })),
      settleRequest(
        db,
        res.requestId,
        {
          kind: "usage",
          usage: {
            inputTokens: 100n,
            outputTokens: 100n,
            cachedInputTokens: 0n,
            reasoningTokens: 0n,
          },
          upstreamModel: "m",
          provider: "p",
          publicModel: "pub",
        },
        NOW,
      ),
    ]);
    expect(adjust.replayed).toBe(false);
    expect(settle.status).toBe("settled");
    const row = await walletRow(w);
    // 2000 + 300 (adjust) - charged (settle) — both applied exactly once
    const ledger = await q<{ total: number; n: number }>(
      db,
      sql`select sum(case when direction = 'credit' then amount else -amount end)::bigint::int as total, count(*)::int as n from ledger_entries where wallet_id = ${w}`,
    );
    expect(ledger[0]!.n).toBe(2); // exactly one adjust entry + one settle entry
    // Opening balance 2000 was seeded via SQL (no ledger entry), so the ledger
    // sum is only the DELTA (adjust credit - settled charge). Stronger
    // invariant: balance = opening + ledger net delta exactly (no drift, no
    // double spend). The authoritative settle charge is whatever
    // settleRequest charged — asserted via the ledger, not re-derived here.
    expect(row.balance).toBe(2000 + ledger[0]!.total);
  });
});

describe("adjustWalletBalance — unique violation mapping", () => {
  test("isUniqueViolation detects the actor+key arbiter", async () => {
    const key = "uniq-mapping-0123456789";
    await adjustWalletBalance(db, args({ idempotencyKey: key }));
    let caught: unknown;
    try {
      // raw insert reproduces the arbiter violation
      await db.execute(sql`
        insert into admin_wallet_adjustments
          (id, actor_user_id, idempotency_key, wallet_id, workspace_id, delta, reason,
           balance_before, balance_after, reserved, request_payload, created_at)
        values ('x1', ${ACTOR}, ${key}, ${f.walletA}, ${f.wsA}, 1, 'r', 0, 1, 0,
                '{"workspaceId":"ws-a","delta":1,"reason":"r"}'::jsonb, ${NOW})
      `);
    } catch (e) {
      caught = e;
    }
    expect(isUniqueViolation(caught)).toBe(true);
    expect(caught).toBeDefined();
    void WalletError;
  });
});
