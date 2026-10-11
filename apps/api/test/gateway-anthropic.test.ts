// Anthropic-compatible POST /v1/messages gateway: thin passthrough to CPA's
// native /v1/messages (protocol "messages"). Money-critical invariants under
// test: exact settled charge from Anthropic usage fields (input +
// cache_creation + cache_read at cached rate, output), missing/invalid usage
// -> exactly ONE full-hold settlement, client abort -> full hold, concurrent
// reservations -> no double-spend, settlement replay -> no double charge.
// Auth accepts x-api-key (Anthropic native) plus the existing Bearer.
import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { Elysia } from "elysia";
import { createTestDb } from "@hoborouter/db";
import { hashApiKey } from "@hoborouter/keys";
import { settleRequest } from "@hoborouter/wallet";
import { q, trackDrop, makeApp, waitFor } from "./helpers";
import { gatewayRoutes, MAX_BODY_BYTES } from "../src/routes/v1-gateway";

const PLAINTEXT = "sk-hbr-anthropic-key";
const CPA_KEY = "test-cpa-secret";
const MESSAGES_PATH = "/v1/messages";
const COUNT_TOKENS_PATH = "/v1/messages/count_tokens";
const UPSTREAM_MODEL = "claude-upstream-sonnet";
const PUBLIC_MODEL = "anthropic/gw-claude";

const ENV_KEYS = [
  "HBR_GATEWAY_ENABLED",
  "CPA_BASE_URL",
  "CPA_ACCESS_KEY",
  "HBR_USD_VND_RATE",
  "HBR_DEFAULT_MAX_OUTPUT_TOKENS",
];
let savedEnv: Record<string, string | undefined> = {};

async function seedGateway(db: Awaited<ReturnType<typeof makeApp>>["db"]) {
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
    "sk-hbr-an...",
    now,
  );
  await q(
    db,
    "INSERT INTO models (id, public_id, slug, display_name, provider, context_window, enabled, published, created_at, updated_at) VALUES ('mdl-a',?,'gw-claude','GW Claude','anthropic',128000,true,true,?,?)",
    PUBLIC_MODEL,
    now,
    now,
  );
  await q(
    db,
    "INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at) VALUES ('map-a','mdl-a','anthropic', ?,true,?,?)",
    UPSTREAM_MODEL,
    now,
    now,
  );
  await q(
    db,
    "INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at, retired_at) VALUES ('price-a','mdl-a',1000000,2000000,500000,3000000,1200000,?,NULL)",
    now - 1000,
  );
}

let db: Awaited<ReturnType<typeof makeApp>>["db"];
let gw: (req: Request) => Promise<Response>;

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  trackDrop(t.drop);
  await seedGateway(db);
  gw = (req) => new Elysia().use(gatewayRoutes(db)).handle(req);
});

const mreq = (
  body: unknown,
  opts: { key?: string | null; keyHeader?: "x-api-key" | "authorization" } = {},
) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const key = opts.key === undefined ? PLAINTEXT : opts.key;
  if (key !== null) {
    if ((opts.keyHeader ?? "x-api-key") === "x-api-key") headers["x-api-key"] = key;
    else headers.authorization = `Bearer ${key}`;
  }
  return gw(
    new Request("http://localhost" + MESSAGES_PATH, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
};

const messagesBody = (extra: Record<string, unknown> = {}) => ({
  model: PUBLIC_MODEL,
  max_tokens: 1024,
  messages: [{ role: "user", content: "hi" }],
  ...extra,
});

type Captured = { path: string; headers: Headers; body: string };
let captured: Captured[] = [];
let upstreamAborted = false;
let fakeServer: ReturnType<typeof Bun.serve> | null = null;

function startFakeCpa(handler: (c: Captured) => Response | Promise<Response>) {
  captured = [];
  upstreamAborted = false;
  fakeServer = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const c = { path: new URL(req.url).pathname, headers: req.headers, body: await req.text() };
      captured.push(c);
      return await handler(c);
    },
  });
  process.env.CPA_BASE_URL = `http://127.0.0.1:${fakeServer.port}`;
  return fakeServer;
}

const anthropicUsage = () => ({
  input_tokens: 1000,
  output_tokens: 100,
  cache_creation_input_tokens: 200,
  cache_read_input_tokens: 50,
});

