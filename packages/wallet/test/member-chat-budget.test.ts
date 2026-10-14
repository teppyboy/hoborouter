// Member chat budget admission (migration 0025): policy counter holds live
// inside the reserve transaction, never overspend under parallel spend, and
// settlement folds the TICKETED period row only (rollover-safe). Key-budget
// period ticket: an old-period settle must never debit the new window.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { billingReservations, memberChatUsage, requests } from "@hoborouter/db";
import {
  reserveRequest,
  markDispatching,
  releaseRequest,
  settleRequest,
  MemberBudgetError,
  utcDay,
} from "../src/index";
import { checkAndReserveKeyBudget, settleKeyBudgetHold } from "@hoborouter/keys";
import { makeDb, seedFixture, NOW } from "./helpers";

const DAY_MS = 86_400_000;

let db: Awaited<ReturnType<typeof makeDb>>["db"];
let drop: () => Promise<void>;
let ws: string;
let wallet: string;

const reserveArgs = (overrides: Record<string, unknown> = {}) => ({
  requestId: `req-${crypto.randomUUID()}`,
  workspaceId: ws,
  apiKeyId: "key-member",
  modelId: "model-mc",
  mappingId: "pm-mc",
  modelPriceId: "price-mc",
  endpoint: "/v1/chat/completions" as const,
  mode: "non-stream" as const,
  fxRate: 26000,
  capVnd: 400,
  now: NOW,
  ...overrides,
});

const seedMemberKey = async (keyId: string, userId: string) => {
  await db.execute(
    sql`INSERT INTO users (id, name, email, created_at, updated_at) VALUES (${userId}, ${userId}, ${userId + "@t.local"}, ${NOW}, ${NOW}) ON CONFLICT DO NOTHING`,
  );
  await db.execute(
    sql`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${ws}, ${userId}, 'member')`,
  );
  await db.execute(
    sql`INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at, purpose, owner_user_id) VALUES (${keyId}, ${ws}, ${"hash-" + keyId}, 'sk-hbr-x', ${keyId}, 'active', ${NOW}, 'chat_member', ${userId})`,
  );
};

const memberUsed = async (userId: string, day: string) => {
  const rows = await db
    .select({ used: memberChatUsage.used_vnd })
    .from(memberChatUsage)
    .where(
      and(
        eq(memberChatUsage.workspace_id, ws),
        eq(memberChatUsage.user_id, userId),
        eq(memberChatUsage.period_start, day),
      ),
    );
  return rows[0]?.used ?? 0;
};

beforeAll(async () => {
  const t = await makeDb();
  db = t.db;
  drop = t.drop;
  const f = await seedFixture(db);
  ws = f.wsA;
  wallet = f.walletA;
  // Member chat policy: enabled, 1000 VND/day.
  await db.execute(
    sql`UPDATE workspaces SET member_chat_enabled = true, member_chat_daily_cap_vnd = 1000 WHERE id = ${ws}`,
  );
  await seedMemberKey("key-member", "u1");
  await db.execute(
    sql`INSERT INTO models (id, public_id, slug, display_name, provider, enabled, published, created_at, updated_at) VALUES ('model-mc', 'pub-mc', 'slug-mc', 'MC', 'openai', true, true, ${NOW}, ${NOW})`,
  );
  await db.execute(
    sql`INSERT INTO provider_model_mappings (id, model_id, provider, upstream_model, enabled, created_at, updated_at) VALUES ('pm-mc', 'model-mc', 'openai', 'upstream-mc', true, ${NOW}, ${NOW})`,
  );
  await db.execute(
    sql`INSERT INTO model_prices (id, model_id, input_usd_micro_per_1m, output_usd_micro_per_1m, cached_input_usd_micro_per_1m, reasoning_usd_micro_per_1m, markup_ppm, effective_at) VALUES ('price-mc', 'model-mc', 1000000, 2000000, 0, 0, 1000000, ${NOW})`,
  );
  await db.execute(sql`UPDATE wallets SET balance = 100000 WHERE id = ${wallet}`);
});

afterAll(async () => {
  await drop();
});

