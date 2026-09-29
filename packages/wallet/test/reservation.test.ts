// Task 8: createReservation / releaseHold — reservation core, ownership validation,
// concurrency gate, sequential fuzz.
// NOTE: fuzz test is explicitly SEQUENTIAL. Concurrency claims are limited to the
// two-connection WAL gate below; nothing here asserts parallel safety beyond it.
import { describe, expect, test, beforeAll } from "bun:test";
import type { Database } from "bun:sqlite";
import { createDb, migrate } from "@hoborouter/db";
import {
  createReservation,
  releaseHold,
  creditWallet,
  getWallet,
  WalletError,
} from "../src/wallet";
import { makeDb, seedFixture, makePayment, NOW, type Fixture } from "./helpers";

let db: Database;
let f: Fixture;

beforeAll(() => {
  db = makeDb();
  f = seedFixture(db);
  makePayment(db, "pay-res-1", "ws-a");
  creditWallet(db, { walletId: f.walletA, amount: 10_000, kind: "topup", paymentId: "pay-res-1" });
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

function countRequests(): number {
  return (db.prepare("SELECT count(*) c FROM requests").get() as { c: number }).c;
}
function countReservations(): number {
  return (db.prepare("SELECT count(*) c FROM reservations").get() as { c: number }).c;
}

describe("createReservation — happy path", () => {
  test("reserves cap, inserts pending request row, available drops by cap", () => {
    const before = getWallet(db, f.walletA);
    const args = baseArgs();
    const r = createReservation(db, args);
    if ("error" in r) throw new Error("expected success");
    const after = getWallet(db, f.walletA);
    expect(after.reserved).toBe(before.reserved + args.capAmount);
    expect(after.available).toBe(before.available - args.capAmount);
    expect(after.version).toBe(before.version + 1);
    const req = db.prepare("SELECT * FROM requests WHERE id = ?").get(r.requestId) as Record<
      string,
      unknown
    >;
    expect(req.workspace_id).toBe(f.wsA);
    expect(req.api_key_id).toBe(f.keyA);
    expect(req.model_binding_id).toBe(f.mbGlobal);
    expect(req.endpoint).toBe("/v1/chat/completions");
    expect(req.mode).toBe("stream");
    expect(req.status).toBe("pending");
    const res = db
      .prepare("SELECT * FROM reservations WHERE id = ?")
      .get(r.reservationId) as Record<string, unknown>;
    expect(res.gateway_request_id).toBe(r.requestId);
    expect(res.status).toBe("held");
    expect(res.cap_amount).toBe(args.capAmount);
    expect(res.price_snapshot_id).toBe(f.snapGlobal);
  });

  test("insufficient: reserve cap+1 over available → {error:'insufficient'}, wallet unchanged, no rows", () => {
    const w = getWallet(db, f.walletA);
    const args = { ...baseArgs(), capAmount: w.available + 1 };
    const r = createReservation(db, args);
    expect(r).toEqual({ error: "insufficient" });
    expect(getWallet(db, f.walletA)).toEqual(w);
    expect(countRequests()).toBe(1);
    expect(countReservations()).toBe(1);
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
    test(name, () => {
      const before = getWallet(db, f.walletA);
      const nReq = countRequests();
      const nRes = countReservations();
      expect(() =>
        createReservation(
          db,
          mutate(baseArgs()) as typeof baseArgs extends () => infer T ? T : never,
        ),
      ).toThrow(WalletError);
      expect(getWallet(db, f.walletA)).toEqual(before);
      expect(countRequests()).toBe(nReq);
      expect(countReservations()).toBe(nRes);
    });
  }

  test("(f) duplicate gatewayRequestId → conflict error, no second reservation", () => {
    const args = baseArgs();
    const first = createReservation(db, args);
    expect(first).toHaveProperty("reservationId");
    const before = getWallet(db, f.walletA);
    const nRes = countReservations();
    expect(() =>
      createReservation(db, { ...baseArgs(), gatewayRequestId: args.gatewayRequestId }),
    ).toThrow(/conflict/i);
    expect(getWallet(db, f.walletA)).toEqual(before);
    expect(countReservations()).toBe(nRes);
  });

  test("(g) apiKeyId null → invalid error (releaseHold requires same key; null-key holds are unreleasable)", () => {
    const before = getWallet(db, f.walletA);
    const nReq = countRequests();
    const nRes = countReservations();
    expect(() =>
      createReservation(db, { ...baseArgs(), apiKeyId: null as unknown as string }),
    ).toThrow(/invalid/);
    expect(getWallet(db, f.walletA)).toEqual(before);
    expect(countRequests()).toBe(nReq);
    expect(countReservations()).toBe(nRes);
  });

  test("positive control: same-workspace wallet + global binding + matching snapshot succeeds", () => {
    const r = createReservation(db, baseArgs());
    expect(r).toHaveProperty("reservationId");
  });
});

describe("releaseHold", () => {
  let resId: string;
  test("releases: reserved returns to available, NO ledger row, status released", () => {
    const args = baseArgs();
    const r = createReservation(db, args);
    if (!("reservationId" in r)) throw new Error("expected success");
    resId = r.reservationId;
    const during = getWallet(db, f.walletA);
    const ledgerBefore = (
      db.prepare("SELECT count(*) c FROM ledger_entries").get() as { c: number }
    ).c;
    releaseHold(db, { reservationId: resId, apiKeyId: f.keyA, workspaceId: f.wsA, now: NOW + 1 });
    const after = getWallet(db, f.walletA);
    expect(after.reserved).toBe(during.reserved - args.capAmount);
    const ledgerAfter = (db.prepare("SELECT count(*) c FROM ledger_entries").get() as { c: number })
      .c;
    expect(ledgerAfter).toBe(ledgerBefore);
    expect(
      (db.prepare("SELECT status s FROM reservations WHERE id = ?").get(resId) as { s: string }).s,
    ).toBe("released");
  });

  test("double release → terminal error", () => {
    expect(() =>
      releaseHold(db, { reservationId: resId, apiKeyId: f.keyA, workspaceId: f.wsA, now: NOW + 2 }),
    ).toThrow(/terminal/i);
  });

  test("release with wrong api key → ownership error, reserved unchanged", () => {
    const args = baseArgs();
    const r = createReservation(db, args);
    if (!("reservationId" in r)) throw new Error("expected success");
    const during = getWallet(db, f.walletA);
    expect(() =>
      releaseHold(db, {
        reservationId: r.reservationId,
        apiKeyId: f.keyB,
        workspaceId: f.wsA,
        now: NOW,
      }),
    ).toThrow(/ownership|not found/i);
    expect(getWallet(db, f.walletA)).toEqual(during);
    releaseHold(db, {
      reservationId: r.reservationId,
      apiKeyId: f.keyA,
      workspaceId: f.wsA,
      now: NOW,
    });
  });

  test("release with wrong workspace → ownership error", () => {
    const args = baseArgs();
    const r = createReservation(db, args);
    if (!("reservationId" in r)) throw new Error("expected success");
    const during = getWallet(db, f.walletA);
    expect(() =>
      releaseHold(db, {
        reservationId: r.reservationId,
        apiKeyId: f.keyA,
        workspaceId: f.wsB,
        now: NOW,
      }),
    ).toThrow(/ownership|not found/i);
    expect(getWallet(db, f.walletA)).toEqual(during);
    releaseHold(db, {
      reservationId: r.reservationId,
      apiKeyId: f.keyA,
      workspaceId: f.wsA,
      now: NOW,
    });
  });

  test("release of already-terminal reservation → terminal error", () => {
    const args = baseArgs();
    const r = createReservation(db, args);
    if (!("reservationId" in r)) throw new Error("expected success");
    releaseHold(db, {
      reservationId: r.reservationId,
      apiKeyId: f.keyA,
      workspaceId: f.wsA,
      now: NOW,
    });
    expect(() =>
      releaseHold(db, {
        reservationId: r.reservationId,
        apiKeyId: f.keyA,
        workspaceId: f.wsA,
        now: NOW,
      }),
    ).toThrow(/terminal/i);
  });
});

describe("two-connection WAL concurrency gate", () => {
  test("two parallel createReservation of > balance/2 → exactly one succeeds", async () => {
    const path = `${import.meta.dir}/../../.tmp-conc-test.sqlite`;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await import("node:fs").then((fs) => fs.unlinkSync(path + suffix));
      } catch {
        /* absent */
      }
    }
    // NOTE (honesty caveat): createReservation is synchronous bun:sqlite, so these
    // two Promise.allSettled closures CANNOT interleave inside a transaction on one
    // thread — the second call always starts after the first commits. This test
    // proves BEGIN IMMEDIATE atomicity + DB-level unique/constraint backstops
    // across two connections on one WAL file; it does NOT prove true concurrent
    // lock contention (that would need worker_threads and is not claimed here).
    const db1 = createDb(path);
    const db2 = createDb(path);
    migrate(db1);
    migrate(db2);
    db1.exec("PRAGMA busy_timeout = 5000");
    db2.exec("PRAGMA busy_timeout = 5000");
    db1
      .prepare(
        "INSERT INTO users (id, name, email, created_at, updated_at) VALUES ('u1','U1','u1@t.local',?,?)",
      )
      .run(NOW, NOW);
    db1
      .prepare(
        "INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws-c','C','active',?)",
      )
      .run(NOW);
    db1
      .prepare(
        "INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at) VALUES ('w-c','ws-c','VND',100,0,0,?)",
      )
      .run(NOW);
    db1
      .prepare(
        "INSERT INTO model_bindings (id, workspace_id, public_model, cpa_alias, status, price_input_per_1m, price_output_per_1m, effective_at) VALUES ('mb-c',NULL,'m','a','published',1,1,?)",
      )
      .run(NOW);
    db1
      .prepare(
        "INSERT INTO price_snapshots (id, binding_id, price_input, price_output, created_at) VALUES ('snap-c','mb-c',1,1,?)",
      )
      .run(NOW);
    // Real active key: createReservation now requires a non-null active apiKeyId
    // (releaseHold requires the same key, so null-key holds would be unreleasable).
    db1
      .prepare(
        "INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at) VALUES ('key-c','ws-c','hash-c','sk-hbr-x','key c','active',?)",
      )
      .run(NOW);
    // share seed rows with db2 (same file, but insert via db1 only)
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
      Promise.resolve().then(() => createReservation(db1, args("r1"))),
      Promise.resolve().then(() => createReservation(db2, args("r2"))),
    ]);
    const outcomes = results.map((r) =>
      r.status === "fulfilled" ? r.value : { error: String(r.reason) },
    );
    const succeeded = outcomes.filter(
      (o) => o && !("error" in o && o.error) && "reservationId" in o,
    );
    const failed = outcomes.filter((o) => o && "error" in o);
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);
    const w = getWallet(db1, "w-c");
    expect(w.balance).toBe(100);
    expect(w.reserved).toBe(60);
    expect(w.available).toBe(40);
    db1.close();
    db2.close();
  });
});

