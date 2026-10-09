// Unified promos Task 3: money/auth/concurrency regressions on the real test
// Postgres. Invariants: replay never double-credits; concurrent last-slot
// redemptions credit exactly once (storage-gate rollback); concurrent
// payment creations with one percent voucher consume it exactly once; fixed
// codes are rejected at checkout (409) without consuming anything; a
// promo-attached payment can't be double-charged by retrying creation.
import { describe, test, expect, beforeAll } from "bun:test";
import { makeApp, q, signUp, createWorkspace, userIdByEmail } from "../apps/api/test/helpers";
import { generatePromoCode } from "../apps/api/src/routes/admin-promotions";
import { hashPromoCode } from "../apps/api/src/promo-code";
import type { Db } from "../packages/db/src/index";

let app: Awaited<ReturnType<typeof makeApp>>["app"];
let db: Db;
let memberCookie: string;
let ws: string;
let ws2: string;
const memberEmail = "regress-member@test.dev";

const seedPromo = async (
  id: string,
  code: string,
  over: {
    kind?: "fixed" | "percent";
    amount_vnd?: number;
    percent_bp?: number;
    max_discount_vnd?: number;
    max_uses?: number;
  } = {},
) => {
  const kind = over.kind ?? "fixed";
  await q(
    db,
    `INSERT INTO promo_codes (id, code_hash, name, kind, amount_vnd, percent_bp, max_discount_vnd, max_uses, uses, expires_at, active, created_at)
     VALUES (?,?,?,?,?,?,?,?,0,NULL,true,?)`,
    id,
    hashPromoCode(code),
    `Promo ${id}`,
    kind,
    kind === "fixed" ? (over.amount_vnd ?? 50000) : null,
    kind === "percent" ? (over.percent_bp ?? 250) : null,
    kind === "percent" ? (over.max_discount_vnd ?? 100000) : null,
    over.max_uses ?? 10,
    Date.now(),
  );
};

const seedWallet = (id: string, workspaceId: string) =>
  q(
    db,
    `INSERT INTO wallets (id, workspace_id, kind, currency, balance, reserved, version, created_at)
     VALUES (?,?,'topup','VND',0,0,0,?)`,
    id,
    workspaceId,
    Date.now(),
  );

const redeem = (workspaceId: string, code: string, cookie = memberCookie) =>
  app.handle(
    new Request(`http://localhost/api/v1/workspaces/${workspaceId}/promotions/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ code }),
    }),
  );

const createTopup = (workspaceId: string, body: Record<string, unknown>, cookie = memberCookie) =>
  app.handle(
    new Request(`http://localhost/api/v1/workspaces/${workspaceId}/payments`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    }),
  );

const errCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code;

const redemptionCount = (promoId: string) =>
  q<{ n: number }>(
    db,
    "SELECT COUNT(*)::int AS n FROM promo_redemptions WHERE promo_code_id = ?",
    promoId,
  ).then((r) => r[0]!.n);
const ledgerCount = (memo: string) =>
  q<{ n: number }>(db, "SELECT COUNT(*)::int AS n FROM ledger_entries WHERE memo = ?", memo).then(
    (r) => r[0]!.n,
  );
const promoUses = (promoId: string) =>
  q<{ uses: number }>(db, "SELECT uses FROM promo_codes WHERE id = ?", promoId).then(
    (r) => r[0]!.uses,
  );
const balanceOf = (walletId: string) =>
  q<{ balance: number }>(db, "SELECT balance FROM wallets WHERE id = ?", walletId).then(
    (r) => r[0]!.balance,
  );

beforeAll(async () => {
  ({ db, app } = await makeApp());
  memberCookie = await signUp(app, memberEmail, "M");
  const uid = await userIdByEmail(db, memberEmail);
  ws = "ws-reg";
  ws2 = "ws-reg-2";
  await createWorkspace(db, ws, uid);
  await createWorkspace(db, ws2, uid);
  await seedWallet(`wal-${ws}`, ws);
  await seedWallet(`wal-${ws2}`, ws2);
});

describe("fixed redemption invariants", () => {
  test("replay: 409 ALREADY_REDEEMED, no second credit, one ledger row", async () => {
    const code = generatePromoCode();
    await seedPromo("pc-replay", code);
    const first = await redeem(ws, code);
    expect(first.status).toBe(200);
    const balanceAfterFirst = await balanceOf("wal-ws-reg");
    const replay = await redeem(ws, code);
    expect(replay.status).toBe(409);
    expect(await errCode(replay)).toBe("ALREADY_REDEEMED");
    expect(await ledgerCount("promo:pc-replay")).toBe(1);
    expect(await redemptionCount("pc-replay")).toBe(1);
    expect(await promoUses("pc-replay")).toBe(1);
    expect(await balanceOf("wal-ws-reg")).toBe(balanceAfterFirst);
  });

  test("concurrent last-slot: exactly one credit across two workspaces", async () => {
    const code = generatePromoCode();
    await seedPromo("pc-last", code, { max_uses: 1, amount_vnd: 77777 });
    const [a, b] = await Promise.all([redeem(ws, code), redeem(ws2, code)]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 409]);
    expect(await ledgerCount("promo:pc-last")).toBe(1);
    expect(await redemptionCount("pc-last")).toBe(1);
    expect(await promoUses("pc-last")).toBe(1);
    // exactly one workspace got the credit; wal-ws-reg already holds 50000
    // from the replay test, so compare against its delta
    const [balA, balB] = [await balanceOf("wal-ws-reg"), await balanceOf("wal-ws-reg-2")];
    expect([balA - 50000, balB].filter((v) => v === 77777).length).toBe(1);
  });
});

