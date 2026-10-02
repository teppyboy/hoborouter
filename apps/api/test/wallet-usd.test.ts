// Workspace wallet endpoint exposes usd_vnd_rate (same env billing uses) and
// customer usage-logs responses never leak upstream_model.
import { describe, test, expect, beforeAll } from "bun:test";
import { Elysia } from "elysia";
import type { Database } from "bun:sqlite";
import { createDb, migrate } from "@hoborouter/db";
import { dashboardRoutes } from "../src/routes/dashboard";

const ws = "ws-usd";
let db: Database;

const authAs = (userId: string) => ({
  handler: async () => new Response("", { status: 404 }),
  api: { getSession: async () => ({ user: { id: userId }, session: { id: "s", userId } }) },
});

let app: ReturnType<typeof dashboardRoutes>;

beforeAll(() => {
  db = createDb(":memory:");
  migrate(db);
  db.prepare(
    "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?,?,?,1,?,?)",
  ).run("u1", "U", "u@t.test", Date.now(), Date.now());
  db.prepare("INSERT INTO workspaces (id, name, status, created_at) VALUES (?,?,'active',?)").run(
    ws,
    "ws",
    Date.now(),
  );
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?,?,'owner')").run(
    ws,
    "u1",
  );
  db.prepare(
    "INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at) VALUES (?,?, 'VND', 100000, 0, 0, ?)",
  ).run(`wal-${ws}`, ws, Date.now());
  const reqId = "req-1";
  db.prepare(
    "INSERT INTO models (id, public_id, slug, display_name, provider, enabled, published, created_at, updated_at) VALUES ('m-1','gpt-public','gpt-public','GPT','vendor',1,1,?,?)",
  ).run(Date.now(), Date.now());
  db.prepare(
    "INSERT INTO requests (id, workspace_id, endpoint, mode, status, dispatch_state, model_id, created_at) VALUES (?,?,?, 'non-stream', 'ok', 'terminal', 'm-1', ?)",
  ).run(reqId, ws, "/v1/chat/completions", Date.now());
  db.prepare(
    "INSERT INTO usage_logs (id, idempotency_key, request_id, workspace_id, provider, public_model, upstream_model, input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, status, created_at) VALUES ('log-1','idem-1',?,?,'openrouter','gpt-public','gpt-secret-upstream-xyz',10,5,0,0,'ok',?)",
  ).run(reqId, ws, Date.now());
  app = new Elysia().use(dashboardRoutes(db, authAs("u1")));
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
