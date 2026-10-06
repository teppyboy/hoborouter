// USD catalog metadata schema behavior on a real migrated PostgreSQL database:
// legacy VND rows keep every USD column NULL; valid USD groups insert; the
// database itself rejects malformed USD text, incomplete currency groups,
// non-positive prices, negative credits, and unbounded/non-positive FX.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, type Db } from "../packages/db/src/index";

const MAX_MONEY = 9007199254740991;
const NOW = 1_700_000_000_000;

let db: Db;
let drop: () => Promise<void>;

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  drop = t.drop;
});

afterAll(async () => {
  await drop();
});

async function exec(text: string, params: unknown[] = []): Promise<void> {
  await db.$client.unsafe(text, params as never[]);
}

async function rows<T>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.$client.unsafe(text, params as never[])) as T[];
}

async function insertLegacyBundle(id: string): Promise<void> {
  await exec(
    `INSERT INTO credit_bundles (id, name, price_vnd, credit_vnd, bonus_vnd, active, created_at)
     VALUES ($1, $1, 100000, 100000, 0, true, $2)`,
    [id, NOW],
  );
}

async function insertLegacyPlan(id: string): Promise<void> {
  await exec(
    `INSERT INTO subscription_plans (id, name, price_vnd, credit_per_period_vnd, period_days, rate_limit_per_minute, active, created_at)
     VALUES ($1, $1, 250000, 300000, 30, 15, true, $2)`,
    [id, NOW],
  );
}

interface InsertBundle {
  id: string;
  priceUsd?: string;
  creditUsd?: string;
  bonusUsd?: string;
  fx?: number;
}

async function insertBundle(b: InsertBundle): Promise<void> {
  await exec(
    `INSERT INTO credit_bundles
       (id, name, price_vnd, credit_vnd, bonus_vnd, active, created_at,
        price_usd, credit_usd, bonus_usd, creation_fx_rate_vnd_per_usd)
     VALUES ($1, $1, 259740, 130005, 0, true, $2, $3, $4, $5, $6)`,
    [b.id, NOW, b.priceUsd ?? null, b.creditUsd ?? null, b.bonusUsd ?? null, b.fx ?? null],
  );
}

interface InsertPlan {
  id: string;
  priceUsd?: string;
  creditUsd?: string;
  fx?: number;
}

async function insertPlan(p: InsertPlan): Promise<void> {
  await exec(
    `INSERT INTO subscription_plans
       (id, name, price_vnd, credit_per_period_vnd, period_days, rate_limit_per_minute, active, created_at,
        price_usd, credit_per_period_usd, creation_fx_rate_vnd_per_usd)
     VALUES ($1, $1, 259750, 312012, 30, 15, true, $2, $3, $4, $5)`,
    [p.id, NOW, p.priceUsd ?? null, p.creditUsd ?? null, p.fx ?? null],
  );
}

