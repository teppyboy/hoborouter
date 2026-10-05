// usage-summary ?model= filter (E2E over buildApp):
// empty/populated results, model isolation across workspaces, error counts,
// membership 403, daily.errors. No filter = unchanged semantics.
import { describe, test, expect, beforeAll } from "bun:test";
import type { Db } from "@hoborouter/db";
import { makeApp, signUp, req, createWorkspace, userIdByEmail } from "./helpers";
import { sql } from "drizzle-orm";

let db: Db;
let app: Awaited<ReturnType<typeof makeApp>>["app"];
let cookie: string;
let otherCookie: string;
const ws = "ws-uf";
const now = Date.now();

async function insertLog(
  id: string,
  wsId: string,
  model: string,
  status: string,
  vnd: number,
  at: number,
  tokens: { input: number; output: number } = { input: 1, output: 1 },
) {
  await db.execute(
    sql`INSERT INTO requests (id, workspace_id, endpoint, mode, status, dispatch_state, model_id, created_at) VALUES (${`req-${id}`}, ${wsId}, '/v1/chat/completions', 'non-stream', ${status === "error" ? "upstream_error" : status}, 'terminal', 'm-1', ${at})`,
  );
  await db.execute(
    sql`INSERT INTO usage_logs (id, idempotency_key, request_id, workspace_id, provider, public_model, upstream_model, input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, status, charged_vnd, created_at) VALUES (${id}, ${`idem-${id}`}, ${`req-${id}`}, ${wsId}, 'openrouter', ${model}, 'secret', ${tokens.input}, ${tokens.output}, 0, 0, ${status}, ${vnd}, ${at})`,
  );
}

beforeAll(async () => {
  ({ db, app } = await makeApp());
  cookie = await signUp(app, "uf@t.test", "U");
  otherCookie = await signUp(app, "uf2@t.test", "V");
  await createWorkspace(db, ws, await userIdByEmail(db, "uf@t.test"));
  await db.execute(
    sql`INSERT INTO models (id, public_id, slug, display_name, provider, enabled, published, created_at, updated_at) VALUES ('m-1','m1','m1','M','vendor',true,true,${now},${now})`,
  );
  await insertLog("l-a", ws, "model-a", "ok", 100, now);
  await insertLog("l-b", ws, "model-a", "error", 0, now);
  await insertLog("l-c", ws, "model-b", "ok", 500, now);
  // Hidden rows (visibility gate): empty model, and both-tokens-0 error row.
  await insertLog("l-h1", ws, "", "error", 0, now, { input: 0, output: 0 });
  await insertLog("l-h2", ws, "model-b", "error", 50, now, { input: 0, output: 0 });
});

const summary = async (q = "", c = cookie) => {
  const res = await req(app, `/api/v1/workspaces/${ws}/usage-summary${q}`, { cookie: c });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    totals: {
      requests: number;
      spend_vnd: number;
      errors: number;
      visible_requests: number;
      visible_errors: number;
    };
    daily: { day: string; requests: number; spend_vnd: number; tokens: number; errors: number }[];
    by_model: { public_model: string; requests: number; spend_vnd: number; tokens: number }[];
  };
};

describe("usage-summary model filter", () => {
  test("no filter: unchanged semantics, totals errors=1", async () => {
    const body = await summary();
    expect(body.totals.requests).toBe(5);
    expect(body.totals.spend_vnd).toBe(650);
    expect(body.totals.errors).toBe(3);
    expect(body.by_model).toHaveLength(3);
    expect(body.daily[0]!.errors).toBe(3);
  });

  test("visible counts gate hidden rows; success rate reflects eligible rows only", async () => {
    const body = await summary();
    // 3 existing rows + 2 hidden rows = 5 total; only 3 eligible (l-h1 empty
    // model, l-h2 both tokens 0 -> hidden; l-h2 error still counted in errors).
    expect(body.totals.requests).toBe(5);
    expect(body.totals.errors).toBe(3);
    expect(body.totals.spend_vnd).toBe(650);
    expect(body.totals.visible_requests).toBe(3);
    expect(body.totals.visible_errors).toBe(1);
    // Success rate over visible rows only: (3-1)/3 = 66.7%, NOT (5-2)/5.
    expect(
      ((body.totals.visible_requests - body.totals.visible_errors) / body.totals.visible_requests) *
        100,
    ).toBeCloseTo(66.7, 0);
  });

  test("model filter applies identically to visible counts", async () => {
    const body = await summary("?model=model-b");
    expect(body.totals.visible_requests).toBe(1);
    expect(body.totals.visible_errors).toBe(0);
    expect(body.totals.spend_vnd).toBe(550);
  });

  test("model=a: totals/daily/by_model all scoped", async () => {
    const body = await summary("?days=30&model=model-a");
    expect(body.totals.requests).toBe(2);
    expect(body.totals.spend_vnd).toBe(100);
    expect(body.totals.errors).toBe(1);
    expect(body.daily).toHaveLength(1);
    expect(body.daily[0]!.requests).toBe(2);
    expect(body.daily[0]!.errors).toBe(1);
    expect(body.by_model).toHaveLength(1);
    expect(body.by_model[0]!.public_model).toBe("model-a");
  });

  test("model with no rows: zero totals, empty series", async () => {
    const body = await summary("?model=model-z");
    expect(body.totals.requests).toBe(0);
    expect(body.totals.errors).toBe(0);
    expect(body.daily).toEqual([]);
    expect(body.by_model).toEqual([]);
  });

  test("model filter does not cross workspaces", async () => {
    const ws2 = "ws-uf2";
    await createWorkspace(db, ws2, await userIdByEmail(db, "uf2@t.test"));
    await insertLog("l-x", ws2, "model-a", "ok", 999, now);
    const res = await req(app, `/api/v1/workspaces/${ws2}/usage-summary?model=model-a`, {
      cookie,
    });
    expect(res.status).toBe(403);
  });

  test("non-member: 403 regardless of filter", async () => {
    const res = await req(app, `/api/v1/workspaces/${ws}/usage-summary?model=model-a`, {
      cookie: otherCookie,
    });
    expect(res.status).toBe(403);
  });

  test("window: exact UTC days ending today — cutoff inclusive, pre-cutoff excluded, totals == sum daily", async () => {
    const d = new Date();
    const todayUtcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const since = todayUtcMidnight - 29 * 86_400_000; // days=30
    await insertLog("l-early", ws, "model-a", "ok", 111, since - 1); // excluded
    await insertLog("l-edge", ws, "model-a", "ok", 222, since); // included
    const body = await summary("?days=30");
    expect(body.totals.requests).toBe(6); // l-a,l-b,l-c,l-h1,l-h2,l-edge
    expect(body.totals.spend_vnd).toBe(100 + 500 + 50 + 222);
    expect(body.totals.errors).toBe(3);
    expect(body.totals.requests).toBe(body.daily.reduce((s, r) => s + r.requests, 0));
    expect(body.daily.length).toBeLessThanOrEqual(30);
    const todayKey = new Date(todayUtcMidnight).toISOString().slice(0, 10);
    const todayBucket = body.daily.find((r) => r.day === todayKey);
    expect(todayBucket?.spend_vnd).toBe(100 + 500 + 50); // l-a, l-c, l-h2 (l-b error = 0)
    const sinceKey = new Date(since).toISOString().slice(0, 10);
    const sinceBucket = body.daily.find((r) => r.day === sinceKey);
    expect(sinceBucket?.spend_vnd).toBe(222); // l-edge only; l-early at since-1 excluded
  });
});
