// sk-hbr- API key generation/verification.
// Plaintext format: `sk-hbr-` + 43 base64url chars (32 CSPRNG bytes, no padding).
// Only SHA-256 hex is stored. Status: 'active' is legacy and treated as enabled.
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  apiKeys,
  apiKeyModelPermissions,
  memberChatUsage,
  workspaceMembers,
  workspaces,
  type Db,
  type Tx,
} from "@hoborouter/db";

const PREFIX = "sk-hbr-";

export function hashApiKey(plaintext: string): string {
  return new Bun.CryptoHasher("sha256").update(plaintext).digest("hex");
}

export function generateApiKey(): { plaintext: string; hash: string; prefix: string } {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const plaintext = PREFIX + Buffer.from(bytes).toString("base64url"); // 43 chars
  return { plaintext, hash: hashApiKey(plaintext), prefix: displayPrefix(plaintext) };
}

export function displayPrefix(plaintext: string): string {
  const secret = plaintext.startsWith(PREFIX) ? plaintext.slice(PREFIX.length) : plaintext;
  return PREFIX + secret.slice(0, 4) + "..." + secret.slice(-6);
}

export interface ApiKeyRecord {
  api_key_id: string;
  workspace_id: string;
  status: string;
  purpose: "generic" | "chat" | "chat_member";
  /** Owner of a 'chat_member' key; null for generic and instance chat keys. */
  owner_user_id: string | null;
}

