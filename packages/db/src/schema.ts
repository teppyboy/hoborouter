// PostgreSQL schema — 1:1 translation of the SQLite schema (same table/column
// names, checks, indexes, FKs). Money/token/epoch-ms columns are bigint mode
// 'number'; former typeof() type checks become bounded CHECKs
// (col >= 0 AND col <= MAX_SAFE_INTEGER_MONEY).
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// `users`/`session`/`account`/`verification` are Better Auth-generated
// (auth-schema.ts). Re-export scope-local bindings (bare `export *` breaks FK
// builders like workspaceMembers.user_id.references(() => users.id)).
import { users, session, account, verification } from "./auth-schema";
export { users, session, account, verification };

/** Largest integer representable exactly in IEEE doubles — upper bound for all canonical money/token columns. */
export const MAX_SAFE_INTEGER_MONEY = 9007199254740991;

/** Canonical reasoning effort ladder (OpenAI/OpenRouter-compatible names). */
export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
const MAX_BOUND = sql.raw(String(MAX_SAFE_INTEGER_MONEY));
// DB-side mirror of shared CHAT_ATTACHMENT_MAX_IMAGE_BYTES (10 MiB) — schema
// stays dependency-free, so the bound is duplicated with a comment tying it.
const CHAT_ATTACHMENT_MAX_BYTES_BOUND = sql.raw(String(10 * 1024 * 1024));
const intBounded = (col: AnyPgColumn) => sql`${col} >= 0 AND ${col} <= ${MAX_BOUND}`;

const big = (name: string) => bigint(name, { mode: "number" });

// --- workspaces & keys ---
export const workspaces = pgTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    status: text("status", { enum: ["active", "suspended"] })
      .notNull()
      .default("active"),
    // Member chat policy (migration 0025). Toggling or recapping NEVER resets
    // member_chat_usage rows or live holds — historical periods stay frozen.
    member_chat_enabled: boolean("member_chat_enabled").notNull().default(false),
    member_chat_daily_cap_vnd: big("member_chat_daily_cap_vnd"),
    created_at: big("created_at").notNull(),
  },
  (t) => [
    // Enabled policy always names an explicit positive per-user daily cap
    // (user explicitly capped; disabled workspaces keep cap NULL).
    check(
      "workspaces_member_chat_cap_required",
      sql`${t.member_chat_enabled} = false OR ${t.member_chat_daily_cap_vnd} IS NOT NULL`,
    ),
  ],
);

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspace_id: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role", { enum: ["owner", "admin", "member"] }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.user_id] }),
    check("wm_role", sql`${t.role} IN ('owner','admin','member')`),
  ],
);

export const instanceAdmins = pgTable("instance_admins", {
  user_id: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  created_at: big("created_at").notNull(),
  added_by: text("added_by"),
});

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    workspace_id: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    key_hash: text("key_hash").notNull(),
    key_prefix: text("key_prefix").notNull(),
    name: text("name").notNull(),
    status: text("status", { enum: ["active", "enabled", "disabled", "revoked"] })
      .notNull()
      .default("active"),
    // Server-owned key provenance: only the chat-key route writes 'chat';
    // the gateway resolves the 1 MiB vs 16 MiB body cap from this.
    purpose: text("purpose", { enum: ["generic", "chat", "chat_member"] })
      .notNull()
      .default("generic"),
    created_at: big("created_at").notNull(),
    last_used_at: big("last_used_at"),
    revoked_at: big("revoked_at"),
    deleted_at: big("deleted_at"),
    deleted_by: text("deleted_by"),
    // Key policy (Task 4 parity): optional epoch-ms expiry and a per-period
    // VND spend budget. budget_used_vnd is a POLICY counter (admission holds
    // + settled charges in the current window), never wallet money; wallet
    // ledger/reservation semantics are unchanged.
    expires_at: big("expires_at"),
    budget_vnd: big("budget_vnd"),
    budget_period: text("budget_period", { enum: ["daily", "weekly", "monthly"] }),
    budget_used_vnd: big("budget_used_vnd").notNull().default(0),
    budget_period_start: big("budget_period_start"),
    // Owner of a member chat key ('chat_member' purpose). NULL for generic
    // and instance-issued chat keys. FK is NO ACTION by design: user identity
    // removal must TOMBSTONE (soft-delete keys/rows referencing the user),
    // never hard-delete the user row — enforced by the admin lane.
    owner_user_id: text("owner_user_id").references(() => users.id),
  },
  (t) => [
    uniqueIndex("api_keys_key_hash").on(t.key_hash),
    check("api_keys_status", sql`${t.status} IN ('active','enabled','disabled','revoked')`),
    check("api_keys_purpose", sql`${t.purpose} IN ('generic','chat','chat_member')`),
    // A member chat key always names its owner.
    check(
      "api_keys_chat_member_owner",
      sql`${t.purpose} != 'chat_member' OR ${t.owner_user_id} IS NOT NULL`,
    ),
    // Member keys are never workspace-wide ownerless keys.
    check(
      "api_keys_generic_ownerless",
      sql`${t.purpose} = 'generic' OR ${t.owner_user_id} IS NULL OR ${t.purpose} = 'chat_member'`,
    ),
    check(
      "api_keys_expires_at_bound",
      sql`${t.expires_at} IS NULL OR (${t.expires_at} >= 0 AND ${t.expires_at} <= ${MAX_BOUND})`,
    ),
    check(
      "api_keys_budget_vnd_bound",
      sql`${t.budget_vnd} IS NULL OR (${t.budget_vnd} > 0 AND ${t.budget_vnd} <= ${MAX_BOUND})`,
    ),
    check(
      "api_keys_budget_period_enum",
      sql`${t.budget_period} IS NULL OR ${t.budget_period} IN ('daily','weekly','monthly')`,
    ),
    check(
      "api_keys_budget_used_bound",
      sql`${t.budget_used_vnd} >= 0 AND ${t.budget_used_vnd} <= ${MAX_BOUND}`,
    ),
    check(
      "api_keys_budget_period_start_bound",
      sql`${t.budget_period_start} IS NULL OR (${t.budget_period_start} >= 0 AND ${t.budget_period_start} <= ${MAX_BOUND})`,
    ),
    // budget_vnd and budget_period are set/cleared together.
    check("api_keys_budget_pair", sql`(${t.budget_vnd} IS NULL) = (${t.budget_period} IS NULL)`),
    // An admitted window always records its start; a budget without a start
    // would be an un-reset counter.
    check(
      "api_keys_budget_start_required",
      sql`${t.budget_vnd} IS NULL OR ${t.budget_period_start} IS NOT NULL`,
    ),
  ],
);

export const keyRateLimits = pgTable("key_rate_limits", {
  api_key_id: text("api_key_id")
    .primaryKey()
    .references(() => apiKeys.id),
  window: text("window").notNull(),
  max_requests: integer("max_requests").notNull(),
});

