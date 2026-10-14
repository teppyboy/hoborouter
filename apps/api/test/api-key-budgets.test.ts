// Task 4 (OpenRouter parity): API-key expiry, per-period VND budgets, usage
// endpoint. Covers the atomic admission core (expiry, concurrent no-overspend,
// window reset boundary), the billing integration (reserve/release/settle fold
// the admission hold without touching wallet ledger semantics), the key CRUD
// policy validation, and the authorized usage endpoint (no secret exposure).
import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { Db } from "@hoborouter/db";
import { createTestDb } from "@hoborouter/db";
import {
  budgetWindow,
  checkAndReserveKeyBudget,
  getKeyBudgetRemainingVnd,
  releaseKeyBudgetHold,
  settleKeyBudgetHold,
  KeyBudgetError,
} from "@hoborouter/keys";
import {
  creditWallet,
  estimateCapVnd,
  markDispatching,
  releaseRequest,
  reserveRequest,
  settleRequest,
} from "@hoborouter/wallet";
import { signUp, req, createWorkspace, userIdByEmail } from "./helpers";
import { buildApp } from "../src/app";
import { createAuth } from "../src/auth";

// --- Part A: budget window boundaries (pure, no DB) ---

describe("budgetWindow", () => {
  test("daily: window is the UTC day containing now; boundary resets at exact midnight", () => {
    const mid = Date.UTC(2026, 0, 15, 12, 30);
    const w = budgetWindow("daily", mid);
    expect(w.start).toBe(Date.UTC(2026, 0, 15));
    expect(w.end).toBe(Date.UTC(2026, 0, 16));
    // A request at exactly the next midnight lands in the NEW window.
    expect(budgetWindow("daily", w.end).start).toBe(w.end);
  });

  test("weekly: Monday-based; a Sunday and its next Monday fall in different windows", () => {
    // 2026-01-18 is a Sunday; 2026-01-19 is the next Monday.
    const sunday = Date.UTC(2026, 0, 18, 23, 59);
    const monday = Date.UTC(2026, 0, 19, 0, 1);
    const ws = budgetWindow("weekly", sunday);
    expect(ws.start).toBe(Date.UTC(2026, 0, 12)); // Monday of that week
    expect(ws.end).toBe(Date.UTC(2026, 0, 19));
    const wm = budgetWindow("weekly", monday);
    expect(wm.start).toBe(Date.UTC(2026, 0, 19));
  });

  test("monthly: calendar month; boundary resets at the 1st", () => {
    const w = budgetWindow("monthly", Date.UTC(2026, 1, 14));
    expect(w.start).toBe(Date.UTC(2026, 1, 1));
    expect(w.end).toBe(Date.UTC(2026, 2, 1));
  });
});

// --- Part B: admission core ---

const T0 = Date.UTC(2026, 5, 10, 10, 0);

async function seedKey(
  db: Db,
  opts: { budgetVnd?: number; period?: "daily" | "weekly" | "monthly"; expiresAt?: number } = {},
): Promise<{ ws: string; key: string }> {
  const ws = `ws-${crypto.randomUUID().slice(0, 8)}`;
  const key = `key-${crypto.randomUUID().slice(0, 8)}`;
  await db.execute(
    sql`INSERT INTO workspaces (id, name, status, created_at) VALUES (${ws}, 'w', 'active', 1)`,
  );
  await db.execute(
    sql`INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at,
            expires_at, budget_vnd, budget_period, budget_used_vnd, budget_period_start)
        VALUES (${key}, ${ws}, ${"hash-" + key}, 'sk-hbr-x', 'k', 'enabled', 1,
            ${opts.expiresAt ?? null}, ${opts.budgetVnd ?? null}, ${opts.period ?? null}, 0,
            ${opts.budgetVnd != null ? T0 : null})`,
  );
  return { ws, key };
}

async function usedOf(db: Db, key: string): Promise<number> {
  const result: unknown = await db.execute(
    sql`SELECT budget_used_vnd FROM api_keys WHERE id = ${key}`,
  );
  // Connection-level execute wraps rows in { rows }; tx-level returns them.
  const list = ((result as { rows?: Record<string, unknown>[] }).rows ??
    (result as Record<string, unknown>[])) as Record<string, unknown>[];
  return Number(list[0]!.budget_used_vnd);
}

