// Canonical catalog admin API (/api/v1/admin/catalog) — instance-admin only,
// atomic audit, immutable prices — and canonical /v1/models listing.
import { describe, expect, test, beforeAll } from "bun:test";
import type { Db } from "@hoborouter/db";
import { makeApp, signUp, req, makeInstanceAdmin, userIdByEmail, q } from "./helpers";

let db: Db;
let app: Awaited<ReturnType<typeof makeApp>>["app"];
let iadmin: string;
let owner: string;
let key: string;
const MODEL = {
  public_id: "openai/gpt-catalog",
  slug: "gpt-catalog",
  display_name: "GPT Catalog",
  provider: "openai",
  description: "test model",
  capabilities: ["chat", "tools"],
  context_window: 128000,
  enabled: true,
  published: true,
};

async function createModel(overrides: Record<string, unknown> = {}) {
  const res = await req(app, "/api/v1/admin/catalog/models", {
    method: "POST",
    cookie: iadmin,
    body: { ...MODEL, ...overrides },
  });
  const { id } = (await res.json()) as { id?: string };
  return { res, id: id ?? "" };
}

async function addPrice(modelId: string, input = 500) {
  return req(app, `/api/v1/admin/catalog/models/${modelId}/prices`, {
    method: "POST",
    cookie: iadmin,
    body: {
      input_usd_micro_per_1m: input,
      output_usd_micro_per_1m: 1500,
      cached_input_usd_micro_per_1m: 250,
      reasoning_usd_micro_per_1m: 1000,
      markup_ppm: 100000,
    },
  });
}

async function addMapping(modelId: string, upstream = "gpt-4o-mini") {
  return req(app, `/api/v1/admin/catalog/models/${modelId}/mappings`, {
    method: "POST",
    cookie: iadmin,
    body: { provider: "openai", upstream_model: upstream, enabled: true },
  });
}

beforeAll(async () => {
  const made = await makeApp();
  db = made.db;
  app = made.app;
  iadmin = await signUp(app, "catalog-admin@example.com", "IA");
  await makeInstanceAdmin(db, await userIdByEmail(db, "catalog-admin@example.com"));
  owner = await signUp(app, "catalog-owner@example.com", "O");
  const wsOwner = await signUp(app, "catalog-wsowner@example.com", "W");
  const wsRes = await req(app, "/api/v1/workspaces", {
    method: "POST",
    cookie: wsOwner,
    body: { name: "ws" },
  });
  const wsId = ((await wsRes.json()) as { id: string }).id;
  const keyRes = await req(app, `/api/v1/workspaces/${wsId}/keys`, {
    method: "POST",
    cookie: wsOwner,
    body: { name: "k" },
  });
  key = ((await keyRes.json()) as { plaintext: string }).plaintext;
});

