// Prompt caching controls: global instance_settings.prompt_caching_enabled +
// per-model models.prompt_caching ('inherit'|'on'|'off'). Requests are sent to
// CPA IDENTICALLY in both modes; only billing differs:
//   ON  -> cached tokens billed at cached_input rate
//   OFF -> cached tokens billed at full input rate (stored cached count kept)
import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { createDb, migrate } from "@hoborouter/db";
import { hashApiKey } from "@hoborouter/keys";
import { gatewayRoutes } from "../src/routes/v1-gateway";

const PLAINTEXT = "sk-hbr-cache-key";
const CHAT_PATH = "/v1/chat/completions";
const RESPONSES_PATH = "/v1/responses";
const ENV_KEYS = ["HBR_GATEWAY_ENABLED", "CPA_BASE_URL", "CPA_ACCESS_KEY", "HBR_USD_VND_RATE"];

function seed(db: Database) {
  const now = Date.now();
  db.prepare(
    "INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws-c','c','active',?)",
  ).run(now);
  db.prepare(
    "INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at) VALUES ('wal-c','ws-c','VND',1000000000,0,0,?)",
  ).run(now);
  db.prepare(
    "INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at) VALUES ('key-c','ws-c',?,?,'c','active',?)",
  ).run(hashApiKey(PLAINTEXT), "sk-hbr-ca...", now);
  db.prepare(
    "INSERT INTO models (id, public_id, slug, display_name, provider, context_window, enabled, published, created_at, updated_at) VALUES ('mdl-c','openai/cache-test','cache-test','Cache Test','openai',128000,1,1,?,?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at) VALUES ('map-c','mdl-c','openai','cache-upstream',1,?,?)",
    // input $1/M, cached $0.1/M, output $1/M, reasoning $1/M, markup 1x
  ).run(now, now);
  db.prepare(
    "INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at, retired_at) VALUES ('price-c','mdl-c',1000000,1000000,100000,1000000,1000000,?,NULL)",
  ).run(now - 1000);
}

let db: Database;
let gw: (req: Request) => Promise<Response>;

beforeAll(() => {
  db = createDb(":memory:");
  migrate(db);
  seed(db);
  gw = (req) => new Elysia().use(gatewayRoutes(db)).handle(req);
});

const gwr = (path: string, body: unknown) =>
  gw(
    new Request("http://localhost" + path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${PLAINTEXT}` },
      body: JSON.stringify(body),
    }),
  );

let capturedBodies: string[] = [];
let fakeServer: ReturnType<typeof Bun.serve> | null = null;
function startFakeCpa(handler: () => Response) {
  capturedBodies = [];
  fakeServer = Bun.serve({
    port: 0,
    fetch: async (req) => {
      capturedBodies.push(await req.text());
      return handler();
    },
  });
  process.env.CPA_BASE_URL = `http://127.0.0.1:${fakeServer.port}`;
}

const cachedUsage = {
  prompt_tokens: 1336,
  completion_tokens: 13,
  prompt_tokens_details: { cached_tokens: 1280 },
  completion_tokens_details: { reasoning_tokens: 0 },
};
const cachedJson = () =>
  new Response(
    JSON.stringify({
      id: "chatcmpl-c",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: cachedUsage,
    }),
    { headers: { "content-type": "application/json" } },
  );

const lastUsageLog = () =>
  db
    .prepare(
      "SELECT input_tokens, output_tokens, cached_input_tokens, charged_vnd, raw_payload FROM usage_logs ORDER BY rowid DESC LIMIT 1",
    )
    .get() as {
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
    charged_vnd: number;
    raw_payload: string | null;
  };

const cacheBody = {
  model: "openai/cache-test",
  messages: [
    {
      role: "system",
      content: [
        { type: "text", text: "big system prompt", cache_control: { type: "ephemeral" } },
      ],
    },
    { role: "user", content: "hi" },
  ],
};

const setGlobal = (v: boolean | null) => {
  db.prepare("DELETE FROM instance_settings WHERE key = 'prompt_caching_enabled'").run();
  if (v !== null)
    db.prepare("INSERT INTO instance_settings (key, value, updated_at) VALUES ('prompt_caching_enabled', ?, ?)").run(
      v ? "true" : "false",
      Date.now(),
    );
};
const setModel = (v: "inherit" | "on" | "off") =>
  db.prepare("UPDATE models SET prompt_caching = ? WHERE id = 'mdl-c'").run(v);

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.HBR_GATEWAY_ENABLED = "1";
  process.env.CPA_ACCESS_KEY = "test-cpa-secret";
  process.env.HBR_USD_VND_RATE = "26000";
  setGlobal(null);
  setModel("inherit");
  db.prepare("UPDATE wallets SET balance = 1000000000, reserved = 0 WHERE id = 'wal-c'").run();
});

afterEach(() => {
  fakeServer?.stop(true);
  fakeServer = null;
});

afterAll(() => {
  fakeServer?.stop(true);
});