const messageJson = (usage: object | null = anthropicUsage()) =>
  new Response(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: UPSTREAM_MODEL,
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      ...(usage ? { usage } : {}),
    }),
    { headers: { "content-type": "application/json", "x-cpa-trace-id": "trace-anthropic-1" } },
  );

const messageSse = () => {
  const event = (name: string, data: object) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  return (
    event("message_start", {
      type: "message_start",
      message: {
        id: "msg_2",
        type: "message",
        role: "assistant",
        model: UPSTREAM_MODEL,
        content: [],
        usage: {
          input_tokens: 1000,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }) +
    event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }) +
    event("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hello" },
    }) +
    event("content_block_stop", { type: "content_block_stop", index: 0 }) +
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 100 },
    }) +
    event("message_stop", { type: "message_stop" })
  );
};

const lastCharge = async () =>
  (
    await q(
      db,
      "SELECT br.cap_vnd, br.status, le.amount FROM billing_reservations br LEFT JOIN ledger_entries le ON le.billing_reservation_id = br.id ORDER BY br.ctid DESC LIMIT 1",
    )
  )[0] as { cap_vnd: number; status: string; amount: number | null };

const ledgerCount = async () =>
  ((await q(db, "SELECT COUNT(*) c FROM ledger_entries"))[0] as { c: number }).c;

// Ledger is append-only (never deleted); assertions count rows added by the
// current test relative to the per-test baseline.
let ledgerBaseline = 0;
const ledgerDelta = async () => (await ledgerCount()) - ledgerBaseline;
const ledgerSum = async () =>
  (
    await q(db, "SELECT COALESCE(SUM(amount),0) s FROM ledger_entries WHERE direction = 'debit'")
  )[0] as { s: number };

const requestCount = async () =>
  ((await q(db, "SELECT COUNT(*) c FROM requests"))[0] as { c: number }).c;

const walletBalance = async () =>
  (await q(db, "SELECT balance, reserved FROM wallets WHERE id = 'wal-gw'"))[0] as {
    balance: number;
    reserved: number;
  };

const lastRequest = async () =>
  (
    await q(
      db,
      "SELECT id, status, endpoint FROM requests ORDER BY created_at DESC, id DESC LIMIT 1",
    )
  )[0] as { id: string; status: string; endpoint: string };

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.HBR_GATEWAY_ENABLED = "1";
  process.env.CPA_ACCESS_KEY = CPA_KEY;
  process.env.HBR_USD_VND_RATE = "26000";
  delete process.env.CPA_BASE_URL;
  delete process.env.HBR_DEFAULT_MAX_OUTPUT_TOKENS;
  ledgerBaseline = await ledgerCount();
});

afterEach(async () => {
  fakeServer?.stop(true);
  fakeServer = null;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await q(db, "UPDATE wallets SET balance = 1000000000, reserved = 0 WHERE id = 'wal-gw'");
  await q(db, "DELETE FROM settlements");
});

afterAll(() => {
  fakeServer?.stop(true);
});

