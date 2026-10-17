// Gateway cap resolution + side-effect-free preflight (spec 2026-10-08 rev5 §1b):
// body limit resolved from key purpose + path (chat-purpose key on
// /v1/chat/completions: 16 MiB; everything else: 1 MiB). Both size gates run
// BEFORE any DB write: an oversized request updates no last_used_at, consumes
// no rate-limit slot, creates no reservation, and cancels the body stream.
// Scrubbing (upstream-id rewrite) still applies on the 16 MiB path; overflow
// is a function of bounded tokens × price, not body size (§1d).
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { createTestDb, type Db } from "../packages/db/src/index";
import { hashApiKey } from "../packages/keys/src/keys";
import { buildApp } from "../apps/api/src/app";
import { CHAT_MAX_BODY_BYTES, MAX_BODY_BYTES } from "../apps/api/src/routes/v1-gateway";

const GENERIC = "sk-hbr-gw-generic-key";
const CHAT = "sk-hbr-gw-chat-key";
const CPA_KEY = "test-cpa-secret";
const CHAT_PATH = "/v1/chat/completions";
const RESPONSES_PATH = "/v1/responses";

const ENV_KEYS = ["HBR_GATEWAY_ENABLED", "CPA_BASE_URL", "CPA_ACCESS_KEY", "HBR_USD_VND_RATE"];
let savedEnv: Record<string, string | undefined> = {};

let db: Db;
let drop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let gw: (req: Request) => Promise<Response>;
beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  drop = t.drop;
  const now = Date.now();
  const q = (text: string, params: unknown[] = []) => db.$client.unsafe(text, params as never[]);
  await q(
    `INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws-cg','cg','active',$1)`,
    [now],
  );
  await q(
    `INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at)
     VALUES ('wal-cg','ws-cg','VND',1000000000,0,0,$1)`,
    [now],
  );
  await q(
    `INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at, purpose)
     VALUES ('key-cg-generic','ws-cg',$1,'sk-hbr-g...','generic','enabled',$2,'generic'),
            ('key-cg-chat','ws-cg',$3,'sk-hbr-c...','chat','enabled',$2,'chat')`,
    [hashApiKey(GENERIC), now, hashApiKey(CHAT)],
  );
  await q(
    `INSERT INTO models (id, public_id, slug, display_name, provider, context_window, enabled, published, created_at, updated_at)
     VALUES ('mdl-cg','openai/cg-test','cg-test','CG Test','openai',128000,true,true,$1,$1)`,
    [now],
  );
  await q(
    `INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at)
     VALUES ('map-cg','mdl-cg','openai','gpt-4o-upstream',true,$1,$1)`,
    [now],
  );
  await q(
    `INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at, retired_at)
     VALUES ('price-cg','mdl-cg',1000000,2000000,500000,3000000,1200000,$1,NULL)`,
    [now - 1000],
  );
  gw = (req) => app!.handle(req);
});

beforeAll(async () => {
  app = await buildApp({ db });
});

afterAll(async () => {
  await drop();
  fakeServer?.stop(true);
});

type Captured = { path: string; headers: Headers; body: string };
let captured: Captured[] = [];
let fakeServer: ReturnType<typeof Bun.serve> | null = null;

function startFakeCpa(handler: (c: Captured) => Response | Promise<Response>) {
  captured = [];
  fakeServer = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const c = { path: new URL(req.url).pathname, headers: req.headers, body: await req.text() };
      captured.push(c);
      return await handler(c);
    },
  });
  process.env.CPA_BASE_URL = `http://127.0.0.1:${fakeServer.port}`;
}

const chatJson = () =>
  new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      model: "gpt-4o-upstream",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    }),
    { headers: { "content-type": "application/json" } },
  );

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.HBR_GATEWAY_ENABLED = "1";
  process.env.CPA_ACCESS_KEY = CPA_KEY;
  process.env.HBR_USD_VND_RATE = "26000";
  delete process.env.CPA_BASE_URL;
});