describe("gateway prompt caching billing", () => {
  // 56*1 + 1280*0.1 + 13*1 = 197 µUSD; 197 * 26000 * 1e6 / 1e12 = 5.122 -> ceil 6 VND
  test("ON (inherit, unset global): cached tokens billed at cached rate -> 6 VND", async () => {
    startFakeCpa(cachedJson);
    const res = await gwr(CHAT_PATH, cacheBody);
    expect(res.status).toBe(200);
    const log = lastUsageLog();
    expect(log.cached_input_tokens).toBe(1280);
    expect(log.charged_vnd).toBe(6);
    expect(log.raw_payload).toBeNull();
  });

  // 1336*1 + 13*1 = 1349 µUSD; 1349 * 26000 * 1e6 / 1e12 = 35.074 -> ceil 36 VND
  test("OFF (global false, inherit): billed as full input, cached count stored, metadata recorded -> 36 VND", async () => {
    setGlobal(false);
    startFakeCpa(cachedJson);
    const res = await gwr(CHAT_PATH, cacheBody);
    expect(res.status).toBe(200);
    const log = lastUsageLog();
    expect(log.cached_input_tokens).toBe(1280); // provider-reported count kept for transparency
    expect(log.charged_vnd).toBe(36); // full input price
    const meta = JSON.parse(log.raw_payload ?? "{}") as Record<string, unknown>;
    expect(meta.caching).toBe("off");
  });

  test("per-model 'on' overrides global off", async () => {
    setGlobal(false);
    setModel("on");
    startFakeCpa(cachedJson);
    await gwr(CHAT_PATH, cacheBody);
    expect(lastUsageLog().charged_vnd).toBe(6);
  });

  test("per-model 'off' overrides global on", async () => {
    setGlobal(true);
    setModel("off");
    startFakeCpa(cachedJson);
    await gwr(CHAT_PATH, cacheBody);
    expect(lastUsageLog().charged_vnd).toBe(36);
  });

  test("explicit cached_tokens: 0 is not assumed", async () => {
    startFakeCpa(() =>
      new Response(
        JSON.stringify({
          choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 10,
            prompt_tokens_details: { cached_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 0 },
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    await gwr(CHAT_PATH, cacheBody);
    const log = lastUsageLog();
    expect(log.cached_input_tokens).toBe(0);
    expect(log.raw_payload).toBeNull(); // no assumed_splits
  });

  test("Responses API input_tokens_details.cached_tokens is billed (ON)", async () => {
    startFakeCpa(
      () =>
        new Response(
          JSON.stringify({
            id: "resp-1",
            object: "response",
            status: "completed",
            output: [],
            usage: {
              input_tokens: 1336,
              output_tokens: 13,
              input_tokens_details: { cached_tokens: 1280 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const res = await gwr(RESPONSES_PATH, {
      model: "openai/cache-test",
      input: "hi",
    });
    expect(res.status).toBe(200);
    const log = lastUsageLog();
    expect(log.cached_input_tokens).toBe(1280);
    expect(log.charged_vnd).toBe(6);
  });

  test("outbound request body is byte-for-byte identical ON vs OFF (cache_control preserved)", async () => {
    const send = async () => {
      startFakeCpa(cachedJson);
      const res = await gwr(CHAT_PATH, cacheBody);
      expect(res.status).toBe(200);
      const body = capturedBodies[0];
      fakeServer?.stop(true);
      fakeServer = null;
      return body;
    };
    setModel("on");
    const onBody = await send();
    setModel("off");
    const offBody = await send();
    expect(offBody).toBe(onBody);
    const parsed = JSON.parse(onBody ?? "{}") as {
      messages?: { content?: { cache_control?: unknown }[] }[];
    };
    expect(parsed.messages?.[0]?.content?.[0]?.cache_control).toEqual({ type: "ephemeral" });
  });
});

// --- Settings endpoints (admin-only, audited) ---
import { makeApp, signUp, req, makeInstanceAdmin, userIdByEmail } from "./helpers";

describe("admin settings endpoints", () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  let admin: string;
  let user: string;

  beforeAll(async () => {
    ctx = await makeApp();
    admin = await signUp(ctx.app, "cache-admin@example.com");
    user = await signUp(ctx.app, "cache-user@example.com");
    makeInstanceAdmin(ctx.db, userIdByEmail(ctx.db, "cache-admin@example.com"));
  });

  test("non-admin GET/PUT -> 403", async () => {
    expect((await req(ctx.app, "/api/v1/admin/settings", { cookie: user })).status).toBe(403);
    expect(
      (
        await req(ctx.app, "/api/v1/admin/settings", {
          method: "PUT",
          cookie: user,
          body: { prompt_caching_enabled: false },
        })
      ).status,
    ).toBe(403);
  });

  test("admin GET default true; PUT persists and audits settings.update", async () => {
    const g = await req(ctx.app, "/api/v1/admin/settings", { cookie: admin });
    expect(g.status).toBe(200);
    expect(await g.json()).toEqual({ prompt_caching_enabled: true });
    const p = await req(ctx.app, "/api/v1/admin/settings", {
      method: "PUT",
      cookie: admin,
      body: { prompt_caching_enabled: false },
    });
    expect(p.status).toBe(200);
    const row = ctx.db
      .prepare("SELECT value FROM instance_settings WHERE key = 'prompt_caching_enabled'")
      .get() as { value: string };
    expect(row.value).toBe("false");
    const audit = ctx.db
      .prepare(
        "SELECT action, detail FROM audit_log WHERE action = 'settings.update' ORDER BY rowid DESC LIMIT 1",
      )
      .get() as { action: string; detail: string };
    expect(audit.action).toBe("settings.update");
    expect(JSON.parse(audit.detail)).toEqual({ before: true, after: false });
    const g2 = await req(ctx.app, "/api/v1/admin/settings", { cookie: admin });
    expect(await g2.json()).toEqual({ prompt_caching_enabled: false });
  });

  test("PUT rejects non-boolean", async () => {
    const p = await req(ctx.app, "/api/v1/admin/settings", {
      method: "PUT",
      cookie: admin,
      body: { prompt_caching_enabled: "nope" },
    });
    expect(p.status).toBe(400);
  });
});