describe("POST /api/v1/admin/catalog/models", () => {
  test("unauthenticated → 401", async () => {
    expect(
      (await req(app, "/api/v1/admin/catalog/models", { method: "POST", body: MODEL })).status,
    ).toBe(401);
  });

  test("non-admin → 403", async () => {
    const res = await req(app, "/api/v1/admin/catalog/models", {
      method: "POST",
      cookie: owner,
      body: MODEL,
    });
    expect(res.status).toBe(403);
  });

  test("instance admin → 201 with valid public_id; audit written", async () => {
    const { res, id } = await createModel();
    expect(res.status).toBe(201);
    expect(id).toBeDefined();
    const audit = await q(
      db,
      "SELECT * FROM audit_log WHERE target = ? AND action = 'catalog.model.create'",
      id,
    );
    expect(audit.length).toBe(1);
  });

  test("bad public_id variants → 400", async () => {
    for (const public_id of [
      "OpenAI/gpt",
      "openai/GPT",
      "openai/",
      "/gpt",
      "openai/gpt x",
      "openai//gpt",
    ]) {
      const { res } = await createModel({ public_id });
      expect(res.status, public_id).toBe(400);
    }
  });

  test("public_id accepts bare slug or provider/name; slug derives correctly", async () => {
    for (const [public_id, expectedSlug] of [
      ["auto", "auto"],
      ["my-model", "my-model"],
      ["provider/my-model", "my-model"],
    ] as const) {
      const { res, id } = await createModel({
        public_id,
        slug: expectedSlug,
        provider: "p",
      });
      expect(res.status, public_id).toBe(201);
      const row = (
        await q<{ public_id: string; slug: string }>(
          db,
          "SELECT public_id, slug FROM models WHERE id = ?",
          id,
        )
      )[0]!;
      expect(row.public_id).toBe(public_id);
      expect(row.slug).toBe(expectedSlug);
    }
  });

  test("duplicate public_id → 409", async () => {
    await createModel({ slug: "dup1" });
    const res = await req(app, "/api/v1/admin/catalog/models", {
      method: "POST",
      cookie: iadmin,
      body: { ...MODEL, slug: "dup2" },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("DUPLICATE");
  });

  test("bad context_window / capabilities → 400", async () => {
    expect((await createModel({ slug: "cw0", context_window: 0 })).res.status).toBe(400);
    expect((await createModel({ slug: "cwF", context_window: 1.5 })).res.status).toBe(400);
    expect((await createModel({ slug: "capS", capabilities: ["chat", 5] })).res.status).toBe(400);
    expect(
      (await createModel({ slug: "ok-null", public_id: "openai/ok-null", context_window: null }))
        .res.status,
    ).toBe(201);
  });
});

describe("PUT /api/v1/admin/catalog/models/:id", () => {
  test("updates fields; audit written", async () => {
    const { id } = await createModel({ slug: "put-model", public_id: "openai/put-model" });
    const res = await req(app, `/api/v1/admin/catalog/models/${id}`, {
      method: "PUT",
      cookie: iadmin,
      body: { display_name: "Renamed", published: true },
    });
    expect(res.status).toBe(200);
    const row = (
      await q<{ display_name: string }>(db, "SELECT display_name FROM models WHERE id = ?", id)
    )[0]!;
    expect(row.display_name).toBe("Renamed");
    const audit = await q(
      db,
      "SELECT * FROM audit_log WHERE target = ? AND action = 'catalog.model.update'",
      id,
    );
    expect(audit.length).toBe(1);
  });

  test("non-admin → 403", async () => {
    const { id } = await createModel({ slug: "put-403", public_id: "openai/put-403" });
    const res = await req(app, `/api/v1/admin/catalog/models/${id}`, {
      method: "PUT",
      cookie: owner,
      body: { display_name: "x" },
    });
    expect(res.status).toBe(403);
  });
});

describe("mappings + prices", () => {
  test("add mapping and immutable prices; audit rows written", async () => {
    const { id } = await createModel({ slug: "price-model", public_id: "openai/price-model" });
    expect((await addMapping(id!)).status).toBe(201);
    expect((await addPrice(id!)).status).toBe(201);
    const prices = await q<{ id: string; input_usd_micro_per_1m: number }>(
      db,
      "SELECT id, input_usd_micro_per_1m FROM model_prices WHERE model_id = ? ORDER BY effective_at, id",
      id,
    );
    expect(prices.length).toBe(1);
    const audit = (
      await q<{ c: string }>(
        db,
        "SELECT COUNT(*) c FROM audit_log WHERE target = ? AND action LIKE 'catalog.%'",
        id,
      )
    )[0]!;
    expect(Number(audit.c)).toBe(3); // create + mapping + price

    // Price change = NEW row; old row unchanged.
    const before = prices[0]!;
    expect((await addPrice(id!, 700)).status).toBe(201);
    const after = await q<{ id: string; input_usd_micro_per_1m: number }>(
      db,
      "SELECT id, input_usd_micro_per_1m FROM model_prices WHERE model_id = ? ORDER BY effective_at, id",
      id,
    );
    expect(after.length).toBe(2);
    expect(after[0]!.id).toBe(before.id);
    expect(after[0]!.input_usd_micro_per_1m).toBe(500);
    expect(after[1]!.input_usd_micro_per_1m).toBe(700);
  });

  test("invalid prices → 400 (negative, fraction, MAX_SAFE_INTEGER_MONEY + 1)", async () => {
    const { id } = await createModel({ slug: "bad-price", public_id: "openai/bad-price" });
    for (const input of [-1, 1.5, 9007199254740992]) {
      const res = await req(app, `/api/v1/admin/catalog/models/${id}/prices`, {
        method: "POST",
        cookie: iadmin,
        body: {
          input_usd_micro_per_1m: input,
          output_usd_micro_per_1m: 1,
          cached_input_usd_micro_per_1m: 0,
          reasoning_usd_micro_per_1m: 0,
          markup_ppm: 0,
        },
      });
      expect(res.status, String(input)).toBe(400);
    }
  });

  test("non-admin mapping/price → 403", async () => {
    const { id } = await createModel({ slug: "forbidden", public_id: "openai/forbidden" });
    expect(
      (
        await req(app, `/api/v1/admin/catalog/models/${id}/mappings`, {
          method: "POST",
          cookie: owner,
          body: { provider: "openai", upstream_model: "x", enabled: true },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await req(app, `/api/v1/admin/catalog/models/${id}/prices`, {
          method: "POST",
          cookie: owner,
          body: {
            input_usd_micro_per_1m: 1,
            output_usd_micro_per_1m: 1,
            cached_input_usd_micro_per_1m: 0,
            reasoning_usd_micro_per_1m: 0,
            markup_ppm: 0,
          },
        })
      ).status,
    ).toBe(403);
  });
});

describe("GET /v1/models (canonical)", () => {
  test("lists only canonical models (enabled+published+mapping+price) in OpenAI shape", async () => {
    const res = await req(app, "/v1/models", {
      headers: { authorization: "Bearer sk-hbr-invalid" },
    });
    expect(res.status).toBe(401); // key auth kept

    const { id } = await createModel({ slug: "v1-model", public_id: "openai/v1-model" });
    await addMapping(id!);
    await addPrice(id!);
    const listed = await req(app, "/v1/models", {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(listed.status).toBe(200);
    const json = (await listed.json()) as {
      object: string;
      data: { id: string; object: string; created: number; owned_by: string }[];
    };
    expect(json.object).toBe("list");
    const entry = json.data.find((m) => m.id === "openai/v1-model");
    expect(entry).toBeDefined();
    expect(entry!.object).toBe("model");
    expect(entry!.owned_by).toBe("openai");
    expect(typeof entry!.created).toBe("number");
  });

  test("excluded when unpublished / no mapping / no price", async () => {
    const a = await createModel({ slug: "unpub-v1", public_id: "openai/unpub-v1" });
    await addMapping(a.id!);
    await addPrice(a.id!);
    await req(app, `/api/v1/admin/catalog/models/${a.id}`, {
      method: "PUT",
      cookie: iadmin,
      body: { published: false },
    });
    const b = await createModel({ slug: "nomap-v1", public_id: "openai/nomap-v1" });
    await addPrice(b.id!);
    const c = await createModel({ slug: "noprice-v1", public_id: "openai/noprice-v1" });
    await addMapping(c.id!);
    const listed = await req(app, "/v1/models", {
      headers: { authorization: `Bearer ${key}` },
    });
    const ids = ((await listed.json()) as { data: { id: string }[] }).data.map((m) => m.id);
    expect(ids).not.toContain("openai/unpub-v1");
    expect(ids).not.toContain("openai/nomap-v1");
    expect(ids).not.toContain("openai/noprice-v1");
    expect(ids).not.toContain("global-model");
  });
});

describe("PUT public_id collision + /v1/models/:id gating", () => {
  test("PUT to a colliding public_id → 409 DUPLICATE, no row change, no audit", async () => {
    const a = await createModel({ slug: "col-a", public_id: "openai/col-a" });
    await createModel({ slug: "col-b", public_id: "openai/col-b" });
    const auditsBefore = Number(
      (
        await q<{ c: string }>(
          db,
          "SELECT COUNT(*) c FROM audit_log WHERE action = 'catalog.model.update'",
        )
      )[0]!.c,
    );
    const res = await req(app, `/api/v1/admin/catalog/models/${a.id}`, {
      method: "PUT",
      cookie: iadmin,
      body: { public_id: "openai/col-b" },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error).toMatchObject({
      code: "DUPLICATE",
    });
    const row = (
      await q<{ public_id: string }>(db, "SELECT public_id FROM models WHERE id = ?", a.id)
    )[0]!;
    expect(row.public_id).toBe("openai/col-a");
    const auditsAfter = Number(
      (
        await q<{ c: string }>(
          db,
          "SELECT COUNT(*) c FROM audit_log WHERE action = 'catalog.model.update'",
        )
      )[0]!.c,
    );
    expect(auditsAfter).toBe(auditsBefore);
  });

  test("PUT with changed public_id → 200 rename, new slug, rename audit, same id", async () => {
    const m = await createModel({ slug: "immutable-id", public_id: "openai/immutable-id" });
    const res = await req(app, `/api/v1/admin/catalog/models/${m.id}`, {
      method: "PUT",
      cookie: iadmin,
      body: { public_id: "openai/renamed-id" },
    });
    expect(res.status).toBe(200);
    const row = (
      await q<{ public_id: string; slug: string }>(
        db,
        "SELECT public_id, slug FROM models WHERE id = ?",
        m.id,
      )
    )[0]!;
    expect(row.public_id).toBe("openai/renamed-id");
    expect(row.slug).toBe("renamed-id");
    const audit = (
      await q<{ detail: string }>(
        db,
        "SELECT detail FROM audit_log WHERE target = ? AND action = 'catalog.model.rename'",
        m.id,
      )
    )[0]!;
    expect(JSON.parse(audit.detail)).toMatchObject({
      from: "openai/immutable-id",
      to: "openai/renamed-id",
    });
  });

  test("/v1/models/:id → 404 for unpublished model", async () => {
    const u = await createModel({ slug: "unpub-id", public_id: "openai/unpub-id" });
    await addMapping(u.id);
    await addPrice(u.id);
    await req(app, `/api/v1/admin/catalog/models/${u.id}`, {
      method: "PUT",
      cookie: iadmin,
      body: { published: false },
    });
    const res = await req(app, "/v1/models/openai/unpub-id", {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(404);
  });
});
