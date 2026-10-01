// Canonical model catalog helpers: getCurrentPrice, listPublicModels, resolveModel.
import { describe, expect, test, beforeAll } from "bun:test";
import type { Database } from "bun:sqlite";
import { createDb, migrate } from "@hoborouter/db";
import { getCurrentPrice, listPublicModels, resolveModel } from "../src";

let db: Database;
const NOW = Date.now();

function seedModel(o: { id: string; publicId: string; enabled?: boolean; published?: boolean }) {
  db.prepare(
    "INSERT INTO models (id, public_id, slug, display_name, provider, enabled, published, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(
    o.id,
    o.publicId,
    o.publicId.split("/")[1]!,
    o.publicId,
    o.publicId.split("/")[0]!,
    o.enabled === false ? 0 : 1,
    o.published === false ? 0 : 1,
    NOW,
    NOW,
  );
}

function seedMapping(o: { id: string; modelId: string; enabled?: boolean }) {
  db.prepare(
    "INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
  ).run(o.id, o.modelId, "openai", `upstream-${o.modelId}`, o.enabled === false ? 0 : 1, NOW, NOW);
}

function seedPrice(o: {
  id: string;
  modelId: string;
  effectiveAt?: number;
  retiredAt?: number | null;
  input?: number;
}) {
  db.prepare(
    "INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at, retired_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(
    o.id,
    o.modelId,
    o.input ?? 500,
    1500,
    250,
    1000,
    100000,
    o.effectiveAt ?? NOW - 1000,
    o.retiredAt ?? null,
  );
}

beforeAll(() => {
  db = createDb(":memory:");
  migrate(db);
  seedModel({ id: "m1", publicId: "openai/gpt-x" });
  seedMapping({ id: "pm1", modelId: "m1" });
  seedPrice({ id: "p1", modelId: "m1" });
});

describe("getCurrentPrice", () => {
  test("returns latest effective_at <= now, retired_at null", () => {
    const price = getCurrentPrice(db, "m1");
    expect(price).not.toBeNull();
    expect(price!.input_usd_micro_per_1m).toBe(500);
  });

  test("ignores future-effective and retired rows; prefers newest effective", () => {
    seedPrice({ id: "p-future", modelId: "m1", effectiveAt: NOW + 10000, input: 9999 });
    seedPrice({ id: "p-retired", modelId: "m1", input: 8888, retiredAt: NOW });
    seedPrice({ id: "p-new", modelId: "m1", input: 600, effectiveAt: NOW - 500 });
    expect(getCurrentPrice(db, "m1")!.input_usd_micro_per_1m).toBe(600);
  });

  test("null when no price", () => {
    seedModel({ id: "m-noprice", publicId: "openai/no-price" });
    expect(getCurrentPrice(db, "m-noprice")).toBeNull();
  });
});

describe("listPublicModels", () => {
  test("only enabled AND published AND >=1 enabled mapping AND current price", () => {
    seedModel({ id: "m-disabled", publicId: "openai/disabled", enabled: false });
    seedMapping({ id: "pm-d", modelId: "m-disabled" });
    seedPrice({ id: "p-d", modelId: "m-disabled" });
    seedModel({ id: "m-unpub", publicId: "openai/unpub", published: false });
    seedMapping({ id: "pm-u", modelId: "m-unpub" });
    seedPrice({ id: "p-u", modelId: "m-unpub" });
    seedModel({ id: "m-nomap", publicId: "openai/nomap" });
    seedPrice({ id: "p-nm", modelId: "m-nomap" });
    const ids = listPublicModels(db).map((m) => m.public_id);
    expect(ids).toContain("openai/gpt-x");
    expect(ids).not.toContain("openai/disabled");
    expect(ids).not.toContain("openai/unpub");
    expect(ids).not.toContain("openai/nomap");
    expect(ids).not.toContain("openai/no-price");
  });
});

describe("resolveModel", () => {
  test("returns model, mapping, price for a listed public id", () => {
    const r = resolveModel(db, "openai/gpt-x");
    expect(r).not.toBeNull();
    expect(r!.model.id).toBe("m1");
    expect(r!.mapping.id).toBe("pm1");
    expect(r!.price.input_usd_micro_per_1m).toBe(600);
  });

  test("null for missing / disabled / unmapped / unpriced", () => {
    expect(resolveModel(db, "openai/missing")).toBeNull();
    expect(resolveModel(db, "openai/disabled")).toBeNull();
    expect(resolveModel(db, "openai/nomap")).toBeNull();
    expect(resolveModel(db, "openai/no-price")).toBeNull();
  });
});

describe("immutability + published gating", () => {
  test("raw UPDATE on model_prices throws (DB trigger)", () => {
    expect(() =>
      db.prepare("UPDATE model_prices SET input_usd_micro_per_1m = 1 WHERE id = 'p1'").run(),
    ).toThrow();
  });

  test("resolveModel returns null for unpublished model", () => {
    seedModel({ id: "m-unpub-res", publicId: "openai/unpub-res", published: false });
    seedMapping({ id: "pm-unpub-res", modelId: "m-unpub-res" });
    seedPrice({ id: "p-unpub-res", modelId: "m-unpub-res" });
    expect(resolveModel(db, "openai/unpub-res")).toBeNull();
  });
});
