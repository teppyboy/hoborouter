// Admin catalog listing/read endpoints:
// - GET /api/v1/admin/catalog/models carries listed/hidden_reason, first
//   enabled mapping, and current_price.
// - GET .../models/:id/prices returns full price history, newest first, with
//   a `current` flag (getCurrentPrice row).
// - GET .../models/:id/mappings returns mappings (id, provider,
//   upstream_model, enabled, created_at); provider defaults to 'cpa'.
// - PATCH /api/v1/admin/catalog/mappings/:id toggles enabled (audited).
// Authz: non-admin 403 on every route.
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { makeApp, signUp, req, makeInstanceAdmin, userIdByEmail } from "./helpers";

async function seedModel(db: Database, email: string, opts: { mapping?: boolean; price?: boolean } = {}) {
  const now = Date.now();
  db.prepare(
    "INSERT INTO models (id, public_id, slug, display_name, provider, context_window, enabled, published, created_at, updated_at) VALUES ('mdl-1','x/y','y','Y','z-ai',1000,1,1,?,?)",
  ).run(now, now);
  if (opts.mapping)
    db.prepare(
      "INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at) VALUES ('map-1','mdl-1','cpa','up-1',1,?,?)",
    ).run(now, now);
  if (opts.price)
    db.prepare(
      "INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at, retired_at) VALUES ('price-1','mdl-1',100,200,0,0,1000000,?,NULL)",
    ).run(now - 1000);
  void email;
}

async function setup(opts: { admin: boolean } = { admin: true }) {
  const { db, app } = await makeApp();
  const cookie = await signUp(app, "cat@example.com");
  if (opts.admin) makeInstanceAdmin(db, userIdByEmail(db, "cat@example.com"));
  return { db, app, cookie };
}

describe("admin catalog list summary", () => {
  test("admin: flags, mapping, current_price, listed", async () => {
    const { db, app, cookie } = await setup();
    await seedModel(db, "cat@example.com", { mapping: true, price: true });
    const res = await req(app, "/api/v1/admin/catalog/models", { cookie });
    expect(res.status).toBe(200);
    const [m] = (await res.json()) as {
      listed: boolean;
      hidden_reason: string | null;
      mapping: { id: string; provider: string; upstream_model: string; enabled: number } | null;
      current_price: { markup_ppm: number; effective_at: number } | null;
      has_price: number;
      has_mapping: number;
    }[];
    if (!m) throw new Error("no rows");
    expect(m.listed).toBe(true);
    expect(m.hidden_reason).toBeNull();
    expect(m.mapping?.id).toBe("map-1");
    expect(m.mapping?.provider).toBe("cpa");
    expect(m.mapping?.upstream_model).toBe("up-1");
    expect(m.current_price?.markup_ppm).toBe(1000000);
    expect(m.has_price).toBe(1);
    expect(m.has_mapping).toBe(1);
  });

  test("admin: hidden_reason for missing price / missing mapping / unpublished", async () => {
    const { db, app, cookie } = await setup();
    await seedModel(db, "cat@example.com", { mapping: true });
    await db
      .prepare("INSERT INTO models (id, public_id, slug, display_name, provider, context_window, enabled, published, created_at, updated_at) VALUES ('mdl-2','x/y2','y2','Y2','z-ai',1000,1,1,?,?)")
      .run(Date.now(), Date.now());
    const res = await req(app, "/api/v1/admin/catalog/models", { cookie });
    const rows = (await res.json()) as { public_id: string; listed: boolean; hidden_reason: string | null }[];
    expect(rows.find((r) => r.public_id === "x/y")?.hidden_reason).toBe("missing_price");
    expect(rows.find((r) => r.public_id === "x/y2")?.hidden_reason).toBe("missing_mapping");
    await db.prepare("UPDATE models SET published = 0, enabled = 0 WHERE id = 'mdl-1'").run();
    const res2 = await req(app, "/api/v1/admin/catalog/models", { cookie });
    const rows2 = (await res2.json()) as { public_id: string; hidden_reason: string | null }[];
    expect(rows2.find((r) => r.public_id === "x/y")?.hidden_reason).toBe("disabled");
  });

  test("non-admin: 403", async () => {
    const { db, app, cookie } = await setup({ admin: false });
    await seedModel(db, "cat@example.com");
    expect((await req(app, "/api/v1/admin/catalog/models", { cookie })).status).toBe(403);
  });
});

describe("GET prices history", () => {
  test("admin: newest first with current flag", async () => {
    const { db, app, cookie } = await setup();
    await seedModel(db, "cat@example.com", { price: true });
    db.prepare(
      "INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at, retired_at) VALUES ('price-old','mdl-1',1,1,0,0,0,?,NULL)",
    ).run(Date.now() - 2000);
    const res = await req(app, "/api/v1/admin/catalog/models/mdl-1/prices", { cookie });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as {
      id: string;
      current: boolean;
      input_usd_micro_per_1m: number;
      effective_at: number;
      retired_at: number | null;
    }[];
    expect(rows.map((r) => r.id)).toEqual(["price-1", "price-old"]);
    expect(rows[0]!.current).toBe(true);
    expect(rows[1]!.current).toBe(false);
    expect(rows[0]!.input_usd_micro_per_1m).toBe(100);
  });

  test("404 unknown model; 403 non-admin", async () => {
    const { app, cookie } = await setup();
    expect(
      (await req(app, "/api/v1/admin/catalog/models/nope/prices", { cookie })).status,
    ).toBe(404);
    const { app: app2, cookie: c2 } = await setup({ admin: false });
    expect(
      (await req(app2, "/api/v1/admin/catalog/models/x/prices", { cookie: c2 })).status,
    ).toBe(403);
  });
});