describe("checkAndReserveKeyBudget", () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    drop = t.drop;
  });
  afterAll(() => drop());

  test("expired key: rejects with 'expired' even with budget available", async () => {
    const { key } = await seedKey(db, { budgetVnd: 1000, period: "daily", expiresAt: T0 - 1 });
    await expect(
      checkAndReserveKeyBudget(db, { apiKeyId: key, capVnd: 100, now: T0 }),
    ).rejects.toThrow(KeyBudgetError);
    await expect(
      checkAndReserveKeyBudget(db, { apiKeyId: key, capVnd: 100, now: T0 }),
    ).rejects.toMatchObject({ code: "expired" });
  });

  test("admission holds capVnd; over-budget admission rejects with retryAfterMs to window end", async () => {
    const { key } = await seedKey(db, { budgetVnd: 600, period: "daily" });
    await checkAndReserveKeyBudget(db, { apiKeyId: key, capVnd: 300, now: T0 });
    expect(await usedOf(db, key)).toBe(300);
    // 300 + 250 fits within 600; one more 100 would exceed it.
    await checkAndReserveKeyBudget(db, { apiKeyId: key, capVnd: 250, now: T0 });
    const err = await checkAndReserveKeyBudget(db, { apiKeyId: key, capVnd: 100, now: T0 }).catch(
      (e: unknown) => e as KeyBudgetError,
    );
    expect(err).toBeInstanceOf(KeyBudgetError);
    expect((err as KeyBudgetError).code).toBe("budget_exceeded");
    expect((err as KeyBudgetError).retryAfterMs).toBe(budgetWindow("daily", T0).end - T0);
    expect(await usedOf(db, key)).toBe(550);
  });

  test("concurrent admissions serialize on the key row: budget 1000 cap 300 admits exactly 3 of 5", async () => {
    const { key } = await seedKey(db, { budgetVnd: 1000, period: "daily" });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        checkAndReserveKeyBudget(db, { apiKeyId: key, capVnd: 300, now: T0 }),
      ),
    );
    const admitted = results.filter((r) => r.status === "fulfilled").length;
    expect(admitted).toBe(3);
    expect(await usedOf(db, key)).toBe(900);
  });

  test("window reset boundary: first admission after the daily boundary resets the counter", async () => {
    const { key } = await seedKey(db, { budgetVnd: 500, period: "daily" });
    await checkAndReserveKeyBudget(db, { apiKeyId: key, capVnd: 500, now: T0 });
    expect(await usedOf(db, key)).toBe(500);
    // Exactly at the next UTC midnight the new window starts fresh.
    const nextDay = budgetWindow("daily", T0).end;
    await checkAndReserveKeyBudget(db, { apiKeyId: key, capVnd: 200, now: nextDay });
    expect(await usedOf(db, key)).toBe(200);
  });

  test("releaseKeyBudgetHold restores the hold; no-op when the window already rolled", async () => {
    const { key } = await seedKey(db, { budgetVnd: 500, period: "daily" });
    const { periodStart } = await checkAndReserveKeyBudget(db, {
      apiKeyId: key,
      capVnd: 300,
      now: T0,
    });
    await releaseKeyBudgetHold(db, { apiKeyId: key, periodStart: periodStart, holdVnd: 300 });
    expect(await usedOf(db, key)).toBe(0);
    // Stale window start (rolled over): release must not touch the fresh window.
    await checkAndReserveKeyBudget(db, { apiKeyId: key, capVnd: 100, now: T0 });
    await releaseKeyBudgetHold(db, {
      apiKeyId: key,
      periodStart: budgetWindow("daily", T0).end,
      holdVnd: 100,
    });
    expect(await usedOf(db, key)).toBe(100);
  });

  test("settleKeyBudgetHold folds hold - charged inside the caller transaction; full_hold nets zero", async () => {
    const { key } = await seedKey(db, { budgetVnd: 1000, period: "daily" });
    await checkAndReserveKeyBudget(db, { apiKeyId: key, capVnd: 400, now: T0 });
    await db.transaction(async (tx) => {
      await settleKeyBudgetHold(tx, { apiKeyId: key, holdVnd: 400, chargedVnd: 150, periodStart: null });
    });
    expect(await usedOf(db, key)).toBe(150);
    await db.transaction(async (tx) => {
      await settleKeyBudgetHold(tx, { apiKeyId: key, holdVnd: 400, chargedVnd: 400, periodStart: null });
    });
    expect(await usedOf(db, key)).toBe(400); // 150 - 400 clamped to 0, + 400
  });

  test("unknown key: key_invalid", async () => {
    await expect(
      checkAndReserveKeyBudget(db, { apiKeyId: "missing", capVnd: 1, now: T0 }),
    ).rejects.toMatchObject({ code: "key_invalid" });
  });
});

