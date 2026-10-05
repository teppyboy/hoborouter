// Task 7: immutable price snapshots — publishSnapshot + DB trigger immutability.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { createTestDb, type Db } from "@hoborouter/db";
import { publishSnapshot } from "../src/snapshot";

let db: Db;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ db, drop } = await createTestDb());
  await db.execute(sql`
    INSERT INTO model_bindings (id, workspace_id, public_model, cpa_alias, status, price_input_per_1m, price_output_per_1m, effective_at)
    VALUES ('mb-1', NULL, 'gpt-x', 'alias-x', 'published', 1000, 2000, ${Date.now()})`);
});

afterAll(async () => {
  await drop();
});

describe("publishSnapshot", () => {
  test("publish returns id and inserts row", async () => {
    const now = Date.now();
    const { snapshotId } = await publishSnapshot(db, {
      bindingId: "mb-1",
      priceInput: 1500,
      priceOutput: 2500,
      now,
    });
    expect(typeof snapshotId).toBe("string");
    const rows = await db.execute<{
      binding_id: string;
      price_input: number;
      price_output: number;
      created_at: number;
    }>(
      sql`SELECT binding_id, price_input, price_output, created_at FROM price_snapshots WHERE id = ${snapshotId}`,
    );
    const row = rows[0]!;
    expect(row.binding_id).toBe("mb-1");
    expect(Number(row.price_input)).toBe(1500);
    expect(Number(row.price_output)).toBe(2500);
    expect(Number(row.created_at)).toBe(now);
  });

  test("rejects unknown binding", async () => {
    await expect(
      publishSnapshot(db, { bindingId: "nope", priceInput: 1, priceOutput: 1, now: Date.now() }),
    ).rejects.toThrow();
  });

  test("rejects non-integer / negative prices before any SQL", async () => {
    for (const bad of [1.5, -1, Number.NaN, "5" as unknown]) {
      await expect(
        publishSnapshot(db, {
          bindingId: "mb-1",
          priceInput: bad as number,
          priceOutput: 1,
          now: Date.now(),
        }),
      ).rejects.toThrow(TypeError);
    }
  });
});

/** Raw db.execute returns a PgRaw thenable, not a Promise; assert via await/catch. */
async function expectSqlThrow(fn: () => unknown, re: RegExp) {
  let msg: string | undefined;
  try {
    await fn();
  } catch (e) {
    // Drizzle wraps query errors; the trigger's RAISE message lives on `cause`.
    msg = String((e as { cause?: unknown }).cause ?? e);
  }
  expect(msg).toBeDefined();
  expect(msg!).toMatch(re);
}

describe("price_snapshots immutability (DB triggers)", () => {
  let id: string;
  beforeAll(async () => {
    ({ snapshotId: id } = await publishSnapshot(db, {
      bindingId: "mb-1",
      priceInput: 10,
      priceOutput: 20,
      now: Date.now(),
    }));
  });

  test("UPDATE → RAISE(ABORT)", async () => {
    await expectSqlThrow(
      () => db.execute(sql`UPDATE price_snapshots SET price_input = 999 WHERE id = ${id}`),
      /append-only/,
    );
  });

  test("DELETE → RAISE(ABORT)", async () => {
    await expectSqlThrow(
      () => db.execute(sql`DELETE FROM price_snapshots WHERE id = ${id}`),
      /append-only/,
    );
  });

  test("row unchanged after rejected mutations", async () => {
    const rows = await db.execute<{ price_input: number; price_output: number }>(
      sql`SELECT price_input, price_output FROM price_snapshots WHERE id = ${id}`,
    );
    const row = rows[0]!;
    expect(Number(row.price_input)).toBe(10);
    expect(Number(row.price_output)).toBe(20);
  });
});