afterEach(async () => {
  fakeServer?.stop(true);
  fakeServer = null;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const lastUsedAt = async (keyId: string): Promise<number | null> => {
  const rows = (await db.$client.unsafe(`SELECT last_used_at FROM api_keys WHERE id = $1`, [
    keyId,
  ] as never[])) as { last_used_at: string | null }[];
  return rows[0]!.last_used_at === null ? null : Number(rows[0]!.last_used_at);
};

const requestCount = async (): Promise<number> => {
  const rows = (await db.$client.unsafe(`SELECT COUNT(*) c FROM requests`)) as { c: number }[];
  return Number(rows[0]!.c);
};

const ledgerCount = async (): Promise<number> => {
  const rows = (await db.$client.unsafe(`SELECT COUNT(*) c FROM ledger_entries`)) as {
    c: number;
  }[];
  return Number(rows[0]!.c);
};

/** Body from a counting stream: records consumer reads and cancel. HWM 0 so
 * the source never pre-fills: pull fires only on an actual read. */
function streamBody(chunks: Uint8Array[]): {
  body: ReadableStream<Uint8Array>;
  state: { reads: number; cancelled: boolean };
} {
  const state = { reads: 0, cancelled: false };
  const iter = chunks[Symbol.iterator]();
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const next = iter.next();
        if (next.done) controller.close();
        else {
          state.reads++;
          controller.enqueue(next.value);
        }
      },
      cancel() {
        state.cancelled = true;
      },
    },
    new CountQueuingStrategy({ highWaterMark: 0 }),
  );
  return { body, state };
}

const ascii = (bytes: number): Uint8Array => new Uint8Array(bytes).fill(97); // 'a'

function post(path: string, body: BodyInit, key = GENERIC, headers: Record<string, string> = {}) {
  return gw(
    new Request("http://localhost" + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...headers,
      },
      body,
    }),
  );
}

const overMiB = (n: number) =>
  JSON.stringify({
    model: "openai/cg-test",
    messages: [{ role: "user", content: "x".repeat(n * 1024 * 1024) }],
  });

