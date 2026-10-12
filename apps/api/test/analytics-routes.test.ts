// Task 5 bounded analytics API:
// - auth: unauthenticated 401, non-member 403 (cross-workspace never leaks)
// - activity rollups: requests/tokens/charged_vnd/cache_hit_rate grouped by
//   public model / key prefix / day; charged_vnd stays an integer
// - bounded query: strict body rejects private upstream/provider fields and
//   unknown keys; date span capped; keyset cursor pagination is exhaustive
// - privacy: no upstream_model, upstream cost/markup, or key hash anywhere
import { beforeAll, describe, expect, test } from "bun:test";
import type { Db } from "@hoborouter/db";
import { sql } from "drizzle-orm";
import { makeApp, signUp, req, createWorkspace, addMember, userIdByEmail } from "./helpers";

const OWNER = "analytics-owner@example.com";
const MEMBER = "analytics-member@example.com";
const OUTSIDER = "analytics-outsider@example.com";
const WS = "ws-analytics";
const DAY_MS = 24 * 60 * 60 * 1000;

let ctx: Awaited<ReturnType<typeof makeApp>>;
let db: Db;
let owner: string;
let member: string;
let outsider: string;
let from: number;
let to: number;

async function seedKey(id: string, workspaceId: string, prefix: string) {
  await db.execute(
    sql`INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at)
        VALUES (${id}, ${workspaceId}, ${"hash-" + id}, ${prefix}, ${"key " + id}, 'enabled', ${Date.now()})`,
  );
}

async function seedUsageLog(opts: {
  id: string;
  keyId: string | null;
  workspaceId: string;
  createdAt: number;
  publicModel: string;
  inputTokens?: number;
  cachedTokens?: number;
  chargedVnd?: number;
}) {
  const {
    id,
    keyId,
    workspaceId,
    createdAt,
    publicModel,
    inputTokens = 100,
    cachedTokens = 0,
    chargedVnd = 1000,
  } = opts;
  await db.execute(
    sql`INSERT INTO models (id, public_id, slug, display_name, provider, created_at, updated_at)
        VALUES (${"mod-" + id}, ${publicModel + "-" + id}, ${"slug-" + id}, 'Pub', 'openai', ${Date.now()}, ${Date.now()})`,
  );
  await db.execute(
    sql`INSERT INTO requests (id, workspace_id, endpoint, mode, status, created_at, model_id)
        VALUES (${"req-" + id}, ${workspaceId}, '/v1/chat/completions', 'stream', 'ok', ${createdAt}, ${"mod-" + id})`,
  );
  await db.execute(
    sql`INSERT INTO usage_logs (id, idempotency_key, request_id, workspace_id, provider, public_model,
        upstream_model, input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, status,
        charged_vnd, created_at, api_key_id)
       VALUES (${id}, ${"idem-" + id}, ${"req-" + id}, ${workspaceId}, 'openai', ${publicModel},
        'SECRET-UPSTREAM-ID', ${inputTokens}, 20, ${cachedTokens}, 0, 'ok', ${chargedVnd}, ${createdAt}, ${keyId})`,
  );
}

beforeAll(async () => {
  ctx = await makeApp();
  db = ctx.db;
  owner = await signUp(ctx.app, OWNER);
  member = await signUp(ctx.app, MEMBER);
  outsider = await signUp(ctx.app, OUTSIDER);
  await createWorkspace(db, WS, await userIdByEmail(db, OWNER));
  await addMember(db, WS, await userIdByEmail(db, MEMBER), "member");

  to = Date.now();
  from = to - 7 * DAY_MS;
  await seedKey("akey-1", WS, "sk-hbr-aaaa");
  await seedKey("akey-2", WS, "sk-hbr-bbbb");
  // Two rows, same model different keys, one day apart; plus an uncached row
  // for a second model. Cached ratio: (50+0)/(100+100) = 0.25 overall.
  await seedUsageLog({
    id: "log-a1",
    keyId: "akey-1",
    workspaceId: WS,
    createdAt: from + DAY_MS,
    publicModel: "gpt-x",
    cachedTokens: 50,
  });
  await seedUsageLog({
    id: "log-a2",
    keyId: "akey-2",
    workspaceId: WS,
    createdAt: from + 2 * DAY_MS,
    publicModel: "gpt-x",
    inputTokens: 100,
  });
  await seedUsageLog({
    id: "log-b1",
    keyId: null,
    workspaceId: WS,
    createdAt: from + 3 * DAY_MS,
    publicModel: "claude-y",
    chargedVnd: 2500,
  });
});

const post = (body: unknown, cookie: string) =>
  req(ctx.app, "/api/v1/analytics/query", { method: "POST", cookie, body });

