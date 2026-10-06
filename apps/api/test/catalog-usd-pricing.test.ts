// Task 1 (USD catalog pricing) — admin authoring API only.
// USD bundle/plan POST bodies derive frozen integer-VND grants once at
// creation from the canonical payment FX rate read inside the insert
// transaction; USD texts + creation FX are snapshotted; ledger stays empty
// (catalog authoring never moves money). Mixed/incomplete USD+VND bodies and
// invalid/oversized USD text are rejected before any insert. PATCH stays
// money/FX-immutable for both currencies; legacy VND bodies behave exactly
// as before. Checkout/quote resolution is Task 2 and not covered here.
import { describe, test, expect, beforeAll } from "bun:test";
import { q, makeApp, signUp, req, userIdByEmail, makeInstanceAdmin } from "./helpers";

let app: Awaited<ReturnType<typeof makeApp>>["app"];
let db: Awaited<ReturnType<typeof makeApp>>["db"];
let adminCookie: string;
let memberCookie: string;

// Hand-derived plan FX fixture: rate 26001 VND/USD.
// price "0.01" -> ceil(1 * 26001 / 100) = 261
// credit "5"  -> 5 * 26001 = 130005 (exact, no ceiling drift)
// plan price "9.99" -> ceil(999 * 26001 / 100) = 259750
// plan credit "12"  -> 12 * 26001 = 312012
const FX = 26001;

beforeAll(async () => {
  ({ db, app } = await makeApp());
  adminCookie = await signUp(app, "usd-admin@test.dev", "A");
  await makeInstanceAdmin(db, await userIdByEmail(db, "usd-admin@test.dev"));
  memberCookie = await signUp(app, "usd-member@test.dev", "M");
  await q(
    db,
    "INSERT INTO instance_settings (key, value, updated_at) VALUES ('payment_usd_vnd_rate', ?, ?)",
    String(FX),
    Date.now(),
  );
});

const createUsdBundle = async (over: Record<string, unknown> = {}) => {
  const res = await req(app, "/api/v1/admin/bundles", {
    method: "POST",
    cookie: adminCookie,
    body: { name: "USD Bundle", price_usd: "0.01", credit_usd: "5", bonus_usd: "0", ...over },
  });
  return { res, body: (await res.json()) as Record<string, unknown> };
};

const createUsdPlan = async (over: Record<string, unknown> = {}) => {
  const res = await req(app, "/api/v1/admin/subscription-plans", {
    method: "POST",
    cookie: adminCookie,
    body: { name: "USD Plan", price_usd: "9.99", credit_per_period_usd: "12", ...over },
  });
  return { res, body: (await res.json()) as Record<string, unknown> };
};

const ledgerCount = async () =>
  (await q<{ n: number }>(db, "SELECT count(*) AS n FROM ledger_entries"))[0]!.n;

