// Auto-routing regression tests (P1-4): requests for `hoborouter/auto`
// resolve ONCE to the cheapest eligible published candidate BEFORE
// cap/reserve, bill the resolved model's real price snapshot (never the auto
// alias's price), never intercept normal public ids, respect key-model
// permissions (unauthorized candidate => rejected with NO reservation), and
// fall back to the configured auto model's single route when nothing is
// eligible. Exactly one CPA request per gateway call.
import { describe, expect, test, afterAll } from "bun:test";
import type { Db } from "@hoborouter/db";
import { sql } from "drizzle-orm";
import { hashApiKey } from "@hoborouter/keys";
import { makeApp, signUp, req, makeInstanceAdmin, userIdByEmail, q } from "./helpers";
import { resolveAutoModel } from "../src/auto-resolve";

type App = Awaited<ReturnType<typeof makeApp>>["app"];

const CPA_KEY = "test-cpa-secret";

const captured: { body: string }[] = [];
const fakeCpa = Bun.serve({
  port: 0,
  fetch: async (req) => {
    if (new URL(req.url).pathname !== "/v1/chat/completions")
      return Response.json({ error: "nf" }, { status: 404 });
    if (req.headers.get("authorization") !== `Bearer ${CPA_KEY}`)
      return Response.json({ error: "unauthorized" }, { status: 401 });
    const body = await req.text();
    captured.push({ body });
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return Response.json({
      id: "chatcmpl-x",
      object: "chat.completion",
      model: parsed.model,
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    });
  },
});

process.env.CPA_BASE_URL = `http://127.0.0.1:${fakeCpa.port}`;
process.env.CPA_ACCESS_KEY = CPA_KEY;
afterAll(() => {
  fakeCpa.stop(true);
  delete process.env.CPA_BASE_URL;
  delete process.env.CPA_ACCESS_KEY;
});

// Per-model upstream id so assertions can tell exactly which model routed.
interface CandidateSpec {
  public_id: string;
  upstream: string;
  input: number;
  output: number;
  caps: string[];
  ctx: number;
  eligible: boolean;
  published?: boolean;
}
const CANDIDATES: CandidateSpec[] = [
  {
    public_id: "cheap",
    upstream: "up/cheap",
    input: 1000000,
    output: 2000000,
    caps: ["chat", "tools"],
    ctx: 100000,
    eligible: true,
  },
  {
    public_id: "pricey",
    upstream: "up/pricey",
    input: 9000000,
    output: 9000000,
    caps: ["chat", "tools"],
    ctx: 100000,
    eligible: true,
  },
  {
    public_id: "unpub",
    upstream: "up/unpub",
    input: 1,
    output: 1,
    caps: ["chat"],
    ctx: 100000,
    eligible: true,
    published: false,
  },
];

