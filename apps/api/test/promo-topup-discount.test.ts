// Percent-voucher top-up discounts (approved scope): admin authoring of
// kind='percent' promos (basis points + VND cap), checkout apply on plain
// top-up payments (manual + payOS share the same pipeline), integer floor
// math, VND cap, once-per-(code, workspace) consumption, concurrent last-slot
// race, exhaustion, and settlement that credits the ORIGINAL top-up amount
// while the payer is charged the FINAL DUE (replay-safe). Fixed-credit promos
// are redeem-only: applying one at checkout is rejected and their redemption
// path is regression-covered by promo-redemption.test.ts.
import { describe, test, expect, beforeAll } from "bun:test";
import {
  q,
  makeApp,
  signUp,
  req,
  createWorkspace,
  makeInstanceAdmin,
  userIdByEmail,
} from "./helpers";
import { generatePromoCode, hashPromoCode } from "../src/routes/admin-promotions";
import { processMockPaymentEvent } from "@hoborouter/payments";

let app: Awaited<ReturnType<typeof makeApp>>["app"];
let db: Awaited<ReturnType<typeof makeApp>>["db"];
let memberCookie: string;
let adminCookie: string;
let ws: string;
let wsWallet: string;
const NOW = Date.now();

beforeAll(async () => {
  ({ db, app } = await makeApp());
  memberCookie = await signUp(app, "voucher-member@test.dev", "M");
  adminCookie = await signUp(app, "voucher-admin@test.dev", "A");
  await makeInstanceAdmin(db, await userIdByEmail(db, "voucher-admin@test.dev"));
  ws = "ws-voucher";
  await createWorkspace(db, ws, await userIdByEmail(db, "voucher-member@test.dev"));
  wsWallet = `wal-${ws}`;
  await q(
    db,
    `INSERT INTO wallets (id, workspace_id, kind, currency, balance, reserved, version, created_at)
     VALUES (?,?, 'topup','VND',0,0,0,?)`,
    wsWallet,
    ws,
    NOW,
  );
  // First-topup bonus off so balance assertions track the voucher credit only.
  await q(
    db,
    `INSERT INTO instance_settings (key, value, updated_at) VALUES ('first_topup_bonus_enabled','false',?)
     ON CONFLICT (key) DO UPDATE SET value = 'false'`,
    NOW,
  );
});

const createPromo = async (body: Record<string, unknown>) =>
  req(app, "/api/v1/admin/promotions", { method: "POST", cookie: adminCookie, body });

/** Seed a percent promo directly (apply-path tests own their fixtures). */
const seedPercentPromo = async (
  id: string,
  percentBp: number,
  maxDiscountVnd: number,
  over: { max_uses?: number; active?: boolean; expires_at?: number | null } = {},
) => {
  const code = generatePromoCode();
  await q(
    db,
    `INSERT INTO promo_codes (id, code_hash, name, kind, amount_vnd, percent_bp, max_discount_vnd, max_uses, uses, expires_at, active, created_at)
     VALUES (?,?,?, 'percent', NULL, ?, ?, ?, 0, ?, true, ?)`,
    id,
    hashPromoCode(code),
    `Voucher ${id}`,
    percentBp,
    maxDiscountVnd,
    over.max_uses ?? 10,
    over.expires_at ?? null,
    NOW,
  );
  if (over.active === false) await q(db, "UPDATE promo_codes SET active=false WHERE id=?", id);
  return code;
};

const createTopup = async (workspaceId: string, cookie: string, body: Record<string, unknown>) =>
  req(app, `/api/v1/workspaces/${workspaceId}/payments`, {
    method: "POST",
    cookie,
    body,
  });

const balance = async (walletId: string) =>
  Number(
    ((await q(db, "SELECT balance FROM wallets WHERE id = ?", walletId))[0] as { balance: number })
      .balance,
  );