describe("member chat budget admission", () => {
  test("hold lands on today's period row; ticket persisted on the reservation", async () => {
    const day = utcDay(NOW);
    const args = reserveArgs();
    const r = await reserveRequest(db, { ...args, memberBudget: { userId: "u1" } });
    expect(r.walletKind).toBe("topup");
    expect(await memberUsed("u1", day)).toBe(400);
    const tickets = await db
      .select({
        user: billingReservations.member_budget_user_id,
        period: billingReservations.member_budget_period_start,
      })
      .from(billingReservations)
      .where(eq(billingReservations.request_id, args.requestId));
    expect(tickets[0]).toEqual({ user: "u1", period: day });
  });

  test("denied: policy off or non-member; nothing written", async () => {
    // Policy off.
    await db.execute(sql`UPDATE workspaces SET member_chat_enabled = false WHERE id = ${ws}`);
    const args = reserveArgs();
    let err: unknown;
    try {
      await reserveRequest(db, { ...args, memberBudget: { userId: "u1" } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MemberBudgetError);
    expect((err as MemberBudgetError).memberCode).toBe("denied");
    expect(
      await db.select({ id: requests.id }).from(requests).where(eq(requests.id, args.requestId)),
    ).toHaveLength(0);
    // Enabled policy, but the owner is not a member.
    await db.execute(sql`UPDATE workspaces SET member_chat_enabled = true WHERE id = ${ws}`);
    const args2 = reserveArgs();
    let err2: unknown;
    try {
      await reserveRequest(db, { ...args2, memberBudget: { userId: "u2" } });
    } catch (e) {
      err2 = e;
    }
    expect((err2 as MemberBudgetError).memberCode).toBe("denied");
    expect(
      await db.select({ id: requests.id }).from(requests).where(eq(requests.id, args2.requestId)),
    ).toHaveLength(0);
  });

  test("exceeded: typed error, full rollback, counter untouched", async () => {
    const day = utcDay(NOW);
    // u1 is at 400 from the first test; +400 fits exactly (800), +300 over.
    const args = reserveArgs();
    await reserveRequest(db, { ...args, memberBudget: { userId: "u1" } });
    let err: unknown;
    try {
      await reserveRequest(db, {
        ...reserveArgs(),
        capVnd: 300,
        memberBudget: { userId: "u1" },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MemberBudgetError);
    const mbErr = err as MemberBudgetError;
    expect(mbErr.memberCode).toBe("exceeded");
    expect(mbErr.retryAfterMs).toBeGreaterThan(0);
    expect(await memberUsed("u1", day)).toBe(800);
  });

  test("parallel spend cannot overspend the daily cap", async () => {
    await seedMemberKey("key-member-2", "u2");
    // Fresh counter (u2 has no rows yet): 3 x 400 holds against a 1000 cap.
    const results = await Promise.allSettled(
      [1, 2, 3].map(() =>
        reserveRequest(db, {
          ...reserveArgs({ apiKeyId: "key-member-2" }),
          memberBudget: { userId: "u2" },
        }),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const exceeded = results.filter(
      (r) => r.status === "rejected" && (r.reason as MemberBudgetError).memberCode === "exceeded",
    );
    expect(ok).toHaveLength(2);
    expect(exceeded).toHaveLength(1);
    expect(await memberUsed("u2", utcDay(NOW))).toBe(800);
  });

  test("release returns the member hold; settle folds the ticketed OLD period only", async () => {
    // u3: release path (charged 0 back) then rollover-safe settle path.
    await seedMemberKey("key-member-3", "u3");
    const dayA = utcDay(NOW);
    // Release: hold 400 then pre-dispatch release returns it fully.
    const relArgs = reserveArgs({ apiKeyId: "key-member-3" });
    await reserveRequest(db, { ...relArgs, memberBudget: { userId: "u3" } });
    expect(await memberUsed("u3", dayA)).toBe(400);
    await releaseRequest(db, relArgs.requestId, NOW);
    expect(await memberUsed("u3", dayA)).toBe(0);

    // Settle across rollover: hold 400 in period A, then a NEW hold 100 in
    // period B (u3 has the full 1000 cap in B), then settle the A request.
    const settleArgs = reserveArgs({ apiKeyId: "key-member-3", now: NOW });
    await reserveRequest(db, { ...settleArgs, memberBudget: { userId: "u3" } });
    await markDispatching(db, settleArgs.requestId, NOW);
    const dayB = utcDay(NOW + 2 * DAY_MS);
    await reserveRequest(db, {
      ...reserveArgs({ apiKeyId: "key-member-3", capVnd: 100, now: NOW + 2 * DAY_MS }),
      memberBudget: { userId: "u3" },
    });
    expect(await memberUsed("u3", dayA)).toBe(400);
    expect(await memberUsed("u3", dayB)).toBe(100);
    // usage: 10 input + 5 output tokens; price 1x/2x usd micro per 1m, fx
    // 26000, markup 1e6 => charged = (10*1 + 5*2) usd micro * 26000 / 1e6? no:
    // micros: (10*1 + 5*2) usd = 20e-6*26000 = 0.52 VND -> charge rounds per
    // calculateCharge semantics; assert only that A moved by the charge and
    // B is untouched.
    const result = await settleRequest(
      db,
      settleArgs.requestId,
      {
        kind: "usage",
        usage: {
          inputTokens: 10n,
          outputTokens: 5n,
          cachedInputTokens: 0n,
          reasoningTokens: 0n,
        },
        upstreamModel: "upstream-mc",
        provider: "openai",
        publicModel: "pub-mc",
      },
      NOW + 2 * DAY_MS,
    );
    expect(result.alreadySettled).toBe(false);
    const aUsed = await memberUsed("u3", dayA);
    expect(aUsed).toBe(result.chargedVnd); // 0 hold + charge (hold returned, charge added)
    expect(await memberUsed("u3", dayB)).toBe(100); // new period untouched
  });

  test("policy update never resets usage rows", async () => {
    const day = utcDay(NOW);
    await db.execute(
      sql`UPDATE workspaces SET member_chat_daily_cap_vnd = 9000 WHERE id = ${ws}`,
    );
    expect(await memberUsed("u1", day)).toBe(800);
  });
});

describe("key-budget period ticket (rollover fix)", () => {
  test("old-period settle never debits the new window; legacy null ticket folds", async () => {
    // Day-aligned instant so budgetWindow(daily) starts exactly here.
    const window0 = Date.UTC(2023, 10, 14);
    const keyId = "key-ticket";
    await db.execute(
      sql`INSERT INTO api_keys (id, workspace_id, key_hash, key_prefix, name, status, created_at, budget_vnd, budget_period, budget_used_vnd, budget_period_start) VALUES (${keyId}, ${ws}, 'hash-ticket', 'sk-hbr-t', 'ticket key', 'active', ${NOW}, 1000, 'daily', 0, ${window0})`,
    );
    // Period A admission: hold 400.
    const a = await checkAndReserveKeyBudget(db, { apiKeyId: keyId, capVnd: 400, now: window0 });
    expect(a.periodStart).toBe(window0);
    // Rollover: next admission in period B resets used to 0 then holds 100.
    const b = await checkAndReserveKeyBudget(db, {
      apiKeyId: keyId,
      capVnd: 100,
      now: window0 + 2 * DAY_MS,
    });
    expect(b.periodStart).toBe(window0 + 2 * DAY_MS);
    // Old-period settlement with the ticket: skipped entirely — the reset
    // already cleared the hold; the new window's counter stays at its holds.
    await db.transaction(async (tx) => {
      await settleKeyBudgetHold(tx, {
        apiKeyId: keyId,
        holdVnd: 400,
        chargedVnd: 150,
        periodStart: a.periodStart,
      });
    });
    const usedRows = await db
      .select({ used: sql<number>`budget_used_vnd`.mapWith(Number) })
      .from(sql`api_keys`)
      .where(sql`id = ${keyId}`);
    expect(usedRows[0]!.used).toBe(100);
    // Legacy reservation (no ticket): fold applies unconditionally, as before.
    await db.transaction(async (tx) => {
      await settleKeyBudgetHold(tx, {
        apiKeyId: keyId,
        holdVnd: 400,
        chargedVnd: 150,
        periodStart: null,
      });
    });
    const after = await db
      .select({ used: sql<number>`budget_used_vnd`.mapWith(Number) })
      .from(sql`api_keys`)
      .where(sql`id = ${keyId}`);
    expect(after[0]!.used).toBe(150); // max(0, 100-400) + 150
  });
});