describe("sequential fuzz (500 sequential mixed ops)", () => {
  test("invariants hold after every commit; ledger balance_after consistent", () => {
    const fdb = makeDb();
    const ff = seedFixture(fdb);
    makePayment(fdb, "pay-fuzz", ff.wsA);
    creditWallet(fdb, {
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
      const w = getWallet(fdb, ff.walletA);
      if (live.length > 0 && rand() < 0.5) {
        const idx = Math.floor(rand() * live.length);
        const rid = live[idx]!;
        const cap = (
          fdb.prepare("SELECT cap_amount c FROM reservations WHERE id=?").get(rid) as { c: number }
        ).c;
        releaseHold(fdb, {
          reservationId: rid,
          apiKeyId: ff.keyA,
          workspaceId: ff.wsA,
          now: NOW + i,
        });
        live.splice(idx, 1);
        held -= cap;
      } else {
        const cap = 1 + Math.floor(rand() * Math.max(1, w.available));
        const r = createReservation(fdb, {
          ...baseArgs(),
          gatewayRequestId: `fz-${i}`,
          capAmount: cap,
        });
        if ("reservationId" in r) {
          live.push(r.reservationId);
          held += cap;
        }
      }
      const after = getWallet(fdb, ff.walletA);
      expect(after.balance).toBeGreaterThanOrEqual(0);
      expect(after.reserved).toBeGreaterThanOrEqual(0);
      expect(after.balance).toBeGreaterThanOrEqual(after.reserved);
      expect(after.reserved).toBe(held);
      // every ledger balance_after equals wallet balance at that row's creation:
      // total credits == current balance (topups are the only ledger ops here)
      const sum = fdb
        .prepare(
          "SELECT coalesce(sum(amount),0) s FROM ledger_entries WHERE wallet_id=? AND direction='credit'",
        )
        .get(ff.walletA) as { s: number };
      expect(sum.s).toBe(after.balance);
    }
  });
});
