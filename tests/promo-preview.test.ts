// Unified promos Task 2 (server lane): preview route contract, redeem kind
// guard, admin custom codes. Real Postgres via makeApp. Preview is a
// READ-ONLY member+ route: no transaction, no row lock, no uses increment,
// no redemption row, no ledger write — byte-level side-effect-free even on
// error paths. Redeem rejects percent codes with 409 PROMO_WRONG_KIND
// (previously an unhandled 500 from the null-amount credit rollback).
import { describe, test, expect, beforeAll } from "bun:test";
import { createHash } from "node:crypto";
import { makeApp, q, signUp, createWorkspace, userIdByEmail } from "../apps/api/test/helpers";
import { computePercentDiscountVnd } from "../apps/api/src/payment-creation";
import { hashPromoCode, normalizePromoCode } from "../apps/api/src/promo-code";
import { generatePromoCode } from "../apps/api/src/routes/admin-promotions";
import type { Db } from "../packages/db/src/index";

let app: Awaited<ReturnType<typeof makeApp>>["app"];
let db: Db;
let memberCookie: string;
let outsiderCookie: string;
let ws: string;
const memberEmail = "preview-member@test.dev";

const seedPromo = async (
  id: string,
  code: string,
  over: {
    kind?: "fixed" | "percent";
    amount_vnd?: number;
    percent_bp?: number;
    max_discount_vnd?: number;
    max_uses?: number;
    active?: boolean;
    expires_at?: number | null;
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
  if (over.active === false) await q(db, "UPDATE promo_codes SET active = false WHERE id = ?", id);
  if (over.expires_at !== undefined)
    await q(db, "UPDATE promo_codes SET expires_at = ? WHERE id = ?", over.expires_at, id);
};

const seedWallet = async (id: string, workspaceId: string) => {
  await q(
    db,
    `INSERT INTO wallets (id, workspace_id, kind, currency, balance, reserved, version, created_at)
     VALUES (?,?,'topup','VND',0,0,0,?)`,
    id,
    workspaceId,
    Date.now(),
  );
};

const preview = (workspaceId: string, body: unknown, cookie?: string) =>
  app.handle(
    new Request(`http://localhost/api/v1/workspaces/${workspaceId}/promotions/preview`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }),
  );

