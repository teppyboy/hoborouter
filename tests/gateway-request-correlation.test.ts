// Gateway correlation + SSE scrub regressions:
// 1. Every response issued after the request row exists (reserve succeeded)
//    carries x-hbr-request-id — including pre-dispatch release failures,
//    upstream header-timeout 502s, client-abort 499s and stream-setup 502s —
//    and the id matches the requests row; a failed dispatch charges the full
//    hold exactly once (single ledger entry, reserved returned to 0).
// 2. SSE `data:` events WITHOUT the optional space after the colon are still
//    model-scrubbed (no upstream id reaches the client) and the stream stays
//    incremental (chunks pass through as they arrive, not buffered whole).
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { createTestDb, type Db } from "../packages/db/src/index";
import { hashApiKey } from "../packages/keys/src/keys";
import { buildApp } from "../apps/api/src/app";

const KEY = "sk-hbr-rc-key";
const UPSTREAM = "gpt-rc-upstream";
const PUBLIC = "openai/rc-test";
const CHAT_PATH = "/v1/chat/completions";
const ENV_KEYS = [
  "HBR_GATEWAY_ENABLED",
  "CPA_BASE_URL",
  "CPA_ACCESS_KEY",
  "HBR_USD_VND_RATE",
  "HBR_UPSTREAM_HEADERS_TIMEOUT_MS",
];

let db: Db;
let drop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let fakeServer: ReturnType<typeof Bun.serve> | null = null;

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  drop = t.drop;
  const now = Date.now();
  const q = (text: string, params: unknown[] = []) => db.$client.unsafe(text, params as never[]);
  await q(
    `INSERT INTO workspaces (id, name, status, created_at) VALUES ('ws-rc','rc','active',$1)`,
    [now],
  );
  await q(
    `INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at)
     VALUES ('wal-rc','ws-rc','VND',1000000000,0,0,$1)`,
    [now],
  );
  await q(
    `INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at, purpose)
     VALUES ('key-rc','ws-rc',$1,'sk-hbr-r...','rc','enabled',$2,'generic')`,
    [hashApiKey(KEY), now],
  );
  await q(
    `INSERT INTO models (id, public_id, slug, display_name, provider, context_window, enabled, published, created_at, updated_at)
     VALUES ('mdl-rc','openai/rc-test','rc-test','RC Test','openai',128000,true,true,$1,$1)`,
    [now],
  );
  await q(
    `INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at)
     VALUES ('map-rc','mdl-rc','openai','gpt-rc-upstream',true,$1,$1)`,
    [now],
  );
  await q(
    `INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at, retired_at)
     VALUES ('price-rc','mdl-rc',1000000,2000000,500000,3000000,1200000,$1,NULL)`,
    [now - 1000],
  );
  app = await buildApp({ db });
});

afterAll(async () => {
  await drop();
  fakeServer?.stop(true);
});

beforeEach(() => {
  process.env.HBR_GATEWAY_ENABLED = "1";
  process.env.CPA_ACCESS_KEY = "test-cpa-secret";
  process.env.HBR_USD_VND_RATE = "26000";
  delete process.env.HBR_UPSTREAM_HEADERS_TIMEOUT_MS;
});

afterEach(async () => {
  fakeServer?.stop(true);
  fakeServer = null;
  for (const k of ENV_KEYS) delete process.env[k];
});

function startFakeCpa(handler: (path: string) => Response | Promise<Response>) {
  fakeServer = Bun.serve({
    port: 0,
    fetch: (req) => handler(new URL(req.url).pathname),
  });
  process.env.CPA_BASE_URL = `http://127.0.0.1:${fakeServer.port}`;
}

const sseEvent = (withSpace: boolean, content: string): string => {
  const payload = JSON.stringify({
    model: UPSTREAM,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  });
  return (withSpace ? `data: ${payload}` : `data:${payload}`) + "\n\n";
};

const post = (signal?: AbortSignal) =>
  app.handle(
    new Request("http://localhost" + CHAT_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: PUBLIC,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
      ...(signal ? { signal } : {}),
    }),
  );

const dbRows = async (text: string, params: unknown[] = []): Promise<Record<string, string>[]> =>
  (await db.$client.unsafe(text, params as never[])) as Record<string, string>[];

/** The header id must match exactly one requests row; exactly one full-hold
 * ledger debit exists for it and the wallet hold was returned (reserved 0).
 * Scoped by the id: the shared fixture DB accumulates rows across tests. */
const assertCorrelatedFullHold = async (res: Response) => {
  const id = res.headers.get("x-hbr-request-id");
  expect(id).toBeTypeOf("string");
  const rid = id!; // narrowed by the expect above
  const rows = await dbRows(`SELECT id FROM requests WHERE id = $1`, [rid]);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.id).toBe(rid);
  const ledger = await dbRows(
    `SELECT COUNT(*) c FROM ledger_entries WHERE billing_reservation_id IN
     (SELECT id FROM billing_reservations WHERE request_id = $1) AND direction = 'debit'`,
    [id],
  );
  expect(Number(ledger[0]!.c)).toBe(1);
  const wallet = await dbRows(`SELECT reserved FROM wallets WHERE id = 'wal-rc'`);
  expect(wallet[0]!.reserved).toBe("0");
};