describe("GET mappings + PATCH mapping", () => {
  test("admin: list mappings; provider defaults to cpa on create", async () => {
    const { db, app, cookie } = await setup();
    await seedModel(db, "cat@example.com", { mapping: true });
    const res = await req(app, "/api/v1/admin/catalog/models/mdl-1/mappings", { cookie });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as {
      id: string;
      provider: string;
      upstream_model: string;
      enabled: number;
      created_at: number;
    }[];
    expect(rows).toEqual([
      { id: "map-1", provider: "cpa", upstream_model: "up-1", enabled: 1, created_at: expect.any(Number) },
    ]);
    const created = await req(app, "/api/v1/admin/catalog/models/mdl-1/mappings", {
      method: "POST",
      cookie,
      body: { upstream_model: "up-2" },
    });
    expect(created.status).toBe(201);
    const res2 = await req(app, "/api/v1/admin/catalog/models/mdl-1/mappings", { cookie });
    const rows2 = (await res2.json()) as { provider: string; upstream_model: string }[];
    expect(rows2[0]).toMatchObject({ provider: "cpa", upstream_model: "up-2" });
    expect(rows2[1]?.provider).toBe("cpa");
  });

  test("mappings listed newest-insertion-first even with identical created_at", async () => {
    const { db, app, cookie } = await setup();
    await seedModel(db, "cat@example.com", { mapping: true });
    // Force equality: reuse map-1's stored created_at exactly.
    const { created_at: ts, updated_at: uts } = db
      .prepare("SELECT created_at, updated_at FROM provider_model_mappings WHERE id = 'map-1'")
      .get() as { created_at: number; updated_at: number };
    // Ordering must fall back to
    // insertion chronology (rowid), not random UUID id.
    db.prepare(
      "INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at) VALUES ('map-2','mdl-1','kimi','up-2',1,?,?)",
    ).run(ts, uts);
    const res = await req(app, "/api/v1/admin/catalog/models/mdl-1/mappings", { cookie });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { id: string; created_at: number }[];
    expect(rows[0]!.created_at).toBe(rows[1]!.created_at);
    expect(rows.map((r) => r.id)).toEqual(["map-2", "map-1"]);
  });

  test("admin: PATCH toggles enabled (audited); 403 non-admin; 404 unknown", async () => {
    const { db, app, cookie } = await setup();
    await seedModel(db, "cat@example.com", { mapping: true });
    const on = await req(app, "/api/v1/admin/catalog/mappings/map-1", {
      method: "PATCH",
      cookie,
      body: { enabled: false },
    });
    expect(on.status).toBe(200);
    expect(
      ((await on.json()) as { id: string; enabled: boolean }).enabled,
    ).toBe(false);
    expect(
      ((db.prepare("SELECT enabled FROM provider_model_mappings WHERE id = 'map-1'").get() as { enabled: number }).enabled),
    ).toBe(0);
    expect(
      (db.prepare("SELECT 1 FROM audit_log WHERE action = 'catalog.mapping.update' AND target = 'map-1'").get()),
    ).toBeTruthy();
    const { app: app2, cookie: c2 } = await setup({ admin: false });
    expect(
      (await req(app2, "/api/v1/admin/catalog/mappings/map-1", { method: "PATCH", cookie: c2, body: { enabled: true } })).status,
    ).toBe(403);
    expect(
      (await req(app, "/api/v1/admin/catalog/mappings/nope", { method: "PATCH", cookie, body: { enabled: true } })).status,
    ).toBe(404);
    expect(
      (await req(app, "/api/v1/admin/catalog/mappings/map-1", { method: "PATCH", cookie })).status,
    ).toBe(400);
  });
});

describe("GET /api/v1/admin/cpa/models mapped_public_ids", () => {
  test("admin: maps upstream model to mapped public ids, keeps mapped flag", async () => {
    const { db, app, cookie } = await setup();
    await seedModel(db, "cat@example.com", { mapping: true });
    const fake = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({ data: [{ id: "up-1", owned_by: "z-ai" }, { id: "other" }] }),
    });
    process.env.CPA_BASE_URL = `http://127.0.0.1:${fake.port}`;
    process.env.CPA_ACCESS_KEY = "k";
    try {
      const res = await req(app, "/api/v1/admin/cpa/models", { cookie });
      expect(res.status).toBe(200);
      const rows = (await res.json()) as {
        data: { id: string; owned_by: string | null; mapped: boolean; mapped_public_ids: string[] }[];
      };
      expect(rows.data.length).toBe(2);
      expect(rows.data[0]).toEqual({
        id: "up-1",
        owned_by: "z-ai",
        mapped: true,
        mapped_public_ids: ["x/y"],
      });
      expect(rows.data[1]).toEqual({
        id: "other",
        owned_by: null,
        mapped: false,
        mapped_public_ids: [],
      });
    } finally {
      fake.stop(true);
      delete process.env.CPA_BASE_URL;
      delete process.env.CPA_ACCESS_KEY;
    }
  });
});
