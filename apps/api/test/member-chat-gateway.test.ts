// Gateway member regressions: 'chat_member' keys are restricted to
// /v1/chat/completions with the 16MiB body cap, new generations are denied on
// policy-off/revoked-membership while an already-dispatched request still
// settles into its ticketed period, and the member daily cap folds into the
// affordable-output clamp (a small cap clamps instead of 402ing the full
// context; an unfundable cap 429s at the UTC rollover).
import { describe, expect, test, beforeAll } from "bun:test";
import { Elysia } from "elysia";
import { and, eq } from "drizzle-orm";
import { createTestDb, memberChatUsage, workspaceMembers } from "@hoborouter/db";
import { hashApiKey } from "@hoborouter/keys";
import { trackDrop, q, waitFor } from "./helpers";
import { gatewayRoutes } from "../src/routes/v1-gateway";
import { utcDay } from "@hoborouter/wallet";

const MEMBER_KEY = "sk-hbr-mc-member";
const GENERIC_KEY = "sk-hbr-mc-generic";
const CPA_KEY = "test-cpa-secret";
const CHAT_PATH = "/v1/chat/completions";
const PUBLIC_MODEL = "openai/mc-test";
const UPSTREAM_MODEL = "mc-upstream";
const FX = 26000;
const CTX = 1_000_000;
const NOW = Date.now();

let db: Awaited<ReturnType<typeof createTestDb>>["db"];

async function seedMemberGateway(cap: number | null, enabled: boolean) {
  await q(db, "INSERT INTO users (id, name, email, created_at, updated_at) VALUES ('u-mc','M','u-mc@t.local',?,?)", NOW, NOW);
  await q(db, "INSERT INTO workspaces (id, name, status, created_at, member_chat_enabled, member_chat_daily_cap_vnd) VALUES ('ws-mc','mc','active',?,?,?)", NOW, enabled, cap);
  await q(db, "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws-mc','u-mc','member')");
  await q(
    db,
    "INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at, purpose, owner_user_id) VALUES ('key-mc','ws-mc',?,?,'member','active',?,'chat_member','u-mc')",
    hashApiKey(MEMBER_KEY),
    "sk-hbr-mc...",
    NOW,
  );
  await q(
    db,
    "INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at, purpose) VALUES ('key-generic','ws-mc',?,?,'generic','active',?,'generic')",
    hashApiKey(GENERIC_KEY),
    "sk-hbr-gc...",
    NOW,
  );
  await q(
    db,
    "INSERT INTO wallets (id, workspace_id, kind, currency, balance, reserved, version, created_at) VALUES ('wal-mc','ws-mc','topup','VND',494000,0,0,?)",
    NOW,
  );
  await q(
    db,
    "INSERT INTO models (id, public_id, slug, display_name, provider, context_window, enabled, published, created_at, updated_at) VALUES ('mdl-mc',?,?,'MC Test','openai',?,true,true,?,?)",
    PUBLIC_MODEL,
    "mc-test",
    CTX,
    NOW,
    NOW,
  );
  await q(
    db,
    "INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at) VALUES ('map-mc','mdl-mc','openai',?,true,?,?)",
    UPSTREAM_MODEL,
    NOW,
    NOW,
  );
  // 1x markup: per-token cost = 0.26 VND input, 1.3 VND output.
  await q(
    db,
    "INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at, retired_at) VALUES ('price-mc','mdl-mc',10000000,50000000,0,0,1000000,?,NULL)",
    NOW - 1000,
  );
}

let gw: (req: Request) => Promise<Response>;
const gwr = (path: string, body: unknown, key = MEMBER_KEY, extraHeaders: Record<string, string> = {}) =>
  gw(
    new Request("http://localhost" + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    }),
  );

type Captured = { path: string; body: string };
let captured: Captured[] = [];
// When set, the fake CPA holds its response until released — lets a test
// revoke membership AFTER dispatch (reserve committed) but BEFORE settle.
let holdCpa: { promise: Promise<void>; resolve: () => void } | null = null;
let fakeServer: ReturnType<typeof Bun.serve> | null = null;