// --- wallet & ledger ---
export const wallets = pgTable(
  "wallets",
  {
    id: text("id").primaryKey(),
    workspace_id: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    currency: text("currency").notNull().default("VND"),
    kind: text("kind", { enum: ["topup", "subscription"] })
      .notNull()
      .default("topup"),
    balance: big("balance").notNull(),
    reserved: big("reserved").notNull(),
    version: integer("version").notNull().default(0),
    created_at: big("created_at").notNull(),
  },
  (t) => [
    // One wallet row per funding source: 'topup' (existing, all pre-kind rows)
    // and 'subscription' (created lazily at first plan settlement).
    uniqueIndex("wallets_workspace_kind").on(t.workspace_id, t.kind),
    check("wallets_kind", sql`${t.kind} IN ('topup','subscription')`),
    check("wallets_currency", sql`${t.currency} = 'VND'`),
    check("wallets_balance_type", intBounded(t.balance)),
    check("wallets_reserved_type", intBounded(t.reserved)),
    check("wallets_balance_gte_reserved", sql`${t.balance} >= ${t.reserved}`),
  ],
);

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: text("id").primaryKey(),
    wallet_id: text("wallet_id")
      .notNull()
      .references(() => wallets.id),
    direction: text("direction", { enum: ["debit", "credit"] }).notNull(),
    billing_reservation_id: text("billing_reservation_id").references(() => billingReservations.id),
    amount: big("amount").notNull(),
    kind: text("kind", {
      enum: ["topup", "settle", "adjustment", "refund", "subscription_daily_grant"],
    }).notNull(),
    reservation_id: text("reservation_id").references(() => reservations.id),
    original_ledger_entry_id: text("original_ledger_entry_id").references(
      (): AnyPgColumn => ledgerEntries.id,
    ),
    payment_id: text("payment_id").references(() => payments.id),
    balance_after: big("balance_after").notNull(),
    memo: text("memo"),
    created_at: big("created_at").notNull(),
  },
  (t) => [
    index("ledger_wallet_idx").on(t.wallet_id),
    index("ledger_billing_reservation_idx").on(t.billing_reservation_id),
    uniqueIndex("ledger_one_settle_per_reservation")
      .on(t.reservation_id)
      .where(sql`kind = 'settle'`),
    uniqueIndex("ledger_one_topup_per_payment")
      .on(t.payment_id)
      .where(sql`kind = 'topup'`),
    uniqueIndex("ledger_one_refund_per_original")
      .on(t.original_ledger_entry_id)
      .where(sql`kind = 'refund'`),
    // Idempotency for promo/credit adjustments keyed by (payment, memo) so
    // bundle bonus + first topup bonus can coexist on one payment while
    // replays of either stay impossible.
    uniqueIndex("ledger_one_adjustment_per_payment_memo")
      .on(t.payment_id, t.memo)
      .where(sql`kind = 'adjustment'`),
    check("ledger_direction", sql`${t.direction} IN ('debit','credit')`),
    check(
      "ledger_kind",
      sql`${t.kind} IN ('topup','settle','adjustment','refund','subscription_daily_grant')`,
    ),
    check("ledger_amount_type", sql`${t.amount} > 0 AND ${t.amount} <= ${MAX_BOUND}`),
    check("ledger_balance_after_type", intBounded(t.balance_after)),
    check(
      "ledger_refund_requires_original",
      sql`kind != 'refund' OR ${t.original_ledger_entry_id} IS NOT NULL`,
    ),
    check(
      "ledger_topup_settle_no_original",
      sql`kind NOT IN ('topup','settle') OR ${t.original_ledger_entry_id} IS NULL`,
    ),
  ],
);
// --- admin wallet adjustment receipts ---
// One immutable receipt per adjustment attempt. UNIQUE(actor_user_id,
// idempotency_key) is the replay arbiter: different actors may reuse a client
// key, so the key alone must not be unique. The receipt fields
// (balance_before/balance_after/reserved/request_payload) are persisted so a
// replay returns the ORIGINAL result without recomputation. ledger_entry_id is
// set later in the SAME transaction, after the ledger row insert; the
// "non-null at commit" guarantee is application-enforced (single transaction
// sequence + rollback regression tests), not declaratively enforceable.
export const adminWalletAdjustments = pgTable(
  "admin_wallet_adjustments",
  {
    id: text("id").primaryKey(),
    actor_user_id: text("actor_user_id")
      .notNull()
      .references(() => users.id),
    idempotency_key: text("idempotency_key").notNull(),
    wallet_id: text("wallet_id")
      .notNull()
      .references(() => wallets.id),
    workspace_id: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    // Signed, non-zero, bounded money delta; ledger.amount is |delta|.
    delta: big("delta").notNull(),
    // ADMIN-PRIVATE: never surfaced to workspace members/admins.
    reason: text("reason").notNull(),
    balance_before: big("balance_before").notNull(),
    balance_after: big("balance_after").notNull(),
    reserved: big("reserved").notNull(),
    ledger_entry_id: text("ledger_entry_id").references(() => ledgerEntries.id),
    request_payload: jsonb("request_payload")
      .$type<{ workspaceId: string; delta: number; reason: string }>()
      .notNull(),
    created_at: big("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("admin_wallet_adjustments_actor_key_uq").on(t.actor_user_id, t.idempotency_key),
    check(
      "admin_wallet_adjustments_delta_type",
      sql`${t.delta} != 0 AND ${t.delta} >= -${MAX_BOUND} AND ${t.delta} <= ${MAX_BOUND}`,
    ),
    check("admin_wallet_adjustments_balance_before_type", intBounded(t.balance_before)),
    check("admin_wallet_adjustments_balance_after_type", intBounded(t.balance_after)),
    check("admin_wallet_adjustments_reserved_type", intBounded(t.reserved)),
    check("admin_wallet_adjustments_created_at", intBounded(t.created_at)),
  ],
);

// --- payments ---
export const payments = pgTable(
  "payments",
  {
    id: text("id").primaryKey(),
    workspace_id: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    amount: big("amount").notNull(),
    status: text("status", {
      enum: ["pending", "succeeded", "failed", "expired", "rejected"],
    }).notNull(),
    provider: text("provider", { enum: ["manual", "mock", "vietqr_manual", "payos"] }).notNull(),
    provider_order_code: text("provider_order_code").notNull(),
    created_at: big("created_at").notNull(),
    expires_at: big("expires_at"),
    // Exactly one of these is set for a bundle/plan/throughput purchase; all
    // NULL means a plain top-up (whose settlement path must stay unchanged).
    bundle_id: text("bundle_id").references(() => creditBundles.id),
    subscription_plan_id: text("subscription_plan_id").references(() => subscriptionPlans.id),
    throughput_product_id: text("throughput_product_id").references(() => throughputProducts.id),
    // Creation-time snapshot of what the payer entered (never recomputed):
    // VND payments snapshot the VND amount text; USD top-ups snapshot the
    // exact input text plus the FX rate used for the ceiling conversion.
    input_currency: text("input_currency"),
    input_amount_text: text("input_amount_text"),
    fx_rate_vnd_per_usd: big("fx_rate_vnd_per_usd"),
    // Percent-voucher snapshot (plain top-ups only; all four set or all NULL).
    // `amount` holds the FINAL DUE (what the payer/provider is charged and
    // what webhook amount checks bind to); original_amount_vnd is the undiscounted
    // top-up credit granted at settlement, discount_vnd the voucher discount.
    // Promo type is snapshotted (promo_kind) so settlement never needs a join.
    promo_code_id: text("promo_code_id").references(() => promoCodes.id),
    promo_kind: text("promo_kind", { enum: ["fixed", "percent"] }),
    original_amount_vnd: big("original_amount_vnd"),
    discount_vnd: big("discount_vnd"),
  },
  (t) => [
    uniqueIndex("payments_provider_order").on(t.provider, t.provider_order_code),
    check("payments_amount_type", sql`${t.amount} > 0 AND ${t.amount} <= ${MAX_BOUND}`),
    check(
      "payments_one_purchase_kind",
      sql`(CASE WHEN ${t.bundle_id} IS NULL THEN 1 ELSE 0 END + CASE WHEN ${t.subscription_plan_id} IS NULL THEN 1 ELSE 0 END + CASE WHEN ${t.throughput_product_id} IS NULL THEN 1 ELSE 0 END) >= 2`,
    ),
    check(
      "payments_fx_rate_positive",
      sql`${t.fx_rate_vnd_per_usd} IS NULL OR ${t.fx_rate_vnd_per_usd} > 0`,
    ),
    check(
      "payments_voucher_snapshot",
      sql`(${t.promo_code_id} IS NULL AND ${t.promo_kind} IS NULL AND ${t.original_amount_vnd} IS NULL AND ${t.discount_vnd} IS NULL)
          OR (${t.promo_code_id} IS NOT NULL AND ${t.promo_kind} IS NOT NULL AND ${t.original_amount_vnd} > 0
              AND ${t.original_amount_vnd} <= ${MAX_BOUND} AND ${t.discount_vnd} >= 0 AND ${t.discount_vnd} <= ${MAX_BOUND})`,
    ),
  ],
);

export const paymentEvents = pgTable(
  "payment_events",
  {
    id: text("id").primaryKey(),
    payment_id: text("payment_id")
      .notNull()
      .references(() => payments.id),
    provider: text("provider").notNull(),
    provider_reference: text("provider_reference").notNull(),
    raw_payload: text("raw_payload"),
    signature_valid: boolean("signature_valid"),
    processed_at: big("processed_at").notNull(),
  },
  (t) => [uniqueIndex("payment_events_provider_reference").on(t.provider, t.provider_reference)],
);

// --- credit bundles & subscription plans ---
export const creditBundles = pgTable(
  "credit_bundles",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    price_vnd: big("price_vnd").notNull(),
    credit_vnd: big("credit_vnd").notNull(),
    bonus_vnd: big("bonus_vnd").notNull().default(0),
    // Deactivated, never deleted — past payments keep their FK.
    active: boolean("active").notNull().default(true),
    created_at: big("created_at").notNull(),
    // Per-field mixed currency (migration 0009): each USD column is authored
    // independently; the shared creation FX snapshot is required whenever ANY
    // USD column is set. Legacy all-VND rows and all-USD group rows both still
    // satisfy this. USD values are exact decimal texts, never floats; VND
    // grant columns above are frozen at creation from
    // creation_fx_rate_vnd_per_usd and never recomputed.
    price_usd: text("price_usd"),
    credit_usd: text("credit_usd"),
    bonus_usd: text("bonus_usd"),
    creation_fx_rate_vnd_per_usd: big("creation_fx_rate_vnd_per_usd"),
    // Financial revisions (migration 0014): revision_key exists ONLY on the
    // successor row created by a revision and is arbitrated by the partial
    // unique index below; successor_id exists ONLY on the superseded row and
    // is set in the SAME transaction as the successor insert. Assigning the
    // same revision_key to both rows would violate the index by construction.
    revision_key: text("revision_key"),
    successor_id: text("successor_id").references((): AnyPgColumn => creditBundles.id),
  },
  (t) => [
    uniqueIndex("cb_revision_key_uq")
      .on(t.revision_key)
      .where(sql`revision_key IS NOT NULL`),
    check("cb_price_vnd", sql`${t.price_vnd} > 0 AND ${t.price_vnd} <= ${MAX_BOUND}`),
    check("cb_credit_vnd", intBounded(t.credit_vnd)),
    check("cb_bonus_vnd", intBounded(t.bonus_vnd)),
    check("cb_created_at", intBounded(t.created_at)),
    // Plain unsigned decimal text with at most two fractional digits. The
    // format check precedes the numeric cast so the cast never sees invalid
    // text; the DB layer tolerates leading zeros and the API normalizes them.
    check(
      "cb_usd_group_complete",
      sql`(${t.creation_fx_rate_vnd_per_usd} IS NOT NULL) = (${t.price_usd} IS NOT NULL OR ${t.credit_usd} IS NOT NULL OR ${t.bonus_usd} IS NOT NULL)`,
    ),
    check(
      "cb_price_usd_format",
      sql`${t.price_usd} IS NULL OR (${t.price_usd} ~ '^[0-9]+(\\.[0-9]{1,2})?$' AND ${t.price_usd}::numeric > 0 AND ${t.price_usd}::numeric <= ${MAX_BOUND})`,
    ),
    check(
      "cb_credit_usd_format",
      sql`${t.credit_usd} IS NULL OR (${t.credit_usd} ~ '^[0-9]+(\\.[0-9]{1,2})?$' AND ${t.credit_usd}::numeric >= 0 AND ${t.credit_usd}::numeric <= ${MAX_BOUND})`,
    ),
    check(
      "cb_bonus_usd_format",
      sql`${t.bonus_usd} IS NULL OR (${t.bonus_usd} ~ '^[0-9]+(\\.[0-9]{1,2})?$' AND ${t.bonus_usd}::numeric >= 0 AND ${t.bonus_usd}::numeric <= ${MAX_BOUND})`,
    ),
    check(
      "cb_creation_fx_rate_vnd_per_usd",
      sql`${t.creation_fx_rate_vnd_per_usd} IS NULL OR (${t.creation_fx_rate_vnd_per_usd} > 0 AND ${t.creation_fx_rate_vnd_per_usd} <= ${MAX_BOUND})`,
    ),
  ],
);

