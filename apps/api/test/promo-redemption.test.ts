// Promo redemption route behavior: contract-code validation (trim/upper,
// /^[A-F0-9]{32}$/, SHA-256 matching admin-promotions.ts), member+workspace
// gates, one-time-per-workspace grant with the ledger row (kind=adjustment,
// payment_id null, memo promo:<promoId>), uses increment and promo.redeem
// audit all in one transaction; 409 replays and races never double-credit;
// expired/inactive/auth failures write nothing. Real Postgres via makeApp.
import { describe, test, expect, beforeAll } from "bun:test";
import { createHash } from "node:crypto";
import { q, makeApp, signUp, createWorkspace, userIdByEmail } from "./helpers";
import { generatePromoCode, hashPromoCode } from "../src/routes/admin-promotions";
import { normalizePromoCode, promotionsRoutes } from "../src/routes/promotions";
import { workspacesRoutes } from "../src/routes/workspaces";

let app: Awaited<ReturnType<typeof makeApp>>["app"];
// Standalone plugin instance: app.ts mounting is owned by another slice; the
// route contract under test is promotionsRoutes(db, auth) itself.
let promoApp: ReturnType<typeof promotionsRoutes>;
let wsApp: ReturnType<typeof workspacesRoutes>;
let db: Awaited<ReturnType<typeof makeApp>>["db"];
let auth: Awaited<ReturnType<typeof makeApp>>["auth"];
let memberCookie: string;
let outsiderCookie: string;
let ws: string;
let wsWallet: string;
let otherWs: string;

const CODE = generatePromoCode();

const seedPromo = async (
  id: string,
  code: string,
  over: {
    amount_vnd?: number;
    max_uses?: number;
    active?: boolean;
    expires_at?: number | null;
  } = {},
) => {
  await q(
    db,
    `INSERT INTO promo_codes (id, code_hash, name, amount_vnd, max_uses, uses, expires_at, active, created_at)
     VALUES (?,?,?,?,?,0,NULL,true,?)`,
    id,
    hashPromoCode(code),
    `Promo ${id}`,
    over.amount_vnd ?? 50000,
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

const redeem = (workspaceId: string, code: string, cookie?: string) =>
  promoApp.handle(
    new Request(`http://localhost/api/v1/workspaces/${workspaceId}/promotions/redeem`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ code }),
    }),
  );

const ledgerCount = async (memo: string) =>
  (await q(db, "SELECT COUNT(*)::int AS n FROM ledger_entries WHERE memo = ?", memo))[0]!.n;

beforeAll(async () => {
  ({ db, app, auth } = await makeApp());
  promoApp = promotionsRoutes(db, auth);
  wsApp = workspacesRoutes(db, auth);
  memberCookie = await signUp(app, "promo-member@test.dev", "M");
  outsiderCookie = await signUp(app, "promo-out@test.dev", "O");
  const userId = await userIdByEmail(db, "promo-member@test.dev");
  ws = "ws-promo";
  await createWorkspace(db, ws, userId);
  wsWallet = `wal-${ws}`;
  await seedWallet(wsWallet, ws);
  otherWs = "ws-promo-2";
  await createWorkspace(db, otherWs, userId);
  await seedWallet(`wal-${otherWs}`, otherWs);
  await seedPromo("pc-main", CODE);
});

describe("code contract", () => {
  test("generatePromoCode: CSPRNG uppercase hex, 32 chars, unguessable in practice", () => {
    for (let i = 0; i < 20; i++) expect(generatePromoCode()).toMatch(/^[A-F0-9]{32}$/);
    expect(new Set(Array.from({ length: 50 }, generatePromoCode)).size).toBe(50);
  });

  test("normalizePromoCode trims+uppercases then enforces /^[A-F0-9]{32}$/", () => {
    expect(normalizePromoCode(`  ${CODE.toLowerCase()}  `)).toBe(CODE);
    expect(normalizePromoCode("abc")).toBeNull();
    expect(normalizePromoCode("G" + CODE.slice(1))).toBeNull();
    expect(normalizePromoCode(CODE + "A")).toBeNull();
    expect(normalizePromoCode("")).toBeNull();
  });

  test("hashPromoCode is plain SHA-256 hex of the normalized code", () => {
    expect(hashPromoCode(`  ${CODE.toLowerCase()} `)).toBe(
      createHash("sha256").update(CODE).digest("hex"),
    );
  });
});

