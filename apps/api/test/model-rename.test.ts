// Model public_id rename via PUT /api/v1/admin/catalog/models/:id.
// Contract: public_id + slug (last path segment) rename in one transaction,
// audit 'catalog.model.rename' {from,to}, history rows keep the old name as
// snapshots, model_id-keyed API key allowlists keep working, gateway bills the
// new name, old name → 404 model_not_found (no alias).
import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { makeApp, signUp, req, makeInstanceAdmin, userIdByEmail, q } from "./helpers";
import { hashApiKey } from "@hoborouter/keys";

const CPA_KEY = "test-cpa-secret";
const PLAINTEXT = "sk-hbr-rename-test-key";
const CHAT_PATH = "/v1/chat/completions";
const OLD_ID = "openai/rename-me";
const NEW_ID = "openai/renamed-model";
let PRE_RENAME_REQUEST_ID = "";
const ENV_KEYS = ["HBR_GATEWAY_ENABLED", "CPA_BASE_URL", "CPA_ACCESS_KEY", "HBR_USD_VND_RATE"];
let savedEnv: Record<string, string | undefined> = {};

let db: Awaited<ReturnType<typeof makeApp>>["db"];
let app: Awaited<ReturnType<typeof makeApp>>["app"];
let iadmin: string;
let owner: string;
let fakeServer: ReturnType<typeof Bun.serve> | null = null;

const chatUsage = () => ({
  prompt_tokens: 1000,
  completion_tokens: 100,
  prompt_tokens_details: { cached_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 0 },
});

function startFakeCpa() {
  fakeServer = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        JSON.stringify({
          id: "chatcmpl-rn",
          object: "chat.completion",
          model: NEW_ID,
          choices: [
            { index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" },
          ],
          usage: chatUsage(),
        }),
        { headers: { "content-type": "application/json" } },
      ),
  });
  process.env.CPA_BASE_URL = `http://127.0.0.1:${fakeServer.port}`;
}

const lastCharge = async () =>
  (
    await q(
      db,
      "SELECT br.status, le.amount FROM billing_reservations br LEFT JOIN ledger_entries le ON le.billing_reservation_id = br.id ORDER BY br.ctid DESC LIMIT 1",
    )
  )[0] as { status: string; amount: number | null };

beforeAll(async () => {
  const made = await makeApp();
  db = made.db;
  app = made.app;
  iadmin = await signUp(app, "rename-admin@example.com", "IA");
  await makeInstanceAdmin(db, await userIdByEmail(db, "rename-admin@example.com"));
  owner = await signUp(app, "rename-owner@example.com", "O");

  const now = Date.now();
  await q(
    db,
    "INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws-rn','rn','active',?)",
    now,
  );
  await q(
    db,
    "INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at) VALUES ('wal-rn','ws-rn','VND',1000000000,0,0,?)",
    now,
  );
  await q(
    db,
    "INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at) VALUES ('key-rn','ws-rn',?,?,'rn','active',?)",
    hashApiKey(PLAINTEXT),
    "sk-hbr-rn...",
    now,
  );
  await q(
    db,
    "INSERT INTO models (id, public_id, slug, display_name, provider, context_window, enabled, published, created_at, updated_at) VALUES ('mdl-rn','openai/rename-me','rename-me','Rename Me','openai',128000,true,true,?,?)",
    now,
    now,
  );
  await q(
    db,
    "INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at) VALUES ('map-rn','mdl-rn','openai','gpt-rename-upstream',true,?,?)",
    now,
    now,
  );
  await q(
    db,
    "INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at, retired_at) VALUES ('price-rn','mdl-rn',1000000,2000000,500000,3000000,1200000,?,NULL)",
    now - 1000,
  );
  startFakeCpa();
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

afterAll(() => {
  fakeServer?.stop(true);
});

const chat = (model: string) =>
  req(app, CHAT_PATH, {
    method: "POST",
    headers: { authorization: `Bearer ${PLAINTEXT}` },
    body: { model, messages: [{ role: "user", content: "hi" }] },
  });

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.HBR_GATEWAY_ENABLED = "1";
  process.env.CPA_ACCESS_KEY = CPA_KEY;
  process.env.HBR_USD_VND_RATE = "26000";
});