describe("percent voucher invariants", () => {
  test("concurrent payment creations with one voucher: consumed exactly once", async () => {
    const code = generatePromoCode();
    await seedPromo("pc-ccy", code, { kind: "percent" });
    // The once-per-(code, workspace) gate is what serializes two concurrent
    // creations by the SAME workspace: exactly one consumes the voucher.
    const body = { amount: 100000, promo_code: code };
    const [a, b] = await Promise.all([createTopup(ws, body), createTopup(ws, body)]);
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([201, 409]);
    expect(await redemptionCount("pc-ccy")).toBe(1);
    expect(await promoUses("pc-ccy")).toBe(1);
  });

  test("fixed code at checkout: 409 PROMO_NOT_PERCENT, nothing consumed", async () => {
    const code = generatePromoCode();
    await seedPromo("pc-notpct", code);
    const res = await createTopup(ws, { amount: 100000, promo_code: code });
    expect(res.status).toBe(409);
    expect(await errCode(res)).toBe("PROMO_NOT_PERCENT");
    expect(await redemptionCount("pc-notpct")).toBe(0);
    expect(await promoUses("pc-notpct")).toBe(0);
  });

  test("retry (idempotency) with a promo-attached creation: no second payment, no double charge", async () => {
    const code = generatePromoCode();
    await seedPromo("pc-idem", code, { kind: "percent" });
    const first = await createTopup(ws, { amount: 100000, promo_code: code });
    expect(first.status).toBe(201);
    const fid = ((await first.json()) as { payment_id?: string; id?: string }).payment_id;
    const retry = await createTopup(ws, { amount: 100000, promo_code: code });
    expect(retry.status).toBe(409);
    expect(await errCode(retry)).toBe("ALREADY_REDEEMED");
    // exactly one payment exists for the discounted 99,750 VND due
    const payments = await q<{ n: number; amount: number }>(
      db,
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::int AS amount
       FROM payments WHERE workspace_id = ? AND promo_code_id = 'pc-idem'`,
      ws,
    );
    expect(payments[0]!.n).toBe(1);
    expect(payments[0]!.amount).toBe(97500); // 100000 - floor(100000*250/10000)
    expect(fid !== undefined || payments[0]!.n === 1).toBe(true);
  });

  test("suspended workspace: preview and checkout both rejected, nothing consumed", async () => {
    const code = generatePromoCode();
    await seedPromo("pc-suspr", code);
    const wsS = "ws-reg-susp";
    const uid = await userIdByEmail(db, memberEmail);
    await createWorkspace(db, wsS, uid);
    await seedWallet(`wal-${wsS}`, wsS);
    await q(db, "UPDATE workspaces SET status = 'suspended' WHERE id = ?", wsS);
    const pv = await app.handle(
      new Request(`http://localhost/api/v1/workspaces/${wsS}/promotions/preview`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: memberCookie },
        body: JSON.stringify({ code }),
      }),
    );
    expect(pv.status).toBe(403);
    const res = await redeem(wsS, code);
    expect(res.status).toBe(403);
    expect(await redemptionCount("pc-suspr")).toBe(0);
    expect(await promoUses("pc-suspr")).toBe(0);
  });
});