const redeem = (workspaceId: string, code: string, cookie?: string) =>
  app.handle(
    new Request(`http://localhost/api/v1/workspaces/${workspaceId}/promotions/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ code }),
    }),
  );

const errCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code;

const sideEffectCounts = async () => ({
  redemptions: (await q(db, "SELECT COUNT(*)::int AS n FROM promo_redemptions"))[0]!.n,
  ledger: (await q(db, "SELECT COUNT(*)::int AS n FROM ledger_entries"))[0]!.n,
  promoUses: (await q(db, "SELECT uses FROM promo_codes WHERE id = 'pc-fix'"))[0]!.uses,
});

let FIXED: string;
let PCT: string;

beforeAll(async () => {
  ({ db, app } = await makeApp());
  memberCookie = await signUp(app, memberEmail, "M");
  outsiderCookie = await signUp(app, "preview-out@test.dev", "O");
  const userId = await userIdByEmail(db, memberEmail);
  ws = "ws-prev";
  await createWorkspace(db, ws, userId);
  await seedWallet(`wal-${ws}`, ws);
  FIXED = generatePromoCode();
  PCT = generatePromoCode();
  await seedPromo("pc-fix", FIXED);
  await seedPromo("pc-pct", PCT, { kind: "percent" });
});

describe("preview: fixed shape", () => {
  test("200 { kind, promo_id, name, amount_vnd } — legacy 32-hex input", async () => {
    const res = await preview(ws, { code: FIXED }, memberCookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      kind: "fixed",
      promo_id: "pc-fix",
      name: "Promo pc-fix",
      amount_vnd: 50000,
    });
  });
});

describe("preview: percent shape", () => {
  test("200 without amount: no money fields", async () => {
    const res = await preview(ws, { code: PCT }, memberCookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe("percent");
    expect(body.promo_id).toBe("pc-pct");
    expect(body.percent_bp).toBe(250);
    expect(body.max_discount_vnd).toBe(100000);
    expect("discount_vnd" in body).toBe(false);
    expect("final_due_vnd" in body).toBe(false);
  });

  test("200 with original_amount_vnd: server floor/cap math == computePercentDiscountVnd", async () => {
    // 2.5% of 1,000,000 = 25,000 raw, capped at 100,000 -> no cap hit
    const a = await preview(ws, { code: PCT, original_amount_vnd: 1_000_000 }, memberCookie);
    expect(a.status).toBe(200);
    const ba = (await a.json()) as { discount_vnd: number; final_due_vnd: number };
    expect(ba.discount_vnd).toBe(computePercentDiscountVnd(1_000_000, 250, 100_000).discountVnd);
    expect(ba.final_due_vnd).toBe(computePercentDiscountVnd(1_000_000, 250, 100_000).finalDueVnd);
    // floor: 12345 * 250 / 10000 = 308.625 -> 308 (integer VND, no float)
    expect(computePercentDiscountVnd(12345, 250, 100_000).discountVnd).toBe(308);
    const b = await preview(ws, { code: PCT, original_amount_vnd: 12345 }, memberCookie);
    const bb = (await b.json()) as { discount_vnd: number; final_due_vnd: number };
    expect(bb.discount_vnd).toBe(308);
    expect(bb.final_due_vnd).toBe(12037);
  });

  test("cap binds: capped discount", async () => {
    // seed a low-cap percent code and compare against the shared math
    const code = generatePromoCode();
    await seedPromo("pc-cap", code, { kind: "percent", percent_bp: 250, max_discount_vnd: 10000 });
    const res = await preview(ws, { code, original_amount_vnd: 1_000_000 }, memberCookie);
    const body = (await res.json()) as { discount_vnd: number; final_due_vnd: number };
    expect(body.discount_vnd).toBe(computePercentDiscountVnd(1_000_000, 250, 10000).discountVnd);
    expect(body.discount_vnd).toBe(10000);
    expect(body.final_due_vnd).toBe(990000);
  });
});

describe("preview: auth + errors", () => {
  test("401 unauthenticated", async () => {
    expect((await preview(ws, { code: FIXED })).status).toBe(401);
  });

  test("404 non-member (workspace masking)", async () => {
    expect((await preview(ws, { code: FIXED }, outsiderCookie)).status).toBe(404);
  });

  test("404 unknown code", async () => {
    expect((await preview(ws, { code: generatePromoCode() }, memberCookie)).status).toBe(404);
  });

  test("400 INVALID_CODE: empty or control characters", async () => {
    expect(await errCode(await preview(ws, { code: "" }, memberCookie))).toBe("INVALID_CODE");
    expect(await errCode(await preview(ws, { code: "ab\u200Bcd" }, memberCookie))).toBe(
      "INVALID_CODE",
    );
  });

  test("400 INVALID_AMOUNT: <= 0 or non-integer", async () => {
    for (const v of [0, -5, 1.5, Number.NaN]) {
      const res = await preview(ws, { code: PCT, original_amount_vnd: v }, memberCookie);
      expect(res.status).toBe(400);
      expect(await errCode(res)).toBe("INVALID_AMOUNT");
    }
  });

  test("409 PROMO_INACTIVE | PROMO_EXPIRED | PROMO_EXHAUSTED | ALREADY_REDEEMED", async () => {
    const c1 = generatePromoCode();
    await seedPromo("pc-in", c1, { active: false });
    expect(await errCode(await preview(ws, { code: c1 }, memberCookie))).toBe("PROMO_INACTIVE");

    const c2 = generatePromoCode();
    await seedPromo("pc-ex", c2, { expires_at: Date.now() - 1000 });
    expect(await errCode(await preview(ws, { code: c2 }, memberCookie))).toBe("PROMO_EXPIRED");

    const c3 = generatePromoCode();
    await seedPromo("pc-hx", c3, { max_uses: 5 });
    await q(db, "UPDATE promo_codes SET uses = 5 WHERE id = 'pc-hx'");
    expect(await errCode(await preview(ws, { code: c3 }, memberCookie))).toBe("PROMO_EXHAUSTED");

    const c4 = generatePromoCode();
    await seedPromo("pc-al", c4);
    expect((await redeem(ws, c4, memberCookie)).status).toBe(200);
    expect(await errCode(await preview(ws, { code: c4 }, memberCookie))).toBe("ALREADY_REDEEMED");
  });
});

describe("preview: side-effect-free", () => {
  test("no rows/uses/ledger changes on success AND on 404/409/400 paths", async () => {
    const before = await sideEffectCounts();
    await preview(ws, { code: FIXED }, memberCookie);
    await preview(ws, { code: FIXED, original_amount_vnd: 100000 }, memberCookie);
    await preview(ws, { code: generatePromoCode() }, memberCookie); // 404
    await preview(ws, { code: "" }, memberCookie); // 400
    const c = generatePromoCode();
    await seedPromo("pc-dead", c, { active: false });
    await preview(ws, { code: c }, memberCookie); // 409
    const after = await sideEffectCounts();
    expect(after).toEqual(before);
  });

  test("suspended workspace: rejected, no writes (member+ but inactive ws)", async () => {
    const code = generatePromoCode();
    await seedPromo("pc-susp", code);
    const wsS = "ws-prev-susp";
    const userId = await userIdByEmail(db, memberEmail);
    await createWorkspace(db, wsS, userId);
    await seedWallet(`wal-${wsS}`, wsS);
    await q(db, "UPDATE workspaces SET status = 'suspended' WHERE id = ?", wsS);
    const before = await sideEffectCounts();
    const res = await preview(wsS, { code }, memberCookie);
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("WORKSPACE_SUSPENDED");
    expect(await sideEffectCounts()).toEqual(before);
  });
});

describe("redeem kind guard", () => {
  test("percent code at redeem: 409 PROMO_WRONG_KIND, NO ledger/redemption/uses change, NOT 500", async () => {
    const before = await sideEffectCounts();
    const res = await redeem(ws, PCT, memberCookie);
    expect(res.status).toBe(409); // was an unhandled 500 before the guard
    expect(await errCode(res)).toBe("PROMO_WRONG_KIND");
    const after = await sideEffectCounts();
    expect(after.redemptions).toBe(before.redemptions);
    expect(after.ledger).toBe(before.ledger);
    expect(after.promoUses).toBe(before.promoUses);
  });

  test("fixed code still redeems after helper adoption (legacy hash unchanged)", async () => {
    const res = await redeem(ws, FIXED.toLowerCase(), memberCookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { credited_vnd: number; balance: number };
    expect(body.credited_vnd).toBe(50000);
  });
});

describe("admin create with optional custom code", () => {
  const adminEmail = "preview-admin@test.dev";
  const adminSignUp = async () => {
    const { makeInstanceAdmin } = await import("../apps/api/test/helpers");
    const cookie = await signUp(app, adminEmail, "A");
    const uid = await userIdByEmail(db, adminEmail);
    await makeInstanceAdmin(db, uid);
    return cookie;
  };
  let adminCookie: string;

  const createPromo = (body: unknown, cookie = adminCookie) =>
    app.handle(
      new Request("http://localhost/api/v1/admin/promotions", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(body),
      }),
    );

  test("admin setup", async () => {
    adminCookie = await adminSignUp();
    expect(adminCookie).toBeTruthy();
  });

  test("absent code -> generated 32-hex (legacy path unchanged), plaintext only in response", async () => {
    const res = await createPromo({
      name: "gen",
      kind: "fixed",
      amount_vnd: 1000,
      max_uses: 10,
      expires_at: null,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { code: string; promo: { id: string } };
    expect(body.code).toMatch(/^[A-F0-9]{32}$/);
    const row = (await q(db, "SELECT code_hash FROM promo_codes WHERE id = ?", body.promo.id))[0]!;
    expect(row.code_hash).toBe(createHash("sha256").update(body.code).digest("hex"));
  });

  test("custom mixed-case + outer-whitespace code: stored hash = sha256(normalized), redeem round-trip", async () => {
    const res = await createPromo({
      name: "custom",
      kind: "fixed",
      amount_vnd: 2000,
      code: `  SuPer-Deal 01  `,
      max_uses: 10,
      expires_at: null,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { code: string; promo: { id: string } };
    expect(body.code).toBe("SUPER-DEAL 01"); // normalized, revealed once
    const row = (await q(db, "SELECT code_hash FROM promo_codes WHERE id = ?", body.promo.id))[0]!;
    expect(row.code_hash).toBe(createHash("sha256").update("SUPER-DEAL 01").digest("hex"));
    // redeem via a case/whitespace variant resolves to the SAME promo
    const ws2 = "ws-prev-2";
    const uid = await userIdByEmail(db, memberEmail);
    await createWorkspace(db, ws2, uid);
    await seedWallet(`wal-${ws2}`, ws2);
    const red = await redeem(ws2, " super-deal 01 ", memberCookie);
    expect(red.status).toBe(200);
    expect(((await red.json()) as { promo_id: string }).promo_id).toBe(body.promo.id);
  });

  test("variant of an existing code -> 400 CODE_EXISTS", async () => {
    const res = await createPromo({
      name: "dup",
      kind: "fixed",
      amount_vnd: 1000,
      code: "super-DEAL 01",
      max_uses: 10,
      expires_at: null,
    });
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe("CODE_EXISTS");
  });

  test("invalid admin codes -> 400 INVALID_CODE (empty, controls, too long after uppercase)", async () => {
    for (const bad of ["", "   ", "ab\u200Bcd", "ß".repeat(33)]) {
      const res = await createPromo({
        name: "bad",
        kind: "fixed",
        amount_vnd: 1000,
        code: bad,
        max_uses: 10,
        expires_at: null,
      });
      expect(res.status).toBe(400);
      expect(await errCode(res)).toBe("INVALID_CODE");
    }
  });

  test("audit never carries plaintext or hash", async () => {
    const audits = await q<{ detail: unknown }>(
      db,
      "SELECT detail FROM audit_log WHERE action = 'promo.create' ORDER BY created_at DESC LIMIT 1",
    );
    expect(JSON.stringify(audits[0]!.detail)).not.toContain("SUPER-DEAL");
    expect(JSON.stringify(audits[0]!.detail)).not.toContain("code_hash");
  });
});

describe("helper adoption: one normalized spelling everywhere", () => {
  test("redeem accepts a custom admin code via canonical normalizePromoCode", () => {
    expect(normalizePromoCode(" super-deal 01 ")).toBe("SUPER-DEAL 01");
  });
});