export const subscriptionPlans = pgTable(
  "subscription_plans",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    price_vnd: big("price_vnd").notNull(),
    credit_per_period_vnd: big("credit_per_period_vnd").notNull(),
    // Fixed period length; renewal extends from max(now, period_end).
    period_days: integer("period_days").notNull().default(30),
    // Per-minute gateway request cap for subscription-funded traffic;
    // admin-editable on existing plans (not a money amount).
    rate_limit_per_minute: integer("rate_limit_per_minute").notNull().default(15),
    // Deactivated, never deleted.
    active: boolean("active").notNull().default(true),
    created_at: big("created_at").notNull(),
    // Optional USD authoring group (per-field mixed contract, migration 0009):
    // NULL for legacy VND rows; each USD column otherwise authored
    // independently with a shared creation FX snapshot.
    price_usd: text("price_usd"),
    credit_per_period_usd: text("credit_per_period_usd"),
    creation_fx_rate_vnd_per_usd: big("creation_fx_rate_vnd_per_usd"),
    // Authored once-per-UTC-day VND grant (migration 0019), credited lazily
    // inside the gateway funding transaction while the subscription is active
    // and unexpired. 0 = no daily grant. Snapshot of the applied amount is
    // stored per grant in subscription_daily_grants.
    daily_grant_vnd: big("daily_grant_vnd").notNull().default(0),
    // Exact authored USD daily-grant text (migration 0020); NULL when the
    // grant was authored in VND. Converted ONCE to daily_grant_vnd at the
    // shared creation_fx_rate_vnd_per_usd snapshot — the stored VND is frozen
    // forever after and never recomputed.
    daily_grant_usd: text("daily_grant_usd"),
    // Financial revision columns (migration 0014) — same successor/superseded
    // split as credit_bundles above.
    revision_key: text("revision_key"),
    successor_id: text("successor_id").references((): AnyPgColumn => subscriptionPlans.id),
  },
  (t) => [
    uniqueIndex("sp_revision_key_uq")
      .on(t.revision_key)
      .where(sql`revision_key IS NOT NULL`),
    check("sp_price_vnd", sql`${t.price_vnd} > 0 AND ${t.price_vnd} <= ${MAX_BOUND}`),
    check("sp_credit_per_period_vnd", intBounded(t.credit_per_period_vnd)),
    check("sp_daily_grant_vnd", intBounded(t.daily_grant_vnd)),
    check("sp_period_days", sql`${t.period_days} >= 1`),
    check(
      "sp_rate_limit_per_minute",
      sql`${t.rate_limit_per_minute} >= 1 AND ${t.rate_limit_per_minute} <= 600`,
    ),
    check("sp_created_at", intBounded(t.created_at)),
    check(
      "sp_usd_group_complete",
      sql`(${t.creation_fx_rate_vnd_per_usd} IS NOT NULL) = (${t.price_usd} IS NOT NULL OR ${t.credit_per_period_usd} IS NOT NULL OR ${t.daily_grant_usd} IS NOT NULL)`,
    ),
    check(
      "sp_price_usd_format",
      sql`${t.price_usd} IS NULL OR (${t.price_usd} ~ '^[0-9]+(\\.[0-9]{1,2})?$' AND ${t.price_usd}::numeric > 0 AND ${t.price_usd}::numeric <= ${MAX_BOUND})`,
    ),
    check(
      "sp_credit_per_period_usd_format",
      sql`${t.credit_per_period_usd} IS NULL OR (${t.credit_per_period_usd} ~ '^[0-9]+(\\.[0-9]{1,2})?$' AND ${t.credit_per_period_usd}::numeric >= 0 AND ${t.credit_per_period_usd}::numeric <= ${MAX_BOUND})`,
    ),
    check(
      "sp_daily_grant_usd_format",
      sql`${t.daily_grant_usd} IS NULL OR (${t.daily_grant_usd} ~ '^[0-9]+(\\.[0-9]{1,2})?$' AND ${t.daily_grant_usd}::numeric >= 0 AND ${t.daily_grant_usd}::numeric <= ${MAX_BOUND})`,
    ),
    check(
      "sp_creation_fx_rate_vnd_per_usd",
      sql`${t.creation_fx_rate_vnd_per_usd} IS NULL OR (${t.creation_fx_rate_vnd_per_usd} > 0 AND ${t.creation_fx_rate_vnd_per_usd} <= ${MAX_BOUND})`,
    ),
  ],
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    workspace_id: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    plan_id: text("plan_id")
      .notNull()
      .references(() => subscriptionPlans.id),
    status: text("status", { enum: ["active", "canceled"] })
      .notNull()
      .default("active"),
    // Cancel marker (decision b): set when the member cancels. Renewal is
    // not automatic in this system, so cancellation is informational —
    // status stays 'active' and credit stays spendable through
    // current_period_end, after which the normal lazy expiry forfeits it.
    canceled_at: big("canceled_at"),
    current_period_start: big("current_period_start").notNull(),
    current_period_end: big("current_period_end").notNull(),
    created_at: big("created_at").notNull(),
  },
  (t) => [
    // One active subscription per workspace; canceled rows keep history.
    uniqueIndex("subscriptions_one_active_per_workspace")
      .on(t.workspace_id)
      .where(sql`status = 'active'`),
    check("subscriptions_status", sql`${t.status} IN ('active','canceled')`),
    check("subscriptions_period", sql`${t.current_period_start} < ${t.current_period_end}`),
    check("subscriptions_current_period_start", intBounded(t.current_period_start)),
    check("subscriptions_current_period_end", intBounded(t.current_period_end)),
    check("subscriptions_created_at", intBounded(t.created_at)),
  ],
);

