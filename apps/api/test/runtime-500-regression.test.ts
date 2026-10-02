// Regression tests for runtime 500s (E2E red): usage-summary on a fresh
// empty workspace and /admin/system counts, over real HTTP via buildApp.
import { describe, test, expect, beforeAll } from "bun:test";
import type { Database } from "bun:sqlite";
import { makeApp, signUp, req, createWorkspace, makeInstanceAdmin, userIdByEmail } from "./helpers";

let db: Database;
let app: Awaited<ReturnType<typeof makeApp>>["app"];
let adminCookie: string;
let userCookie: string;
let wsId = "ws-empty";

beforeAll(async () => {
  ({ db, app } = await makeApp());
  adminCookie = await signUp(app, "admin@t.test", "Admin");
  makeInstanceAdmin(db, userIdByEmail(db, "admin@t.test"));
  userCookie = await signUp(app, "user@t.test", "User");
});

describe("GET /workspaces/:id/usage-summary", () => {
  test("empty workspace: 200 zero totals, empty daily/by_model", async () => {
    createWorkspace(db, wsId, userIdByEmail(db, "user@t.test"));
    const res = await req(app, `/api/v1/workspaces/${wsId}/usage-summary`, { cookie: userCookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totals: Record<string, number>;
      daily: unknown[];
      by_model: unknown[];
    };
    expect(body.totals.requests).toBe(0);
    expect(body.totals.spend_vnd).toBe(0);
    expect(body.totals.errors).toBe(0);
    expect(body.daily).toEqual([]);
    expect(body.by_model).toEqual([]);
  });

  test("populated workspace: per-model spend descending, correct totals", async () => {
    const ws = "ws-full";
    const uid = userIdByEmail(db, "user@t.test");
    createWorkspace(db, ws, uid);
    const now = Date.now();
    db.prepare(
      "INSERT INTO models (id, public_id, slug, display_name, provider, enabled, published, created_at, updated_at) VALUES ('m-1','gpt-public','gpt-public','GPT','vendor',1,1,?,?)"
    ).run(now, now);
    db.prepare(
      "INSERT INTO requests (id, workspace_id, endpoint, mode, status, dispatch_state, model_id, created_at) VALUES (?,?, '/v1/chat/completions', 'non-stream', 'ok', 'terminal', 'm-1', ?)"
    ).run("req-a", ws, now);
    db.prepare(
      "INSERT INTO requests (id, workspace_id, endpoint, mode, status, dispatch_state, model_id, created_at) VALUES (?,?, '/v1/chat/completions', 'non-stream', 'upstream_error', 'terminal', 'm-1', ?)"
    ).run("req-b", ws, now);
    db.prepare(
      "INSERT INTO usage_logs (id, idempotency_key, request_id, workspace_id, provider, public_model, upstream_model, input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, status, charged_vnd, created_at) VALUES (?,?,?,?,'openrouter',?,'secret-a',10,5,0,0,'ok',?,?)"
    ).run("log-a", "idem-a", "req-a", ws, "model-a", 100, now);
    db.prepare(
      "INSERT INTO usage_logs (id, idempotency_key, request_id, workspace_id, provider, public_model, upstream_model, input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, status, charged_vnd, created_at) VALUES (?,?,?,?,'openrouter',?,'secret-b',20,7,0,0,'error',?,?)"
    ).run("log-b", "idem-b", "req-b", ws, "model-b", 500, now);
    const res = await req(app, `/api/v1/workspaces/${ws}/usage-summary`, { cookie: userCookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totals: { requests: number; spend_vnd: number; errors: number; input_tokens: number; output_tokens: number };
      daily: { day: string; requests: number; spend_vnd: number; tokens: number }[];
      by_model: { public_model: string; spend_vnd: number }[];
    };
    expect(body.totals.requests).toBe(2);
    expect(body.totals.spend_vnd).toBe(600);
    expect(body.totals.errors).toBe(1);
    expect(body.totals.input_tokens).toBe(30);
    expect(body.totals.output_tokens).toBe(12);
    expect(body.daily.length).toBeGreaterThan(0);
    expect(body.daily[0]!.spend_vnd).toBe(600);
    expect(body.by_model.map((m) => m.public_model)).toEqual(["model-b", "model-a"]);
    expect(body.by_model[0]!.spend_vnd).toBe(500);
  });
});

describe("GET /admin/system", () => {
  test("admin: numeric counts", async () => {
    const res = await req(app, "/api/v1/admin/system", { cookie: adminCookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { counts: Record<string, unknown> };
    for (const k of ["users", "workspaces", "models", "requests"]) {
      expect(typeof body.counts[k], `counts.${k}`).toBe("number");
    }
    expect(body.counts.users).toBeGreaterThanOrEqual(2);
  });

  test("non-admin: 403", async () => {
    const res = await req(app, "/api/v1/admin/system", { cookie: userCookie });
    expect(res.status).toBe(403);
  });
});