describe("USD bundle authoring", () => {
  test("creates USD bundle with exact cents conversion at creation FX", async () => {
    const { res, body } = await createUsdBundle();
    expect(res.status).toBe(201);
    expect(body.price_vnd).toBe(261);
    expect(body.credit_vnd).toBe(130005);
    expect(body.bonus_vnd).toBe(0);
    expect(body.price_usd).toBe("0.01");
    expect(body.credit_usd).toBe("5");
    expect(body.bonus_usd).toBe("0");
    expect(body.creation_fx_rate_vnd_per_usd).toBe(FX);
    const list = await req(app, "/api/v1/admin/bundles", { cookie: adminCookie });
    const { data } = (await list.json()) as { data: Record<string, unknown>[] };
    const row = data.find((r) => r.id === body.id)!;
    expect(row).toMatchObject({
      price_vnd: 261,
      credit_vnd: 130005,
      bonus_vnd: 0,
      price_usd: "0.01",
      credit_usd: "5",
      bonus_usd: "0",
      creation_fx_rate_vnd_per_usd: FX,
    });
    // Catalog authoring must never move money: no ledger entries, no wallets,
    // no balances. (This file never seeds a wallet; purchases do.)
    expect((await q<{ n: number }>(db, "SELECT count(*) AS n FROM wallets"))[0]!.n).toBe(0);
    expect(await ledgerCount()).toBe(0);
    // Snapshot fields are audited (bun SQL may return jsonb as a string).
    const audits = await q<{ detail: unknown }>(
      db,
      "SELECT detail FROM audit_log WHERE action = 'bundle.create' AND target = ?",
      String(body.id),
    );
    expect(audits.length).toBe(1);
    const detail = audits[0]!.detail as Record<string, unknown> | string | null;
    const parsed =
      typeof detail === "string" ? (JSON.parse(detail) as Record<string, unknown>) : detail;
    expect(parsed).toMatchObject({
      price_usd: "0.01",
      credit_usd: "5",
      bonus_usd: "0",
      creation_fx_rate_vnd_per_usd: FX,
      price_vnd: 261,
      credit_vnd: 130005,
    });
  });

  test("bonus_usd defaults to zero; zero credit grant is allowed", async () => {
    const { res, body } = await createUsdBundle({ name: "NoBonus", bonus_usd: undefined });
    expect(res.status).toBe(201);
    expect(body.bonus_usd).toBe("0");
    expect(body.bonus_vnd).toBe(0);
    const zeroCredit = await createUsdBundle({ name: "ZeroCredit", credit_usd: "0" });
    expect(zeroCredit.res.status).toBe(201);
    expect(zeroCredit.body.credit_vnd).toBe(0);
    expect(zeroCredit.body.credit_usd).toBe("0");
  });

  test("rejects invalid USD price text and oversized conversion", async () => {
    for (const price_usd of [
      "0",
      "-1",
      "+5",
      "1.001",
      "1e2",
      "12345678901234567",
      // 12-digit integer part parses, but 26001 x ~1e12 USD overflows the safe
      // VND money bound -> must fail closed, never clamp.
      "999999999999.99",
    ]) {
      const bad = await createUsdBundle({ price_usd });
      expect(bad.res.status).toBe(400);
    }
    for (const credit_usd of ["-1", "1.001", "abc"]) {
      const bad = await createUsdBundle({ credit_usd });
      expect(bad.res.status).toBe(400);
    }
    // Nothing inserted by the rejected attempts beyond the three valid rows.
    const rows = await q<{ n: number }>(db, "SELECT count(*) AS n FROM credit_bundles");
    expect(rows[0]!.n).toBe(3);
  });

  test("rejects mixed USD+VND and incomplete USD bodies", async () => {
    // createUsdBundle's base already carries a complete USD group, so "mixed"
    // cases add VND money fields and "incomplete" cases delete a USD field
    // via an explicit undefined override.
    for (const body of [
      { price_vnd: 100000 },
      { price_vnd: 100000, credit_vnd: 100000 },
      { bonus_vnd: 5 },
      { price_usd: "1", bonus_vnd: 5 },
      { price_usd: "1", credit_usd: undefined }, // missing credit_usd
      { credit_usd: undefined }, // missing credit_usd
      { bonus_usd: undefined, price_vnd: 1 },
    ]) {
      const bad = await createUsdBundle(body);
      expect(bad.res.status).toBe(400);
    }
  });

  test("instance-admin gate: member 403, unauthenticated 401", async () => {
    const member = await req(app, "/api/v1/admin/bundles", {
      method: "POST",
      cookie: memberCookie,
      body: { name: "X", price_usd: "1", credit_usd: "1" },
    });
    expect(member.status).toBe(403);
    const anon = await req(app, "/api/v1/admin/bundles", {
      method: "POST",
      body: { name: "X", price_usd: "1", credit_usd: "1" },
    });
    expect(anon.status).toBe(401);
  });

  test("PATCH never edits money/FX fields, even on USD rows", async () => {
    const { body } = await createUsdBundle({ name: "Immutable" });
    const id = String(body.id);
    for (const patch of [
      { price_usd: "2" },
      { credit_usd: "2" },
      { bonus_usd: "2" },
      { creation_fx_rate_vnd_per_usd: 1 },
      { price_vnd: 5 },
    ]) {
      const res = await req(app, `/api/v1/admin/bundles/${id}`, {
        method: "PATCH",
        cookie: adminCookie,
        body: patch,
      });
      expect(res.status).toBe(400);
    }
    const ok = await req(app, `/api/v1/admin/bundles/${id}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { name: "Renamed USD", active: false },
    });
    expect(ok.status).toBe(200);
  });
});

describe("USD subscription plan authoring", () => {
  test("creates USD plan with exact cents conversion at creation FX", async () => {
    const { res, body } = await createUsdPlan();
    expect(res.status).toBe(201);
    expect(body.price_vnd).toBe(259750);
    expect(body.credit_per_period_vnd).toBe(312012);
    expect(body.price_usd).toBe("9.99");
    expect(body.credit_per_period_usd).toBe("12");
    expect(body.creation_fx_rate_vnd_per_usd).toBe(FX);
    expect(body.period_days).toBe(30);
    expect(body.rate_limit_per_minute).toBe(15);
    expect(await ledgerCount()).toBe(0);
  });

  test("rejects invalid/mixed/incomplete plan USD bodies", async () => {
    for (const over of [
      { price_usd: "0" },
      { price_usd: "-2" },
      { price_usd: "1e2" },
      { price_usd: "1.001" },
      { price_usd: "999999999999.99" },
      { credit_per_period_usd: "-1" },
      { credit_per_period_usd: "1.001" },
      { price_vnd: 200000, price_usd: "9.99", credit_per_period_usd: "12" },
      { price_vnd: 200000, credit_per_period_vnd: 250000, credit_per_period_usd: "12" },
      { price_usd: undefined }, // missing credit_per_period_usd
      { credit_per_period_usd: undefined }, // missing price_usd
    ]) {
      const bad = await createUsdPlan(over);
      expect(bad.res.status).toBe(400);
    }
  });

  test("PATCH never edits money/FX fields on USD plans", async () => {
    const { body } = await createUsdPlan({ name: "PlanImmutable" });
    const id = String(body.id);
    for (const patch of [
      { price_usd: "2" },
      { credit_per_period_usd: "2" },
      { creation_fx_rate_vnd_per_usd: 1 },
    ]) {
      const res = await req(app, `/api/v1/admin/subscription-plans/${id}`, {
        method: "PATCH",
        cookie: adminCookie,
        body: patch,
      });
      expect(res.status).toBe(400);
    }
    const ok = await req(app, `/api/v1/admin/subscription-plans/${id}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { rate_limit_per_minute: 60 },
    });
    expect(ok.status).toBe(200);
  });
});