/**
 * Expiry idempotency gate (O5): one forfeit of unused subscription credit per
 * (subscription, period end). Inserted in the same txn as the forfeiture
 * adjustment debit, so replays are impossible without deleting ledger rows.
 */
export const subscriptionExpiries = pgTable(
  "subscription_expiries",
  {
    subscription_id: text("subscription_id")
      .notNull()
      .references(() => subscriptions.id),
    period_end: big("period_end").notNull(),
    ledger_entry_id: text("ledger_entry_id")
      .notNull()
      .references(() => ledgerEntries.id),
    created_at: big("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.subscription_id, t.period_end] }),
    check("se_period_end", intBounded(t.period_end)),
    check("se_created_at", intBounded(t.created_at)),
  ],
);

/**
 * Daily-grant idempotency gate (migration 0019): one grant of the plan's
 * authored daily_grant_vnd per (workspace, subscription, UTC day). Inserted
 * in the SAME transaction as the subscription_daily_grant ledger credit and
 * snapshotting the applied terms (plan_id, amount), so a grant row is both
 * the replay arbiter and the frozen record of what was applied that day.
 * No catch-up: a day with no gateway funding transaction gets no grant row.
 */
export const subscriptionDailyGrants = pgTable(
  "subscription_daily_grants",
  {
    id: text("id").primaryKey(),
    workspace_id: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    subscription_id: text("subscription_id")
      .notNull()
      .references(() => subscriptions.id),
    plan_id: text("plan_id")
      .notNull()
      .references(() => subscriptionPlans.id),
    /** UTC calendar day of the grant, 'YYYY-MM-DD' (from the funding transaction's now). */
    grant_day: text("grant_day").notNull(),
    amount: big("amount").notNull(),
    ledger_entry_id: text("ledger_entry_id")
      .notNull()
      .references(() => ledgerEntries.id),
    created_at: big("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("subscription_daily_grants_one_per_day").on(
      t.workspace_id,
      t.subscription_id,
      t.grant_day,
    ),
    check("sdg_grant_day", sql`${t.grant_day} ~ '^\\d{4}-\\d{2}-\\d{2}$'`),
    check("sdg_amount", sql`${t.amount} > 0 AND ${t.amount} <= ${MAX_BOUND}`),
    check("sdg_created_at", intBounded(t.created_at)),
  ],
);

/** Grants the once-per-workspace first successful paid top-up bonus; the PK is the grant gate. */
export const firstTopupBonuses = pgTable(
  "first_topup_bonuses",
  {
    workspace_id: text("workspace_id")
      .primaryKey()
      .references(() => workspaces.id),
    payment_id: text("payment_id")
      .notNull()
      .references(() => payments.id),
    ledger_entry_id: text("ledger_entry_id")
      .notNull()
      .references(() => ledgerEntries.id),
    amount: big("amount").notNull(),
    created_at: big("created_at").notNull(),
  },
  (t) => [
    check("ftb_amount", sql`${t.amount} > 0 AND ${t.amount} <= ${MAX_BOUND}`),
    check("ftb_created_at", intBounded(t.created_at)),
  ],
);

/**
 * Promo codes grant a one-time credit per workspace on redemption. Only the
 * app-side hash is stored — the plaintext code never reaches the database.
 * `uses` is bounded by `max_uses` so exhausted codes cannot be redeemed even
 * if app-side checks race.
 *
 * Two kinds:
 *  - fixed: amount_vnd credit granted by the /promotions/redeem endpoint.
 *  - percent: percent_bp basis points off a TOP-UP payment at checkout (1..9999,
 *    never 10000 — the final due must stay positive), with an optional-VND cap
 *    max_discount_vnd. kind/amounts are immutable after creation.
 *
 * Repeat view (unlike sk-hbr- API keys): code_encrypted holds the plaintext
 * under AES-256-GCM (key = HKDF-SHA256 of the server-only auth secret, AAD
 * binds the ciphertext to this row id). NULL for legacy rows (created before
 * repeat view) or when no server secret was configured — those codes can
 * never be re-viewed, only redeemed via code_hash.
 */
export const promoCodes = pgTable(
  "promo_codes",
  {
    id: text("id").primaryKey(),
    code_hash: text("code_hash").notNull(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["fixed", "percent"] })
      .notNull()
      .default("fixed"),
    amount_vnd: big("amount_vnd"),
    percent_bp: integer("percent_bp"),
    max_discount_vnd: big("max_discount_vnd"),
    max_uses: integer("max_uses").notNull(),
    uses: integer("uses").notNull().default(0),
    expires_at: big("expires_at"),
    active: boolean("active").notNull().default(true),
    created_at: big("created_at").notNull(),
    // Soft removal: set by the admin DELETE endpoint. Never a hard delete —
    // promo_redemptions/promo_payments keep their FKs and redemption history
    // stays intact. The row (and its code_hash) remains for FK integrity.
    deleted_at: big("deleted_at"),
    // AES-256-GCM ciphertext of the normalized plaintext code (admin repeat
    // view). Never selected into any response shape except the admin reveal
    // endpoint; NULL = not re-viewable (legacy row / no server secret).
    code_encrypted: text("code_encrypted"),
  },
  (t) => [
    uniqueIndex("promo_codes_code_hash").on(t.code_hash),
    check(
      "pc_amount_vnd",
      sql`${t.amount_vnd} IS NULL OR (${t.amount_vnd} > 0 AND ${t.amount_vnd} <= ${MAX_BOUND})`,
    ),
    check(
      "pc_kind",
      sql`(${t.kind} = 'fixed' AND ${t.amount_vnd} IS NOT NULL AND ${t.percent_bp} IS NULL AND ${t.max_discount_vnd} IS NULL)
          OR (${t.kind} = 'percent' AND ${t.amount_vnd} IS NULL AND ${t.percent_bp} > 0 AND ${t.percent_bp} <= 9999
              AND ${t.max_discount_vnd} > 0 AND ${t.max_discount_vnd} <= ${MAX_BOUND})`,
    ),
    check("pc_max_uses", sql`${t.max_uses} >= 1`),
    check("pc_uses", sql`${t.uses} >= 0 AND ${t.uses} <= ${t.max_uses}`),
    check("pc_expires_at", sql`${t.expires_at} IS NULL OR ${intBounded(t.expires_at)}`),
    check("pc_created_at", intBounded(t.created_at)),
  ],
);