describe("gates (no writes)", () => {
  test("unauthenticated 401", async () => {
    const res = await redeem(ws, CODE);
    expect(res.status).toBe(401);
  });

  test("non-member 404 (workspace masking)", async () => {
    const res = await redeem(ws, CODE, outsiderCookie);
    expect(res.status).toBe(404);
  });

  test("invalid format 400; unknown code 404 — no writes either way", async () => {
    for (const bad of ["nope", "", "Z".repeat(32), `${CODE.toLowerCase()}x`]) {
      const res = await redeem(ws, bad, memberCookie);
      expect(res.status).toBe(400);
    }
    const unknown = await redeem(ws, generatePromoCode(), memberCookie);
    expect(unknown.status).toBe(404);
    expect(await ledgerCount("promo:pc-main")).toBe(0);
    expect((await q(db, "SELECT uses FROM promo_codes WHERE id = 'pc-main'"))[0]!.uses).toBe(0);
  });
});

describe("suspended workspace (no credit)", () => {
  test("member of suspended workspace: 403, zero ledger/redemption/uses/audit/balance writes", async () => {
    const code = generatePromoCode();
    await seedPromo("pc-susp", code);
    const wsS = "ws-susp";
    const userId = await userIdByEmail(db, "promo-member@test.dev");
    await createWorkspace(db, wsS, userId);
    await seedWallet(`wal-${wsS}`, wsS);
    await q(db, "UPDATE workspaces SET status = 'suspended' WHERE id = ?", wsS);

    // wsRole alone would authorize this member; the route must additionally
    // require an ACTIVE workspace before any credit.
    const res = await redeem(wsS, code, memberCookie);
    expect(res.status).toBe(403);

    expect(await ledgerCount("promo:pc-susp")).toBe(0);
    expect((await q(db, "SELECT uses FROM promo_codes WHERE id = 'pc-susp'"))[0]!.uses).toBe(0);
    expect(
      (
        await q(
          db,
          "SELECT COUNT(*)::int AS n FROM promo_redemptions WHERE promo_code_id = 'pc-susp'",
        )
      )[0]!.n,
    ).toBe(0);
    expect(
      (
        await q(
          db,
          "SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'promo.redeem' AND workspace_id = ?",
          wsS,
        )
      )[0]!.n,
    ).toBe(0);
    expect(
      (await q(db, "SELECT balance FROM wallets WHERE id = ?", `wal-${wsS}`))[0]!.balance,
    ).toBe(0);
  });
});

describe("successful redemption", () => {
  test("credits topup wallet; ledger+redemption+uses+audit in one transaction", async () => {
    const res = await redeem(ws, ` ${CODE.toLowerCase()} `, memberCookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ balance: 50000, credited_vnd: 50000, promo_id: "pc-main" });

    const ledger = await q(
      db,
      "SELECT wallet_id, direction, amount, kind, payment_id, memo FROM ledger_entries WHERE memo = ?",
      "promo:pc-main",
    );
    expect(ledger.length).toBe(1);
    expect(ledger[0]).toMatchObject({
      wallet_id: wsWallet,
      direction: "credit",
      amount: 50000,
      kind: "adjustment",
      payment_id: null,
      memo: "promo:pc-main",
    });

    const redemption = await q(
      db,
      "SELECT (r.ledger_entry_id = l.id) AS fk_ok, r.workspace_id FROM promo_redemptions r JOIN ledger_entries l ON l.id = r.ledger_entry_id WHERE r.promo_code_id = 'pc-main'",
    );
    expect(redemption.length).toBe(1);
    expect(redemption[0]).toMatchObject({ fk_ok: true, workspace_id: ws });

    expect((await q(db, "SELECT uses FROM promo_codes WHERE id = 'pc-main'"))[0]!.uses).toBe(1);
    const rawDetail = (
      await q(
        db,
        "SELECT detail FROM audit_log WHERE action = 'promo.redeem' AND workspace_id = ?",
        ws,
      )
    )[0]!.detail;
    // jsonb may arrive as a JSON string depending on the driver.
    const detail =
      typeof rawDetail === "string"
        ? (JSON.parse(rawDetail) as Record<string, unknown>)
        : rawDetail;
    expect(detail).toMatchObject({ promo_id: "pc-main", credited_vnd: 50000 });
  });

  test("replay same workspace: 409, exactly one ledger entry, no second credit", async () => {
    const before = (await q(db, "SELECT balance FROM wallets WHERE id = ?", wsWallet))[0]!.balance;
    const res = await redeem(ws, CODE, memberCookie);
    expect(res.status).toBe(409);
    expect(await ledgerCount("promo:pc-main")).toBe(1);
    expect((await q(db, "SELECT balance FROM wallets WHERE id = ?", wsWallet))[0]!.balance).toBe(
      before,
    );
  });

  test("same code, different workspace: allowed", async () => {
    const res = await redeem(otherWs, CODE, memberCookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).balance).toBe(50000);
    expect(await ledgerCount("promo:pc-main")).toBe(2);
  });
});

