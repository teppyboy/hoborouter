// Reasoning normalization through the gateway (parity plan Task 2), against
// the owner's example catalog: public Claude model with authored routes
// max/xhigh/low(/medium) -> CPA z-ai/glm-5.3-flash high/high/none(/high).
// Money-critical invariants under test: normalization and pre-reservation
// rejection happen BEFORE any wallet/limiter touch; the outbound body carries
// exactly one canonical effort field and the route's upstream model; public
// responses never contain upstream ids; un-authored models pass through
// verbatim; tools/structured-output/multimodal bodies survive normalization;
// usage settlement is unchanged for overridden routes.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Elysia } from "elysia";
import { createTestDb } from "@hoborouter/db";
import { hashApiKey } from "@hoborouter/keys";
import { q, trackDrop, makeApp } from "./helpers";
import { gatewayRoutes } from "../src/routes/v1-gateway";

const PLAINTEXT = "sk-hbr-reasoning-key";
const PUBLIC_MODEL = "anthropic/claude-mythos-5";
const BASE_UPSTREAM = "claude-mythos-5-upstream";
const ROUTE_UPSTREAM = "z-ai/glm-5.3-flash";

let savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["HBR_GATEWAY_ENABLED", "CPA_BASE_URL", "CPA_ACCESS_KEY", "HBR_USD_VND_RATE"];

async function seed(db: Awaited<ReturnType<typeof makeApp>>["db"]) {
  const now = Date.now();
  await q(
    db,
    "INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws-gw','gw','active',?)",
    now,
  );
  await q(
    db,
    "INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at) VALUES ('wal-gw','ws-gw','VND',1000000000,0,0,?)",
    now,
  );
  await q(
    db,
    "INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at) VALUES ('key-gw','ws-gw',?,?,'gw','active',?)",
    hashApiKey(PLAINTEXT),
    "sk-hbr-re...",
    now,
  );
  await q(
    db,
    "INSERT INTO models (id, public_id, slug, display_name, provider, context_window, enabled, published, default_reasoning_effort, created_at, updated_at) VALUES ('mdl-a',?,'claude-mythos-5','Mythos 5','anthropic',128000,true,true,'medium',?,?)",
    PUBLIC_MODEL,
    now,
    now,
  );
  await q(
    db,
    "INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at) VALUES ('map-a','mdl-a','anthropic',?,true,?,?)",
    BASE_UPSTREAM,
    now,
    now,
  );
  const routes: [string, string][] = [
    ["max", "high"],
    ["xhigh", "high"],
    ["low", "none"],
    ["medium", "high"],
  ];
  for (const [i, [pub, up]] of routes.entries()) {
    await q(
      db,
      "INSERT INTO model_reasoning_routes (id, model_id, public_effort, provider, upstream_model, upstream_effort, enabled, created_at, updated_at) VALUES (?,?,?,'z-ai',?,?,true,?,?)",
      `rr-${i}`,
      "mdl-a",
      pub,
      ROUTE_UPSTREAM,
      up,
      now + i,
      now + i,
    );
  }
  // Un-authored sibling: reasoning requests pass through verbatim.
  await q(
    db,
    "INSERT INTO models (id, public_id, slug, display_name, provider, context_window, enabled, published, created_at, updated_at) VALUES ('mdl-b','z/plain-glm','plain-glm','Plain GLM','z-ai',128000,true,true,?,?)",
    now,
    now,
  );
  await q(
    db,
    "INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at) VALUES ('map-b','mdl-b','z-ai','plain-glm-upstream',true,?,?)",
    now,
    now,
  );
  await q(
    db,
    "INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at, retired_at) VALUES ('price-a','mdl-a',1000000,2000000,500000,3000000,1000000,?,NULL)",
    now - 1000,
  );
  await q(
    db,
    "INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at, retired_at) VALUES ('price-b','mdl-b',1000000,2000000,0,0,1000000,?,NULL)",
    now - 1000,
  );
}

let db: Awaited<ReturnType<typeof makeApp>>["db"];
let gw: (req: Request) => Promise<Response>;

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  trackDrop(t.drop);
  await seed(db);
  gw = (req) => new Elysia().use(gatewayRoutes(db)).handle(req);
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
  }
  process.env.HBR_GATEWAY_ENABLED = "1";
  process.env.CPA_ACCESS_KEY = "test-cpa-secret";
  process.env.HBR_USD_VND_RATE = "26000";
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

