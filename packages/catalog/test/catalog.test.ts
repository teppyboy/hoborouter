// Canonical model catalog helpers: getCurrentPrice, listPublicModels, resolveModel.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { createTestDb, type Db } from "@hoborouter/db";
import { getCurrentPrice, listPublicModels, resolveModel } from "../src";

let db: Db;
let drop: () => Promise<void>;
const NOW = Date.now();

async function seedModel(o: {
  id: string;
  publicId: string;
  enabled?: boolean;
  published?: boolean;
}) {
  await db.execute(sql`
    INSERT INTO models (id, public_id, slug, display_name, provider, enabled, published, created_at, updated_at)
    VALUES (${o.id}, ${o.publicId}, ${o.publicId.split("/")[1]!}, ${o.publicId}, ${o.publicId.split("/")[0]!},
      ${o.enabled === false ? false : true}, ${o.published === false ? false : true}, ${NOW}, ${NOW})`);
}

async function seedMapping(o: { id: string; modelId: string; enabled?: boolean }) {
  await db.execute(sql`
    INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at)
    VALUES (${o.id}, ${o.modelId}, 'openai', ${`upstream-${o.modelId}`}, ${o.enabled === false ? false : true}, ${NOW}, ${NOW})`);
}

async function seedPrice(o: {
  id: string;
  modelId: string;
  effectiveAt?: number;
  retiredAt?: number | null;
  input?: number;
}) {
  await db.execute(sql`
    INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at, retired_at)
    VALUES (${o.id}, ${o.modelId}, ${o.input ?? 500}, 1500, 250, 1000, 100000, ${o.effectiveAt ?? NOW - 1000}, ${o.retiredAt ?? null})`);
}

beforeAll(async () => {
  ({ db, drop } = await createTestDb());
  await seedModel({ id: "m1", publicId: "openai/gpt-x" });
  await seedMapping({ id: "pm1", modelId: "m1" });
  await seedPrice({ id: "p1", modelId: "m1" });
});

afterAll(async () => {
  await drop();
});

describe("getCurrentPrice", () => {
  test("returns latest effective_at <= now, retired_at null", async () => {
    const price = await getCurrentPrice(db, "m1");
    expect(price).not.toBeNull();
    expect(price!.input_usd_micro_per_1m).toBe(500);
  });

  test("ignores future-effective and retired rows; prefers newest effective", async () => {
    await seedPrice({ id: "p-future", modelId: "m1", effectiveAt: NOW + 10000, input: 9999 });
    await seedPrice({ id: "p-retired", modelId: "m1", input: 8888, retiredAt: NOW });
    await seedPrice({ id: "p-new", modelId: "m1", input: 600, effectiveAt: NOW - 500 });
    expect((await getCurrentPrice(db, "m1"))!.input_usd_micro_per_1m).toBe(600);
  });

  test("null when no price", async () => {
    await seedModel({ id: "m-noprice", publicId: "openai/no-price" });
    expect(await getCurrentPrice(db, "m-noprice")).toBeNull();
  });
});

describe("listPublicModels", () => {
  test("only enabled AND published AND >=1 enabled mapping AND current price", async () => {
    await seedModel({ id: "m-disabled", publicId: "openai/disabled", enabled: false });
    await seedMapping({ id: "pm-d", modelId: "m-disabled" });
    await seedPrice({ id: "p-d", modelId: "m-disabled" });
    await seedModel({ id: "m-unpub", publicId: "openai/unpub", published: false });
    await seedMapping({ id: "pm-u", modelId: "m-unpub" });
    await seedPrice({ id: "p-u", modelId: "m-unpub" });
    await seedModel({ id: "m-nomap", publicId: "openai/nomap" });
    await seedPrice({ id: "p-nm", modelId: "m-nomap" });
    const ids = (await listPublicModels(db)).map((m) => m.public_id);
    expect(ids).toContain("openai/gpt-x");
    expect(ids).not.toContain("openai/disabled");
    expect(ids).not.toContain("openai/unpub");
    expect(ids).not.toContain("openai/nomap");
    expect(ids).not.toContain("openai/no-price");
  });
});

describe("resolveModel", () => {
  test("returns model, mapping, price for a listed public id", async () => {
    const r = await resolveModel(db, "openai/gpt-x");
    expect(r).not.toBeNull();
    expect(r!.model.id).toBe("m1");
    expect(r!.mapping.id).toBe("pm1");
    expect(r!.price.input_usd_micro_per_1m).toBe(600);
  });

  test("null for missing / disabled / unmapped / unpriced", async () => {
    expect(await resolveModel(db, "openai/missing")).toBeNull();
    expect(await resolveModel(db, "openai/disabled")).toBeNull();
    expect(await resolveModel(db, "openai/nomap")).toBeNull();
    expect(await resolveModel(db, "openai/no-price")).toBeNull();
  });
});

describe("immutability + published gating", () => {
  test("raw UPDATE on model_prices throws (DB trigger)", async () => {
    let threw = false;
    try {
      await db.execute(sql`UPDATE model_prices SET input_usd_micro_per_1m = 1 WHERE id = 'p1'`);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("resolveModel returns null for unpublished model", async () => {
    await seedModel({ id: "m-unpub-res", publicId: "openai/unpub-res", published: false });
    await seedMapping({ id: "pm-unpub-res", modelId: "m-unpub-res" });
    await seedPrice({ id: "p-unpub-res", modelId: "m-unpub-res" });
    expect(await resolveModel(db, "openai/unpub-res")).toBeNull();
  });
});