/**
 * Redemption record + idempotency gate: the unique (promo_code_id,
 * workspace_id) pair makes a second redemption of the same code by the same
 * workspace impossible at the storage layer, regardless of app races.
 */
export const promoRedemptions = pgTable(
  "promo_redemptions",
  {
    id: text("id").primaryKey(),
    promo_code_id: text("promo_code_id")
      .notNull()
      .references(() => promoCodes.id),
    workspace_id: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    // Fixed redemptions link the granted credit; percent redemptions link the
    // discounted payment instead. Exactly one of the two is always set.
    ledger_entry_id: text("ledger_entry_id").references(() => ledgerEntries.id),
    payment_id: text("payment_id").references(() => payments.id),
    created_at: big("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("promo_redemptions_code_workspace").on(t.promo_code_id, t.workspace_id),
    check("pr_created_at", intBounded(t.created_at)),
    check("pr_one_gate", sql`(${t.ledger_entry_id} IS NULL) <> (${t.payment_id} IS NULL)`),
  ],
);

// --- prepaid throughput allowance (gateway admission product) ---
// A throughput product sells a fixed-window gateway admission cap for a
// workspace: integer-VND price, bounded requests-per-minute, fixed duration.
// It grants NO wallet credit — settlement activates an allowance row instead.
export const throughputProducts = pgTable(
  "throughput_products",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    price_vnd: big("price_vnd").notNull(),
    // Per-minute gateway admission cap while the allowance window is active;
    // same 1..600 bound as subscription_plans.rate_limit_per_minute.
    requests_per_minute: integer("requests_per_minute").notNull(),
    // Fixed active-window length; settlement computes ends_at = starts_at +
    // duration_days. Immutable after create (pending payments settle against
    // it, like bundle amounts).
    duration_days: integer("duration_days").notNull(),
    // Deactivated, never deleted — past payments keep their FK.
    active: boolean("active").notNull().default(true),
    created_at: big("created_at").notNull(),
  },
  (t) => [
    check("tp_price_vnd", sql`${t.price_vnd} > 0 AND ${t.price_vnd} <= ${MAX_BOUND}`),
    check(
      "tp_requests_per_minute",
      sql`${t.requests_per_minute} >= 1 AND ${t.requests_per_minute} <= 600`,
    ),
    check("tp_duration_days", sql`${t.duration_days} >= 1 AND ${t.duration_days} <= 3650`),
    check("tp_created_at", intBounded(t.created_at)),
  ],
);

/**
 * One purchased allowance per workspace payment. Status lifecycle:
 * 'scheduled' (purchased, window not started — queued behind the incumbent
 * by settlement chaining) -> 'active' (window started; at most ONE per
 * workspace via the partial unique index, promoted lazily) -> 'expired'
 * (window lapsed, flipped lazily) or 'deactivated' (admin removed the cap).
 * The gateway gates on status='active' AND [starts_at, ends_at) containing
 * now. The (workspace_id, starts_at) unique index makes concurrent
 * settlement retries of the same chain position impossible to double-insert.
 */
