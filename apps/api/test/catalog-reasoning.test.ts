// Catalog reasoning route metadata (parity plan Task 1):
// - getReasoningMetadata returns default effort + enabled routes (owner's
//   example: public max/xhigh/low -> CPA z-ai/glm-5.3-flash high/high/none).
// - validateReasoningRequest parses OpenRouter/OpenAI/Anthropic forms,
//   rejects conflicts/budget forms/invalid values, and resolves routes.
// - Admin API: reasoning-route create (with re-author replace + audit) and
//   list; default_reasoning_effort on model create/update; non-admin 403.
import { afterEach, describe, expect, test } from "bun:test";
import type { Db } from "@hoborouter/db";
import { createTestDb } from "@hoborouter/db";
import { createAuth } from "../src/auth";
import { buildApp } from "../src/app";
import {
  getReasoningMetadata,
  REASONING_EFFORTS,
  validateReasoningRequest,
  type ReasoningEffort,
  type ReasoningMetadata,
  type ReasoningValidation,
} from "@hoborouter/catalog";
import { signUp, req, makeInstanceAdmin, userIdByEmail, q } from "./helpers";
import { sql } from "drizzle-orm";

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

async function seedExampleModel(db: Db) {
  const now = Date.now();
  await db.execute(
    sql`INSERT INTO models (id, public_id, slug, display_name, provider, context_window, enabled, published, default_reasoning_effort, created_at, updated_at) VALUES ('mdl-1','anthropic/claude-mythos-5','claude-mythos-5','Mythos 5','anthropic',128000,true,true,'medium',${now},${now})`,
  );
  await db.execute(
    sql`INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at) VALUES ('map-1','mdl-1','anthropic','claude-mythos-5-upstream',true,${now},${now})`,
  );
  // Owner's example: public max/xhigh/low -> CPA z-ai GLM route high/high/none.
  const routes: [string, string][] = [
    ["max", "high"],
    ["xhigh", "high"],
    ["low", "none"],
    ["medium", "high"],
  ];
  for (const [i, [pub, up]] of routes.entries()) {
    await db.execute(
      sql`INSERT INTO model_reasoning_routes (id, model_id, public_effort, provider, upstream_model, upstream_effort, enabled, created_at, updated_at) VALUES (${"rr-" + i},'mdl-1',${pub},'z-ai','z-ai/glm-5.3-flash',${up},true,${now + i},${now + i})`,
    );
  }
}

const metadataWithRoutes = (): ReasoningMetadata => ({
  model_id: "mdl-1",
  default_effort: "medium",
  routes: [
    {
      public_effort: "max",
      provider: "z-ai",
      upstream_model: "z-ai/glm-5.3-flash",
      upstream_effort: "high",
    },
    {
      public_effort: "xhigh",
      provider: "z-ai",
      upstream_model: "z-ai/glm-5.3-flash",
      upstream_effort: "high",
    },
    {
      public_effort: "low",
      provider: "z-ai",
      upstream_model: "z-ai/glm-5.3-flash",
      upstream_effort: "none",
    },
    {
      public_effort: "medium",
      provider: "z-ai",
      upstream_model: "z-ai/glm-5.3-flash",
      upstream_effort: "high",
    },
  ],
});

describe("getReasoningMetadata", () => {
  test("returns default effort and enabled routes for the example mapping", async () => {
    const t = await createTestDb();
    drops.push(t.drop);
    await seedExampleModel(t.db);
    const meta = await getReasoningMetadata(t.db, "mdl-1");
    expect(meta.model_id).toBe("mdl-1");
    expect(meta.default_effort).toBe("medium");
    const byEffort = new Map(meta.routes.map((r) => [r.public_effort, r]));
    expect(byEffort.get("max")?.upstream_model).toBe("z-ai/glm-5.3-flash");
    expect(byEffort.get("max")?.upstream_effort).toBe("high");
    expect(byEffort.get("xhigh")?.upstream_effort).toBe("high");
    expect(byEffort.get("low")?.upstream_effort).toBe("none");
    expect(byEffort.get("medium")?.upstream_effort).toBe("high");
  });

  test("model without metadata yields empty routes and null default", async () => {
    const t = await createTestDb();
    drops.push(t.drop);
    const now = Date.now();
    await t.db.execute(
      sql`INSERT INTO models (id, public_id, slug, display_name, provider, context_window, enabled, published, created_at, updated_at) VALUES ('mdl-2','x/y','y','Y','z',1000,true,true,${now},${now})`,
    );
    const meta = await getReasoningMetadata(t.db, "mdl-2");
    expect(meta.default_effort).toBeNull();
    expect(meta.routes).toEqual([]);
  });
});