type Captured = { path: string; body: string };
let captured: Captured[] = [];
let fakeServer: ReturnType<typeof Bun.serve> | null = null;
const chatJson = (upstreamModel: string) =>
  new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      model: upstreamModel,
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    { headers: { "content-type": "application/json" } },
  );

function startFakeCpa(handler: (c: Captured) => Response) {
  captured = [];
  fakeServer = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const c = { path: new URL(req.url).pathname, body: await req.text() };
      captured.push(c);
      return handler(c);
    },
  });
  process.env.CPA_BASE_URL = `http://127.0.0.1:${fakeServer.port}`;
}

const send = (path: string, body: unknown) =>
  gw(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${PLAINTEXT}` },
      body: JSON.stringify(body),
    }),
  );

const chatBody = (extra: Record<string, unknown> = {}) => ({
  model: PUBLIC_MODEL,
  messages: [{ role: "user", content: "hi" }],
  ...extra,
});

const outbound = () => JSON.parse(captured[0]?.body ?? "{}") as Record<string, unknown>;

const walletCount = async () =>
  ((await q(db, "SELECT COUNT(*) c FROM billing_reservations"))[0] as { c: number }).c;

describe("reasoning normalization -> CPA route", () => {
  test("chat reasoning_effort max routes to the z-ai GLM upstream with high effort", async () => {
    startFakeCpa(() => chatJson(ROUTE_UPSTREAM));
    const res = await send("/v1/chat/completions", chatBody({ reasoning_effort: "max" }));
    expect(res.status).toBe(200);
    expect(outbound().model).toBe(ROUTE_UPSTREAM);
    expect(outbound().reasoning_effort).toBe("high");
    expect(outbound().reasoning).toBeUndefined();
    expect(outbound().thinking).toBeUndefined();
    // Public response never contains upstream ids.
    const text = await res.text();
    expect(text).not.toContain(ROUTE_UPSTREAM);
    expect(JSON.parse(text).model).toBe(PUBLIC_MODEL);
  });

  test("OpenRouter reasoning.effort xhigh maps to upstream high", async () => {
    startFakeCpa(() => chatJson(ROUTE_UPSTREAM));
    const res = await send("/v1/chat/completions", chatBody({ reasoning: { effort: "xhigh" } }));
    expect(res.status).toBe(200);
    expect(outbound().reasoning_effort).toBe("high");
    expect(outbound().reasoning).toBeUndefined();
  });

  test("public low maps to upstream none", async () => {
    startFakeCpa(() => chatJson(ROUTE_UPSTREAM));
    await send("/v1/chat/completions", chatBody({ reasoning_effort: "low" }));
    expect(outbound().model).toBe(ROUTE_UPSTREAM);
    expect(outbound().reasoning_effort).toBe("none");
  });

  test("responses protocol forwards reasoning.effort canonical form", async () => {
    startFakeCpa(
      () =>
        new Response(
          JSON.stringify({
            status: "completed",
            model: ROUTE_UPSTREAM,
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const res = await send("/v1/responses", {
      model: PUBLIC_MODEL,
      input: "hi",
      reasoning: { effort: "max" },
    });
    expect(res.status).toBe(200);
    expect(outbound().model).toBe(ROUTE_UPSTREAM);
    expect(outbound().reasoning).toEqual({ effort: "high" });
    expect(outbound().reasoning_effort).toBeUndefined();
    const text = await res.text();
    expect(text).not.toContain(ROUTE_UPSTREAM);
  });

  test("messages thinking adaptive uses the default effort route", async () => {
    startFakeCpa(
      () =>
        new Response(
          JSON.stringify({
            type: "message",
            model: ROUTE_UPSTREAM,
            content: [{ type: "text", text: "hi" }],
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const res = await send("/v1/messages", {
      model: PUBLIC_MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive" },
    });
    expect(res.status).toBe(200);
    expect(outbound().model).toBe(ROUTE_UPSTREAM);
    expect(outbound().output_config).toEqual({ effort: "high" });
    expect(outbound().thinking).toBeUndefined();
  });

  test("messages thinking disabled maps to the Anthropic disable form", async () => {
    startFakeCpa(
      () =>
        new Response(
          JSON.stringify({
            type: "message",
            model: ROUTE_UPSTREAM,
            content: [],
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    await send("/v1/messages", {
      model: PUBLIC_MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "disabled" },
    });
    expect(outbound().thinking).toEqual({ type: "disabled" });
    expect(outbound().output_config).toBeUndefined();
  });

  test("no reasoning form passes the base mapping through verbatim", async () => {
    startFakeCpa(() => chatJson(BASE_UPSTREAM));
    await send("/v1/chat/completions", chatBody());
    expect(outbound().model).toBe(BASE_UPSTREAM);
    expect(outbound().reasoning_effort).toBeUndefined();
  });

  test("un-authored model passes reasoning forms through verbatim", async () => {
    startFakeCpa(() => chatJson("plain-glm-upstream"));
    const res = await send("/v1/chat/completions", {
      model: "z/plain-glm",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high",
    });
    expect(res.status).toBe(200);
    expect(outbound().model).toBe("plain-glm-upstream");
    expect(outbound().reasoning_effort).toBe("high");
  });

  test("tools, structured output, and multimodal content survive normalization", async () => {
    startFakeCpa(() => chatJson(ROUTE_UPSTREAM));
    const tools = [{ type: "function", function: { name: "f", parameters: {} } }];
    await send(
      "/v1/chat/completions",
      chatBody({
        reasoning: { effort: "low" },
        tools,
        tool_choice: "auto",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hi" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            ],
          },
        ],
      }),
    );
    expect(outbound().tools).toEqual(tools);
    expect(outbound().tool_choice).toBe("auto");
    expect(outbound().response_format).toEqual({ type: "json_object" });
    expect(Array.isArray(outbound().messages)).toBe(true);
    expect(outbound().reasoning_effort).toBe("none");
  });
});

describe("pre-reservation rejection", () => {
  test("conflicting reasoning forms reject 400 with zero reservations", async () => {
    startFakeCpa(() => chatJson(ROUTE_UPSTREAM));
    const before = await walletCount();
    const res = await send(
      "/v1/chat/completions",
      chatBody({ reasoning: { effort: "high" }, reasoning_effort: "low" }),
    );
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: { code: string } };
    expect(err.error.code).toBe("conflicting_reasoning");
    expect(await walletCount()).toBe(before);
  });

  test("unsupported effort rejects before reservation", async () => {
    startFakeCpa(() => chatJson(ROUTE_UPSTREAM));
    const before = await walletCount();
    const res = await send("/v1/chat/completions", chatBody({ reasoning_effort: "minimal" }));
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: { code: string } };
    expect(err.error.code).toBe("unsupported_reasoning");
    expect(await walletCount()).toBe(before);
  });

  test("budget-only forms reject on authored models before reservation", async () => {
    startFakeCpa(() => chatJson(ROUTE_UPSTREAM));
    const before = await walletCount();
    const res = await send("/v1/chat/completions", chatBody({ reasoning: { max_tokens: 2048 } }));
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: { code: string } };
    expect(err.error.code).toBe("unsupported_reasoning");
    expect(await walletCount()).toBe(before);
  });

  test("messages route rejects conflicts with the Anthropic envelope", async () => {
    startFakeCpa(() => chatJson(ROUTE_UPSTREAM));
    const res = await send("/v1/messages", {
      model: PUBLIC_MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "disabled" },
      output_config: { effort: "max" },
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: { type: string } };
    expect(err.error.type).toBe("invalid_request_error");
  });
});

describe("billing with route override", () => {
  test("usage settlement is unchanged when a route override ran", async () => {
    startFakeCpa(() => chatJson(ROUTE_UPSTREAM));
    const res = await send("/v1/chat/completions", chatBody({ reasoning_effort: "max" }));
    expect(res.status).toBe(200);
    const rows = await q<{ status: string; charged: number | null }>(
      db,
      "SELECT br.status, le.amount charged FROM billing_reservations br JOIN ledger_entries le ON le.billing_reservation_id = br.id WHERE br.request_id = (SELECT id FROM requests ORDER BY ctid DESC LIMIT 1)",
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("settled");
    // 10 in + 5 out micro-USD = 20 => ceil(20 * 26000 * 1e6 / 1e12) = 1 VND
    expect(rows[0]?.charged).toBe(1);
  });
});
