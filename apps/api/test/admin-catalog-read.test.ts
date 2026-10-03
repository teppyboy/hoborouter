// Admin catalog listing/read endpoints:
// - GET /api/v1/admin/catalog/models carries listed/hidden_reason, first
//   enabled mapping, and current_price.
// - GET .../models/:id/prices returns full price history, newest first, with
//   a `current` flag (getCurrentPrice row).
// - GET .../models/:id/mappings returns mappings (id, provider,
//   upstream_model, enabled, created_at); provider defaults to 'cpa'.
// - PATCH /api/v1/admin/catalog/mappings/:id toggles enabled (audited).
// Authz: non-admin 403 on every route.
import { afterEach, describe, expect, test } from "bun:test";
import type { Db } from "@hoborouter/db";
import { createTestDb } from "@hoborouter/db";
import { createAuth } from "../src/auth";
import { buildApp } from "../src/app";
import { signUp, req, makeInstanceAdmin, userIdByEmail, q } from "./helpers";
import { sql } from "drizzle-orm";

async function seedModel(db: Db, email: string, opts: { mapping?: boolean; price?: boolean } = {}) {
  const now = Date.now();
  await db.execute(
    sql`INSERT INTO models (id, public_id, slug, display_name, provider, context_window, enabled, published, created_at, updated_at) VALUES ('mdl-1','x/y','y','Y','z-ai',1000,true,true,${now},${now})`,
  );
  if (opts.mapping)
    await db.execute(
      sql`INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at) VALUES ('map-1','mdl-1','cpa','up-1',true,${now},${now})`,
    );
  if (opts.price)
    await db.execute(
      sql`INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at, retired_at) VALUES ('price-1','mdl-1',100,200,0,0,1000000,${now - 1000},NULL)`,
    );
  void email;
}

// One live test DB at a time: each Bun SQL pool holds connections until
// closed and the test Postgres has a finite connection budget, so many
// simultaneously-open test DBs exhaust it. afterEach closes the pool.
let drops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const d of drops) await d();
  drops = [];
});

async function setup(opts: { admin: boolean } = { admin: true }) {
  const t = await createTestDb();
  drops.push(t.drop);
  const db = t.db;
  const auth = createAuth(db);
  const app = await buildApp({ db, auth });
  const cookie = await signUp(app, "cat@example.com");
  if (opts.admin) await makeInstanceAdmin(db, await userIdByEmail(db, "cat@example.com"));
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
      mapping: { id: string; provider: string; upstream_model: string; enabled: boolean } | null;
      current_price: { markup_ppm: number; effective_at: number } | null;
      has_price: boolean;
      has_mapping: boolean;
    }[];
    if (!m) throw new Error("no rows");
    expect(m.listed).toBe(true);
    expect(m.hidden_reason).toBeNull();
    expect(m.mapping?.id).toBe("map-1");
    expect(m.mapping?.provider).toBe("cpa");
    expect(m.mapping?.upstream_model).toBe("up-1");
    expect(m.current_price?.markup_ppm).toBe(1000000);
    expect(m.has_price).toBe(true);
    expect(m.has_mapping).toBe(true);
  });

  test("admin: hidden_reason for missing price / missing mapping / unpublished", async () => {
    const { db, app, cookie } = await setup();
    await seedModel(db, "cat@example.com", { mapping: true });
    await db.execute(
      sql`INSERT INTO models (id, public_id, slug, display_name, provider, context_window, enabled, published, created_at, updated_at) VALUES ('mdl-2','x/y2','y2','Y2','z-ai',1000,true,true,${Date.now()},${Date.now()})`,
    );
    const res = await req(app, "/api/v1/admin/catalog/models", { cookie });
    const rows = (await res.json()) as { public_id: string; listed: boolean; hidden_reason: string | null }[];
    expect(rows.find((r) => r.public_id === "x/y")?.hidden_reason).toBe("missing_price");
    expect(rows.find((r) => r.public_id === "x/y2")?.hidden_reason).toBe("missing_mapping");
    await db.execute(sql`UPDATE models SET published = false, enabled = false WHERE id = 'mdl-1'`);
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
    await db.execute(
      sql`INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at, retired_at) VALUES ('price-old','mdl-1',1,1,0,0,0,${Date.now() - 2000},NULL)`,
    );
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
      enabled: boolean;
      created_at: number;
    }[];
    expect(rows).toEqual([
      { id: "map-1", provider: "cpa", upstream_model: "up-1", enabled: true, created_at: expect.any(Number) },
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
    const { created_at: ts, updated_at: uts } = (
      await q<{ created_at: number; updated_at: number }>(
        db,
        "SELECT created_at, updated_at FROM provider_model_mappings WHERE id = 'map-1'",
      )
    )[0]!;
    // Ordering must fall back to id DESC on created_at ties ('map-2' > 'map-1').
    await db.execute(
      sql`INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at) VALUES ('map-2','mdl-1','kimi','up-2',true,${ts},${uts})`,
    );
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
      ((await q<{ enabled: boolean }>(db, "SELECT enabled FROM provider_model_mappings WHERE id = 'map-1'"))[0]!).enabled,
    ).toBe(false);
    expect(
      (await q(db, "SELECT 1 FROM audit_log WHERE action = 'catalog.mapping.update' AND target = 'map-1'")).length,
    ).toBe(1);
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
    // Prior values restored (not deleted) so parallel/isolated runs keep any
    // ambient env intact; key is a test dummy, never logged.
    const prevBase = process.env.CPA_BASE_URL;
    const prevKey = process.env.CPA_ACCESS_KEY;
    let fakeRequests = 0;
    const fake = Bun.serve({
      port: 0,
      fetch: () => {
        fakeRequests++;
        return Response.json({ data: [{ id: "up-1", owned_by: "z-ai" }, { id: "other" }] });
      },
    });
    process.env.CPA_BASE_URL = `http://127.0.0.1:${fake.port}`;
    process.env.CPA_ACCESS_KEY = "k";
    try {
      const res = await req(app, "/api/v1/admin/cpa/models", { cookie });
      if (res.status !== 200) {
        // Surface the route's error payload (code/message only; no secrets) so
        // a flaky 502 is diagnosable from CI logs.
        const body = await res.text();
        throw new Error(
          `GET /api/v1/admin/cpa/models -> ${res.status}; body=${body}; fakeRequests=${fakeRequests}`,
        );
      }
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
      if (prevBase === undefined) delete process.env.CPA_BASE_URL;
      else process.env.CPA_BASE_URL = prevBase;
      if (prevKey === undefined) delete process.env.CPA_ACCESS_KEY;
      else process.env.CPA_ACCESS_KEY = prevKey;
    }
  });
});
