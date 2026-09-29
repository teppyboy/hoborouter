// Task 7: immutable price snapshots — publishSnapshot + DB trigger immutability.
import { describe, expect, test, beforeAll } from "bun:test";
import type { Database } from "bun:sqlite";
import { createDb, migrate } from "@hoborouter/db";
import { publishSnapshot } from "../src/snapshot";

let db: Database;

beforeAll(() => {
  db = createDb(":memory:");
  migrate(db);
  db.prepare(
    "INSERT INTO model_bindings (id, workspace_id, public_model, cpa_alias, status, price_input_per_1m, price_output_per_1m, effective_at) VALUES ('mb-1', NULL, 'gpt-x', 'alias-x', 'published', 1000, 2000, ?)",
  ).run(Date.now());
});

describe("publishSnapshot", () => {
  test("publish returns id and inserts row", () => {
    const now = Date.now();
    const { snapshotId } = publishSnapshot(db, {
      bindingId: "mb-1",
      priceInput: 1500,
      priceOutput: 2500,
      now,
    });
    expect(typeof snapshotId).toBe("string");
    const row = db.prepare("SELECT * FROM price_snapshots WHERE id = ?").get(snapshotId) as {
      binding_id: string;
      price_input: number;
      price_output: number;
      created_at: number;
    };
    expect(row.binding_id).toBe("mb-1");
    expect(row.price_input).toBe(1500);
    expect(row.price_output).toBe(2500);
    expect(row.created_at).toBe(now);
  });

  test("rejects unknown binding", () => {
    expect(() =>
      publishSnapshot(db, { bindingId: "nope", priceInput: 1, priceOutput: 1, now: Date.now() }),
    ).toThrow();
  });

  test("rejects non-integer / negative prices before any SQL", () => {
    for (const bad of [1.5, -1, Number.NaN, "5" as unknown]) {
      expect(() =>
        publishSnapshot(db, {
          bindingId: "mb-1",
          priceInput: bad as number,
          priceOutput: 1,
          now: Date.now(),
        }),
      ).toThrow();
    }
  });
});

describe("price_snapshots immutability (DB triggers)", () => {
  let id: string;
  beforeAll(() => {
    ({ snapshotId: id } = publishSnapshot(db, {
      bindingId: "mb-1",
      priceInput: 10,
      priceOutput: 20,
      now: Date.now(),
    }));
  });

  test("UPDATE → RAISE(ABORT)", () => {
    expect(() =>
      db.prepare("UPDATE price_snapshots SET price_input = 999 WHERE id = ?").run(id),
    ).toThrow(/immutable/);
  });

  test("DELETE → RAISE(ABORT)", () => {
    expect(() => db.prepare("DELETE FROM price_snapshots WHERE id = ?").run(id)).toThrow(
      /immutable/,
    );
  });

  test("row unchanged after rejected mutations", () => {
    const row = db
      .prepare("SELECT price_input, price_output FROM price_snapshots WHERE id = ?")
      .get(id) as {
      price_input: number;
      price_output: number;
    };
    expect(row.price_input).toBe(10);
    expect(row.price_output).toBe(20);
  });
});