describe("USD catalog schema", () => {
  test("legacy VND bundle and plan rows keep every USD column NULL", async () => {
    await insertLegacyBundle("leg-b");
    await insertLegacyPlan("leg-p");
    const [b] = await rows<{
      price_usd: string | null;
      credit_usd: string | null;
      bonus_usd: string | null;
      // Raw SQL reads return bigint columns as text.
      creation_fx_rate_vnd_per_usd: string | null;
    }>(
      `SELECT price_usd, credit_usd, bonus_usd, creation_fx_rate_vnd_per_usd
       FROM credit_bundles WHERE id = 'leg-b'`,
    );
    expect(b).toEqual({
      price_usd: null,
      credit_usd: null,
      bonus_usd: null,
      creation_fx_rate_vnd_per_usd: null,
    });
    const [p] = await rows<{
      price_usd: string | null;
      credit_per_period_usd: string | null;
      creation_fx_rate_vnd_per_usd: string | null;
    }>(
      `SELECT price_usd, credit_per_period_usd, creation_fx_rate_vnd_per_usd
       FROM subscription_plans WHERE id = 'leg-p'`,
    );
    expect(p).toEqual({
      price_usd: null,
      credit_per_period_usd: null,
      creation_fx_rate_vnd_per_usd: null,
    });
  });

  test("valid USD bundle group inserts and stores exact texts and FX", async () => {
    await insertBundle({
      id: "usd-b",
      priceUsd: "9.99",
      creditUsd: "5",
      bonusUsd: "0",
      fx: 26001,
    });
    const [b] = await rows<{
      price_usd: string;
      credit_usd: string;
      bonus_usd: string;
      creation_fx_rate_vnd_per_usd: string;
    }>(
      `SELECT price_usd, credit_usd, bonus_usd, creation_fx_rate_vnd_per_usd
       FROM credit_bundles WHERE id = 'usd-b'`,
    );
    expect(b).toEqual({
      price_usd: "9.99",
      credit_usd: "5",
      bonus_usd: "0",
      // bigint columns come back as text through raw SQL reads.
      creation_fx_rate_vnd_per_usd: "26001",
    });
  });

  test("valid USD plan group inserts and stores exact texts and FX", async () => {
    await insertPlan({
      id: "usd-p",
      priceUsd: "0.01",
      creditUsd: "12",
      fx: 26001,
    });
    const [p] = await rows<{
      price_usd: string;
      credit_per_period_usd: string;
      creation_fx_rate_vnd_per_usd: string;
    }>(
      `SELECT price_usd, credit_per_period_usd, creation_fx_rate_vnd_per_usd
       FROM subscription_plans WHERE id = 'usd-p'`,
    );
    expect(p).toEqual({
      price_usd: "0.01",
      credit_per_period_usd: "12",
      creation_fx_rate_vnd_per_usd: "26001",
    });
  });

  test("zero credit and zero bonus USD texts are allowed", async () => {
    await insertBundle({
      id: "usd-b-zero",
      priceUsd: "5",
      creditUsd: "0",
      bonusUsd: "0",
      fx: 26001,
    });
    await insertPlan({
      id: "usd-p-zero",
      priceUsd: "5",
      creditUsd: "0",
      fx: 26001,
    });
  });

  test("malformed USD price text rejected on bundles and plans", async () => {
    const bad = ["1.001", "1e2", "-5", "abc", "", "+5", "5.", ".5"];
    for (let i = 0; i < bad.length; i++) {
      await expect(
        insertBundle({
          id: `bad-price-b-${i}`,
          priceUsd: bad[i]!,
          creditUsd: "5",
          bonusUsd: "0",
          fx: 26001,
        }),
      ).rejects.toThrow();
      await expect(
        insertPlan({
          id: `bad-price-p-${i}`,
          priceUsd: bad[i]!,
          creditUsd: "12",
          fx: 26001,
        }),
      ).rejects.toThrow();
    }
  });

  test("malformed USD credit text rejected", async () => {
    const bad = ["1.001", "-1", "x", "1e2"];
    for (let i = 0; i < bad.length; i++) {
      await expect(
        insertBundle({
          id: `bad-credit-b-${i}`,
          priceUsd: "9.99",
          creditUsd: bad[i]!,
          bonusUsd: "0",
          fx: 26001,
        }),
      ).rejects.toThrow();
      await expect(
        insertPlan({
          id: `bad-credit-p-${i}`,
          priceUsd: "9.99",
          creditUsd: bad[i]!,
          fx: 26001,
        }),
      ).rejects.toThrow();
    }
  });

  test("malformed USD bonus text rejected on bundles", async () => {
    await expect(
      insertBundle({
        id: "bad-bonus-b",
        priceUsd: "9.99",
        creditUsd: "5",
        bonusUsd: "-1",
        fx: 26001,
      }),
    ).rejects.toThrow();
  });

  test("zero price USD text rejected on bundles and plans", async () => {
    await expect(
      insertBundle({
        id: "zero-price-b",
        priceUsd: "0",
        creditUsd: "5",
        bonusUsd: "0",
        fx: 26001,
      }),
    ).rejects.toThrow();
    await expect(
      insertPlan({
        id: "zero-price-p",
        priceUsd: "0.00",
        creditUsd: "12",
        fx: 26001,
      }),
    ).rejects.toThrow();
  });

  test("incomplete bundle USD group (missing credit/bonus/FX) rejected", async () => {
    await expect(insertBundle({ id: "inc-b-1", priceUsd: "9.99" })).rejects.toThrow();
    await expect(
      insertBundle({ id: "inc-b-2", priceUsd: "9.99", creditUsd: "5" }),
    ).rejects.toThrow();
    await expect(
      insertBundle({ id: "inc-b-3", priceUsd: "9.99", creditUsd: "5", bonusUsd: "0" }),
    ).rejects.toThrow();
  });

  test("incomplete plan USD group (missing credit/FX) rejected", async () => {
    await expect(insertPlan({ id: "inc-p-1", priceUsd: "9.99" })).rejects.toThrow();
    await expect(
      insertPlan({ id: "inc-p-2", priceUsd: "9.99", creditUsd: "12" }),
    ).rejects.toThrow();
  });

  test("credit/bonus USD text without price (orphan non-null group member) rejected", async () => {
    // Group completeness is defined pairwise from the price column: a lone
    // non-null member without price_usd is an ambiguous mixed-currency row.
    await expect(
      exec(
        `INSERT INTO credit_bundles
           (id, name, price_vnd, credit_vnd, bonus_vnd, active, created_at, price_usd, credit_usd, bonus_usd, creation_fx_rate_vnd_per_usd)
         VALUES ('mixed-b', 'mixed-b', 100000, 100000, 0, true, $1, NULL, '5', '0', 26001)`,
        [NOW],
      ),
    ).rejects.toThrow();
  });

  test("non-positive FX rejected; FX bounded above by MAX_SAFE_INTEGER_MONEY", async () => {
    await expect(
      insertBundle({
        id: "fx-zero-b",
        priceUsd: "9.99",
        creditUsd: "5",
        bonusUsd: "0",
        fx: 0,
      }),
    ).rejects.toThrow();
    await expect(
      insertBundle({
        id: "fx-neg-b",
        priceUsd: "9.99",
        creditUsd: "5",
        bonusUsd: "0",
        fx: -1,
      }),
    ).rejects.toThrow();
    await expect(
      insertBundle({
        id: "fx-huge-b",
        priceUsd: "9.99",
        creditUsd: "5",
        bonusUsd: "0",
        fx: MAX_MONEY + 1,
      }),
    ).rejects.toThrow();
    await insertBundle({
      id: "fx-max-b",
      priceUsd: "9.99",
      creditUsd: "5",
      bonusUsd: "0",
      fx: MAX_MONEY,
    });
    await expect(
      insertPlan({
        id: "fx-zero-p",
        priceUsd: "9.99",
        creditUsd: "12",
        fx: 0,
      }),
    ).rejects.toThrow();
  });

  test("USD price text above money bound rejected", async () => {
    await expect(
      insertBundle({
        id: "price-huge-b",
        priceUsd: String(MAX_MONEY) + "0",
        creditUsd: "5",
        bonusUsd: "0",
        fx: 26001,
      }),
    ).rejects.toThrow();
  });
});