export const throughputAllowances = pgTable(
  "throughput_allowances",
  {
    id: text("id").primaryKey(),
    workspace_id: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    payment_id: text("payment_id")
      .notNull()
      .references(() => payments.id),
    product_id: text("product_id")
      .notNull()
      .references(() => throughputProducts.id),
    requests_per_minute: integer("requests_per_minute").notNull(),
    starts_at: big("starts_at").notNull(),
    ends_at: big("ends_at").notNull(),
    status: text("status", { enum: ["scheduled", "active", "expired", "deactivated"] })
      .notNull()
      .default("active"),
    created_at: big("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("throughput_allowances_one_active_per_workspace")
      .on(t.workspace_id)
      .where(sql`status = 'active'`),
    // Two windows of one workspace can never START at the same instant;
    // settlement chaining computes starts_at deterministically, so a
    // concurrent settlement retry conflicts here instead of double-inserting.
    uniqueIndex("throughput_allowances_one_start_per_workspace").on(t.workspace_id, t.starts_at),
    index("throughput_allowances_workspace_status_idx").on(t.workspace_id, t.status),
    check(
      "ta_requests_per_minute",
      sql`${t.requests_per_minute} >= 1 AND ${t.requests_per_minute} <= 600`,
    ),
    check("ta_window", sql`${t.starts_at} < ${t.ends_at}`),
    check("ta_starts_at", intBounded(t.starts_at)),
    check("ta_ends_at", intBounded(t.ends_at)),
    check("ta_status", sql`${t.status} IN ('scheduled','active','expired','deactivated')`),
    check("ta_created_at", intBounded(t.created_at)),
  ],
);

// --- canonical paid-gateway catalog ---
export const models = pgTable(
  "models",
  {
    id: text("id").primaryKey(),
    public_id: text("public_id").notNull(),
    slug: text("slug").notNull(),
    display_name: text("display_name").notNull(),
    provider: text("provider").notNull(),
    description: text("description"),
    capabilities: jsonb("capabilities"),
    context_window: integer("context_window"),
    enabled: boolean("enabled").notNull().default(true),
    published: boolean("published").notNull().default(false),
    // Per-model prompt-caching override; 'inherit' follows the global
    // instance_settings.prompt_caching_enabled flag.
    prompt_caching: text("prompt_caching", { enum: ["inherit", "on", "off"] })
      .notNull()
      .default("inherit"),
    // Marks models resolvable by the hoborouter/auto cheapest-first router.
    auto_eligible: boolean("auto_eligible").notNull().default(false),
    // Catalog-authored default reasoning effort applied when a client enables
    // reasoning without naming an effort; NULL = no default (such requests
    // pass through to CPA untouched).
    default_reasoning_effort: text("default_reasoning_effort", {
      enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    }),
    created_at: big("created_at").notNull(),
    updated_at: big("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("models_public_id").on(t.public_id),
    check("models_prompt_caching", sql`${t.prompt_caching} IN ('inherit', 'on', 'off')`),
    check(
      "models_default_reasoning_effort",
      sql`${t.default_reasoning_effort} IS NULL OR ${t.default_reasoning_effort} IN ('none','minimal','low','medium','high','xhigh','max')`,
    ),
  ],
);

/**
 * Catalog-authored reasoning route: one public effort -> one CPA-compatible
 * upstream (model + effort). Instance-admin authored and audited; the public
 * effort never leaks the upstream model. At most ONE enabled row per
 * (model, public_effort) via the partial unique index — a re-authored route
 * disables the previous row, preserving history like providerModelMappings.
 */
export const modelReasoningRoutes = pgTable(
  "model_reasoning_routes",
  {
    id: text("id").primaryKey(),
    model_id: text("model_id")
      .notNull()
      .references(() => models.id),
    public_effort: text("public_effort", {
      enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    }).notNull(),
    provider: text("provider").notNull(),
    upstream_model: text("upstream_model").notNull(),
    upstream_effort: text("upstream_effort", {
      enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    // Admin-authored display/routing order among a model's enabled routes;
    // contiguous 0..n-1 within each model (enforced by the reorder endpoint).
    sort_order: integer("sort_order").notNull().default(0),
    created_at: big("created_at").notNull(),
    updated_at: big("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("model_reasoning_routes_one_enabled_per_effort")
      .on(t.model_id, t.public_effort)
      .where(sql`enabled = true`),
    check(
      "mrr_public_effort",
      sql`${t.public_effort} IN ('none','minimal','low','medium','high','xhigh','max')`,
    ),
    check(
      "mrr_upstream_effort",
      sql`${t.upstream_effort} IN ('none','minimal','low','medium','high','xhigh','max')`,
    ),
    check("mrr_created_at", intBounded(t.created_at)),
    check("mrr_updated_at", intBounded(t.updated_at)),
  ],
);

export const providerModelMappings = pgTable("provider_model_mappings", {
  id: text("id").primaryKey(),
  model_id: text("model_id")
    .notNull()
    .references(() => models.id),
  provider: text("provider").notNull(),
  upstream_model: text("upstream_model").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  created_at: big("created_at").notNull(),
  updated_at: big("updated_at").notNull(),
});

export const modelPrices = pgTable(
  "model_prices",
  {
    id: text("id").primaryKey(),
    model_id: text("model_id")
      .notNull()
      .references(() => models.id),
    input_usd_micro_per_1m: big("input_usd_micro_per_1m").notNull(),
    output_usd_micro_per_1m: big("output_usd_micro_per_1m").notNull(),
    cached_input_usd_micro_per_1m: big("cached_input_usd_micro_per_1m").notNull(),
    reasoning_usd_micro_per_1m: big("reasoning_usd_micro_per_1m").notNull(),
    markup_ppm: big("markup_ppm").notNull(),
    effective_at: big("effective_at").notNull(),
    retired_at: big("retired_at"),
  },
  (t) => [
    check(
      "model_prices_integer_nonnegative",
      sql`${intBounded(t.input_usd_micro_per_1m)} AND ${intBounded(t.output_usd_micro_per_1m)} AND ${intBounded(t.cached_input_usd_micro_per_1m)} AND ${intBounded(t.reasoning_usd_micro_per_1m)}`,
    ),
    check("model_prices_markup", intBounded(t.markup_ppm)),
  ],
);

export const apiKeyModelPermissions = pgTable(
  "api_key_model_permissions",
  {
    api_key_id: text("api_key_id")
      .notNull()
      .references(() => apiKeys.id),
    model_id: text("model_id")
      .notNull()
      .references(() => models.id),
    created_at: big("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.api_key_id, t.model_id] })],
);

// --- model catalog & price snapshots ---
export const modelBindings = pgTable(
  "model_bindings",
  {
    id: text("id").primaryKey(),
    workspace_id: text("workspace_id").references(() => workspaces.id), // NULL = global
    public_model: text("public_model").notNull(),
    cpa_alias: text("cpa_alias").notNull(),
    status: text("status", { enum: ["published", "disabled"] }).notNull(),
    price_input_per_1m: big("price_input_per_1m").notNull(),
    price_output_per_1m: big("price_output_per_1m").notNull(),
    effective_at: big("effective_at").notNull(),
  },
  (t) => [
    check("mb_price_input_type", intBounded(t.price_input_per_1m)),
    check("mb_price_output_type", intBounded(t.price_output_per_1m)),
    check("mb_status", sql`${t.status} IN ('published','disabled')`),
  ],
);

export const priceSnapshots = pgTable(
  "price_snapshots",
  {
    id: text("id").primaryKey(),
    binding_id: text("binding_id")
      .notNull()
      .references(() => modelBindings.id),
    price_input: big("price_input").notNull(),
    price_output: big("price_output").notNull(),
    created_at: big("created_at").notNull(),
  },
  (t) => [
    check("ps_price_input_type", intBounded(t.price_input)),
    check("ps_price_output_type", intBounded(t.price_output)),
  ],
);

// --- requests & usage ---
export const requests = pgTable(
  "requests",
  {
    id: text("id").primaryKey(),
    workspace_id: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    api_key_id: text("api_key_id").references(() => apiKeys.id),
    model_binding_id: text("model_binding_id").references(() => modelBindings.id),
    model_id: text("model_id").references(() => models.id),
    provider_model_mapping_id: text("provider_model_mapping_id").references(
      () => providerModelMappings.id,
    ),
    endpoint: text("endpoint").notNull(),
    mode: text("mode", { enum: ["stream", "non-stream"] }).notNull(),
    cpa_trace_id: text("cpa_trace_id"),
    status: text("status", {
      enum: ["pending", "ok", "client_abort", "upstream_error", "unknown"],
    }).notNull(),
    dispatch_state: text("dispatch_state", { enum: ["reserved", "dispatching", "terminal"] })
      .notNull()
      .default("reserved"),
    dispatched_at: big("dispatched_at"),
    http_status: integer("http_status"),
    ttft_ms: integer("ttft_ms"),
    duration_ms: integer("duration_ms"),
    created_at: big("created_at").notNull(),
    // Soft delete. Audit trail only: wallet, ledger, payments and financial
    // totals are untouched by deletion.
    deleted_at: big("deleted_at"),
    deleted_by: text("deleted_by"),
  },
  (t) => [
    index("requests_cpa_trace_idx").on(t.cpa_trace_id),
    check(
      "requests_endpoint",
      sql`${t.endpoint} IN ('/v1/chat/completions','/v1/responses','/v1/messages')`,
    ),
    check("requests_mode", sql`${t.mode} IN ('stream','non-stream')`),
    check(
      "requests_status",
      sql`${t.status} IN ('pending','ok','client_abort','upstream_error','unknown')`,
    ),
    check(
      "requests_dispatch_state",
      sql`${t.dispatch_state} IN ('reserved','dispatching','terminal')`,
    ),
    check(
      "requests_model_source",
      sql`${t.model_binding_id} IS NOT NULL OR ${t.model_id} IS NOT NULL`,
    ),
  ],
);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: text("id").primaryKey(),
    source_request_id: text("source_request_id").notNull(),
    cpa_execution_uuid: text("cpa_execution_uuid"),
    gateway_request_id: text("gateway_request_id").references(() => requests.id),
    tokens_input: big("tokens_input").notNull(),
    tokens_output: big("tokens_output").notNull(),
    tokens_reasoning: big("tokens_reasoning").notNull(),
    tokens_cached: big("tokens_cached").notNull(),
    tokens_total: big("tokens_total").notNull(),
    failed: boolean("failed").notNull(),
    latency_ms: integer("latency_ms"),
    raw_payload: text("raw_payload"),
    ingested_at: big("ingested_at").notNull(),
  },
  (t) => [
    check(
      "usage_events_tokens_nonnegative",
      sql`${intBounded(t.tokens_input)} AND ${intBounded(t.tokens_output)} AND ${intBounded(t.tokens_reasoning)} AND ${intBounded(t.tokens_cached)} AND ${intBounded(t.tokens_total)}`,
    ),
  ],
);

// --- reservations ---
export const reservations = pgTable(
  "reservations",
  {
    id: text("id").primaryKey(),
    wallet_id: text("wallet_id")
      .notNull()
      .references(() => wallets.id),
    gateway_request_id: text("gateway_request_id")
      .notNull()
      .references(() => requests.id),
    api_key_id: text("api_key_id").references(() => apiKeys.id),
    price_snapshot_id: text("price_snapshot_id")
      .notNull()
      .references(() => priceSnapshots.id),
    status: text("status", {
      enum: ["held", "settled", "released", "unknown"],
    }).notNull(),
    cap_amount: big("cap_amount").notNull(),
    estimated_input_tokens: big("estimated_input_tokens").notNull(),
    created_at: big("created_at").notNull(),
    resolved_at: big("resolved_at"),
    expires_at: big("expires_at"),
  },
  (t) => [
    uniqueIndex("reservations_gateway_request_id").on(t.gateway_request_id),
    check("res_cap_amount_type", sql`${t.cap_amount} > 0 AND ${t.cap_amount} <= ${MAX_BOUND}`),
    check("res_status", sql`${t.status} IN ('held','settled','released','unknown')`),
  ],
);

export const billingReservations = pgTable(
  "billing_reservations",
  {
    id: text("id").primaryKey(),
    wallet_id: text("wallet_id")
      .notNull()
      .references(() => wallets.id),
    request_id: text("request_id")
      .notNull()
      .unique()
      .references(() => requests.id),
    api_key_id: text("api_key_id").references(() => apiKeys.id),
    model_id: text("model_id")
      .notNull()
      .references(() => models.id),
    model_price_id: text("model_price_id")
      .notNull()
      .references(() => modelPrices.id),
    usd_vnd_exchange_rate: big("usd_vnd_exchange_rate").notNull(),
    markup_ppm: big("markup_ppm").notNull(),
    cap_vnd: big("cap_vnd").notNull(),
    // Member daily-cap hold ticket (migration 0025): snapshots the policy
    // counter this hold charged against (workspace member_chat_usage period
    // key, UTC 'YYYY-MM-DD'). NULL for owner/admin/key-budget traffic. The
    // persisted ticket lets late settlements modify the OLD period row only.
    member_budget_user_id: text("member_budget_user_id").references(() => users.id),
    member_budget_period_start: text("member_budget_period_start"),
    // Key-budget hold ticket: api_keys.budget_period_start snapshot at hold
    // time (epoch ms). Fixes the old-ticket bug where settlement re-read the
    // live (possibly rolled-over) period start instead of the held one.
    key_budget_period_start: big("key_budget_period_start"),
    status: text("status", {
      enum: ["held", "settled", "settled_full_hold", "released"],
    }).notNull(),
    created_at: big("created_at").notNull(),
    resolved_at: big("resolved_at"),
  },
  (t) => [
    check(
      "billing_reservations_money",
      sql`${t.cap_vnd} > 0 AND ${t.cap_vnd} <= ${MAX_BOUND} AND ${t.usd_vnd_exchange_rate} > 0 AND ${t.usd_vnd_exchange_rate} <= ${MAX_BOUND} AND ${intBounded(t.markup_ppm)}`,
    ),
    check(
      "billing_reservations_status",
      sql`${t.status} IN ('held','settled','settled_full_hold','released')`,
    ),
    // Member hold tickets are complete or absent (period key rides the user).
    check(
      "billing_reservations_member_ticket_pair",
      sql`(${t.member_budget_user_id} IS NULL) = (${t.member_budget_period_start} IS NULL)`,
    ),
    check(
      "billing_reservations_key_period_start_bound",
      sql`${t.key_budget_period_start} IS NULL OR (${t.key_budget_period_start} >= 0 AND ${t.key_budget_period_start} <= ${MAX_BOUND})`,
    ),
  ],
);

export const usageLogs = pgTable(
  "usage_logs",
  {
    id: text("id").primaryKey(),
    idempotency_key: text("idempotency_key").notNull().unique(),
    request_id: text("request_id")
      .notNull()
      .unique()
      .references(() => requests.id),
    api_key_id: text("api_key_id").references(() => apiKeys.id),
    workspace_id: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    provider: text("provider").notNull(),
    public_model: text("public_model").notNull(),
    upstream_model: text("upstream_model").notNull(),
    input_tokens: big("input_tokens").notNull(),
    output_tokens: big("output_tokens").notNull(),
    cached_input_tokens: big("cached_input_tokens").notNull(),
    reasoning_tokens: big("reasoning_tokens").notNull(),
    status: text("status").notNull(),
    failure: text("failure"),
    latency_ms: integer("latency_ms"),
    ttft_ms: integer("ttft_ms"),
    upstream_cost_usd_micro: big("upstream_cost_usd_micro"),
    usd_vnd_exchange_rate: big("usd_vnd_exchange_rate"),
    markup_ppm: big("markup_ppm"),
    charged_vnd: big("charged_vnd"),
    raw_payload: text("raw_payload"),
    created_at: big("created_at").notNull(),
  },
  (t) => [
    check(
      "usage_logs_tokens_nonnegative",
      sql`${intBounded(t.input_tokens)} AND ${intBounded(t.output_tokens)} AND ${intBounded(t.cached_input_tokens)} AND ${intBounded(t.reasoning_tokens)} AND ${t.cached_input_tokens} <= ${t.input_tokens} AND ${t.reasoning_tokens} <= ${t.output_tokens}`,
    ),
    check(
      "usage_logs_snapshot_money",
      sql`(${t.upstream_cost_usd_micro} IS NULL OR ${intBounded(t.upstream_cost_usd_micro)}) AND (${t.usd_vnd_exchange_rate} IS NULL OR (${t.usd_vnd_exchange_rate} > 0 AND ${t.usd_vnd_exchange_rate} <= ${MAX_BOUND})) AND (${t.markup_ppm} IS NULL OR ${intBounded(t.markup_ppm)}) AND (${t.charged_vnd} IS NULL OR ${intBounded(t.charged_vnd)})`,
    ),
  ],
);

/** Instance-level key/value settings (e.g. prompt_caching_enabled). Values are the string 'true'/'false' for booleans. */
export const instanceSettings = pgTable("instance_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updated_at: big("updated_at").notNull(),
});

// --- Phase 2 settlement tables (schema preserved per spec; no app code touches them) ---
export const settlements = pgTable(
  "settlements",
  {
    id: text("id").primaryKey(),
    reservation_id: text("reservation_id").references(() => reservations.id),
    billing_reservation_id: text("billing_reservation_id").references(() => billingReservations.id),
    charged_input: big("charged_input").notNull(),
    charged_output: big("charged_output").notNull(),
    charged_total: big("charged_total").notNull(),
    settled_at: big("settled_at").notNull(),
    charged_vnd: big("charged_vnd"),
    usage_log_id: text("usage_log_id").references(() => usageLogs.id),
    reason: text("reason"),
    created_at: big("created_at"),
  },
  (t) => [
    uniqueIndex("settlements_reservation_id").on(t.reservation_id),
    uniqueIndex("settlements_billing_reservation_id").on(t.billing_reservation_id),
    check("st_charged_input_type", intBounded(t.charged_input)),
    check("st_charged_output_type", intBounded(t.charged_output)),
    check("st_charged_total_type", intBounded(t.charged_total)),
    check("st_charged_vnd_nonneg", sql`${t.charged_vnd} IS NULL OR ${intBounded(t.charged_vnd)}`),
    check(
      "st_one_reservation",
      sql`(${t.reservation_id} IS NOT NULL) != (${t.billing_reservation_id} IS NOT NULL)`,
    ),
  ],
);

export const settlementUsageEvents = pgTable(
  "settlement_usage_events",
  {
    settlement_id: text("settlement_id")
      .notNull()
      .references(() => settlements.id),
    usage_event_id: text("usage_event_id")
      .notNull()
      .references(() => usageEvents.id),
  },
  (t) => [
    primaryKey({ columns: [t.settlement_id, t.usage_event_id] }),
    uniqueIndex("sue_usage_event_id").on(t.usage_event_id),
  ],
);

export const unknownResolutions = pgTable(
  "unknown_resolutions",
  {
    id: text("id").primaryKey(),
    resolution_key: text("resolution_key").notNull(),
    request_id: text("request_id")
      .notNull()
      .references(() => requests.id),
    reservation_id: text("reservation_id")
      .notNull()
      .references(() => reservations.id),
    payload_hash: text("payload_hash").notNull(),
    outcome: text("outcome", { enum: ["hold_release", "manual_settle"] }).notNull(),
    result: text("result").notNull(),
    actor_user_id: text("actor_user_id").references(() => users.id),
    created_at: big("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("ur_resolution_key").on(t.resolution_key),
    uniqueIndex("ur_request_id").on(t.request_id),
    check("ur_outcome", sql`${t.outcome} IN ('hold_release','manual_settle')`),
  ],
);

export const refundOperations = pgTable(
  "refund_operations",
  {
    id: text("id").primaryKey(),
    operation_key: text("operation_key").notNull(),
    original_ledger_entry_id: text("original_ledger_entry_id")
      .notNull()
      .references(() => ledgerEntries.id),
    request_id: text("request_id")
      .notNull()
      .references(() => requests.id),
    reservation_id: text("reservation_id")
      .notNull()
      .references(() => reservations.id),
    payload_hash: text("payload_hash").notNull(),
    amount: big("amount").notNull(),
    result: text("result").notNull(),
    actor_user_id: text("actor_user_id").references(() => users.id),
    created_at: big("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("ro_operation_key").on(t.operation_key),
    uniqueIndex("ro_original_ledger_entry_id").on(t.original_ledger_entry_id),
    check("ro_amount_type", sql`${t.amount} > 0 AND ${t.amount} <= ${MAX_BOUND}`),
  ],
);

// --- chat history (context storage only — never billed, no wallet/ledger coupling) ---
export const chatConversations = pgTable(
  "chat_conversations",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id),
    workspace_id: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    title: text("title").notNull(),
    model: text("model"),
    // Message-shape validation lives app-side (Zod at the API boundary);
    // the column stays a plain jsonb array of plain-text messages.
    messages: jsonb("messages").notNull().default([]),
    version: integer("version").notNull().default(1),
    created_at: big("created_at").notNull(),
    updated_at: big("updated_at").notNull(),
    archived_at: big("archived_at"),
  },
  (t) => [
    // Covers the conversation-list query: active-or-archived slice per
    // (user, workspace), ordered by updated_at DESC, id for the cursor.
    index("chat_conversations_list_idx").on(
      t.user_id,
      t.workspace_id,
      t.archived_at,
      t.updated_at,
      t.id,
    ),
    check("chat_conversations_version", sql`${t.version} >= 1`),
    check("chat_conversations_created_at", intBounded(t.created_at)),
    check("chat_conversations_updated_at", intBounded(t.updated_at)),
    check(
      "chat_conversations_archived_at",
      sql`${t.archived_at} IS NULL OR ${intBounded(t.archived_at)}`,
    ),
  ],
);

// --- member chat policy usage (migration 0025) ---
// Per-(workspace, user, UTC day) policy counter. used_vnd includes live
// admission holds AND settled charges; rows are HISTORICAL — a policy update
// or period rollover never deletes/resets them. UTC period key is the text
// date 'YYYY-MM-DD' (same convention as subscription_daily_grants.grant_day).
export const memberChatUsage = pgTable(
  "member_chat_usage",
  {
    workspace_id: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id),
    period_start: text("period_start").notNull(),
    used_vnd: big("used_vnd").notNull().default(0),
    created_at: big("created_at").notNull(),
    updated_at: big("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspace_id, t.user_id, t.period_start] }),
    check("mcu_period_start", sql`${t.period_start} ~ '^\\d{4}-\\d{2}-\\d{2}$'`),
    check("mcu_used_vnd", intBounded(t.used_vnd)),
    check("mcu_created_at", intBounded(t.created_at)),
    check("mcu_updated_at", intBounded(t.updated_at)),
  ],
);

// --- chat attachments (migration 0024) ---
// Metadata rows only: bytes live on the filesystem at
// data/chat-attachments/<uuid> (server-generated from the row UUID — no
// client path ever reaches the filename). TTL 30 days from upload; unreferenced
// uploads are GC'd after 24h. Expired/deleted refs stay in history snapshots.
// user_id FK is NO ACTION by design: user identity removal must TOMBSTONE
// these rows (deleted_at) before removing the user — never hard-delete.
export const chatAttachments = pgTable(
  "chat_attachments",
  {
    id: text("id").primaryKey(), // UUIDv4 text; also the storage filename
    user_id: text("user_id")
      .notNull()
      .references(() => users.id),
    workspace_id: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    kind: text("kind", { enum: ["image", "text"] }).notNull(),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    bytes: big("bytes").notNull(),
    created_at: big("created_at").notNull(),
    expires_at: big("expires_at").notNull(),
    deleted_at: big("deleted_at"),
  },
  (t) => [
    // Live-bytes quota query (sum WHERE deleted_at IS NULL, per user).
    index("chat_attachments_user_live_idx")
      .on(t.user_id)
      .where(sql`deleted_at IS NULL`),
    // Per-workspace listing + GC sweeps by expiry.
    index("chat_attachments_workspace_created_idx").on(t.workspace_id, t.created_at),
    index("chat_attachments_expires_idx").on(t.expires_at),
    check("chat_attachments_kind", sql`${t.kind} IN ('image','text')`),
    check(
      "chat_attachments_bytes",
      sql`${t.bytes} > 0 AND ${t.bytes} <= ${CHAT_ATTACHMENT_MAX_BYTES_BOUND}`,
    ),
    check("chat_attachments_created_at", intBounded(t.created_at)),
    check("chat_attachments_expires_at", intBounded(t.expires_at)),
    check(
      "chat_attachments_deleted_at",
      sql`${t.deleted_at} IS NULL OR ${intBounded(t.deleted_at)}`,
    ),
  ],
);

// --- support lead intake (paid chatbot-integration requests) ---
export const supportLeads = pgTable(
  "support_leads",
  {
    id: text("id").primaryKey(),
    contact_email: text("contact_email").notNull(),
    contact_channel: text("contact_channel"),
    workspace_id: text("workspace_id").references(() => workspaces.id),
    message: text("message").notNull(),
    status: text("status", { enum: ["open", "handled"] })
      .notNull()
      .default("open"),
    created_at: big("created_at").notNull(),
    handled_at: big("handled_at"),
    handled_by: text("handled_by").references(() => users.id),
  },
  (t) => [
    check("sl_status", sql`${t.status} IN ('open','handled')`),
    check("sl_created_at", intBounded(t.created_at)),
    check("sl_handled_at", sql`${t.handled_at} IS NULL OR ${intBounded(t.handled_at)}`),
  ],
);

// --- audit ---
export const auditLog = pgTable("audit_log", {
  id: text("id").primaryKey(),
  actor_user_id: text("actor_user_id").references(() => users.id),
  workspace_id: text("workspace_id").references(() => workspaces.id),
  action: text("action").notNull(),
  target: text("target").notNull(),
  detail: jsonb("detail"),
  created_at: big("created_at").notNull(),
});