// --- Part C: billing integration (budget folds with reserve/settle) ---

const ENDPOINT = "/v1/chat/completions" as const;

describe("getKeyBudgetRemainingVnd", () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    drop = t.drop;
  });
  afterAll(() => drop());

  test("remaining = budget - in-window used; exhausted reports retryAfterMs to window end", async () => {
    const { key } = await seedKey(db, { budgetVnd: 1000, period: "daily" });
    await checkAndReserveKeyBudget(db, { apiKeyId: key, capVnd: 700, now: T0 });
    await releaseKeyBudgetHold(db, { apiKeyId: key, periodStart: T0, holdVnd: 700 });
    await db.execute(sql`UPDATE api_keys SET budget_used_vnd = 700 WHERE id = ${key}`);
    const headroom = await getKeyBudgetRemainingVnd(db, key, T0);
    expect(headroom).toMatchObject({ remaining: 300, expired: false, retryAfterMs: null });
    await db.execute(sql`UPDATE api_keys SET budget_used_vnd = 1000 WHERE id = ${key}`);
    const exhausted = await getKeyBudgetRemainingVnd(db, key, T0);
    expect(exhausted.remaining).toBe(0);
    expect(exhausted.retryAfterMs).toBe(budgetWindow("daily", T0).end - T0);
  });

  test("stale period_start (older window) counts as unused; no budget configured is null", async () => {
    const stale = await seedKey(db, { budgetVnd: 500, period: "daily" });
    await db.execute(
      sql`UPDATE api_keys SET budget_used_vnd = 500, budget_period_start = ${T0 - 86_400_000} WHERE id = ${stale.key}`,
    );
    expect((await getKeyBudgetRemainingVnd(db, stale.key, T0)).remaining).toBe(500);
    const unbudgeted = await seedKey(db, {});
    const headroom = await getKeyBudgetRemainingVnd(db, unbudgeted.key, T0);
    expect(headroom).toEqual({ remaining: null, expired: false, retryAfterMs: null });
  });

  test("expired key reports expired=true with null remaining (must not mask the 403)", async () => {
    const { key } = await seedKey(db, { budgetVnd: 1000, period: "daily", expiresAt: T0 - 1 });
    const headroom = await getKeyBudgetRemainingVnd(db, key, T0);
    expect(headroom).toMatchObject({ remaining: null, expired: true, retryAfterMs: null });
  });
});