describe("unredeemable promos (no writes)", () => {
  const assertNoWrites = async (promoId: string, expectedUses = 0) => {
    expect(await ledgerCount(`promo:${promoId}`)).toBe(0);
    expect((await q(db, "SELECT uses FROM promo_codes WHERE id = ?", promoId))[0]!.uses).toBe(
      expectedUses,
    );
    expect(
      (
        await q(
          db,
          "SELECT COUNT(*)::int AS n FROM promo_redemptions WHERE promo_code_id = ?",
          promoId,
        )
      )[0]!.n,
    ).toBe(0);
  };

  test("inactive 409", async () => {
    const code = generatePromoCode();
    await seedPromo("pc-inactive", code, { active: false });
    const res = await redeem(ws, code, memberCookie);
    expect(res.status).toBe(409);
    await assertNoWrites("pc-inactive");
  });

  test("expired 409", async () => {
    const code = generatePromoCode();
    await seedPromo("pc-expired", code, { expires_at: Date.now() - 1000 });
    const res = await redeem(ws, code, memberCookie);
    expect(res.status).toBe(409);
    await assertNoWrites("pc-expired");
  });

  test("exhausted 409", async () => {
    const code = generatePromoCode();
    await seedPromo("pc-done", code, { max_uses: 1 });
    await q(db, "UPDATE promo_codes SET uses = max_uses WHERE id = 'pc-done'");
    const res = await redeem(ws, code, memberCookie);
    expect(res.status).toBe(409);
    await assertNoWrites("pc-done", 1);
  });
});