describe("gateway request correlation", () => {
  test("upstream header timeout -> 502 with matching x-hbr-request-id, full hold charged once", async () => {
    process.env.HBR_UPSTREAM_HEADERS_TIMEOUT_MS = "120";
    startFakeCpa(() => new Promise<Response>(() => {})); // never answers headers
    const res = await post();
    expect(res.status).toBe(502);
    await assertCorrelatedFullHold(res);
  });

  test("client abort during dispatch -> 499 with matching x-hbr-request-id, full hold charged once", async () => {
    process.env.HBR_UPSTREAM_HEADERS_TIMEOUT_MS = "500";
    startFakeCpa(() => new Promise<Response>(() => {}));
    const ac = new AbortController();
    const pending = post(ac.signal);
    await Bun.sleep(30); // let the request reach the dispatch phase
    ac.abort();
    const res = await pending;
    expect(res.status).toBe(499);
    await assertCorrelatedFullHold(res);
  });

  test("pre-dispatch release failure (markDispatching blocked) -> 400 with matching x-hbr-request-id", async () => {
    startFakeCpa(() => new Response("{}", { headers: { "content-type": "application/json" } }));
    // Force markDispatching to throw (its CAS update raises) so the handler
    // takes the pre-dispatch release path. The WHEN clause blocks ONLY the
    // reserved->dispatching transition; releaseRequest (reserved->terminal)
    // still runs, so its financial checks execute for real and the hold is
    // actually returned instead of leaking into later assertions.
    await db.$client.unsafe(
      `CREATE FUNCTION rc_block_dispatch() RETURNS trigger AS $$
       BEGIN RAISE EXCEPTION 'forced markDispatching failure'; END
       $$ LANGUAGE plpgsql`,
    );
    await db.$client.unsafe(
      `CREATE TRIGGER rc_block_dispatch_upd BEFORE UPDATE OF dispatch_state ON requests
       FOR EACH ROW WHEN (NEW.dispatch_state = 'dispatching')
       EXECUTE FUNCTION rc_block_dispatch()`,
    );
    try {
      const res = await post();
      expect(res.status).toBe(400);
      const id = res.headers.get("x-hbr-request-id");
      expect(id).toBeTypeOf("string");
      const rid = id!; // narrowed by the expect above
      const rows = await dbRows(`SELECT id FROM requests WHERE id = $1`, [rid]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(rid);
      const debits = await dbRows(
        `SELECT COUNT(*) c FROM ledger_entries WHERE billing_reservation_id IN
         (SELECT id FROM billing_reservations WHERE request_id = $1)`,
        [id],
      );
      expect(Number(debits[0]!.c)).toBe(0);
    } finally {
      await db.$client.unsafe(`DROP TRIGGER rc_block_dispatch_upd ON requests`);
      await db.$client.unsafe(`DROP FUNCTION rc_block_dispatch()`);
    }
  });

  test("upstream 200 with no stream body -> 502 with matching x-hbr-request-id, full hold charged once", async () => {
    // Injected fetch mock: Bun.serve converts a null-body Response into an
    // empty stream, so the faithful Response(null) body-less branch is only
    // reachable this way. Restored immediately after.
    const origFetch = globalThis.fetch;
    const fakeFetch: typeof fetch = Object.assign(
      async () =>
        new Response(null, { status: 200, headers: { "content-type": "text/event-stream" } }),
      { preconnect: async () => {} },
    );
    globalThis.fetch = fakeFetch;
    try {
      const res = await post();
      expect(res.status).toBe(502);
      await assertCorrelatedFullHold(res);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("SSE data: no-space scrubbing", () => {
  test("events with and without the space are scrubbed and the stream stays incremental", async () => {
    let serverClosed = false;
    startFakeCpa(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              const enc = new TextEncoder();
              // Event 1 without the space, immediately; event 2 with the
              // space after a visible gap, then close.
              controller.enqueue(enc.encode(sseEvent(false, "He")));
              await Bun.sleep(80);
              controller.enqueue(enc.encode(sseEvent(true, "llo")));
              controller.close();
              serverClosed = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.headers.get("x-hbr-request-id")).toBeTruthy();
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const first = dec.decode((await reader.read()).value);
    // Incremental: the first event arrives before the upstream stream closes;
    // a buffering gateway would only resolve this read after close.
    expect(serverClosed).toBe(false);
    const rest = dec.decode((await reader.read()).value) + dec.decode((await reader.read()).value);
    const text = first + rest;
    expect(text).not.toContain(UPSTREAM);
    expect(text).toContain(PUBLIC);
    // Both events reached the client with their delta content intact.
    expect(text).toContain('"content":"He"');
    expect(text).toContain('"content":"llo"');
  });
});