describe("validateReasoningRequest", () => {
  const meta = metadataWithRoutes();

  test("no reasoning form passes through with no route", () => {
    const v = validateReasoningRequest({ model: "m", messages: [] }, meta);
    expect(v).toEqual({ ok: true, effort: null, route: null });
  });

  test("OpenAI reasoning_effort resolves the route (max -> high upstream)", () => {
    const v = validateReasoningRequest({ reasoning_effort: "max" }, meta);
    expect(v.ok).toBe(true);
    if (v.ok && v.route) {
      expect(v.effort).toBe("max");
      expect(v.route.upstream_model).toBe("z-ai/glm-5.3-flash");
      expect(v.route.upstream_effort).toBe("high");
    }
  });

  test("OpenRouter reasoning.effort resolves (xhigh -> high upstream)", () => {
    const v = validateReasoningRequest({ reasoning: { effort: "xhigh" } }, meta);
    expect(v.ok).toBe(true);
    if (v.ok && v.route) expect(v.route.upstream_effort).toBe("high");
  });

  test("OpenRouter reasoning.enabled=false resolves the none route (low -> none upstream)", () => {
    const v = validateReasoningRequest({ reasoning: { enabled: false } }, meta);
    expect(v.ok).toBe(true);
    if (v.ok && v.route) {
      expect(v.effort).toBe("none");
      expect(v.route.upstream_effort).toBe("none");
    }
  });

  test("Anthropic thinking adaptive resolves the default effort", () => {
    const v = validateReasoningRequest({ thinking: { type: "adaptive" } }, meta);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.effort).toBe("medium");
  });

  test("Anthropic thinking disabled resolves effort none", () => {
    const v = validateReasoningRequest({ thinking: { type: "disabled" } }, meta);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.effort).toBe("none");
  });

  test("output_config.effort resolves like reasoning.effort", () => {
    const v = validateReasoningRequest({ output_config: { effort: "low" } }, meta);
    expect(v.ok).toBe(true);
    if (v.ok && v.route) expect(v.route.upstream_effort).toBe("none");
  });

  test("conflicting efforts across forms are rejected", () => {
    const v = validateReasoningRequest(
      { reasoning: { effort: "high" }, reasoning_effort: "low" },
      meta,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("conflicting_reasoning");
  });

  test("thinking enabled with budget_tokens conflicts with an explicit effort", () => {
    const v = validateReasoningRequest(
      { thinking: { type: "enabled", budget_tokens: 2048 }, reasoning_effort: "low" },
      meta,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("conflicting_reasoning");
  });

  test("budget-only forms are unsupported (effort-keyed catalog), not billed", () => {
    for (const body of [
      { reasoning: { max_tokens: 2048 } },
      { thinking: { type: "enabled", budget_tokens: 2048 } },
    ]) {
      const v = validateReasoningRequest(body, meta);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.code).toBe("unsupported_reasoning");
    }
  });

  test("reasoning.effort and reasoning.max_tokens are mutually exclusive", () => {
    const v = validateReasoningRequest({ reasoning: { effort: "low", max_tokens: 100 } }, meta);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("conflicting_reasoning");
  });

  test("unrouted effort is unsupported before any billing", () => {
    const v = validateReasoningRequest({ reasoning_effort: "minimal" }, meta);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("unsupported_reasoning");
  });

  test("invalid effort strings and shapes are rejected", () => {
    for (const body of [
      { reasoning_effort: "ultra" },
      { reasoning: { effort: 5 } },
      { reasoning: "high" },
      { thinking: { type: "enabled" } },
      { thinking: { type: "extreme" } },
    ]) {
      const v = validateReasoningRequest(body, meta);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.code).toBe("invalid_reasoning");
    }
  });

  test("identical restatements of the same effort do not conflict", () => {
    const v = validateReasoningRequest(
      { reasoning: { effort: "low" }, output_config: { effort: "low" } },
      meta,
    );
    expect(v.ok).toBe(true);
  });

  test("no metadata: well-formed requests pass through untouched (CPA owns conversion)", () => {
    for (const [body, effort] of [
      [{ reasoning_effort: "high" }, "high"],
      [{ reasoning: { effort: "max" } }, "max"],
      [{ thinking: { type: "adaptive" } }, null],
      [{ reasoning: { max_tokens: 2048 } }, null],
    ] as [Record<string, unknown>, ReasoningEffort | null][]) {
      const v = validateReasoningRequest(body, null);
      expect(v).toEqual({ ok: true, effort, route: null } satisfies ReasoningValidation);
    }
  });

  test("conflicting forms are rejected even without metadata", () => {
    const v = validateReasoningRequest(
      { reasoning: { max_tokens: 100 }, reasoning_effort: "low" },
      null,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("conflicting_reasoning");
  });

  test("REASONING_EFFORTS covers the canonical ladder", () => {
    expect([...REASONING_EFFORTS]).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
});

describe("admin reasoning metadata API", () => {
  test("non-admin gets 403 on reasoning routes", async () => {
    const { db, app, cookie } = await setup({ admin: false });
    await seedExampleModel(db);
    const res = await req(app, "/api/v1/admin/catalog/models/mdl-1/reasoning-routes", { cookie });
    expect(res.status).toBe(403);
  });

  test("admin lists seeded routes and re-authoring replaces with audit", async () => {
    const { db, app, cookie } = await setup();
    await seedExampleModel(db);
    const listRes = await req(app, "/api/v1/admin/catalog/models/mdl-1/reasoning-routes", {
      cookie,
    });
    expect(listRes.status).toBe(200);
    const routes = (await listRes.json()) as { public_effort: string; enabled: boolean }[];
    expect(routes.filter((r) => r.enabled).length).toBe(4);

    const res = await req(app, "/api/v1/admin/catalog/models/mdl-1/reasoning-routes", {
      method: "POST",
      cookie,
      body: {
        public_effort: "low",
        provider: "z-ai",
        upstream_model: "z-ai/glm-5.3-flash",
        upstream_effort: "minimal",
      },
    });
    expect(res.status).toBe(201);
    const after = (await req(app, "/api/v1/admin/catalog/models/mdl-1/reasoning-routes", {
      cookie,
    }).then((r) => r.json())) as {
      public_effort: string;
      enabled: boolean;
    }[];
    const low = after.filter((r) => r.public_effort === "low");
    expect(low.length).toBe(2);
    expect(low.filter((r) => r.enabled).length).toBe(1);
    const audit = await q(
      db,
      "SELECT action FROM audit_log WHERE action = 'catalog.reasoning_route.update'",
    );
    expect(audit.length).toBe(1);
  });

  test("no-op re-author returns changed=false without a new row", async () => {
    const { db, app, cookie } = await setup();
    await seedExampleModel(db);
    const res = await req(app, "/api/v1/admin/catalog/models/mdl-1/reasoning-routes", {
      method: "POST",
      cookie,
      body: {
        public_effort: "max",
        provider: "z-ai",
        upstream_model: "z-ai/glm-5.3-flash",
        upstream_effort: "high",
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changed?: boolean };
    expect(body.changed).toBe(false);
    const count = await q(db, "SELECT COUNT(*) c FROM model_reasoning_routes");
    expect(count[0]?.c).toBe(4);
  });

  test("invalid effort or missing upstream_model is rejected", async () => {
    const { db, app, cookie } = await setup();
    await seedExampleModel(db);
    for (const body of [
      { public_effort: "ultra", upstream_model: "x" },
      { public_effort: "low", upstream_effort: "ultra", upstream_model: "x" },
      { public_effort: "low" },
    ]) {
      const res = await req(app, "/api/v1/admin/catalog/models/mdl-1/reasoning-routes", {
        method: "POST",
        cookie,
        body,
      });
      expect(res.status).toBe(400);
    }
  });

  test("default_reasoning_effort is settable on create and update", async () => {
    const { db, app, cookie } = await setup();
    await seedExampleModel(db);
    const created = await req(app, "/api/v1/admin/catalog/models", {
      method: "POST",
      cookie,
      body: {
        public_id: "z/glm",
        slug: "glm",
        display_name: "GLM",
        provider: "z-ai",
        default_reasoning_effort: "high",
      },
    });
    expect(created.status).toBe(201);
    const bad = await req(app, "/api/v1/admin/catalog/models", {
      method: "POST",
      cookie,
      body: {
        public_id: "z/glm2",
        slug: "glm2",
        display_name: "GLM2",
        provider: "z",
        default_reasoning_effort: "ultra",
      },
    });
    expect(bad.status).toBe(400);
    const updated = await req(app, "/api/v1/admin/catalog/models/mdl-1", {
      method: "PUT",
      cookie,
      body: { default_reasoning_effort: null },
    });
    expect(updated.status).toBe(200);
    const rows = await q<{ default_reasoning_effort: string | null }>(
      db,
      "SELECT default_reasoning_effort FROM models WHERE id = 'mdl-1'",
    );
    expect(rows[0]?.default_reasoning_effort).toBeNull();
  });
});
