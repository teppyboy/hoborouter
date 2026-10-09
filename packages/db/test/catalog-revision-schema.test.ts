import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../src/testing";
import { isUniqueViolation, pgErrorCode } from "../src/errors";
import { creditBundles, subscriptionPlans } from "../src/schema";

// Catalog revision columns: revision_key lives only on the SUCCESSOR row and
// is arbitrated by a partial unique index per table; successor_id lives only
// on the SUPERSEDED row as a nullable self-FK. Behavior is tested against a
// real migrated database (inserts/constraints), never against SQL text.
let t: TestDb;
let d: TestDb["db"];

function bundleRow(id: string): typeof creditBundles.$inferInsert {
  return {
    id,
    name: id,
    price_vnd: 100,
    credit_vnd: 100,
    bonus_vnd: 0,
    active: true,
    created_at: 1,
  };
}

function planRow(id: string): typeof subscriptionPlans.$inferInsert {
  return {
    id,
    name: id,
    price_vnd: 100,
    credit_per_period_vnd: 100,
    period_days: 30,
    active: true,
    created_at: 1,
  };
}

beforeAll(async () => {
  t = await createTestDb();
  d = t.db;
});

afterAll(() => t.drop());

describe("credit_bundles revision columns", () => {
  test("rows never created by a revision keep both columns null (defaults)", async () => {
    await d.insert(creditBundles).values(bundleRow("cb-plain"));
    const row = await d.query.creditBundles.findFirst({
      where: eq(creditBundles.id, "cb-plain"),
    });
    expect(row?.revision_key).toBeNull();
    expect(row?.successor_id).toBeNull();
  });

  test("successor row carries revision_key; null revision_keys coexist", async () => {
    await d.insert(creditBundles).values(bundleRow("cb-old-a"));
    await d
      .insert(creditBundles)
      .values({ ...bundleRow("cb-new-a"), revision_key: "rev:u:cb-old-a:abc" });
    const rows = await d.query.creditBundles.findMany();
    const keys = rows.filter((r) => r.revision_key !== null).map((r) => r.revision_key);
    expect(keys).toEqual(["rev:u:cb-old-a:abc"]);
  });

  test("duplicate non-null revision_key on the same table is rejected", async () => {
    await d.insert(creditBundles).values({ ...bundleRow("cb-dup-1"), revision_key: "rev:u:dup:1" });
    try {
      await d
        .insert(creditBundles)
        .values({ ...bundleRow("cb-dup-2"), revision_key: "rev:u:dup:1" });
      throw new Error("expected unique violation");
    } catch (e) {
      expect(isUniqueViolation(e)).toBe(true);
    }
  });

  test("successor_id self-FK accepts a real bundle id and rejects an unknown one", async () => {
    await d.insert(creditBundles).values(bundleRow("cb-old-b"));
    await d.insert(creditBundles).values(bundleRow("cb-new-b"));
    await d
      .update(creditBundles)
      .set({ active: false, successor_id: "cb-new-b" })
      .where(eq(creditBundles.id, "cb-old-b"));
    const old = await d.query.creditBundles.findFirst({
      where: eq(creditBundles.id, "cb-old-b"),
    });
    expect(old?.successor_id).toBe("cb-new-b");

    try {
      await d
        .update(creditBundles)
        .set({ successor_id: "cb-missing" })
        .where(eq(creditBundles.id, "cb-new-b"));
      throw new Error("expected FK violation");
    } catch (e) {
      expect(pgErrorCode(e)).toBe("23503");
    }
  });
});

describe("subscription_plans revision columns", () => {
  test("successor row carries revision_key; null revision_keys coexist", async () => {
    await d.insert(subscriptionPlans).values(planRow("sp-old-a"));
    await d
      .insert(subscriptionPlans)
      .values({ ...planRow("sp-new-a"), revision_key: "rev:u:sp-old-a:xyz" });
    const rows = await d.query.subscriptionPlans.findMany();
    const keys = rows.filter((r) => r.revision_key !== null).map((r) => r.revision_key);
    expect(keys).toEqual(["rev:u:sp-old-a:xyz"]);
  });

  test("duplicate non-null revision_key on the same table is rejected", async () => {
    await d
      .insert(subscriptionPlans)
      .values({ ...planRow("sp-dup-1"), revision_key: "rev:u:spdup:1" });
    try {
      await d
        .insert(subscriptionPlans)
        .values({ ...planRow("sp-dup-2"), revision_key: "rev:u:spdup:1" });
      throw new Error("expected unique violation");
    } catch (e) {
      expect(isUniqueViolation(e)).toBe(true);
    }
  });

  test("successor_id self-FK accepts a real plan id and rejects an unknown one", async () => {
    await d.insert(subscriptionPlans).values(planRow("sp-old-b"));
    await d.insert(subscriptionPlans).values(planRow("sp-new-b"));
    await d
      .update(subscriptionPlans)
      .set({ active: false, successor_id: "sp-new-b" })
      .where(eq(subscriptionPlans.id, "sp-old-b"));
    const old = await d.query.subscriptionPlans.findFirst({
      where: eq(subscriptionPlans.id, "sp-old-b"),
    });
    expect(old?.successor_id).toBe("sp-new-b");

    try {
      await d
        .update(subscriptionPlans)
        .set({ successor_id: "sp-missing" })
        .where(eq(subscriptionPlans.id, "sp-new-b"));
      throw new Error("expected FK violation");
    } catch (e) {
      expect(pgErrorCode(e)).toBe("23503");
    }
  });
});
