// Task 7: published catalog routes — admin CRUD, member view, /v1 key-auth view.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { sql, type SQL } from "drizzle-orm";
import { createTestDb, type Db } from "@hoborouter/db";
import { createAuth } from "../src/auth";
import { buildApp } from "../src/app";
import {
  signUp,
  req,
  createWorkspace,
  addMember,
  userIdByEmail,
  makeInstanceAdmin,
} from "./helpers";

const A = "ws-a";
const B = "ws-b";
const OWNER = "mowner@example.com";
const ADMIN = "madmin@example.com";
const MEMBER = "mmember@example.com";
const IADMIN = "miadmin@example.com";

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>;
let owner: string, admin: string, member: string, iadmin: string;
let keyA: string; // plaintext for ws-a key

/** Run a raw SQL query and return its rows. */
async function q<T = Record<string, unknown>>(query: SQL): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

async function seedBinding(o: {
  id: string;
  wsId: string | null;
  publicModel: string;
  cpaAlias: string;
  status?: string;
  pin?: number;
  pout?: number;
}) {
  await db.execute(
    sql`INSERT INTO model_bindings (id, workspace_id, public_model, cpa_alias, status, price_input_per_1m, price_output_per_1m, effective_at) VALUES (${o.id},${o.wsId},${o.publicModel},${o.cpaAlias},${o.status ?? "published"},${o.pin ?? 1000},${o.pout ?? 2000},${Date.now()})`,
  );
}

async function makeKey(cookie: string, wsId: string, name: string): Promise<string> {
  const res = await req(app, `/api/v1/workspaces/${wsId}/keys`, {
    method: "POST",
    cookie,
    body: { name },
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { plaintext: string };
  return body.plaintext;
}

const bearer = (token: string) => ({
  method: "GET",
  headers: { authorization: `Bearer ${token}` },
});

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  const auth = createAuth(db);
  app = await buildApp({ db, auth });

  owner = await signUp(app, OWNER, "O");
  admin = await signUp(app, ADMIN, "Ad");
  member = await signUp(app, MEMBER, "M");
  iadmin = await signUp(app, IADMIN, "IA");

  await createWorkspace(db, A, await userIdByEmail(db, OWNER), "A");
  await addMember(db, A, await userIdByEmail(db, ADMIN), "admin");
  await addMember(db, A, await userIdByEmail(db, MEMBER), "member");
  await createWorkspace(db, B, await userIdByEmail(db, ADMIN), "B"); // admin also owns B → cross-ws negative
  await makeInstanceAdmin(db, await userIdByEmail(db, IADMIN));

  await seedBinding({
    id: "mb-global",
    wsId: null,
    publicModel: "global-model",
    cpaAlias: "secret-alias",
  });
  await seedBinding({ id: "mb-a", wsId: A, publicModel: "wsa-model", cpaAlias: "wsa-alias" });
  await seedBinding({ id: "mb-b", wsId: B, publicModel: "wsb-model", cpaAlias: "wsb-alias" });
  await seedBinding({
    id: "mb-off",
    wsId: null,
    publicModel: "off-model",
    cpaAlias: "off-alias",
    status: "disabled",
  });

  keyA = await makeKey(owner, A, "test-key-a");
});

afterAll(async () => {
  await t.drop();
});