describe("key budget x billing", () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    drop = t.drop;
  });
  afterAll(() => drop());

  const NOW2 = 1_700_000_000_000;

  async function seedCanonWithBudget(suffix: string): Promise<{
    ws: string;
    key: string;
    wallet: string;
    model: string;
    mapping: string;
    price: string;
  }> {
    const ws = `ws-b-${suffix}`;
    const key = `key-b-${suffix}`;
    const wallet = `wallet-b-${suffix}`;
    const model = `model-b-${suffix}`;
    const mapping = `pm-b-${suffix}`;
    const price = `price-b-${suffix}`;
    await db.execute(
      sql`INSERT INTO workspaces (id, name, status, created_at) VALUES (${ws}, 'B', 'active', ${NOW2})`,
    );
    // Key WITH a 5000 VND daily budget.
    await db.execute(
      sql`INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at,
              budget_vnd, budget_period, budget_used_vnd, budget_period_start)
          VALUES (${key}, ${ws}, ${"hash-b-" + suffix}, 'sk-hbr-b', 'b', 'enabled', ${NOW2},
              5000, 'daily', 0, ${NOW2})`,
    );
    await db.execute(
      sql`INSERT INTO payments (id, workspace_id, amount, status, provider, provider_order_code, created_at)
          VALUES (${"pay-b-" + suffix}, ${ws}, 1000000, 'succeeded', 'mock', ${"order-b-" + suffix}, ${NOW2})`,
    );
    await db.execute(
      sql`INSERT INTO wallets (id, workspace_id, currency, balance, reserved, version, created_at)
          VALUES (${wallet}, ${ws}, 'VND', 0, 0, 0, ${NOW2})`,
    );
    await creditWallet(db, {
      walletId: wallet,
      amount: 1_000_000,
      kind: "topup",
      paymentId: `pay-b-${suffix}`,
      memo: "test topup",
    });
    await db.execute(
      sql`INSERT INTO models (id, public_id, slug, display_name, provider, enabled, published, created_at, updated_at)
          VALUES (${model}, ${"pub-b-" + suffix}, ${"slug-b-" + suffix}, 'Model B', 'openai', true, true, ${NOW2}, ${NOW2})`,
    );
    await db.execute(
      sql`INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at)
          VALUES (${mapping}, ${model}, 'openai', 'upstream-b', true, ${NOW2}, ${NOW2})`,
    );
    await db.execute(
      sql`INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at)
          VALUES (${price}, ${model}, 1000000, 2000000, 500000, 3000000, 1000000, ${NOW2})`,
    );
    return { ws, key, wallet, model, mapping, price };
  }

  const capForModel = () =>
    estimateCapVnd(
      { maxInputTokens: 1000, maxOutputTokens: 1000 },
      {
        inputUsdMicroPer1m: 1_000_000,
        outputUsdMicroPer1m: 2_000_000,
        cachedInputUsdMicroPer1m: 500_000,
        reasoningUsdMicroPer1m: 3_000_000,
      },
      26_000,
      1_000_000,
    );

  async function ledgerCount(db: Db, wallet: string): Promise<number> {
    const result: unknown = await db.execute(
      sql`SELECT count(*) c FROM ledger_entries WHERE wallet_id = ${wallet}`,
    );
    const rows = ((result as { rows?: Record<string, unknown>[] }).rows ??
      (result as Record<string, unknown>[])) as Record<string, unknown>[];
    return Number(rows[0]!.c);
  }

  test("reserve/release/settle fold the admission hold; wallet ledger unchanged", async () => {
    const f = await seedCanonWithBudget("a");
    const cap = capForModel();
    expect(cap).toBeGreaterThan(0);
    const ledgerBefore = await ledgerCount(db, f.wallet);

    // 1. Gateway admission (checkAndReserveKeyBudget) then wallet reserve:
    // admission hold lands on the key counter.
    await checkAndReserveKeyBudget(db, { apiKeyId: f.key, capVnd: cap, now: NOW2 });
    const requestId = "req-b1";
    const reserved = await reserveRequest(db, {
      requestId,
      workspaceId: f.ws,
      apiKeyId: f.key,
      modelId: f.model,
      mappingId: f.mapping,
      modelPriceId: f.price,
      endpoint: ENDPOINT,
      mode: "non-stream",
      fxRate: 26_000,
      capVnd: cap,
      now: NOW2,
    });
    expect(reserved.walletKind).toBe("topup");
    expect(await usedOf(db, f.key)).toBe(cap);

    // 2. Pre-dispatch release: hold returned, wallet untouched.
    await releaseRequest(db, requestId, NOW2 + 1);
    expect(await usedOf(db, f.key)).toBe(0);
    expect(await ledgerCount(db, f.wallet)).toBe(ledgerBefore);

    // 3. Settled usage: counter ends at the ACTUAL charged VND.
    await checkAndReserveKeyBudget(db, { apiKeyId: f.key, capVnd: cap, now: NOW2 });
    const requestId2 = "req-b2";
    await reserveRequest(db, {
      requestId: requestId2,
      workspaceId: f.ws,
      apiKeyId: f.key,
      modelId: f.model,
      mappingId: f.mapping,
      modelPriceId: f.price,
      endpoint: ENDPOINT,
      mode: "non-stream",
      fxRate: 26_000,
      capVnd: cap,
      now: NOW2,
    });
    await markDispatching(db, requestId2, NOW2 + 1);
    const settle = await settleRequest(
      db,
      requestId2,
      {
        kind: "usage",
        usage: {
          inputTokens: 10n,
          outputTokens: 5n,
          cachedInputTokens: 0n,
          reasoningTokens: 0n,
        },
        upstreamModel: "upstream-b",
        provider: "openai",
        publicModel: "pub-b",
      },
      NOW2 + 2,
    );
    expect(settle.chargedVnd).toBeGreaterThan(0);
    expect(settle.chargedVnd).toBeLessThan(cap);
    expect(await usedOf(db, f.key)).toBe(settle.chargedVnd);

    // 4. Full hold (ambiguous dispatch): charged == cap, counter unchanged.
    await checkAndReserveKeyBudget(db, { apiKeyId: f.key, capVnd: cap, now: NOW2 });
    const requestId3 = "req-b3";
    await reserveRequest(db, {
      requestId: requestId3,
      workspaceId: f.ws,
      apiKeyId: f.key,
      modelId: f.model,
      mappingId: f.mapping,
      modelPriceId: f.price,
      endpoint: ENDPOINT,
      mode: "non-stream",
      fxRate: 26_000,
      capVnd: cap,
      now: NOW2,
    });
    await markDispatching(db, requestId3, NOW2 + 3);
    const settleFull = await settleRequest(
      db,
      requestId3,
      { kind: "full_hold", reason: "unknown" },
      NOW2 + 4,
    );
    expect(settleFull.chargedVnd).toBe(cap);
    expect(await usedOf(db, f.key)).toBe(settle.chargedVnd + cap);
  });

  test("budget exhaustion stops admission even with ample wallet balance", async () => {
    const f = await seedCanonWithBudget("b");
    const cap = 4900; // under budget 5000, above remaining after one admit
    await checkAndReserveKeyBudget(db, { apiKeyId: f.key, capVnd: cap, now: NOW2 });
    await reserveRequest(db, {
      requestId: "req-x1",
      workspaceId: f.ws,
      apiKeyId: f.key,
      modelId: f.model,
      mappingId: f.mapping,
      modelPriceId: f.price,
      endpoint: ENDPOINT,
      mode: "non-stream",
      fxRate: 26_000,
      capVnd: cap,
      now: NOW2,
    });
    await expect(
      checkAndReserveKeyBudget(db, { apiKeyId: f.key, capVnd: 200, now: NOW2 }),
    ).rejects.toMatchObject({ code: "budget_exceeded" });
  });
});