/** Hash + lookup. Returns null for unknown/disabled/revoked/removed keys. Used by /v1 auth. */
export async function verifyApiKey(db: Db | Tx, plaintext: string): Promise<ApiKeyRecord | null> {
  if (typeof plaintext !== "string" || !plaintext.startsWith(PREFIX)) return null;
  const rows = await db
    .select({
      api_key_id: apiKeys.id,
      workspace_id: apiKeys.workspace_id,
      status: apiKeys.status,
      purpose: apiKeys.purpose,
      owner_user_id: apiKeys.owner_user_id,
    })
    .from(apiKeys)
    // Archived (suspended) workspaces reject their old keys at the gateway;
    // settlement/refund paths do not use this lookup and stay unaffected.
    .innerJoin(workspaces, eq(workspaces.id, apiKeys.workspace_id))
    .where(
      and(
        eq(apiKeys.key_hash, hashApiKey(plaintext)),
        inArray(apiKeys.status, ["active", "enabled"]),
        // soft-deleted (removed) keys must never authenticate even if their
        // status column still reads 'enabled'
        isNull(apiKeys.deleted_at),
        eq(workspaces.status, "active"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Zero permission rows = unrestricted (true); otherwise model must be in the set. */
export async function isModelAllowed(
  db: Db | Tx,
  apiKeyId: string,
  modelId: string,
): Promise<boolean> {
  const hasAny = await db
    .select({ x: apiKeyModelPermissions.api_key_id })
    .from(apiKeyModelPermissions)
    .where(eq(apiKeyModelPermissions.api_key_id, apiKeyId))
    .limit(1);
  if (hasAny.length === 0) return true;
  const hit = await db
    .select({ x: apiKeyModelPermissions.model_id })
    .from(apiKeyModelPermissions)
    .where(
      and(
        eq(apiKeyModelPermissions.api_key_id, apiKeyId),
        eq(apiKeyModelPermissions.model_id, modelId),
      ),
    )
    .limit(1);
  return hit.length > 0;
}

// --- key policy: expiry + per-period VND budget (atomic admission) ---
// budget_used_vnd is a POLICY counter on api_keys, never wallet money: the
// wallet ledger/reservation/settlement semantics in @hoborouter/wallet are
// unchanged. Admission holds capVnd against the current window under the
// api_keys row lock (FOR UPDATE) so concurrent requests serialize and cannot
// overspend the period budget.

export type KeyBudgetPeriod = "daily" | "weekly" | "monthly";

export type KeyBudgetErrorCode = "key_invalid" | "expired" | "budget_exceeded";

export class KeyBudgetError extends Error {
  constructor(
    readonly code: KeyBudgetErrorCode,
    /** ms until the current budget window resets; null when not budget-related. */
    readonly retryAfterMs: number | null,
    message: string,
  ) {
    super(message);
  }
}

/**
 * UTC window containing `now`: daily = calendar day, weekly = Monday-based
 * week, monthly = calendar month. Both bounds are epoch ms.
 */
export function budgetWindow(period: KeyBudgetPeriod, now: number): { start: number; end: number } {
  const d = new Date(now);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (period === "daily") return { start: dayStart, end: dayStart + 86_400_000 };
  if (period === "weekly") {
    // Monday-based week: getUTCDay() 0=Sun..6=Sat -> offset (day+6)%7 back to Monday.
    const start = dayStart - ((d.getUTCDay() + 6) % 7) * 86_400_000;
    return { start, end: start + 7 * 86_400_000 };
  }
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return { start: monthStart, end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) };
}

// keys must not depend on @hoborouter/wallet (wallet -> keys for settlement),
// so the tiny tx wrapper is duplicated here with the same "$client" sniff.
function inTx<T>(db: Db | Tx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if ("$client" in db) return db.transaction(fn);
  return fn(db);
}

function requirePositiveCap(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) {
    throw new KeyBudgetError("key_invalid", null, "capVnd must be a positive safe integer");
  }
  return v;
}

export interface KeyBudgetAdmission {
  /** Window start that received the hold; null = key has no budget configured. */
  periodStart: number | null;
}

/**
 * Atomic key-policy admission BEFORE wallet reservation: throws on expired
 * keys and exhausted period budgets; otherwise holds capVnd against the
 * key's current budget window (used += cap) under the api_keys row lock, so
 * concurrent admissions serialize and cannot overspend. Returns the window
 * start that received the hold so a later failed reserve can release it.
 * Window rollover (first admission after daily/weekly/monthly boundary)
 * resets the counter to 0 before the check.
 */
export async function checkAndReserveKeyBudget(
  db: Db | Tx,
  args: { apiKeyId: string; capVnd: number; now: number },
): Promise<KeyBudgetAdmission> {
  const capVnd = requirePositiveCap(args.capVnd);
  return inTx(db, async (tx) => {
    const rows = await tx
      .select({
        status: apiKeys.status,
        deleted_at: apiKeys.deleted_at,
        expires_at: apiKeys.expires_at,
        budget_vnd: apiKeys.budget_vnd,
        budget_period: apiKeys.budget_period,
        budget_used_vnd: apiKeys.budget_used_vnd,
        budget_period_start: apiKeys.budget_period_start,
      })
      .from(apiKeys)
      .where(eq(apiKeys.id, args.apiKeyId))
      .for("update")
      .limit(1);
    const key = rows[0];
    if (!key || key.deleted_at !== null || key.status === "disabled" || key.status === "revoked") {
      throw new KeyBudgetError("key_invalid", null, "API key is not active");
    }
    if (key.expires_at !== null && args.now >= key.expires_at) {
      throw new KeyBudgetError("expired", null, "API key expired");
    }
    if (key.budget_vnd === null || key.budget_period === null) return { periodStart: null };
    const window = budgetWindow(key.budget_period, args.now);
    const used = key.budget_period_start === window.start ? key.budget_used_vnd : 0;
    if (used + capVnd > key.budget_vnd) {
      throw new KeyBudgetError(
        "budget_exceeded",
        window.end - args.now,
        "API key budget exhausted for the current period",
      );
    }
    await tx
      .update(apiKeys)
      .set({ budget_used_vnd: used + capVnd, budget_period_start: window.start })
      .where(eq(apiKeys.id, args.apiKeyId));
    return { periodStart: window.start };
  });
}

/**
 * Release an admission hold after a FAILED wallet reserve (pre-dispatch, no
 * request row exists yet). No-op without a budget or when the window already
 * rolled over (the reset cleared the hold). The hold MUST be released on
 * every admission-then-fail path or the counter permanently over-counts.
 */
export async function releaseKeyBudgetHold(
  db: Db | Tx,
  args: { apiKeyId: string; periodStart: number | null; holdVnd: number },
): Promise<void> {
  if (args.periodStart === null) return;
  await inTx(db, async (tx) => {
    const rows = await tx
      .select({
        budget_vnd: apiKeys.budget_vnd,
        budget_period_start: apiKeys.budget_period_start,
        budget_used_vnd: apiKeys.budget_used_vnd,
      })
      .from(apiKeys)
      .where(eq(apiKeys.id, args.apiKeyId))
      .for("update")
      .limit(1);
    const key = rows[0];
    if (!key || key.budget_vnd === null || key.budget_period_start !== args.periodStart) return;
    await tx
      .update(apiKeys)
      .set({ budget_used_vnd: Math.max(0, key.budget_used_vnd - args.holdVnd) })
      .where(eq(apiKeys.id, args.apiKeyId));
  });
}

export type KeyBudgetHeadroom = {
  /** Remaining VND for the current window; null = no configured budget (unlimited). */
  remaining: number | null;
  /** True when past expires_at — admission (checkAndReserveKeyBudget) is the
   * canonical expiry gate and must still produce its 403, so callers must not
   * mask expiry with an earlier 402/429. */
  expired: boolean;
  /** ms until the budget window resets; null unless a configured budget is exhausted. */
  retryAfterMs: number | null;
};

/**
 * Read-only budget headroom for the key's CURRENT UTC window (no row lock,
 * no writes): budget_vnd minus the in-window used counter (0 when the stored
 * counter predates the window). remaining is null when the key has no budget
 * configured (unlimited) — and also when the key is past expires_at, because
 * a 0 there would mask expiry with an earlier insufficient-balance rejection.
 * Advisory only: callers must re-run admission for the authoritative
 * serialized check.
 */
export async function getKeyBudgetRemainingVnd(
  db: Db | Tx,
  apiKeyId: string,
  now: number,
): Promise<KeyBudgetHeadroom> {
  const rows = await db
    .select({
      expires_at: apiKeys.expires_at,
      budget_vnd: apiKeys.budget_vnd,
      budget_period: apiKeys.budget_period,
      budget_used_vnd: apiKeys.budget_used_vnd,
      budget_period_start: apiKeys.budget_period_start,
    })
    .from(apiKeys)
    .where(eq(apiKeys.id, apiKeyId))
    .limit(1);
  const key = rows[0];
  const expired = key !== undefined && key.expires_at !== null && now >= key.expires_at;
  if (!key || key.budget_vnd === null || key.budget_period === null || expired)
    return { remaining: null, expired, retryAfterMs: null };
  const window = budgetWindow(key.budget_period, now);
  const used = key.budget_period_start === window.start ? key.budget_used_vnd : 0;
  const remaining = Math.max(0, key.budget_vnd - used);
  return {
    remaining,
    expired,
    retryAfterMs: remaining === 0 ? Math.max(0, window.end - now) : null,
  };
}

/**
 * Fold an admission hold back into the key's period budget INSIDE the
 * caller's transaction (billing settle/release in @hoborouter/wallet):
 * used = max(0, used - hold) + charged. Settlement clamps charge <= cap, so
 * the counter never exceeds budget_vnd. If the window rolled over between
 * admission and settlement the reset already cleared the hold and the charge
 * still counts (conservative: never under-counts spend). No-op without a
 * budget. Wallet ledger rows are untouched by this.
 */
export async function settleKeyBudgetHold(
  tx: Tx,
  args: {
    apiKeyId: string;
    holdVnd: number;
    chargedVnd: number;
    /**
     * Hold-time window ticket (billing_reservations.key_budget_period_start).
     * When present, the fold applies ONLY if the live window still matches —
     * a rollover already cleared the hold, so an old-period settlement must
     * never debit the new window's counter (which may carry fresh holds).
     * null = legacy pre-ticket reservation, folded unconditionally.
     */
    periodStart: number | null;
  },
): Promise<void> {
  const rows = await tx
    .select({
      budget_vnd: apiKeys.budget_vnd,
      budget_used_vnd: apiKeys.budget_used_vnd,
      budget_period_start: apiKeys.budget_period_start,
    })
    .from(apiKeys)
    .where(eq(apiKeys.id, args.apiKeyId))
    .for("update")
    .limit(1);
  const key = rows[0];
  if (!key || key.budget_vnd === null) return;
  if (
    args.periodStart !== null &&
    args.periodStart !== undefined &&
    key.budget_period_start !== args.periodStart
  )
    return;
  const used = Math.max(0, key.budget_used_vnd - args.holdVnd) + args.chargedVnd;
  await tx.update(apiKeys).set({ budget_used_vnd: used }).where(eq(apiKeys.id, args.apiKeyId));
}

// --- member chat policy context (migration 0025) ---
// Per-(workspace, user, UTC day) spend counter with live admission holds.
// Read-only helpers here; the atomic admission runs inside the wallet
// reserve transaction (@hoborouter/wallet) so policy check + hold + wallet
// CAS commit or abort together.

/** UTC calendar day of an epoch-ms instant, 'YYYY-MM-DD' (period_start key). */
export function memberChatUtcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Epoch ms of the first instant AFTER the UTC day containing `now`. */
export function memberChatDayEndMs(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

export interface MemberChatContext {
  /** 'YYYY-MM-DD' UTC period key for `now`. */
  periodStart: string;
  enabled: boolean;
  /** Positive daily cap; null while disabled (DB CHECK keeps them in step). */
  capVnd: number | null;
  usedVnd: number;
  /** cap - used (incl. live holds), clamped at 0; null while disabled. */
  remainingVnd: number | null;
  /** Epoch ms when the current UTC period rolls over. */
  resetsAtMs: number;
  /** Caller holds an active workspace membership (any role). */
  isMember: boolean;
}

/**
 * Read-only snapshot of the member chat policy + today's usage for a user.
 * Advisory only: the authoritative serialized check runs inside the wallet
 * reserve transaction.
 */
export async function getMemberChatContext(
  db: Db | Tx,
  args: { workspaceId: string; userId: string; now: number },
): Promise<MemberChatContext> {
  const periodStart = memberChatUtcDay(args.now);
  const wsRows = await db
    .select({
      enabled: workspaces.member_chat_enabled,
      cap: workspaces.member_chat_daily_cap_vnd,
    })
    .from(workspaces)
    .where(eq(workspaces.id, args.workspaceId))
    .limit(1);
  const memberRows = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspace_id, args.workspaceId),
        eq(workspaceMembers.user_id, args.userId),
      ),
    )
    .limit(1);
  const usageRows = await db
    .select({ used: memberChatUsage.used_vnd })
    .from(memberChatUsage)
    .where(
      and(
        eq(memberChatUsage.workspace_id, args.workspaceId),
        eq(memberChatUsage.user_id, args.userId),
        eq(memberChatUsage.period_start, periodStart),
      ),
    )
    .limit(1);
  const enabled = wsRows[0]?.enabled ?? false;
  const cap = enabled ? (wsRows[0]?.cap ?? null) : null;
  const used = usageRows[0]?.used ?? 0;
  return {
    periodStart,
    enabled,
    capVnd: cap,
    usedVnd: used,
    remainingVnd: cap === null ? null : Math.max(0, cap - used),
    resetsAtMs: memberChatDayEndMs(args.now),
    isMember: memberRows.length > 0,
  };
}
