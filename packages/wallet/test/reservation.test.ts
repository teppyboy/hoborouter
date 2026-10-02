// Task 8: createReservation / releaseHold — reservation core, ownership validation,
// concurrency gate, sequential fuzz.
// NOTE: fuzz test is explicitly SEQUENTIAL. Concurrency claims are limited to
// the two-connection test below; nothing here asserts parallel safety beyond it.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { createDb } from "@hoborouter/db";
import type { Db } from "@hoborouter/db";
import {
  createReservation,
  releaseHold,
  creditWallet,
  getWallet,
  WalletError,
} from "../src/wallet";
import { makeDb, seedFixture, makePayment, q1, NOW, type Fixture } from "./helpers";

let db: Db;
let drop: () => Promise<void>;
let f: Fixture;

beforeAll(async () => {
  const t = await makeDb();
  db = t.db;
  drop = t.drop;
  f = await seedFixture(db);
  await makePayment(db, "pay-res-1", "ws-a");
  await creditWallet(db, { walletId: f.walletA, amount: 10_000, kind: "topup", paymentId: "pay-res-1" });
});

afterAll(async () => {
  await drop();
});

const baseArgs = () => ({
  walletId: f.walletA,
  workspaceId: f.wsA,
  gatewayRequestId: `req-${Math.random().toString(36).slice(2)}`,
  apiKeyId: f.keyA,
  modelBindingId: f.mbGlobal,
  endpoint: "/v1/chat/completions" as const,
  mode: "stream" as const,
  priceSnapshotId: f.snapGlobal,
  capAmount: 1_000,
  estimatedInputTokens: 100,
  now: NOW,
});

async function countRequests(): Promise<number> {
  return (await q1<{ c: number }>(db, sql`SELECT count(*)::int c FROM requests`)).c;
}
async function countReservations(): Promise<number> {
  return (await q1<{ c: number }>(db, sql`SELECT count(*)::int c FROM reservations`)).c;
}

describe("createReservation — happy path", () => {
  test("reserves cap, inserts pending request row, available drops by cap", async () => {
    const before = await getWallet(db, f.walletA);
    const args = baseArgs();
    const r = await createReservation(db, args);
    if ("error" in r) throw new Error("expected success");
    const after = await getWallet(db, f.walletA);
    expect(after.reserved).toBe(before.reserved + args.capAmount);
    expect(after.available).toBe(before.available - args.capAmount);
    expect(after.version).toBe(before.version + 1);
    const req = await q1(db, sql`SELECT * FROM requests WHERE id = ${r.requestId}`);
    expect(req.workspace_id).toBe(f.wsA);
    expect(req.api_key_id).toBe(f.keyA);
    expect(req.model_binding_id).toBe(f.mbGlobal);
    expect(req.endpoint).toBe("/v1/chat/completions");
    expect(req.mode).toBe("stream");
    expect(req.status).toBe("pending");
    const res = await q1(db, sql`SELECT * FROM reservations WHERE id = ${r.reservationId}`);
    expect(res.gateway_request_id).toBe(r.requestId);
    expect(res.status).toBe("held");
    expect(Number(res.cap_amount)).toBe(args.capAmount);
    expect(res.price_snapshot_id).toBe(f.snapGlobal);
  });

  test("insufficient: reserve cap+1 over available → {error:'insufficient'}, wallet unchanged, no rows", async () => {
    const w = await getWallet(db, f.walletA);
    const args = { ...baseArgs(), capAmount: w.available + 1 };
    const r = await createReservation(db, args);
    expect(r).toEqual({ error: "insufficient" });
    expect(await getWallet(db, f.walletA)).toEqual(w);
    expect(await countRequests()).toBe(1);
    expect(await countReservations()).toBe(1);
  });
});