describe("concurrency", () => {
  test("two workspaces racing for the last slot: exactly one grant", async () => {
    const code = generatePromoCode();
    await seedPromo("pc-slot", code, { max_uses: 1 });
    const wsA = "ws-race-a";
    const wsB = "ws-race-b";
    const userId = await userIdByEmail(db, "promo-member@test.dev");
    await createWorkspace(db, wsA, userId);
    await createWorkspace(db, wsB, userId);
    await seedWallet(`wal-${wsA}`, wsA);
    await seedWallet(`wal-${wsB}`, wsB);

    const [a, b] = await Promise.all([
      redeem(wsA, code, memberCookie),
      redeem(wsB, code, memberCookie),
    ]);
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);

    const winner = a.status === 200 ? wsA : wsB;
    expect(await ledgerCount("promo:pc-slot")).toBe(1);
    expect(
      (
        await q(
          db,
          "SELECT COUNT(*)::int AS n FROM promo_redemptions WHERE promo_code_id = 'pc-slot'",
        )
      )[0]!.n,
    ).toBe(1);
    expect((await q(db, "SELECT uses FROM promo_codes WHERE id = 'pc-slot'"))[0]!.uses).toBe(1);
    expect(
      (await q(db, "SELECT balance FROM wallets WHERE id = ?", `wal-${winner}`))[0]!.balance,
    ).toBe(50000);
  });

  test("duplicate same workspace in parallel: exactly one ledger entry and grant", async () => {
    const code = generatePromoCode();
    await seedPromo("pc-dup", code);
    const [a, b] = await Promise.all([
      redeem(ws, code, memberCookie),
      redeem(ws, code, memberCookie),
    ]);
    expect([a.status, b.status].filter((s) => s === 200).length).toBe(1);
    expect(await ledgerCount("promo:pc-dup")).toBe(1);
    expect(
      (
        await q(
          db,
          "SELECT COUNT(*)::int AS n FROM promo_redemptions WHERE promo_code_id = 'pc-dup'",
        )
      )[0]!.n,
    ).toBe(1);
    // ws balance: 50000 (main) + 50000 (other-ws check was separate wallet... no — otherWs) + 50000 once here
    expect((await q(db, "SELECT balance FROM wallets WHERE id = ?", wsWallet))[0]!.balance).toBe(
      100000,
    );
  });

  // Deadlock regression: promo redeem locks workspace → promo → wallet.
  // Workspace delete must acquire the workspace row lock BEFORE its
  // wallet/audit/member writes, or concurrent redeem+delete can cycle
  // (redeem holds ws, wants wallet; delete holds wallet, wants ws) and
  // Postgres aborts one transaction — surfacing as a 500.
  //
  // Coverage limitation: the exact interleaving cannot be forced
  // deterministically from a black-box test (no prod hooks, no source
  // assertions), so this bounds the race to repeated concurrent pairs and
  // asserts the invariants that must hold for EVERY interleaving outcome:
  //   - neither request ever 5xx / deadlock-aborts
  //   - at most one credit, exactly consistent with the surviving rows:
  //     workspace survives  ⇔ one ledger entry + one redemption + uses=1
  //     + funded wallet + delete 409
  //     workspace deleted   ⇔ zero ledger entries + redeem masked 404
  //     + delete 200
  describe("workspace delete lock order (deadlock regression)", () => {
    const del = (workspaceId: string, cookie: string) =>
      wsApp.handle(
        new Request(`http://localhost/api/v1/workspaces/${workspaceId}`, {
          method: "DELETE",
          headers: { cookie },
        }),
      );

    test("concurrent redeem + owner delete: no 5xx/deadlock, at most one credit, history consistent with surviving rows", async () => {
      const userId = await userIdByEmail(db, "promo-member@test.dev");
      for (let i = 0; i < 6; i++) {
        const code = generatePromoCode();
        const promoId = `pc-lock-${i}`;
        await seedPromo(promoId, code);
        const wsD = `ws-lock-${i}`;
        await createWorkspace(db, wsD, userId);
        await seedWallet(`wal-${wsD}`, wsD);

        const [red, res] = await Promise.all([
          redeem(wsD, code, memberCookie),
          del(wsD, memberCookie),
        ]);
        expect(red.status).toBeLessThan(500);
        expect(res.status).toBeLessThan(500);

        const wsGone = (await q(db, "SELECT id FROM workspaces WHERE id = ?", wsD)).length === 0;
        const ledger = await ledgerCount(`promo:${promoId}`);
        const redemptions = (
          await q(
            db,
            "SELECT COUNT(*)::int AS n FROM promo_redemptions WHERE promo_code_id = ?",
            promoId,
          )
        )[0]!.n;
        const uses = (await q(db, "SELECT uses FROM promo_codes WHERE id = ?", promoId))[0]!.uses;
        const balanceRows = await q(db, "SELECT balance FROM wallets WHERE id = ?", `wal-${wsD}`);

        if (wsGone) {
          // Delete won: wallet (empty) removed with the workspace; the redeem
          // transaction rolled back at the workspace lock or 404-masked at the
          // membership gate. No money history may survive the deleted workspace.
          expect(res.status).toBe(200);
          expect(red.status).toBe(404);
          expect(ledger).toBe(0);
          expect(redemptions).toBe(0);
          expect(uses).toBe(0);
          expect(balanceRows.length).toBe(0);
        } else {
          // Redeem won: the credit committed first, so the wallet is funded
          // and delete must refuse rather than remove money history.
          expect(res.status).toBe(409);
          expect(red.status).toBe(200);
          expect(ledger).toBe(1);
          expect(redemptions).toBe(1);
          expect(uses).toBe(1);
          expect(balanceRows[0]!.balance).toBe(50000);
        }
      }
    });
  });
});