async function setup() {
  const { db, app } = await makeApp();
  const email = `auto-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const cookie = await signUp(app, email);
  await makeInstanceAdmin(db, await userIdByEmail(db, email));

  // The configured auto model (existing single route / fallback).
  await createModel(app, cookie, {
    public_id: "hoborouter/auto",
    upstream: "up/auto",
    input: 5000000,
    output: 5000000,
    ctx: 128000,
  });
  for (const c of CANDIDATES) {
    const id = await createModel(app, cookie, {
      public_id: c.public_id,
      upstream: c.upstream,
      input: c.input,
      output: c.output,
      ctx: c.ctx,
      capabilities: c.caps,
      published: c.published ?? true,
    });
    if (c.eligible) {
      const toggled = await toggleAuto(app, cookie, id, true);
      expect(toggled.status).toBe(200);
    }
  }

  const key = "sk-hbr-auto-base-key";
  await seedWalletAndKey(db, "ws-ar", "wal-ar", "key-ar", key);
  return { db, app, cookie, key };
}

async function createModel(
  app: App,
  cookie: string,
  m: {
    public_id: string;
    upstream: string;
    input: number;
    output: number;
    ctx: number;
    capabilities?: string[];
    published?: boolean;
  },
): Promise<string> {
  const created = await req(app, "/api/v1/admin/catalog/models", {
    method: "POST",
    cookie,
    body: {
      public_id: m.public_id,
      slug: m.public_id.split("/").pop(),
      display_name: m.public_id,
      provider: "z-ai",
      capabilities: m.capabilities ?? null,
      context_window: m.ctx,
      enabled: true,
      published: m.published ?? true,
    },
  });
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const mapping = await req(app, `/api/v1/admin/catalog/models/${id}/mappings`, {
    method: "POST",
    cookie,
    body: { provider: "cpa", upstream_model: m.upstream, enabled: true },
  });
  expect(mapping.status).toBe(201);
  const price = await req(app, `/api/v1/admin/catalog/models/${id}/prices`, {
    method: "POST",
    cookie,
    body: {
      input_usd_micro_per_1m: m.input,
      output_usd_micro_per_1m: m.output,
      cached_input_usd_micro_per_1m: 0,
      reasoning_usd_micro_per_1m: 0,
      markup_ppm: 1200000,
    },
  });
  expect(price.status).toBe(201);
  return id;
}

function toggleAuto(app: App, cookie: string, modelId: string, value: unknown) {
  return req(app, `/api/v1/admin/catalog/models/${modelId}`, {
    method: "PUT",
    cookie,
    body: { auto_eligible: value },
  });
}

async function seedWalletAndKey(
  db: Db,
  wsId: string,
  walletId: string,
  keyId: string,
  plaintext: string,
  permittedModelIds?: string[],
) {
  const now = Date.now();
  await db.execute(
    sql`INSERT INTO workspaces (id, name, status, created_at) VALUES (${wsId},${wsId},'active',${now})`,
  );
  await db.execute(
    sql`INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at) VALUES (${walletId},${wsId},'VND',1000000000,0,0,${now})`,
  );
  await db.execute(
    sql`INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at) VALUES (${keyId},${wsId},${hashApiKey(plaintext)},'sk-hbr-x...','k','active',${now})`,
  );
  for (const modelId of permittedModelIds ?? []) {
    await db.execute(
      sql`INSERT INTO api_key_model_permissions (api_key_id, model_id, created_at) VALUES (${keyId},${modelId},${now})`,
    );
  }
}

async function modelIdByPublicId(db: Db, publicId: string): Promise<string> {
  const rows = await q<{ id: string }>(db, "SELECT id FROM models WHERE public_id = ?", publicId);
  return rows[0]!.id;
}

const chat = (app: App, key: string, body: object) =>
  req(app, "/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body,
  });

describe("auto routing", () => {
  test("resolves cheapest eligible candidate, bills its price snapshot, exactly one CPA request", async () => {
    const { db, app, key } = await setup();
    const before = captured.length;
    const res = await chat(app, key, {
      model: "hoborouter/auto",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    // One-time resolution: exactly one CPA dispatch, no retry/failover.
    expect(captured.length - before).toBe(1);
    expect(JSON.parse(captured[before]!.body).model).toBe("up/cheap");
    // Client sees the resolved PUBLIC model, never the upstream id.
    expect(((await res.json()) as { model: string }).model).toBe("cheap");

    const logs = await q<Record<string, unknown>>(
      db,
      "SELECT public_model, upstream_model, charged_vnd FROM usage_logs ORDER BY created_at DESC LIMIT 1",
    );
    // Billed the resolved model's real price snapshot (cheap: $1/$2 per 1M,
    // 1.2x markup, fx 26000 => 14 usd-micro => 1 VND), NOT the auto alias's
    // price and NOT a fabricated tier.
    expect(logs[0]!.public_model).toBe("cheap");
    expect(logs[0]!.upstream_model).toBe("up/cheap");
    expect(logs[0]!.charged_vnd).toBe(1);
    const resv = await q<{ model_id: string; cap_vnd: number }>(
      db,
      "SELECT br.model_id, br.cap_vnd FROM billing_reservations br ORDER BY br.created_at DESC LIMIT 1",
    );
    expect(resv[0]!.model_id).toBe(await modelIdByPublicId(db, "cheap"));
    expect(resv[0]!.cap_vnd).toBeGreaterThan(0);
  });

  test("no history => health label is unknown, not fabricated healthy", async () => {
    const { db } = await setup();
    const out = await resolveAutoModel(db, {
      apiKeyId: "key-ar",
      body: { messages: [{ role: "user", content: "hi" }] },
      bodyBytes: 64,
      fxRate: 26000,
    });
    expect(out?.model.public_id).toBe("cheap");
    expect(out?.health).toBe("unknown");
  });

  test("normal public ids are never intercepted", async () => {
    const { app, key } = await setup();
    const before = captured.length;
    const res = await chat(app, key, {
      model: "pricey",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    expect(captured.length - before).toBe(1);
    expect(JSON.parse(captured[before]!.body).model).toBe("up/pricey");
  });

  test("auto candidate must be allowed by key-model permissions, not just alias", async () => {
    const { db, app } = await setup();
    const key = "sk-hbr-auto-perm-key";
    await seedWalletAndKey(db, "ws-ar2", "wal-ar2", "key-ar2", key, [
      await modelIdByPublicId(db, "pricey"),
    ]);
    const before = captured.length;
    const res = await chat(app, key, {
      model: "hoborouter/auto",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    // cheapest (cheap) is not permitted => resolves to the permitted pricey.
    expect(JSON.parse(captured[before]!.body).model).toBe("up/pricey");
  });

  test("unauthorized candidate is rejected with no reservation", async () => {
    const { db, app } = await setup();
    const key = "sk-hbr-auto-denied-key";
    await seedWalletAndKey(db, "ws-ar3", "wal-ar3", "key-ar3", key, [
      await modelIdByPublicId(db, "unpub"),
    ]);
    const res = await chat(app, key, {
      model: "hoborouter/auto",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(403);
    const resv = await q<Record<string, unknown>>(
      db,
      "SELECT * FROM billing_reservations WHERE api_key_id = 'key-ar3'",
    );
    expect(resv.length).toBe(0);
    const reqs = await q<Record<string, unknown>>(
      db,
      "SELECT * FROM requests WHERE api_key_id = 'key-ar3'",
    );
    expect(reqs.length).toBe(0);
  });

  test("falls back to the configured auto model when nothing is eligible", async () => {
    const { db, app, cookie, key } = await setup();
    for (const publicId of ["cheap", "pricey", "unpub"]) {
      const id = await modelIdByPublicId(db, publicId);
      const off = await toggleAuto(app, cookie, id, false);
      expect(off.status).toBe(200);
    }
    const before = captured.length;
    const res = await chat(app, key, {
      model: "hoborouter/auto",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    expect(captured.length - before).toBe(1);
    expect(JSON.parse(captured[before]!.body).model).toBe("up/auto");
    expect(((await res.json()) as { model: string }).model).toBe("hoborouter/auto");
  });

  test("excludes candidates with recent upstream failures when a healthier one exists", async () => {
    const { db, app, key } = await setup();
    const cheapId = await modelIdByPublicId(db, "cheap");
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await db.execute(
        sql`INSERT INTO requests (id, workspace_id, api_key_id, model_id, endpoint, mode, status, dispatch_state, created_at) VALUES (${crypto.randomUUID()},'ws-ar','key-ar',${cheapId},'/v1/chat/completions','non-stream','upstream_error','terminal',${now - i})`,
      );
    }
    const before = captured.length;
    const res = await chat(app, key, {
      model: "hoborouter/auto",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(captured[before]!.body).model).toBe("up/pricey");
  });

  test("capability filtering: tools requests skip candidates without declared tools", async () => {
    const { db, app, cookie, key } = await setup();
    const toolless = await createModel(app, cookie, {
      public_id: "toolless",
      upstream: "up/toolless",
      input: 1,
      output: 1,
      ctx: 100000,
      capabilities: ["chat"],
    });
    expect((await toggleAuto(app, cookie, toolless, true)).status).toBe(200);
    const before = captured.length;
    const res = await chat(app, key, {
      model: "hoborouter/auto",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "f", parameters: {} } }],
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(captured[before]!.body).model).toBe("up/cheap");
    void db;
  });

  test("context filtering: candidates whose window cannot hold the request are skipped", async () => {
    const { db, app, cookie, key } = await setup();
    const tiny = await createModel(app, cookie, {
      public_id: "tiny",
      upstream: "up/tiny",
      input: 1,
      output: 1,
      ctx: 1000,
    });
    expect((await toggleAuto(app, cookie, tiny, true)).status).toBe(200);
    const bigBody = "x".repeat(2000);
    const before = captured.length;
    const res = await chat(app, key, {
      model: "hoborouter/auto",
      messages: [{ role: "user", content: bigBody }],
    });
    expect(res.status).toBe(200);
    // tiny (cheapest, ctx 1000 < 2000 body bytes) excluded => cheap.
    expect(JSON.parse(captured[before]!.body).model).toBe("up/cheap");
    void db;
  });

  test("auto toggle API: boolean whitelist, audited", async () => {
    const { db, app, cookie } = await setup();
    const id = await modelIdByPublicId(db, "cheap");
    const bad = await toggleAuto(app, cookie, id, "yes");
    expect(bad.status).toBe(400);
    const good = await toggleAuto(app, cookie, id, false);
    expect(good.status).toBe(200);
    const list = await req(app, "/api/v1/admin/catalog/models", { method: "GET", cookie });
    expect(list.status).toBe(200);
    const rows = (await list.json()) as { id: string; auto_eligible: boolean }[];
    expect(rows.find((r) => r.id === id)?.auto_eligible).toBe(false);
    const audit = await q<Record<string, unknown>>(
      db,
      "SELECT detail FROM audit_log WHERE action = 'catalog.model.update' AND target = ? ORDER BY created_at DESC LIMIT 1",
      id,
    );
    expect(JSON.stringify(audit[0]!.detail)).toContain("auto_eligible");
  });
});