describe("createReservation — ownership negatives (each: rollback, no rows, wallet unchanged)", () => {
  const negatives: Array<[string, (args: ReturnType<typeof baseArgs>) => unknown]> = [
    [
      "(a) wallet from workspace B while key is workspace A",
      (a) => ({ ...a, walletId: f.walletB }),
    ],
    ["(b1) key whose workspace ≠ workspaceId", (a) => ({ ...a, apiKeyId: f.keyB })],
    ["(b2) revoked key", (a) => ({ ...a, apiKeyId: f.keyRevoked })],
    [
      "(c) model binding owned by workspace B (non-global)",
      (a) => ({ ...a, modelBindingId: f.mbB }),
    ],
    ["(d) disabled binding", (a) => ({ ...a, modelBindingId: f.mbDisabled })],
    [
      "(e) priceSnapshotId of a DIFFERENT binding",
      (a) => ({ ...a, modelBindingId: f.mbGlobal, priceSnapshotId: f.snapA }),
    ],
  ];
  for (const [name, mutate] of negatives) {
    test(name, async () => {
      const before = await getWallet(db, f.walletA);
      const nReq = await countRequests();
      const nRes = await countReservations();
      expect(() =>
        createReservation(
          db,
          mutate(baseArgs()) as typeof baseArgs extends () => infer T ? T : never,
        ),
      ).toThrow(WalletError);
      expect(await getWallet(db, f.walletA)).toEqual(before);
      expect(await countRequests()).toBe(nReq);
      expect(await countReservations()).toBe(nRes);
    });
  }

  test("(f) duplicate gatewayRequestId → conflict error, no second reservation", async () => {
    const args = baseArgs();
    const first = await createReservation(db, args);
    expect(first).toHaveProperty("reservationId");
    const before = await getWallet(db, f.walletA);
    const nRes = await countReservations();
    expect(() =>
      createReservation(db, { ...baseArgs(), gatewayRequestId: args.gatewayRequestId }),
    ).toThrow(/conflict/i);
    expect(await getWallet(db, f.walletA)).toEqual(before);
    expect(await countReservations()).toBe(nRes);
  });

  test("(g) apiKeyId null → invalid error (releaseHold requires same key; null-key holds are unreleasable)", async () => {
    const before = await getWallet(db, f.walletA);
    const nReq = await countRequests();
    const nRes = await countReservations();
    expect(() =>
      createReservation(db, { ...baseArgs(), apiKeyId: null as unknown as string }),
    ).toThrow(/invalid/);
    expect(await getWallet(db, f.walletA)).toEqual(before);
    expect(await countRequests()).toBe(nReq);
    expect(await countReservations()).toBe(nRes);
  });

  test("positive control: same-workspace wallet + global binding + matching snapshot succeeds", async () => {
    const r = await createReservation(db, baseArgs());
    expect(r).toHaveProperty("reservationId");
  });
});

describe("releaseHold", () => {
  let resId: string;
  test("releases: reserved returns to available, NO ledger row, status released", async () => {
    const args = baseArgs();
    const r = await createReservation(db, args);
    if (!("reservationId" in r)) throw new Error("expected success");
    resId = r.reservationId;
    const during = await getWallet(db, f.walletA);
    const ledgerBefore = (
      await q1<{ c: number }>(db, sql`SELECT count(*)::int c FROM ledger_entries`)
    ).c;
    await releaseHold(db, { reservationId: resId, apiKeyId: f.keyA, workspaceId: f.wsA, now: NOW + 1 });
    const after = await getWallet(db, f.walletA);
    expect(after.reserved).toBe(during.reserved - args.capAmount);
    const ledgerAfter = (
      await q1<{ c: number }>(db, sql`SELECT count(*)::int c FROM ledger_entries`)
    ).c;
    expect(ledgerAfter).toBe(ledgerBefore);
    const row = await q1<{ s: string }>(db, sql`SELECT status s FROM reservations WHERE id = ${resId}`);
    expect(row.s).toBe("released");
  });

  test("double release → terminal error", async () => {
    expect(
      releaseHold(db, { reservationId: resId, apiKeyId: f.keyA, workspaceId: f.wsA, now: NOW + 2 }),
    ).rejects.toThrow(/terminal/i);
  });

  test("release with wrong api key → ownership error, reserved unchanged", async () => {
    const args = baseArgs();
    const r = await createReservation(db, args);
    if (!("reservationId" in r)) throw new Error("expected success");
    const during = await getWallet(db, f.walletA);
    expect(
      releaseHold(db, {
        reservationId: r.reservationId,
        apiKeyId: f.keyB,
        workspaceId: f.wsA,
        now: NOW,
      }),
    ).rejects.toThrow(/ownership|not found/i);
    expect(await getWallet(db, f.walletA)).toEqual(during);
    await releaseHold(db, {
      reservationId: r.reservationId,
      apiKeyId: f.keyA,
      workspaceId: f.wsA,
      now: NOW,
    });
  });

  test("release with wrong workspace → ownership error", async () => {
    const args = baseArgs();
    const r = await createReservation(db, args);
    if (!("reservationId" in r)) throw new Error("expected success");
    const during = await getWallet(db, f.walletA);
    expect(
      releaseHold(db, {
        reservationId: r.reservationId,
        apiKeyId: f.keyA,
        workspaceId: f.wsB,
        now: NOW,
      }),
    ).rejects.toThrow(/ownership|not found/i);
    expect(await getWallet(db, f.walletA)).toEqual(during);
    await releaseHold(db, {
      reservationId: r.reservationId,
      apiKeyId: f.keyA,
      workspaceId: f.wsA,
      now: NOW,
    });
  });

  test("release of already-terminal reservation → terminal error", async () => {
    const args = baseArgs();
    const r = await createReservation(db, args);
    if (!("reservationId" in r)) throw new Error("expected success");
    await releaseHold(db, {
      reservationId: r.reservationId,
      apiKeyId: f.keyA,
      workspaceId: f.wsA,
      now: NOW,
    });
    expect(
      releaseHold(db, {
        reservationId: r.reservationId,
        apiKeyId: f.keyA,
        workspaceId: f.wsA,
        now: NOW,
      }),
    ).rejects.toThrow(/terminal/i);
  });
});