describe("GET /api/v1/workspaces/:id/models (member+ read-only view)", () => {
  test("member can read own workspace view (global ∪ own), no cpa_alias", async () => {
    const res = await req(app, `/api/v1/workspaces/${A}/models`, { cookie: member });
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = (body as { id: string }[]).map((m) => m.id);
    expect(ids).toContain("mb-global");
    expect(ids).toContain("mb-a");
    expect(ids).not.toContain("mb-b");
    expect(ids).not.toContain("mb-off");
    expect(JSON.stringify(body)).not.toContain("secret-alias");
    expect(JSON.stringify(body)).not.toContain("cpa_alias");
  });

  test("non-member → 403", async () => {
    const outsider = await signUp(app, "outsider@example.com", "X");
    const res = await req(app, `/api/v1/workspaces/${A}/models`, { cookie: outsider });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/v1/admin/models (instance admin only)", () => {
  test("workspace owner → 403", async () => {
    const res = await req(app, "/api/v1/admin/models", {
      method: "POST",
      cookie: owner,
      body: { public_model: "x", cpa_alias: "y", price_input_per_1m: 1, price_output_per_1m: 1 },
    });
    expect(res.status).toBe(403);
  });

  test("workspace admin → 403", async () => {
    const res = await req(app, "/api/v1/admin/models", {
      method: "POST",
      cookie: admin,
      body: { public_model: "x", cpa_alias: "y", price_input_per_1m: 1, price_output_per_1m: 1 },
    });
    expect(res.status).toBe(403);
  });

  test("instance admin → 201, snapshot published, audit written", async () => {
    const res = await req(app, "/api/v1/admin/models", {
      method: "POST",
      cookie: iadmin,
      body: {
        public_model: "new-model",
        cpa_alias: "new-alias",
        price_input_per_1m: 500,
        price_output_per_1m: 700,
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    const [snap] = await q<{ price_input: number }>(
      sql`SELECT price_input FROM price_snapshots WHERE binding_id = ${body.id} ORDER BY created_at DESC`,
    );
    expect(snap).toBeDefined();
    expect(Number(snap!.price_input)).toBe(500);
    const [audit] = await q(
      sql`SELECT id FROM audit_log WHERE target = ${body.id} AND action LIKE 'model%'`,
    );
    expect(audit).toBeDefined();
  });

  test("unauthenticated → 401", async () => {
    const res = await req(app, "/api/v1/admin/models", { method: "POST", body: {} });
    expect(res.status).toBe(401);
  });
});

describe("PUT /api/v1/admin/models/:id (price change → NEW snapshot)", () => {
  test("instance admin updates prices; old snapshot row untouched, new row added", async () => {
    const before = (
      await q<{ price_input: number }>(
        sql`SELECT price_input FROM price_snapshots WHERE binding_id = 'mb-global'`,
      )
    ).map((r) => Number(r.price_input));
    const res = await req(app, "/api/v1/admin/models/mb-global", {
      method: "PUT",
      cookie: iadmin,
      body: { price_input_per_1m: 3000, price_output_per_1m: 4000, status: "published" },
    });
    expect(res.status).toBe(200);
    const after = (
      await q<{ price_input: number }>(
        sql`SELECT price_input FROM price_snapshots WHERE binding_id = 'mb-global'`,
      )
    ).map((r) => Number(r.price_input));
    expect(after.length).toBe(before.length + 1);
    expect(after.at(-1)).toBe(3000);
    // immutability: original rows unchanged
    for (let i = 0; i < before.length; i++) expect(after[i]).toBe(before[i]);
  });

  test("price-only PUT preserves existing disabled status; explicit published reactivates", async () => {
    await seedBinding({ id: "mb-dis", wsId: null, publicModel: "d", cpaAlias: "d", status: "disabled" });
    const res = await req(app, "/api/v1/admin/models/mb-dis", {
      method: "PUT",
      cookie: iadmin,
      body: { price_input_per_1m: 5, price_output_per_1m: 6 },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("disabled");
    const [dis] = await q<{ status: string }>(
      sql`SELECT status FROM model_bindings WHERE id = 'mb-dis'`,
    );
    expect(dis!.status).toBe("disabled");
    const res2 = await req(app, "/api/v1/admin/models/mb-dis", {
      method: "PUT",
      cookie: iadmin,
      body: { price_input_per_1m: 5, price_output_per_1m: 6, status: "published" },
    });
    expect(((await res2.json()) as { status: string }).status).toBe("published");
  });

  test("non-instance-admin → 403", async () => {
    const res = await req(app, "/api/v1/admin/models/mb-global", {
      method: "PUT",
      cookie: owner,
      body: { price_input_per_1m: 1, price_output_per_1m: 1 },
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /v1/models + /v1/models/:id (canonical catalog, Bearer sk-hbr- key auth)", () => {
  test("missing/invalid bearer → 401", async () => {
    expect((await req(app, "/v1/models")).status).toBe(401);
    expect((await req(app, "/v1/models", bearer("sk-hbr-deadbeef"))).status).toBe(401);
  });

  test("revoked key → 401", async () => {
    const plaintext = await makeKey(owner, A, "revoke-me");
    expect((await req(app, "/v1/models", bearer(plaintext))).status).toBe(200);
    const [row] = await q<{ id: string }>(
      sql`SELECT id FROM api_keys WHERE name = 'revoke-me'`,
    );
    await db.execute(sql`UPDATE api_keys SET status = 'revoked' WHERE id = ${row!.id}`);
    expect((await req(app, "/v1/models", bearer(plaintext))).status).toBe(401);
  });

  test("lists canonical models only (legacy bindings absent) in OpenAI shape", async () => {
    const res = await req(app, "/api/v1/admin/catalog/models", {
      method: "POST",
      cookie: iadmin,
      body: {
        public_id: "openai/gpt-canon",
        slug: "gpt-canon",
        display_name: "GPT Canon",
        provider: "openai",
        capabilities: ["chat"],
        context_window: null,
        enabled: true,
        published: true,
      },
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(
      (
        await req(app, `/api/v1/admin/catalog/models/${id}/mappings`, {
          method: "POST",
          cookie: iadmin,
          body: { provider: "openai", upstream_model: "gpt-4o-mini", enabled: true },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await req(app, `/api/v1/admin/catalog/models/${id}/prices`, {
          method: "POST",
          cookie: iadmin,
          body: {
            input_usd_micro_per_1m: 150,
            output_usd_micro_per_1m: 600,
            cached_input_usd_micro_per_1m: 75,
            reasoning_usd_micro_per_1m: 0,
            markup_ppm: 100000,
          },
        })
      ).status,
    ).toBe(201);

    const listed = await req(app, "/v1/models", bearer(keyA));
    expect(listed.status).toBe(200);
    const json = (await listed.json()) as {
      object: string;
      data: { id: string; object: string; created: number; owned_by: string }[];
    };
    expect(json.object).toBe("list");
    const entry = json.data.find((m) => m.id === "openai/gpt-canon");
    expect(entry).toBeDefined();
    expect(entry!.object).toBe("model");
    expect(entry!.owned_by).toBe("openai");
    expect(typeof entry!.created).toBe("number");
    // legacy model_bindings never appear
    expect(JSON.stringify(json)).not.toContain("global-model");
    expect(JSON.stringify(json)).not.toContain("wsa-model");
    expect(JSON.stringify(json)).not.toContain("cpa_alias");
  });
});