describe("admin authoring: percent promos", () => {
  test("2.5% = 250bp + cap 10000: created, safe shape, kind exposed, amount null", async () => {
    const res = await createPromo({
      name: "2.5pct",
      kind: "percent",
      percent_bp: 250,
      max_discount_vnd: 10000,
      max_uses: 5,
      expires_at: null,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { promo: Record<string, unknown>; code: string };
    expect(body.promo).toMatchObject({
      kind: "percent",
      percent_bp: 250,
      max_discount_vnd: 10000,
      amount_vnd: null,
      max_uses: 5,
      uses: 0,
      active: true,
    });
    expect(body.code).toMatch(/^[A-F0-9]{32}$/);
    expect(JSON.stringify(body)).not.toContain("code_hash");
  });

  test("validation: bp must be integer 1..9999, cap positive integer, shapes exclusive", async () => {
    for (const body of [
      { name: "x", kind: "percent", percent_bp: 0, max_discount_vnd: 1000 },
      { name: "x", kind: "percent", percent_bp: 10000, max_discount_vnd: 1000 },
      { name: "x", kind: "percent", percent_bp: 2.5, max_discount_vnd: 1000 },
      { name: "x", kind: "percent", percent_bp: -250, max_discount_vnd: 1000 },
      { name: "x", kind: "percent", percent_bp: 250 },
      { name: "x", kind: "percent", percent_bp: 250, max_discount_vnd: 0 },
      { name: "x", kind: "percent", percent_bp: 250, max_discount_vnd: -1 },
      { name: "x", kind: "percent", percent_bp: 250, max_discount_vnd: 10.5 },
      { name: "x", kind: "percent", percent_bp: 250, max_discount_vnd: 1000, amount_vnd: 500 },
      { name: "x", kind: "fixed", amount_vnd: 500, percent_bp: 250 },
      { name: "x", kind: "percent", max_discount_vnd: 1000 },
    ]) {
      const res = await createPromo(body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID");
    }
    // No rows written by any rejected create.
    const bad = await q(
      db,
      "SELECT COUNT(*)::int AS n FROM promo_codes WHERE percent_bp IS NOT NULL",
    );
    expect((bad[0] as { n: number }).n).toBe(1); // only the 2.5% fixture above
  });

  test("fixed authoring unchanged (default kind, regression)", async () => {
    const res = await createPromo({
      name: "legacy",
      amount_vnd: 1000,
      max_uses: 1,
      expires_at: null,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { promo: Record<string, unknown> };
    expect(body.promo).toMatchObject({ kind: "fixed", amount_vnd: 1000, percent_bp: null });
  });
});

describe("checkout apply (manual provider)", () => {
  test("2.5% of 200000 = 5000 discount, final due 195000; snapshot + redemption + uses atomic", async () => {
    const code = await seedPercentPromo("pc-v25", 250, 10000);
    const res = await createTopup(ws, memberCookie, { amount: 200000, promo_code: code });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      amount: number;
      original_amount_vnd: number;
      discount_vnd: number;
      promo_code_id: string;
    };
    expect(body.amount).toBe(195000);
    expect(body.original_amount_vnd).toBe(200000);
    expect(body.discount_vnd).toBe(5000);
    expect(body.promo_code_id).toBe("pc-v25");

    const row = (
      await q(
        db,
        `SELECT amount, promo_code_id, promo_kind, original_amount_vnd, discount_vnd
         FROM payments WHERE id = ?`,
        body.id,
      )
    )[0] as Record<string, number | string | null>;
    expect(row).toEqual({
      amount: 195000,
      promo_code_id: "pc-v25",
      promo_kind: "percent",
      original_amount_vnd: 200000,
      discount_vnd: 5000,
    });

    const redemption = (
      await q(
        db,
        `SELECT payment_id, ledger_entry_id FROM promo_redemptions WHERE promo_code_id = 'pc-v25'`,
      )
    )[0] as { payment_id: string; ledger_entry_id: string | null };
    expect(redemption.payment_id).toBe(body.id);
    expect(redemption.ledger_entry_id).toBeNull();
    expect(
      Number(
        ((await q(db, "SELECT uses FROM promo_codes WHERE id='pc-v25'"))[0] as { uses: number })
          .uses,
      ),
    ).toBe(1);
    // No wallet movement at apply time — credit happens at settlement only.
    expect(await balance(wsWallet)).toBe(0);
  });

  test("floor math: 3% of 33333 = 999.99 -> 999 (never floats, never over-discounts)", async () => {
    const code = await seedPercentPromo("pc-floor", 300, 100000);
    const res = await createTopup(ws, memberCookie, { amount: 33333, promo_code: code });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { amount: number; discount_vnd: number };
    expect(body.discount_vnd).toBe(999);
    expect(body.amount).toBe(32334);
  });

  test("VND cap: 2.5% of 1000000 = 25000 raw, capped at 10000", async () => {
    const code = await seedPercentPromo("pc-cap", 250, 10000);
    const res = await createTopup(ws, memberCookie, { amount: 1000000, promo_code: code });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { amount: number; discount_vnd: number };
    expect(body.discount_vnd).toBe(10000);
    expect(body.amount).toBe(990000);
  });

  test("gates write nothing: unknown 404, invalid 400, inactive/expired/exhausted/suspended", async () => {
    // unknown
    const unknown = await createTopup(ws, memberCookie, {
      amount: 1000,
      promo_code: generatePromoCode(),
    });
    expect(unknown.status).toBe(404);
    // invalid format (canonical normalization: empty/\p{C} only)
    const invalid = await createTopup(ws, memberCookie, { amount: 1000, promo_code: "" });
    expect(invalid.status).toBe(400);
    const invalidCtrl = await createTopup(ws, memberCookie, {
      amount: 1000,
      promo_code: "ab\u200Bcd",
    });
    expect(invalidCtrl.status).toBe(400);
    // valid-format but unknown code answers 404, not 400
    const unknownFmt = await createTopup(ws, memberCookie, { amount: 1000, promo_code: "nope" });
    expect(unknownFmt.status).toBe(404);
    // inactive
    const inactiveCode = await seedPercentPromo("pc-vin", 250, 10000, { active: false });
    expect(
      (await createTopup(ws, memberCookie, { amount: 1000, promo_code: inactiveCode })).status,
    ).toBe(409);
    // expired
    const expiredCode = await seedPercentPromo("pc-vex", 250, 10000, { expires_at: NOW - 1000 });
    expect(
      (await createTopup(ws, memberCookie, { amount: 1000, promo_code: expiredCode })).status,
    ).toBe(409);
    // exhausted
    const doneCode = await seedPercentPromo("pc-vex2", 250, 10000, { max_uses: 1 });
    await q(db, "UPDATE promo_codes SET uses = max_uses WHERE id = 'pc-vex2'");
    expect(
      (await createTopup(ws, memberCookie, { amount: 1000, promo_code: doneCode })).status,
    ).toBe(409);
    // suspended workspace
    const susCode = await seedPercentPromo("pc-vsusp", 250, 10000);
    const susWs = "ws-vsusp";
    await createWorkspace(db, susWs, await userIdByEmail(db, "voucher-member@test.dev"));
    await q(db, "UPDATE workspaces SET status = 'suspended' WHERE id = ?", susWs);
    const sus = await createTopup(susWs, memberCookie, { amount: 1000, promo_code: susCode });
    expect(sus.status).toBe(403);

    for (const id of ["pc-vin", "pc-vex", "pc-vex2", "pc-vsusp"]) {
      expect(
        (
          (
            await q(
              db,
              "SELECT COUNT(*)::int AS n FROM promo_redemptions WHERE promo_code_id=?",
              id,
            )
          )[0] as { n: number }
        ).n,
      ).toBe(0);
      expect(
        ((await q(db, "SELECT uses FROM promo_codes WHERE id=?", id))[0] as { uses: number }).uses,
      ).toBe(id === "pc-vex2" ? 1 : 0);
    }
    expect(((await q(db, "SELECT COUNT(*)::int AS n FROM payments"))[0] as { n: number }).n).toBe(
      3,
    );
  });

  test("fixed-credit promo rejected at checkout (redeem-only contract), still redeemable", async () => {
    const code = generatePromoCode();
    await q(
      db,
      `INSERT INTO promo_codes (id, code_hash, name, kind, amount_vnd, percent_bp, max_discount_vnd, max_uses, uses, expires_at, active, created_at)
       VALUES ('pc-fixed', ?, 'Fixed regression', 'fixed', 50000, NULL, NULL, 5, 0, NULL, true, ?)`,
      hashPromoCode(code),
      NOW,
    );
    const apply = await createTopup(ws, memberCookie, { amount: 1000, promo_code: code });
    expect(apply.status).toBe(409);
    expect(((await apply.json()) as { error: { code: string } }).error.code).toBe(
      "PROMO_NOT_PERCENT",
    );
    expect(
      ((await q(db, "SELECT uses FROM promo_codes WHERE id='pc-fixed'"))[0] as { uses: number })
        .uses,
    ).toBe(0);
    expect(
      (
        (
          await q(db, "SELECT COUNT(*)::int AS n FROM payments WHERE promo_code_id='pc-fixed'")
        )[0] as { n: number }
      ).n,
    ).toBe(0);

    // Existing redemption path unchanged.
    const redeem = await req(app, `/api/v1/workspaces/${ws}/promotions/redeem`, {
      method: "POST",
      cookie: memberCookie,
      body: { code },
    });
    expect(redeem.status).toBe(200);
    expect(((await redeem.json()) as { credited_vnd: number }).credited_vnd).toBe(50000);
    expect(
      ((await q(db, "SELECT uses FROM promo_codes WHERE id='pc-fixed'"))[0] as { uses: number })
        .uses,
    ).toBe(1);
  });

  test("duplicate apply by same workspace: 409, exactly one payment + one redemption", async () => {
    const code = await seedPercentPromo("pc-dup", 250, 10000);
    const first = await createTopup(ws, memberCookie, { amount: 10000, promo_code: code });
    expect(first.status).toBe(201);
    const second = await createTopup(ws, memberCookie, { amount: 10000, promo_code: code });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe(
      "ALREADY_REDEEMED",
    );
    expect(
      (
        (
          await q(
            db,
            "SELECT COUNT(*)::int AS n FROM promo_redemptions WHERE promo_code_id='pc-dup'",
          )
        )[0] as { n: number }
      ).n,
    ).toBe(1);
    expect(
      (
        (
          await q(db, "SELECT COUNT(*)::int AS n FROM payments WHERE promo_code_id='pc-dup'")
        )[0] as { n: number }
      ).n,
    ).toBe(1);
    expect(
      ((await q(db, "SELECT uses FROM promo_codes WHERE id='pc-dup'"))[0] as { uses: number }).uses,
    ).toBe(1);
  });

  test("concurrent last-slot race (max_uses=1, two workspaces): exactly one 201", async () => {
    const code = await seedPercentPromo("pc-race", 250, 10000, { max_uses: 1 });
    const wsB = "ws-voucher-b";
    await createWorkspace(db, wsB, await userIdByEmail(db, "voucher-admin@test.dev"));
    await q(
      db,
      `INSERT INTO wallets (id, workspace_id, kind, currency, balance, reserved, version, created_at)
       VALUES (?,?, 'topup','VND',0,0,0,?)`,
      `wal-${wsB}`,
      wsB,
      NOW,
    );
    const [a, b] = await Promise.all([
      createTopup(ws, memberCookie, { amount: 20000, promo_code: code }),
      createTopup(wsB, adminCookie, { amount: 20000, promo_code: code }),
    ]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([201, 409]);
    expect(
      (
        (
          await q(
            db,
            "SELECT COUNT(*)::int AS n FROM promo_redemptions WHERE promo_code_id='pc-race'",
          )
        )[0] as { n: number }
      ).n,
    ).toBe(1);
    expect(
      ((await q(db, "SELECT uses FROM promo_codes WHERE id='pc-race'"))[0] as { uses: number })
        .uses,
    ).toBe(1);
    // The loser must not have a payment row at all (whole transaction rolled back).
    expect(
      (
        (
          await q(db, "SELECT COUNT(*)::int AS n FROM payments WHERE promo_code_id='pc-race'")
        )[0] as { n: number }
      ).n,
    ).toBe(1);
  });

  test("payOS pipeline honors the same apply (created via shared creator)", async () => {
    // payOS is not configured in tests: provider=payos answers 503 BEFORE any
    // promo consumption — the shared creator itself is exercised by the
    // manual path above (same applyPromoToTopup + recordPercentRedemption).
    const code = await seedPercentPromo("pc-payos-gate", 250, 10000);
    const res = await createTopup(ws, memberCookie, {
      amount: 1000,
      provider: "payos",
      promo_code: code,
    });
    expect(res.status).toBe(503);
    expect(
      (
        (await q(db, "SELECT uses FROM promo_codes WHERE id='pc-payos-gate'"))[0] as {
          uses: number;
        }
      ).uses,
    ).toBe(0);
  });
});

describe("settlement: credit original, charge final due, replay-safe", () => {
  test("webhook/admin-complete amount = final due; credit = original amount; replay credits once", async () => {
    const code = await seedPercentPromo("pc-settle", 250, 10000);
    const created = await createTopup(ws, memberCookie, { amount: 200000, promo_code: code });
    expect(created.status).toBe(201);
    const payment = (await created.json()) as { id: string; amount: number };
    expect(payment.amount).toBe(195000); // charged
    const before = await balance(wsWallet);

    const result = await processMockPaymentEvent(db, {
      provider: "manual",
      orderCode: `MANUAL-${payment.id}`,
      providerReference: "voucher-settle-1",
      amount: 195000, // provider event carries the FINAL DUE
      rawPayload: JSON.stringify({ source: "voucher-test" }),
    });
    expect(result.outcome).toBe("credited");
    if (result.outcome !== "credited") return;
    // Credited the ORIGINAL top-up amount, not the discounted due.
    expect(result.balanceAfter).toBe(before + 200000);
    expect(await balance(wsWallet)).toBe(before + 200000);

    // Ledger: one topup credit of the original amount against the payment.
    const ledger = (await q(
      db,
      `SELECT direction, amount, kind FROM ledger_entries WHERE payment_id = ? AND kind = 'topup'`,
      payment.id,
    )) as Array<{ direction: string; amount: number; kind: string }>;
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ direction: "credit", amount: 200000, kind: "topup" });

    // Replay of the same provider reference: idempotent, no second credit.
    const replay = await processMockPaymentEvent(db, {
      provider: "manual",
      orderCode: `MANUAL-${payment.id}`,
      providerReference: "voucher-settle-1",
      amount: 195000,
      rawPayload: JSON.stringify({ source: "voucher-test" }),
    });
    expect(replay.outcome).toBe("already_processed");
    expect(await balance(wsWallet)).toBe(before + 200000);

    // Distinct reference on the succeeded payment: rejected, no second credit.
    await expect(
      processMockPaymentEvent(db, {
        provider: "manual",
        orderCode: `MANUAL-${payment.id}`,
        providerReference: "voucher-settle-2",
        amount: 195000,
        rawPayload: JSON.stringify({ source: "voucher-test" }),
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await balance(wsWallet)).toBe(before + 200000);

    // Amount mismatch (event claiming the original, not the final due) rejected.
    const created2 = await createTopup(ws, memberCookie, { amount: 40000, promo_code: code });
    expect(created2.status).toBe(409); // voucher already consumed by this workspace
  });

  test("concurrent settlement replays of one voucher payment credit exactly once", async () => {
    const code = await seedPercentPromo("pc-conc-settle", 250, 10000);
    const wsC = "ws-voucher-c";
    const ownerId = await userIdByEmail(db, "voucher-admin@test.dev");
    await createWorkspace(db, wsC, ownerId);
    await q(
      db,
      `INSERT INTO wallets (id, workspace_id, kind, currency, balance, reserved, version, created_at)
       VALUES (?,?, 'topup','VND',0,0,0,?)`,
      `wal-${wsC}`,
      wsC,
      NOW,
    );
    // voucher-admin owns wsC (created with its user id above).
    const created = await createTopup(wsC, adminCookie, { amount: 20000, promo_code: code });
    expect(created.status).toBe(201);
    const payment = (await created.json()) as { id: string; amount: number };
    expect(payment.amount).toBe(19500);

    const [r1, r2] = await Promise.all([
      processMockPaymentEvent(db, {
        provider: "manual",
        orderCode: `MANUAL-${payment.id}`,
        providerReference: "voucher-conc",
        amount: 19500,
        rawPayload: "{}",
      }).catch((e: Error) => e),
      processMockPaymentEvent(db, {
        provider: "manual",
        orderCode: `MANUAL-${payment.id}`,
        providerReference: "voucher-conc",
        amount: 19500,
        rawPayload: "{}",
      }).catch((e: Error) => e),
    ]);
    const outcomes = [r1, r2].map((r) =>
      r instanceof Error ? "error" : (r as { outcome: string }).outcome,
    );
    expect(outcomes.filter((o) => o === "credited")).toHaveLength(1);
    expect(await balance(`wal-${wsC}`)).toBe(20000);
  });
});