describe("model public_id rename", () => {
  test("pre-rename request bills old name; usage_logs snapshots old public_model", async () => {
    const res = await chat(OLD_ID);
    expect(res.status).toBe(200);
    const reqRow = (
      await q<{ id: string }>(db, "SELECT id FROM requests WHERE model_id = 'mdl-rn'")
    )[0]!;
    PRE_RENAME_REQUEST_ID = reqRow.id;
    const ul = (
      await q<{ public_model: string }>(
        db,
        "SELECT public_model FROM usage_logs WHERE request_id = ?",
        reqRow.id,
      )
    )[0]!;
    expect(ul.public_model).toBe(OLD_ID);
  });

  test("rename → 200; GET shows new public_id + slug; audit row {from,to}", async () => {
    const res = await req(app, "/api/v1/admin/catalog/models/mdl-rn", {
      method: "PUT",
      cookie: iadmin,
      body: { public_id: NEW_ID },
    });
    expect(res.status).toBe(200);
    const list = (await req(app, "/api/v1/admin/catalog/models", { cookie: iadmin }).then((r) =>
      r.json(),
    )) as { id: string; public_id: string; slug: string }[];
    const row = list.find((m) => m.id === "mdl-rn")!;
    expect(row.public_id).toBe(NEW_ID);
    expect(row.slug).toBe("renamed-model");
    const auditRow = (
      await q<{ detail: string | { from: string; to: string } }>(
        db,
        "SELECT detail FROM audit_log WHERE action = 'catalog.model.rename' AND target = 'mdl-rn'",
      )
    )[0]!;
    // audit_log.detail is a jsonb column that stores a JSON string scalar.
    const detail =
      typeof auditRow.detail === "string"
        ? (JSON.parse(auditRow.detail) as Record<string, string>)
        : auditRow.detail;
    expect(detail).toMatchObject({ from: OLD_ID, to: NEW_ID });
  });

  test("gateway routes + bills the NEW name", async () => {
    const res = await chat(NEW_ID);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model: string };
    expect(body.model).toBe(NEW_ID);
    expect((await lastCharge()).status).toBe("settled");
    // Same usage math as gateway.test.ts: 38 VND.
    expect((await lastCharge()).amount).toBe(38);
  });

  test("OLD name → 404 model_not_found (no silent alias)", async () => {
    const res = await chat(OLD_ID);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("model_not_found");
  });

  test("api key allowlist (keyed by model_id) still allows the NEW name", async () => {
    await q(
      db,
      "INSERT INTO api_key_model_permissions (api_key_id, model_id, created_at) VALUES ('key-rn','mdl-rn',?)",
      Date.now(),
    );
    try {
      const res = await chat(NEW_ID);
      expect(res.status).toBe(200);
    } finally {
      await q(db, "DELETE FROM api_key_model_permissions WHERE api_key_id = 'key-rn'");
    }
  });

  test("rename to an existing other model's public_id → 409 DUPLICATE, no change", async () => {
    const now = Date.now();
    await q(
      db,
      "INSERT INTO models (id, public_id, slug, display_name, provider, enabled, published, created_at, updated_at) VALUES ('mdl-rn2','openai/other','other','Other','openai',true,true,?,?)",
      now,
      now,
    );
    const res = await req(app, "/api/v1/admin/catalog/models/mdl-rn", {
      method: "PUT",
      cookie: iadmin,
      body: { public_id: "openai/other" },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("DUPLICATE");
    const row = (
      await q<{ public_id: string }>(db, "SELECT public_id FROM models WHERE id = 'mdl-rn'")
    )[0]!;
    expect(row.public_id).toBe(NEW_ID);
  });

  test("bad format → 400 INVALID, no change", async () => {
    const res = await req(app, "/api/v1/admin/catalog/models/mdl-rn", {
      method: "PUT",
      cookie: iadmin,
      body: { public_id: "OpenAI/Nope" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID");
    const row = (
      await q<{ public_id: string }>(db, "SELECT public_id FROM models WHERE id = 'mdl-rn'")
    )[0]!;
    expect(row.public_id).toBe(NEW_ID);
  });

  test("non-admin → 403", async () => {
    const res = await req(app, "/api/v1/admin/catalog/models/mdl-rn", {
      method: "PUT",
      cookie: owner,
      body: { public_id: "openai/nope" },
    });
    expect(res.status).toBe(403);
  });

  test("two concurrent renames to the same public_id: one 200, one 409 DUPLICATE (never 500)", async () => {
    // mdl-rn currently has NEW_ID ('openai/renamed-model'); mdl-rn2 has 'openai/other'.
    const [a, b] = await Promise.all([
      req(app, "/api/v1/admin/catalog/models/mdl-rn", {
        method: "PUT",
        cookie: iadmin,
        body: { public_id: "openai/clash" },
      }),
      req(app, "/api/v1/admin/catalog/models/mdl-rn2", {
        method: "PUT",
        cookie: iadmin,
        body: { public_id: "openai/clash" },
      }),
    ]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 409]);
    if (b.status === 409)
      expect(((await b.json()) as { error: { code: string } }).error.code).toBe("DUPLICATE");
    else expect(((await a.json()) as { error: { code: string } }).error.code).toBe("DUPLICATE");
    const rows = await q<{ id: string }>(
      db,
      "SELECT id FROM models WHERE public_id = 'openai/clash'",
    );
    expect(rows.length).toBe(1);
    // Restore pre-test state for later tests.
    const winner = rows[0]!.id;
    await q(
      db,
      "UPDATE models SET public_id = ?, slug = ?, updated_at = ? WHERE id = ?",
      winner === "mdl-rn" ? NEW_ID : "openai/other",
      winner === "mdl-rn" ? "renamed-model" : "other",
      Date.now(),
      winner,
    );
  });

  test("two concurrent POST creates with the same public_id: one 201, one 409 DUPLICATE (never 500)", async () => {
    const body = {
      public_id: "openai/create-clash",
      slug: "create-clash",
      display_name: "Create Clash",
      provider: "openai",
    };
    const [a, b] = await Promise.all([
      req(app, "/api/v1/admin/catalog/models", { method: "POST", cookie: iadmin, body }),
      req(app, "/api/v1/admin/catalog/models", { method: "POST", cookie: iadmin, body }),
    ]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([201, 409]);
    if (b.status === 409)
      expect(((await b.json()) as { error: { code: string } }).error.code).toBe("DUPLICATE");
    else expect(((await a.json()) as { error: { code: string } }).error.code).toBe("DUPLICATE");
    const rows = await q<{ id: string }>(
      db,
      "SELECT id FROM models WHERE public_id = 'openai/create-clash'",
    );
    expect(rows.length).toBe(1);
    await q(db, "DELETE FROM models WHERE id = ?", rows[0]!.id);
  });

  test("history rows still carry the OLD public_model after rename", async () => {
    const uls = await q<{ public_model: string }>(
      db,
      "SELECT public_model FROM usage_logs WHERE request_id = ?",
      PRE_RENAME_REQUEST_ID,
    );
    expect(uls.length).toBeGreaterThan(0);
    for (const u of uls) expect(u.public_model).toBe(OLD_ID);
  });
});
