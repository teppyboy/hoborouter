// Workspace wallet endpoint exposes usd_vnd_rate (same env billing uses) and
// customer usage-logs responses never leak upstream_model.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Elysia } from "elysia";
import { sql } from "drizzle-orm";
import { createTestDb, type Db } from "@hoborouter/db";
import { dashboardRoutes } from "../src/routes/dashboard";

const ws = "ws-usd";
let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;

const authAs = (userId: string) => ({
  handler: async () => new Response("", { status: 404 }),
  api: { getSession: async () => ({ user: { id: userId }, session: { id: "s", userId } }) },
});

let app: ReturnType<typeof dashboardRoutes>;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  const now = Date.now();
  await db.execute(
    sql`INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES ('u1','U','u@t.test',true,${now},${now})`,
  );
  await db.execute(
    sql`INSERT INTO workspaces (id, name, status, created_at) VALUES (${ws},'ws','active',${now})`,
  );
  await db.execute(
    sql`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${ws},'u1','owner')`,
  );
  await db.execute(
    sql`INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at) VALUES (${`wal-${ws}`},${ws},'VND',100000,0,0,${now})`,
  );
  await db.execute(
    sql`INSERT INTO models (id, public_id, slug, display_name, provider, enabled, published, created_at, updated_at) VALUES ('m-1','gpt-public','gpt-public','GPT','vendor',true,true,${now},${now})`,
  );
  await db.execute(
    sql`INSERT INTO requests (id, workspace_id, endpoint, mode, status, dispatch_state, model_id, created_at) VALUES ('req-1',${ws},'/v1/chat/completions','non-stream','ok','terminal','m-1',${now})`,
  );
  await db.execute(
    sql`INSERT INTO usage_logs (id, idempotency_key, request_id, workspace_id, provider, public_model, upstream_model, input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, status, created_at) VALUES ('log-1','idem-1','req-1',${ws},'openrouter','gpt-public','gpt-secret-upstream-xyz',10,5,0,0,'ok',${now})`,
  );
  app = new Elysia().use(dashboardRoutes(db, authAs("u1")));
});

afterAll(async () => {
  await t.drop();
});

const get = (path: string) => app.handle(new Request(`http://localhost${path}`));

describe("GET /workspaces/:id/wallet", () => {
  test("returns usd_vnd_rate matching HBR_USD_VND_RATE", async () => {
    process.env.HBR_USD_VND_RATE = "27000";
    const res = await get(`/api/v1/workspaces/${ws}/wallet`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { usd_vnd_rate: number; available: number };
    expect(body.usd_vnd_rate).toBe(27000);
    expect(body.available).toBe(100000);
    delete process.env.HBR_USD_VND_RATE;
  });

  test("defaults to 26000 when env unset", async () => {
    const res = await get(`/api/v1/workspaces/${ws}/wallet`);
    const body = (await res.json()) as { usd_vnd_rate: number };
    expect(body.usd_vnd_rate).toBe(26000);
  });
});

describe("usage-logs leak guard", () => {
  test("no upstream_model key, no upstream id string", async () => {
    const res = await get(`/api/v1/workspaces/${ws}/usage-logs`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("upstream_model");
    expect(text).not.toContain("gpt-secret-upstream-xyz");
    expect(text).toContain("gpt-public");
  });
});