describe("GET /api/v1/analytics/activity", () => {
  test("unauthenticated -> 401", async () => {
    const res = await req(
      ctx.app,
      `/api/v1/analytics/activity?workspace_id=${WS}&from=${from}&to=${to}`,
    );
    expect(res.status).toBe(401);
  });

  test("non-member (cross-workspace) -> 403", async () => {
    const res = await req(
      ctx.app,
      `/api/v1/analytics/activity?workspace_id=${WS}&from=${from}&to=${to}`,
      { cookie: outsider },
    );
    expect(res.status).toBe(403);
  });

  test("member: rollup by public_model with integer charged_vnd and cache hit rate; no private fields", async () => {
    const res = await req(
      ctx.app,
      `/api/v1/analytics/activity?workspace_id=${WS}&group_by=public_model&from=${from}&to=${to}`,
      { cookie: member },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        group: string | null;
        requests: number;
        input_tokens: number;
        output_tokens: number;
        charged_vnd: number;
        cache_hit_rate: number | null;
      }[];
      next_cursor: string | null;
    };
    expect(body.next_cursor).toBeNull();
    const gpt = body.data.find((r) => r.group === "gpt-x");
    const claude = body.data.find((r) => r.group === "claude-y");
    expect(gpt).toMatchObject({
      requests: 2,
      input_tokens: 200,
      output_tokens: 40,
      charged_vnd: 2000,
    });
    expect(gpt?.cache_hit_rate).toBeCloseTo(0.25);
    expect(claude?.charged_vnd).toBe(2500); // integer VND preserved
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("SECRET-UPSTREAM-ID");
    expect(raw).not.toContain("upstream_model");
    expect(raw).not.toContain("upstream_cost");
    expect(raw).not.toContain("markup");
    expect(raw).not.toContain("hash-");
  });

  test("rollup by key_prefix: null group for keyless rows, prefix only (never hash)", async () => {
    const res = await req(
      ctx.app,
      `/api/v1/analytics/activity?workspace_id=${WS}&group_by=key_prefix&from=${from}&to=${to}`,
      { cookie: owner },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { group: string | null; requests: number }[] };
    const byGroup = new Map(body.data.map((r) => [r.group, r.requests]));
    expect(byGroup.get("sk-hbr-aaaa")).toBe(1);
    expect(byGroup.get("sk-hbr-bbbb")).toBe(1);
    expect(byGroup.get(null)).toBe(1);
  });

  test("invalid group_by / oversized date span -> 400", async () => {
    const bad = await req(
      ctx.app,
      `/api/v1/analytics/activity?workspace_id=${WS}&group_by=upstream_model&from=${from}&to=${to}`,
      { cookie: member },
    );
    expect(bad.status).toBe(400);
    const wide = await req(
      ctx.app,
      `/api/v1/analytics/activity?workspace_id=${WS}&from=${from - 400 * DAY_MS}&to=${to}`,
      { cookie: member },
    );
    expect(wide.status).toBe(400);
  });
});

describe("POST /api/v1/analytics/query", () => {
  test("unauthenticated -> 401; non-member -> 403", async () => {
    const body = {
      workspace_id: WS,
      metrics: ["requests"],
      dimensions: ["public_model"],
      date_from: from,
      date_to: to,
    };
    expect((await post(body, "")).status).toBe(401);
    expect((await post(body, outsider)).status).toBe(403);
  });

  test("member: grouped metrics; cursor pagination exhausts all groups", async () => {
    const body = {
      workspace_id: WS,
      metrics: ["requests", "charged_vnd"],
      dimensions: ["public_model", "key_prefix"],
      date_from: from,
      date_to: to,
      limit: 2,
    };
    const res = await post(body, member);
    expect(res.status).toBe(200);
    const page1 = (await res.json()) as {
      data: { dimensions: (string | null)[]; metrics: Record<string, number> }[];
      next_cursor: string | null;
    };
    expect(page1.data).toHaveLength(2);
    expect(page1.next_cursor).toBeTruthy();
    const res2 = await post({ ...body, cursor: page1.next_cursor }, member);
    const page2 = (await res2.json()) as typeof page1;
    expect(page2.next_cursor).toBeNull();
    const all = [...page1.data, ...page2.data];
    expect(all).toHaveLength(3);
    const gptTotal = all
      .filter((r) => r.dimensions[0] === "gpt-x")
      .reduce((s, r) => s + (r.metrics.charged_vnd ?? 0), 0);
    expect(gptTotal).toBe(2000);
    expect(all.find((r) => r.dimensions[1] === null)?.metrics.requests).toBe(1);
  });

  test("strict body: private/unknown fields rejected -> 400", async () => {
    const base = {
      workspace_id: WS,
      metrics: ["requests"],
      dimensions: ["public_model"],
      date_from: from,
      date_to: to,
    };
    for (const body of [
      { ...base, dimensions: ["upstream_model"] },
      { ...base, dimensions: ["provider"] },
      { ...base, metrics: ["upstream_cost_usd_micro"] },
      { ...base, upstream_model: "leak" },
      { ...base, date_to: from }, // empty/invalid range
    ]) {
      const res = await post(body, member);
      expect(res.status).toBe(400);
    }
  });

  test("bad cursor -> 400", async () => {
    const res = await post(
      {
        workspace_id: WS,
        metrics: ["requests"],
        dimensions: ["public_model"],
        date_from: from,
        date_to: to,
        cursor: "!!!not-base64-json!!!",
      },
      member,
    );
    expect(res.status).toBe(400);
  });
});