// --- Part D: routes (create/PATCH validation + usage endpoint) ---

const A = "ws-a";
const OWNER = "bowner@example.com";
const MEMBER = "bmember@example.com";
const OUTSIDER = "boutsider@example.com";

describe("key policy routes", () => {
  let db: Db;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let ownerCookie: string;
  let memberCookie: string;
  let outsiderCookie: string;
  let keyId: string;

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    const auth = createAuth(db);
    app = await buildApp({ db, auth });

    // signUp returns the session cookie directly (see helpers).
    ownerCookie = await signUp(app, OWNER, "O");
    memberCookie = await signUp(app, MEMBER, "M");
    outsiderCookie = await signUp(app, OUTSIDER, "X");
    await createWorkspace(db, A, await userIdByEmail(db, OWNER), "A");
    await db.execute(
      sql`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${A}, ${await userIdByEmail(db, MEMBER)}, 'member')`,
    );
  });
  afterAll(async () => {
    await t_drop();
  });

  let t_drop: () => Promise<void> = async () => {};

  test("create with budget + expiry; missing period or past expiry rejected", async () => {
    const bad = await req(app, `/api/v1/workspaces/${A}/keys`, {
      method: "POST",
      cookie: ownerCookie,
      body: { name: "k", budget_vnd: 1000 },
    });
    expect(bad.status).toBe(400);
    const past = await req(app, `/api/v1/workspaces/${A}/keys`, {
      method: "POST",
      cookie: ownerCookie,
      body: { name: "k", expires_at: 1 },
    });
    expect(past.status).toBe(400);
    const ok = await req(app, `/api/v1/workspaces/${A}/keys`, {
      method: "POST",
      cookie: ownerCookie,
      body: {
        name: "budgeted",
        expires_at: Date.now() + 86_400_000,
        budget_vnd: 50_000,
        budget_period: "daily",
      },
    });
    expect(ok.status).toBe(201);
    const body = (await ok.json()) as { id: string };
    keyId = body.id;
    const rows = await db.execute(
      sql`SELECT budget_vnd, budget_period, budget_period_start, expires_at FROM api_keys WHERE id = ${keyId}`,
    );
    const row = (
      ((rows as { rows?: Record<string, unknown>[] }).rows ??
        (rows as unknown as Record<string, unknown>[])) as Record<string, unknown>[]
    )[0]!;
    expect(Number(row.budget_vnd)).toBe(50_000);
    expect(row.budget_period).toBe("daily");
    expect(row.budget_period_start).not.toBeNull();
  });

  test("PATCH sets and clears policy; any budget change resets the period counter", async () => {
    // Simulate prior spend.
    await db.execute(sql`UPDATE api_keys SET budget_used_vnd = 123 WHERE id = ${keyId}`);
    const set = await req(app, `/api/v1/workspaces/${A}/keys/${keyId}`, {
      method: "PATCH",
      cookie: ownerCookie,
      body: { budget_vnd: 80_000, budget_period: "monthly" },
    });
    expect(set.status).toBe(200);
    const rows = await db.execute(
      sql`SELECT budget_vnd, budget_period, budget_used_vnd, budget_period_start FROM api_keys WHERE id = ${keyId}`,
    );
    const row = (
      ((rows as { rows?: Record<string, unknown>[] }).rows ??
        (rows as unknown as Record<string, unknown>[])) as Record<string, unknown>[]
    )[0]!;
    expect(Number(row.budget_used_vnd)).toBe(0);
    expect(row.budget_period).toBe("monthly");
    const clear = await req(app, `/api/v1/workspaces/${A}/keys/${keyId}`, {
      method: "PATCH",
      cookie: ownerCookie,
      body: { budget_vnd: null, budget_period: null },
    });
    expect(clear.status).toBe(200);
    const cleared = await db.execute(sql`SELECT budget_vnd FROM api_keys WHERE id = ${keyId}`);
    expect(
      (
        ((cleared as { rows?: Record<string, unknown>[] }).rows ??
          (cleared as unknown as Record<string, unknown>[])) as Record<string, unknown>[]
      )[0]!.budget_vnd,
    ).toBeNull();
    const badClear = await req(app, `/api/v1/workspaces/${A}/keys/${keyId}`, {
      method: "PATCH",
      cookie: ownerCookie,
      body: { budget_vnd: 1 },
    });
    expect(badClear.status).toBe(400);
  });

  test("usage endpoint: member+ authorized, no secrets, budget state present", async () => {
    // Recreate a budgeted key for the usage assertions.
    const created = await req(app, `/api/v1/workspaces/${A}/keys`, {
      method: "POST",
      cookie: ownerCookie,
      body: { name: "usage-key", budget_vnd: 1000, budget_period: "daily" },
    });
    const { id } = (await created.json()) as { id: string };
    const ok = await req(app, `/api/v1/keys/${id}/usage`, { cookie: memberCookie });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as Record<string, unknown>;
    expect(body.budget).toMatchObject({ budget_vnd: 1000, period: "daily", used_vnd: 0 });
    expect((body.budget as Record<string, unknown>).remaining_vnd).toBe(1000);
    expect((body.totals as Record<string, unknown>).requests).toBe(0);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("key_hash");
    expect(raw).not.toContain("plaintext");
    // Display prefix is fine; a FULL plaintext key (43-char secret) must never appear.
    expect(raw).not.toMatch(/sk-hbr-[A-Za-z0-9_-]{43}/);

    // Workspace authorization: outsider gets 404 (cross-workspace invisible).
    const nope = await req(app, `/api/v1/keys/${id}/usage`, { cookie: outsiderCookie });
    expect(nope.status).toBe(404);
    // Unauthenticated: 401.
    const anon = await req(app, `/api/v1/keys/${id}/usage`);
    expect(anon.status).toBe(401);
  });
});