describe("/v1/messages happy paths", () => {
  test("non-stream via x-api-key: settled charge with cache splits, model scrubbed, key not forwarded", async () => {
    startFakeCpa(() => messageJson());
    const res = await mreq(messagesBody());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-hbr-request-id")).toBeTruthy();
    const body = (await res.json()) as { model: string; usage: Record<string, number> };
    expect(body.model).toBe(PUBLIC_MODEL);
    expect(JSON.stringify(body)).not.toContain(UPSTREAM_MODEL);
    expect(captured.length).toBe(1);
    expect(captured[0]!.path).toBe(MESSAGES_PATH);
    expect(captured[0]!.headers.get("authorization")).toBe(`Bearer ${CPA_KEY}`);
    // Inbound client credential never reaches upstream.
    expect(captured[0]!.headers.get("x-api-key")).toBeNull();
    expect((JSON.parse(captured[0]!.body) as Record<string, unknown>).model).toBe(UPSTREAM_MODEL);
    expect((JSON.parse(captured[0]!.body) as Record<string, unknown>).max_tokens).toBe(1024);
    // input 1000 + creation 200 = 1200 at full rate, read 50 at cached rate,
    // output 100: (1200-50)*1e6 + 50*5e5 + 100*2e6 = 1375 micro USD
    // -> ceil(1375 * 26000 * 1200000 / 1e12) = 43 VND.
    expect((await lastCharge()).status).toBe("settled");
    expect((await lastCharge()).amount).toBe(43);
    expect((await walletBalance()).balance).toBe(1000000000 - 43);
    expect((await walletBalance()).reserved).toBe(0);
    expect((await lastRequest()).endpoint).toBe("/v1/messages");
  });

  test("stream via x-api-key: SSE passthrough scrubbed, settled from message_start+message_delta, no [DONE] injected", async () => {
    const sse = messageSse();
    startFakeCpa(() => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
    const res = await mreq(messagesBody({ stream: true }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe(sse.replaceAll(`"model":"${UPSTREAM_MODEL}"`, `"model":"${PUBLIC_MODEL}"`));
    expect(text).not.toContain("[DONE]");
    // Anthropic bodies pass through verbatim: no OpenAI stream_options injection.
    expect(JSON.parse(captured[0]!.body)).not.toHaveProperty("stream_options");
    expect((await lastCharge()).status).toBe("settled");
    // input 1000 at full rate + output 100 at output rate
    // -> 1000*1e6 + 100*2e6 = 1200 micro USD -> 38 VND.
    expect((await lastCharge()).amount).toBe(38);
  });

  test("Bearer auth regression on /v1/messages", async () => {
    startFakeCpa(() => messageJson());
    const res = await mreq(messagesBody(), { keyHeader: "authorization" });
    expect(res.status).toBe(200);
    expect((await lastCharge()).status).toBe("settled");
  });

  test("count_tokens: free passthrough, no reservation, no ledger, no request row", async () => {
    startFakeCpa(
      () =>
        new Response(JSON.stringify({ input_tokens: 42 }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const requestsBefore = await requestCount();
    const res = await gw(
      new Request("http://localhost" + COUNT_TOKENS_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": PLAINTEXT },
        body: JSON.stringify({ model: PUBLIC_MODEL, messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { input_tokens: number }).input_tokens).toBe(42);
    expect(captured[0]!.path).toBe(COUNT_TOKENS_PATH);
    expect((JSON.parse(captured[0]!.body) as Record<string, unknown>).model).toBe(UPSTREAM_MODEL);
    expect(await requestCount()).toBe(requestsBefore);
    expect(await ledgerDelta()).toBe(0);
    expect((await walletBalance()).reserved).toBe(0);
  });
});

describe("/v1/messages auth + validation", () => {
  test("invalid x-api-key -> 401 Anthropic error shape (authentication_error)", async () => {
    startFakeCpa(() => messageJson());
    const res = await mreq(messagesBody(), { key: "sk-hbr-nope" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { type: string; error: { type: string; message: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("authentication_error");
    expect(captured.length).toBe(0);
  });

  test("revoked x-api-key -> 401", async () => {
    await q(db, "UPDATE api_keys SET status = 'revoked' WHERE id = 'key-gw'");
    startFakeCpa(() => messageJson());
    const res = await mreq(messagesBody());
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("authentication_error");
    await q(db, "UPDATE api_keys SET status = 'active' WHERE id = 'key-gw'");
  });

  test("missing max_tokens -> 400 invalid_request_error, no dispatch, no request row", async () => {
    startFakeCpa(() => messageJson());
    const before = await requestCount();
    const { max_tokens: _drop, ...noMax } = messagesBody();
    const res = await mreq(noMax);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type: string; error: { type: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
    expect(captured.length).toBe(0);
    expect(await requestCount()).toBe(before);
  });

  test("missing messages -> 400, no dispatch", async () => {
    startFakeCpa(() => messageJson());
    const { messages: _drop, ...noMessages } = messagesBody();
    const res = await mreq(noMessages);
    expect(res.status).toBe(400);
    expect(captured.length).toBe(0);
  });

  test("restricted key -> 403 permission_error", async () => {
    // One permission row for an unrelated model => key-gw becomes restricted.
    const now = Date.now();
    await q(
      db,
      "INSERT INTO models (id, public_id, slug, display_name, provider, context_window, enabled, published, created_at, updated_at) VALUES ('mdl-other','other/mdl','other-mdl','Other','openai',1000,true,true,?,?)",
      now,
      now,
    );
    await q(
      db,
      "INSERT INTO api_key_model_permissions (api_key_id, model_id, created_at) VALUES ('key-gw','mdl-other',?)",
      now,
    );
    startFakeCpa(() => messageJson());
    const res = await mreq(messagesBody());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("permission_error");
    expect(captured.length).toBe(0);
    await q(db, "DELETE FROM api_key_model_permissions WHERE api_key_id = 'key-gw'");
    await q(db, "DELETE FROM models WHERE id = 'mdl-other'");
  });

  test("unknown model -> 404 not_found_error, upstream id never leaks", async () => {
    startFakeCpa(() => messageJson());
    const res = await mreq(messagesBody({ model: "anthropic/nope" }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("not_found_error");
    expect(captured.length).toBe(0);
  });

  test("non-integer / zero max_tokens -> 400, no dispatch", async () => {
    startFakeCpa(() => messageJson());
    for (const mt of [0, -5, 1.5, "1024"]) {
      const res = await mreq(messagesBody({ max_tokens: mt }));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { type: string; error: { type: string } };
      expect(body.type).toBe("error");
      expect(body.error.type).toBe("invalid_request_error");
    }
    expect(captured.length).toBe(0);
  });

  test("count_tokens via Bearer auth: same free passthrough", async () => {
    startFakeCpa(
      () =>
        new Response(JSON.stringify({ input_tokens: 7 }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const res = await gw(
      new Request("http://localhost" + COUNT_TOKENS_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${PLAINTEXT}` },
        body: JSON.stringify({ model: PUBLIC_MODEL, messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { input_tokens: number }).input_tokens).toBe(7);
    expect(captured[0]!.headers.get("authorization")).toBe(`Bearer ${CPA_KEY}`);
    expect(await ledgerDelta()).toBe(0);
    expect((await walletBalance()).reserved).toBe(0);
  });

  test("count_tokens invalid key -> 401 authentication_error envelope", async () => {
    startFakeCpa(() => messageJson());
    const res = await gw(
      new Request("http://localhost" + COUNT_TOKENS_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "sk-hbr-nope" },
        body: JSON.stringify({ model: PUBLIC_MODEL, messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { type: string; error: { type: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("authentication_error");
    expect(captured.length).toBe(0);
  });

  test("count_tokens restricted key -> 403 permission_error, no dispatch", async () => {
    const now = Date.now();
    await q(
      db,
      "INSERT INTO models (id, public_id, slug, display_name, provider, context_window, enabled, published, created_at, updated_at) VALUES ('mdl-ct-other','other/ct','other-ct','Other CT','openai',1000,true,true,?,?)",
      now,
      now,
    );
    await q(
      db,
      "INSERT INTO api_key_model_permissions (api_key_id, model_id, created_at) VALUES ('key-gw','mdl-ct-other',?)",
      now,
    );
    startFakeCpa(() => messageJson());
    const res = await gw(
      new Request("http://localhost" + COUNT_TOKENS_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": PLAINTEXT },
        body: JSON.stringify({ model: PUBLIC_MODEL, messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { type: string; error: { type: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("permission_error");
    expect(captured.length).toBe(0);
    await q(db, "DELETE FROM api_key_model_permissions WHERE api_key_id = 'key-gw'");
    await q(db, "DELETE FROM models WHERE id = 'mdl-ct-other'");
  });

  test("count_tokens unknown model -> 404 not_found_error, no dispatch", async () => {
    startFakeCpa(() => messageJson());
    const res = await gw(
      new Request("http://localhost" + COUNT_TOKENS_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": PLAINTEXT },
        body: JSON.stringify({
          model: "anthropic/nope",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { type: string; error: { type: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("not_found_error");
    expect(captured.length).toBe(0);
  });

  test("count_tokens response scrubs upstream model id from every string", async () => {
    startFakeCpa(
      () =>
        new Response(
          JSON.stringify({
            input_tokens: 42,
            details: [`echo ${UPSTREAM_MODEL}`],
            model: UPSTREAM_MODEL,
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const res = await gw(
      new Request("http://localhost" + COUNT_TOKENS_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": PLAINTEXT },
        body: JSON.stringify({ model: PUBLIC_MODEL, messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(UPSTREAM_MODEL);
    const body = JSON.parse(text) as { model: string; details: string[] };
    expect(body.model).toBe(PUBLIC_MODEL);
    expect(body.details[0]).toBe(`echo ${PUBLIC_MODEL}`);
  });

  test("count_tokens oversized body -> 413 invalid_request_error, no dispatch, no ledger", async () => {
    startFakeCpa(() => messageJson());
    const before = await requestCount();
    // 1 MiB body limit: content string pushes the JSON body past MAX_BODY_BYTES.
    const res = await gw(
      new Request("http://localhost" + COUNT_TOKENS_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": PLAINTEXT },
        body: JSON.stringify({
          model: PUBLIC_MODEL,
          messages: [{ role: "user", content: "x".repeat(MAX_BODY_BYTES) }],
        }),
      }),
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { type: string; error: { type: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
    expect(captured.length).toBe(0);
    expect(await requestCount()).toBe(before);
    expect(await ledgerDelta()).toBe(0);
    expect((await walletBalance()).reserved).toBe(0);
  });

  test("count_tokens non-JSON body -> 400 invalid_request_error", async () => {
    startFakeCpa(() => messageJson());
    const res = await gw(
      new Request("http://localhost" + COUNT_TOKENS_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": PLAINTEXT },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type: string; error: { type: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
    expect(captured.length).toBe(0);
  });
});

describe("/v1/messages money invariants", () => {
  test("upstream 200 without usage -> exactly ONE full-hold settlement, no double charge", async () => {
    startFakeCpa(() => messageJson(null));
    const res = await mreq(messagesBody());
    expect(res.status).toBe(200);
    expect((await lastCharge()).status).toBe("settled_full_hold");
    expect(await ledgerDelta()).toBe(1);
    expect((await walletBalance()).reserved).toBe(0);
    expect((await lastRequest()).status).toBe("unknown");
  });

  test("settlement replay: re-settling the same requestId creates no second charge", async () => {
    startFakeCpa(() => messageJson());
    const res = await mreq(messagesBody());
    expect(res.status).toBe(200);
    expect(await ledgerDelta()).toBe(1);
    const req = await lastRequest();
    const before = (await walletBalance()).balance;
    await settleRequest(
      db,
      req.id,
      {
        kind: "usage",
        usage: {
          inputTokens: 1000n,
          outputTokens: 100n,
          cachedInputTokens: 0n,
          reasoningTokens: 0n,
        },
        upstreamModel: UPSTREAM_MODEL,
        provider: "anthropic",
        publicModel: PUBLIC_MODEL,
      } as never,
      Date.now(),
    );
    expect(await ledgerDelta()).toBe(1);
    expect((await walletBalance()).balance).toBe(before);
    expect((await walletBalance()).reserved).toBe(0);
  });

  test("client abort mid-stream -> full hold once, upstream aborted", async () => {
    startFakeCpa(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("event: message_start\ndata: {}\n\n"));
            },
            cancel() {
              upstreamAborted = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const res = await mreq(messagesBody({ stream: true }));
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    let status = "";
    await waitFor(async () => {
      status = (await lastRequest()).status;
      return upstreamAborted && status === "client_abort";
    });
    expect(status).toBe("client_abort");
    expect((await lastCharge()).status).toBe("settled_full_hold");
    expect(await ledgerDelta()).toBe(1);
    expect((await walletBalance()).reserved).toBe(0);
  });

  test("upstream 500 -> sanitized passthrough + full hold once", async () => {
    startFakeCpa(
      () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "api_error", message: `upstream failure on ${UPSTREAM_MODEL}` },
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        ),
    );
    const res = await mreq(messagesBody());
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain(UPSTREAM_MODEL);
    expect((await lastCharge()).status).toBe("settled_full_hold");
    expect(await ledgerDelta()).toBe(1);
  });

  test("concurrent reservations: no double-spend, balance drop equals ledger sum", async () => {
    startFakeCpa(() => messageJson());
    const initial = (await walletBalance()).balance;
    const initialLedgerSum = Number((await ledgerSum()).s);
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => mreq(messagesBody({ max_tokens: 16 }))),
    );
    for (const r of responses) expect(r.status).toBe(200);
    const after = (await walletBalance()).balance;
    const reserved = (await walletBalance()).reserved;
    const totalLedger = Number((await ledgerSum()).s) - initialLedgerSum;
    expect(reserved).toBe(0);
    expect(initial - after).toBe(totalLedger);
    expect(initial - after).toBeGreaterThan(0);
    // Exactly one ledger charge per request.
    expect(await ledgerDelta()).toBe(6);
  });
});