function startFakeCpa() {
  captured = [];
  fakeServer = Bun.serve({
    port: 0,
    fetch: async (req) => {
      captured.push({ path: new URL(req.url).pathname, body: await req.text() });
      if (holdCpa) await holdCpa.promise;
      return new Response(
        JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          model: UPSTREAM_MODEL,
          choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  process.env.CPA_BASE_URL = `http://127.0.0.1:${fakeServer.port}`;
  return fakeServer;
}

const memberUsed = async () => {
  const rows = await db
    .select({ used: memberChatUsage.used_vnd })
    .from(memberChatUsage)
    .where(
      and(
        eq(memberChatUsage.workspace_id, "ws-mc"),
        eq(memberChatUsage.user_id, "u-mc"),
        eq(memberChatUsage.period_start, utcDay(Date.now())),
      ),
    );
  return rows[0]?.used ?? 0;
};

beforeAll(async () => {
  process.env.HBR_GATEWAY_ENABLED = "1";
  process.env.CPA_ACCESS_KEY = CPA_KEY;
  process.env.HBR_USD_VND_RATE = String(FX);
  delete process.env.HBR_DEFAULT_MAX_OUTPUT_TOKENS;
  const t = await createTestDb();
  db = t.db;
  trackDrop(t.drop);
  await seedMemberGateway(25000, true);
  startFakeCpa();
  gw = (req) => new Elysia().use(gatewayRoutes(db)).handle(req);
});

describe("chat_member gateway restriction", () => {
  test("chat_member keys are rejected on /v1/responses and /v1/messages", async () => {
    const res1 = await gwr("/v1/responses", { model: PUBLIC_MODEL, input: "hi" });
    expect(res1.status).toBe(403);
    expect(((await res1.json()) as { error: { code: string } }).error.code).toBe("member_key_restricted");
    const res2 = await gwr("/v1/messages", { model: PUBLIC_MODEL, max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    expect(res2.status).toBe(403);
  });

  test("member chat keys carry the 16MiB body cap; generic keys stay at 1MiB", async () => {
    const big = { model: PUBLIC_MODEL, max_tokens: 10, messages: [{ role: "user", content: "x".repeat(1_200_000) }] };
    // 1.2MiB body: under the member/chat cap (16MiB) -> proceeds past the size gate.
    const memberRes = await gwr(CHAT_PATH, big, MEMBER_KEY);
    expect(memberRes.status).not.toBe(413);
    // Same body on a generic key -> 413 at the 1MiB gate, and NO member hold.
    const genericRes = await gwr(CHAT_PATH, big, GENERIC_KEY);
    expect(genericRes.status).toBe(413);
  });

  test("affordable member cap: small daily cap CLAMPS the forwarded output instead of 402", async () => {
    // Cap 25000 VND: input ~26 + output tokens at 1.3 VND -> thousands of
    // output tokens affordable, far below the 1M-token context request.
    const res = await gwr(CHAT_PATH, { model: PUBLIC_MODEL, max_tokens: 1_000_000, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(captured.length).toBeGreaterThan(0);
    const forwarded = (JSON.parse(captured[captured.length - 1]!.body) as { max_tokens: number }).max_tokens;
    expect(forwarded).toBeGreaterThan(0);
    expect(forwarded).toBeLessThan(1_000_000);
    // The hold sits on the member counter and settles into it (charged actual).
    const used = await memberUsed();
    expect(used).toBeGreaterThan(0);
    expect(used).toBeLessThanOrEqual(25000);
  });

  test("exhausted member cap: 429 with retry-after, not a wallet 402", async () => {
    // Park the counter just under the cap; any new admission exceeds it.
    await db
      .update(memberChatUsage)
      .set({ used_vnd: 25000 })
      .where(and(eq(memberChatUsage.workspace_id, "ws-mc"), eq(memberChatUsage.period_start, utcDay(Date.now()))));
    const res = await gwr(CHAT_PATH, { model: PUBLIC_MODEL, max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("member_budget_exceeded");
    expect(res.headers.get("retry-after")).toBeTruthy();
    // Restore an empty counter for the policy-off test.
    await db
      .update(memberChatUsage)
      .set({ used_vnd: 0 })
      .where(and(eq(memberChatUsage.workspace_id, "ws-mc"), eq(memberChatUsage.period_start, utcDay(Date.now()))));
  });

  test("policy off: new member generations denied; the settled period row is history, not reset", async () => {
    const usedBefore = await memberUsed();
    await q(db, "UPDATE workspaces SET member_chat_enabled = false WHERE id = 'ws-mc'");
    const res = await gwr(CHAT_PATH, { model: PUBLIC_MODEL, max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("member_chat_disabled");
    expect(await memberUsed()).toBe(usedBefore);
    await q(db, "UPDATE workspaces SET member_chat_enabled = true WHERE id = 'ws-mc'");
  });

  test("revoked membership: new member generations denied (403), counter untouched", async () => {
    await db
      .delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspace_id, "ws-mc"), eq(workspaceMembers.user_id, "u-mc")));
    const res = await gwr(CHAT_PATH, { model: PUBLIC_MODEL, max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("member_chat_disabled");
    const used = await memberUsed();
    await db
      .insert(workspaceMembers)
      .values({ workspace_id: "ws-mc", user_id: "u-mc", role: "member" });
    expect(await memberUsed()).toBe(used);
  });

  test("old dispatched request still settles into its ticketed period after denial", async () => {
    // Hold the CPA response, revoke the membership once the request is
    // DISPATCHED (reserve committed, upstream reached), then let settlement
    // run: the response still streams and the ticketed period row takes the
    // actual charge — denial applies to NEW generations only.
    const capturedBefore = captured.length;
    let releaseCpa!: () => void;
    const gate = new Promise<void>((r) => (releaseCpa = r));
    holdCpa = { promise: gate, resolve: releaseCpa };
    const pending = gwr(CHAT_PATH, {
      model: PUBLIC_MODEL,
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
    });
    await waitFor(async () => captured.length > capturedBefore);
    await db
      .delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspace_id, "ws-mc"), eq(workspaceMembers.user_id, "u-mc")));
    holdCpa.resolve();
    holdCpa = null;
    const res = await pending;
    expect(res.status).toBe(200);
    await res.text();
    const usedRows = await db
      .select({ used: memberChatUsage.used_vnd })
      .from(memberChatUsage)
      .where(and(eq(memberChatUsage.workspace_id, "ws-mc"), eq(memberChatUsage.user_id, "u-mc")));
    expect(usedRows.length).toBeGreaterThan(0);
    expect(usedRows[0]!.used).toBeGreaterThan(0);
    await db.insert(workspaceMembers).values({ workspace_id: "ws-mc", user_id: "u-mc", role: "member" });
  });
});
