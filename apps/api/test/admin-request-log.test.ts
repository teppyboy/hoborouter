// GET /api/v1/admin/usage-logs as the instance request log:
// - auth: unauthenticated 401, non-instance-admin 403
// - privacy: upstream_model (private upstream IDs) never emitted; public_model only
// - actor: key creator from key.create audits (labeled actor_source), never the
//   workspace owner; nullable for historical rows without an audit
// - soft-deleted keys keep their history visible
// - GET /api/v1/admin/system stays log-free (no usage/request log data)
import { beforeAll, describe, expect, test } from "bun:test";
import type { Db } from "@hoborouter/db";
import { sql } from "drizzle-orm";
import { makeApp, signUp, req, createWorkspace, makeInstanceAdmin, userIdByEmail } from "./helpers";

const OWNER = "log-owner@example.com";
const CREATOR = "log-creator@example.com";
const INST = "log-inst@example.com";
const WS = "ws-req-log";
const WS2 = "ws-req-log-2";

let ctx: Awaited<ReturnType<typeof makeApp>>;
let db: Db;
let owner: string;
let inst: string;

async function seedKey(id: string, workspaceId: string, opts: { deletedAt?: number } = {}) {
  await db.execute(
    sql`INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at, deleted_at)
        VALUES (${id}, ${workspaceId}, ${"hash-" + id}, ${"sk-hbr-" + id.slice(0, 4)}, ${"key " + id}, 'enabled', ${Date.now()}, ${opts.deletedAt ?? null})`,
  );
}

async function seedKeyCreateAudit(keyId: string, actorUserId: string, workspaceId: string) {
  await db.execute(
    sql`INSERT INTO audit_log (id, actor_user_id, workspace_id, action, target, created_at)
        VALUES (${"audit-" + keyId}, ${actorUserId}, ${workspaceId}, 'key.create', ${keyId}, ${Date.now()})`,
  );
}

async function seedUsageLog(
  id: string,
  keyId: string | null,
  workspaceId: string,
  createdAt: number,
) {
  await db.execute(
    sql`INSERT INTO models (id, public_id, slug, display_name, provider, created_at, updated_at)
        VALUES (${"mod-" + id}, ${"pub-" + id}, ${"slug-" + id}, 'Pub', 'openai', ${Date.now()}, ${Date.now()})`,
  );
  await db.execute(
    sql`INSERT INTO requests (id, workspace_id, endpoint, mode, status, created_at, model_id)
        VALUES (${"req-" + id}, ${workspaceId}, '/v1/chat/completions', 'stream', 'ok', ${createdAt}, ${"mod-" + id})`,
  );
  await db.execute(
    sql`INSERT INTO usage_logs (id, idempotency_key, request_id, workspace_id, provider, public_model,
        upstream_model, input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, status,
        charged_vnd, created_at, api_key_id)
       VALUES (${id}, ${"idem-" + id}, ${"req-" + id}, ${workspaceId}, 'openai', 'pub-model',
        'SECRET-UPSTREAM-ID', 10, 20, 0, 0, 'ok', 1000, ${createdAt}, ${keyId})`,
  );
}

beforeAll(async () => {
  ctx = await makeApp();
  db = ctx.db;
  owner = await signUp(ctx.app, OWNER);
  await signUp(ctx.app, CREATOR);
  inst = await signUp(ctx.app, INST);
  await createWorkspace(db, WS, await userIdByEmail(db, OWNER));
  await createWorkspace(db, WS2, await userIdByEmail(db, CREATOR));
  await makeInstanceAdmin(db, await userIdByEmail(db, INST));
});

describe("GET /api/v1/admin/usage-logs", () => {
  test("unauthenticated -> 401", async () => {
    const res = await req(ctx.app, "/api/v1/admin/usage-logs");
    expect(res.status).toBe(401);
  });

  test("workspace owner (not instance admin) -> 403", async () => {
    const res = await req(ctx.app, "/api/v1/admin/usage-logs", { cookie: owner });
    expect(res.status).toBe(403);
  });

  test("public model only: upstream_model never emitted, actor is the key creator (labeled), not the workspace owner", async () => {
    await seedKey("key-1", WS);
    // Creator differs from the workspace owner: actor must be CREATOR.
    await seedKeyCreateAudit("key-1", await userIdByEmail(db, CREATOR), WS);
    await seedUsageLog("log-1", "key-1", WS, Date.now());
    const res = await req(ctx.app, "/api/v1/admin/usage-logs", { cookie: inst });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown>[] };
    const row = body.data.find((r) => r.id === "log-1");
    expect(row).toBeDefined();
    // Privacy: upstream model IDs are private, public model is fine.
    expect(body.data.some((r) => "upstream_model" in r)).toBe(false);
    expect(row!.public_model).toBe("pub-model");
    // Actor: key creator, clearly labeled; never claimed as the actual caller
    // and never the workspace owner.
    expect(row!.actor_source).toBe("key_creator");
    expect(row!.actor).toMatchObject({ id: await userIdByEmail(db, CREATOR) });
    expect(row!.actor).not.toMatchObject({ id: await userIdByEmail(db, OWNER) });
  });

  test("historical rows without a key.create audit -> actor null (unknown)", async () => {
    await seedKey("key-2", WS);
    await seedUsageLog("log-2", "key-2", WS, Date.now());
    const res = await req(ctx.app, "/api/v1/admin/usage-logs", { cookie: inst });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; actor: unknown }[] };
    const row = body.data.find((r) => r.id === "log-2");
    expect(row).toBeDefined();
    expect(row!.actor).toBeNull();
  });

  test("soft-deleted keys keep their history: key_prefix and actor still resolve", async () => {
    await seedKey("key-3", WS, { deletedAt: Date.now() });
    await seedKeyCreateAudit("key-3", await userIdByEmail(db, CREATOR), WS);
    await seedUsageLog("log-3", "key-3", WS, Date.now());
    const res = await req(ctx.app, "/api/v1/admin/usage-logs", { cookie: inst });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; key_prefix: string | null; actor: unknown }[];
    };
    const row = body.data.find((r) => r.id === "log-3");
    expect(row).toBeDefined();
    expect(row!.key_prefix).toBe("sk-hbr-key-");
    expect(row!.actor).toMatchObject({ id: await userIdByEmail(db, CREATOR) });
  });

  test("GET /api/v1/admin/system exposes no usage/request log data", async () => {
    const res = await req(ctx.app, "/api/v1/admin/system", { cookie: inst });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const keys = Object.keys(body);
    expect(keys).not.toContain("data");
    expect(keys.some((k) => /log/i.test(k))).toBe(false);
  });
});