describe("legacy VND authoring unchanged", () => {
  test("legacy bundle/plan create still works with NULL USD fields", async () => {
    const legacy = await req(app, "/api/v1/admin/bundles", {
      method: "POST",
      cookie: adminCookie,
      body: { name: "Legacy Bundle", price_vnd: 100000, credit_vnd: 100000, bonus_vnd: 10000 },
    });
    const body = (await legacy.json()) as Record<string, unknown>;
    expect(legacy.status).toBe(201);
    expect(body.price_vnd).toBe(100000);
    expect(body.price_usd).toBeNull();
    expect(body.credit_usd).toBeNull();
    expect(body.bonus_usd).toBeNull();
    expect(body.creation_fx_rate_vnd_per_usd).toBeNull();

    const plan = await req(app, "/api/v1/admin/subscription-plans", {
      method: "POST",
      cookie: adminCookie,
      body: { name: "Legacy Plan", price_vnd: 200000, credit_per_period_vnd: 250000 },
    });
    expect(plan.status).toBe(201);
    const planBody = (await plan.json()) as Record<string, unknown>;
    expect(planBody.price_usd).toBeNull();
    expect(planBody.credit_per_period_usd).toBeNull();
    expect(planBody.creation_fx_rate_vnd_per_usd).toBeNull();
  });

  test("USD plans reject invalid period and request limits before creation", async () => {
    for (const invalid of [
      { period_days: 0 },
      { rate_limit_per_minute: 0 },
      { rate_limit_per_minute: 601 },
    ]) {
      const res = await req(app, "/api/v1/admin/subscription-plans", {
        method: "POST",
        cookie: adminCookie,
        body: { name: "Invalid plan", price_usd: "1", credit_per_period_usd: "1", ...invalid },
      });
      expect(res.status).toBe(400);
    }
  });

  test("admin GET lists include nullable USD fields", async () => {
    const list = await req(app, "/api/v1/admin/bundles", { cookie: adminCookie });
    expect(list.status).toBe(200);
    const { data } = (await list.json()) as { data: Record<string, unknown>[] };
    expect(data.length).toBeGreaterThan(0);
    for (const row of data) {
      expect("price_usd" in row).toBe(true);
      expect("creation_fx_rate_vnd_per_usd" in row).toBe(true);
    }
    const plans = await req(app, "/api/v1/admin/subscription-plans", { cookie: adminCookie });
    const planData = ((await plans.json()) as { data: Record<string, unknown>[] }).data;
    for (const row of planData) {
      expect("price_usd" in row).toBe(true);
      expect("credit_per_period_usd" in row).toBe(true);
    }
  });
});