describe("chat-purpose gateway cap", () => {
  test("invalid auth + 2 MiB streamed body -> 401, stream never read", async () => {
    const { body, state } = streamBody([ascii(2 * 1024 * 1024)]);
    const res = await post(CHAT_PATH, body, "sk-hbr-nope");
    expect(res.status).toBe(401);
    expect(state.reads).toBe(0);
  });

  test("generic key + 2 MiB -> 413 payload_too_large; no last_used_at, no reservation/ledger, no slot", async () => {
    startFakeCpa(() => chatJson());
    const reqs = await requestCount();
    const ledger = await ledgerCount();
    const res = await post(CHAT_PATH, overMiB(2));
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "payload_too_large",
    );
    expect(await lastUsedAt("key-cg-generic")).toBeNull();
    expect(await requestCount()).toBe(reqs);
    expect(await ledgerCount()).toBe(ledger);
    expect(captured.length).toBe(0);
  });

  test("generic key + lying declared Content-Length -> 413 from declared gate, same no-side-effect", async () => {
    startFakeCpa(() => chatJson());
    const res = await post(CHAT_PATH, overMiB(0.1), GENERIC, {
      "content-length": String(MAX_BODY_BYTES + 1),
    });
    expect(res.status).toBe(413);
    expect(await lastUsedAt("key-cg-generic")).toBeNull();
    expect(captured.length).toBe(0);
  });

  test("chat key + chat/completions at 16 MiB-ε dispatches; upstream id scrubbed from client response", async () => {
    startFakeCpa(() => chatJson());
    const filler = "x".repeat(CHAT_MAX_BODY_BYTES - 1024);
    const res = await post(
      CHAT_PATH,
      JSON.stringify({ model: "openai/cg-test", messages: [{ role: "user", content: filler }] }),
      CHAT,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("gpt-4o-upstream");
    const out = JSON.parse(text) as { model: string };
    expect(out.model).toBe("openai/cg-test");
    // outbound to CPA carries the upstream id; client response never does
    expect(captured.length).toBe(1);
    expect(JSON.parse(captured[0]!.body).model).toBe("gpt-4o-upstream");
    // last_used_at updated exactly once, after the gates
    expect(await lastUsedAt("key-cg-chat")).not.toBeNull();
  });

  test("chat key + chat/completions at 16 MiB+ε mid-stream -> 413 with reader cancel, no last_used_at", async () => {
    startFakeCpa(() => chatJson());
    const before = await lastUsedAt("key-cg-chat");
    const { body, state } = streamBody([ascii(15 * 1024 * 1024), ascii(2 * 1024 * 1024)]);
    const res = await post(CHAT_PATH, body, CHAT);
    expect(res.status).toBe(413);
    expect(state.cancelled).toBe(true);
    expect(await lastUsedAt("key-cg-chat")).toBe(before);
    expect(captured.length).toBe(0);
  });

  test("chat key + /v1/responses > 1 MiB -> 413 (purpose does not leak across paths)", async () => {
    startFakeCpa(() => chatJson());
    await db.$client.unsafe(`UPDATE api_keys SET last_used_at = NULL WHERE id = 'key-cg-chat'`);
    const res = await post(RESPONSES_PATH, overMiB(2), CHAT);
    expect(res.status).toBe(413);
    expect(await lastUsedAt("key-cg-chat")).toBeNull();
    expect(captured.length).toBe(0);
  });

  test("oversize 413 consumes no subscription rate-limit slot (limit-1 room still usable)", async () => {
    const now = Date.now();
    await db.$client.unsafe(
      `INSERT INTO subscription_plans (id, name, price_vnd, credit_per_period_vnd, period_days, active, created_at)
       VALUES ('plan-cg','plan-cg',100000,100000,30,true,$1)`,
      [now] as never[],
    );
    await db.$client.unsafe(
      `INSERT INTO subscriptions (id, workspace_id, plan_id, status, current_period_start, current_period_end, created_at)
       VALUES ('sub-cg','ws-cg','plan-cg','active',$1,$2,$1)`,
      [now - 86400000, now + 86400000] as never[],
    );
    await db.$client.unsafe(
      `UPDATE subscription_plans SET rate_limit_per_minute = 1 WHERE id = 'plan-cg'`,
    );
    await db.$client.unsafe(
      `INSERT INTO wallets (id, workspace_id, currency, kind, balance, reserved, version, created_at)
       VALUES ('wal-cg-sub','ws-cg','VND','subscription',1000000000,0,0,$1)`,
      [now] as never[],
    );
    startFakeCpa(() => chatJson());
    const big = await post(CHAT_PATH, overMiB(2), GENERIC);
    expect(big.status).toBe(413);
    // If the 413 had counted a slot, this under-limit request would 429.
    const ok = await post(
      CHAT_PATH,
      JSON.stringify({ model: "openai/cg-test", messages: [{ role: "user", content: "hi" }] }),
      GENERIC,
    );
    expect(ok.status).toBe(200);
  });

  test("unaffordable overflow estimate is rejected before dispatch or ledger writes", async () => {
    // Isolated workspace: the rate-limit test above consumed its slot; overflow
    // must be measured before any limiter/reservation activity.
    const now = Date.now();
    await db.$client.unsafe(
      `INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws-of','of','active',$1)`,
      [now] as never[],
    );
    await db.$client.unsafe(
      `INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at)
       VALUES ('wal-of','ws-of','VND',1000000000,0,0,$1)`,
      [now] as never[],
    );
    await db.$client.unsafe(
      `INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at, purpose)
       VALUES ('key-of','ws-of',$1,'sk-hbr-o...','of','enabled',$2,'generic')`,
      [hashApiKey("sk-hbr-gw-of-key"), now] as never[],
    );
    // context_window 1e6 + price 8e15 µUSD/1M input => bounded maxInputTokens
    // (1e6, from the 1 MiB body) x fx 2000000 pushes capVnd past maxStoredMoney.
    await db.$client.unsafe(
      `INSERT INTO models (id, public_id, slug, display_name, provider, context_window, enabled, published, created_at, updated_at)
       VALUES ('mdl-of','openai/of-test','of-test','OF Test','openai',1000000,true,true,$1,$1)`,
      [now] as never[],
    );
    await db.$client.unsafe(
      `INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at)
       VALUES ('map-of','mdl-of','openai','gpt-of-upstream',true,$1,$1)`,
      [now] as never[],
    );
    await db.$client.unsafe(
      `INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at, retired_at)
       VALUES ('price-of','mdl-of',8000000000000000,2000000,500000,3000000,1000000,$1,NULL)`,
      [now - 1000] as never[],
    );
    startFakeCpa(() => chatJson());
    // Inflated fx for the fixture: bounded usdMicro (8e15) x fx 2e6 x markup
    // pushes capVnd past maxStoredMoney -> estimateCapVnd throws overflow.
    process.env.HBR_USD_VND_RATE = "2000000";
    const walletBefore = (
      (await db.$client.unsafe(`SELECT balance, reserved FROM wallets WHERE id = 'wal-of'`)) as {
        balance: string;
        reserved: string;
      }[]
    )[0]!;
    // Baselines before the request: earlier tests in this file dispatched
    // successfully and legitimately wrote ledger rows; the overflow request
    // must add none.
    const capturedBefore = captured.length;
    const ledgerBefore = await ledgerCount();
    const res2 = await post(
      CHAT_PATH,
      JSON.stringify({
        model: "openai/of-test",
        messages: [{ role: "user", content: "x".repeat(1024 * 1024 - 512) }],
      }),
      "sk-hbr-gw-of-key",
    );
    const text = await res2.text();
    expect(text, text).toContain("insufficient_balance");
    expect(res2.status, text).toBe(402);
    expect(captured.length).toBe(capturedBefore);
    expect(await ledgerCount()).toBe(ledgerBefore);
    const after = (
      (await db.$client.unsafe(`SELECT balance, reserved FROM wallets WHERE id = 'wal-of'`)) as {
        balance: string;
        reserved: string;
      }[]
    )[0]!;
    expect(after.balance).toBe(walletBefore.balance);
    expect(after.reserved).toBe("0");
  });
});