describe("two-connection concurrency gate", () => {
  test("two concurrent createReservation of > balance/2 → exactly one succeeds (no double spend)", async () => {
    const { db: seeded, url: seedUrl, drop: dropSeed } = await makeDb();
    await seeded.execute(
      sql`INSERT INTO users (id, name, email, created_at, updated_at) VALUES ('u1','U1','u1@t.local',${NOW},${NOW})`,
    );
    await seeded.execute(
      sql`INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws-c','C','active',${NOW})`,
    );
    await seeded.execute(
      sql`INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at) VALUES ('w-c','ws-c','VND',100,0,0,${NOW})`,
    );
    await seeded.execute(
      sql`INSERT INTO model_bindings (id, workspace_id, public_model, cpa_alias, status, price_input_per_1m, price_output_per_1m, effective_at) VALUES ('mb-c',NULL,'m','a','published',1,1,${NOW})`,
    );
    await seeded.execute(
      sql`INSERT INTO price_snapshots (id, binding_id, price_input, price_output, created_at) VALUES ('snap-c','mb-c',1,1,${NOW})`,
    );
    await seeded.execute(
      sql`INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at) VALUES ('key-c','ws-c','hash-c','sk-hbr-x','key c','active',${NOW})`,
    );
    // Two SEPARATE connections against the same database: true concurrent
    // transactions, serialized only by the wallets row lock / CAS.
    const db1: Db = createDb(seedUrl);
    const db2: Db = createDb(seedUrl);
    const args = (id: string) => ({
      walletId: "w-c",
      workspaceId: "ws-c",
      gatewayRequestId: id,
      apiKeyId: "key-c",
      modelBindingId: "mb-c",
      endpoint: "/v1/chat/completions" as const,
      mode: "stream" as const,
      priceSnapshotId: "snap-c",
      capAmount: 60,
      estimatedInputTokens: 10,
      now: NOW,
    });
    const results = await Promise.allSettled([
      createReservation(db1, args("r1")),
      createReservation(db2, args("r2")),
    ]);
    const outcomes = results.map((r) =>
      r.status === "fulfilled" ? r.value : { error: String(r.reason) },
    );
    const succeeded = outcomes.filter((o) => "reservationId" in o);
    const failed = outcomes.filter((o) => "error" in o);
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);
    const w = await getWallet(db1, "w-c");
    expect(w.balance).toBe(100);
    expect(w.reserved).toBe(60);
    expect(w.available).toBe(40);
    await dropSeed();
  });
});

describe("sequential fuzz (500 sequential mixed ops)", () => {
  test("invariants hold after every commit; ledger balance_after consistent", async () => {
    const fdb0 = await makeDb();
    const fdb = fdb0.db;
    const ff = await seedFixture(fdb);
    await makePayment(fdb, "pay-fuzz", ff.wsA);
    await creditWallet(fdb, {
      walletId: ff.walletA,
      amount: 50_000,
      kind: "topup",
      paymentId: "pay-fuzz",
    });
    // deterministic PRNG
    let s = 0x2f6e2b1;
    const rand = () => {
      s |= 0;
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let i = 0;
    let held = 0; // our own tracked reserved
    const live: string[] = [];
    while (i < 500) {
      i++;
      const w = await getWallet(fdb, ff.walletA);
      if (live.length > 0 && rand() < 0.5) {
        const idx = Math.floor(rand() * live.length);
        const rid = live[idx]!;
        const cap = (
          await q1<{ c: number }>(fdb, sql`SELECT cap_amount c FROM reservations WHERE id=${rid}`)
        ).c;
        await releaseHold(fdb, {
          reservationId: rid,
          apiKeyId: ff.keyA,
          workspaceId: ff.wsA,
          now: NOW + i,
        });
        live.splice(idx, 1);
        held -= cap;
      } else {
        const cap = 1 + Math.floor(rand() * Math.max(1, w.available));
        const r = await createReservation(fdb, {
          ...baseArgs(),
          gatewayRequestId: `fz-${i}`,
          capAmount: cap,
        });
        if ("reservationId" in r) {
          live.push(r.reservationId);
          held += cap;
        }
      }
      const after = await getWallet(fdb, ff.walletA);
      expect(after.balance).toBeGreaterThanOrEqual(0);
      expect(after.reserved).toBeGreaterThanOrEqual(0);
      expect(after.balance).toBeGreaterThanOrEqual(after.reserved);
      expect(after.reserved).toBe(held);
      // every ledger balance_after equals wallet balance at that row's creation:
      // total credits == current balance (topups are the only ledger ops here)
      const sum = (
        await q1<{ s: number }>(
          fdb,
          sql`SELECT coalesce(sum(amount),0)::int s FROM ledger_entries WHERE wallet_id=${ff.walletA} AND direction='credit'`,
        )
      ).s;
      expect(sum).toBe(after.balance);
    }
    await fdb0.drop();
  });
});