// Fix-round-1 regressions (review P1s): aggregate grant-sum bound on both
// USD and legacy VND authoring paths. Run last so the FX mutation here cannot
// disturb earlier hand-derived fixtures. Transaction atomicity is enforced in
// source (single db.transaction per create) and verified by parent review.
describe("review fix regressions", () => {
  const setFx = (rate: string) =>
    q(
      db,
      "INSERT INTO instance_settings (key, value, updated_at) VALUES ('payment_usd_vnd_rate', ?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at",
      rate,
      Date.now(),
    );

  test("USD bundle rejects credit+bonus aggregate overflow before insert", async () => {
    // At FX 25000, vnd = cents * 250 exactly: each grant "184000000000.00"
    // -> 4,600,000,000,000,000 VND (individually <= 9007199254740991),
    // sum 9,200,000,000,000,000 > MAX_SAFE_INTEGER_MONEY.
    await setFx("25000");
    const bundlesBefore = (
      await q<{ n: number }>(db, "SELECT count(*) AS n FROM credit_bundles")
    )[0]!.n;
    const auditsBefore = (await q<{ n: number }>(db, "SELECT count(*) AS n FROM audit_log"))[0]!.n;
    const res = await req(app, "/api/v1/admin/bundles", {
      method: "POST",
      cookie: adminCookie,
      body: {
        name: "Overflow",
        price_usd: "1",
        credit_usd: "184000000000.00",
        bonus_usd: "184000000000.00",
      },
    });
    expect(res.status).toBe(400);
    expect((await q<{ n: number }>(db, "SELECT count(*) AS n FROM credit_bundles"))[0]!.n).toBe(
      bundlesBefore,
    );
    expect((await q<{ n: number }>(db, "SELECT count(*) AS n FROM audit_log"))[0]!.n).toBe(
      auditsBefore,
    );
    expect(await ledgerCount()).toBe(0);
    await setFx(String(FX)); // restore fixture rate for any later assertions
  });

  test("legacy VND bundle rejects credit+bonus aggregate overflow before insert", async () => {
    // 5e15 + 4.5e15 = 9.5e15 > 9007199254740991; each part is valid alone.
    const bundlesBefore = (
      await q<{ n: number }>(db, "SELECT count(*) AS n FROM credit_bundles")
    )[0]!.n;
    const auditsBefore = (await q<{ n: number }>(db, "SELECT count(*) AS n FROM audit_log"))[0]!.n;
    const res = await req(app, "/api/v1/admin/bundles", {
      method: "POST",
      cookie: adminCookie,
      body: {
        name: "LegacyOverflow",
        price_vnd: 1,
        credit_vnd: 5000000000000000,
        bonus_vnd: 4500000000000000,
      },
    });
    expect(res.status).toBe(400);
    expect((await q<{ n: number }>(db, "SELECT count(*) AS n FROM credit_bundles"))[0]!.n).toBe(
      bundlesBefore,
    );
    expect((await q<{ n: number }>(db, "SELECT count(*) AS n FROM audit_log"))[0]!.n).toBe(
      auditsBefore,
    );
    expect(await ledgerCount()).toBe(0);
  });
});
