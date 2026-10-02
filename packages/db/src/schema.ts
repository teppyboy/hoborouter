// Task 2 handoff (Task 3, Better Auth): `users` is the MINIMAL referenced
// identity contract — the Task 2 migration creates only `users (id TEXT
// PRIMARY KEY)`. Better Auth's generated tables (via @better-auth/cli +
// drizzle-kit, configured so the user table is named `users` — set
// `user: { modelName: "users" }` in the Better Auth config, or reconcile the
// generated table name before generating its migration) will extend this
// table. Do NOT invent full user/session/account/verification definitions
// here; packages/db/src/schema.ts must re-export the generated
// auth-schema.ts in Task 3 instead of this placeholder.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

// `users`/`session`/`account`/`verification` are Better Auth-generated
// (auth-schema.ts, @better-auth/cli). Re-export scope-local bindings (bare
// `export *` breaks FK builders like workspaceMembers.user_id.references(() => users.id)).
import { users, session, account, verification } from "./auth-schema";
export { users, session, account, verification };

/** Largest integer representable exactly in IEEE doubles — upper bound for all canonical money/token columns. */
export const MAX_SAFE_INTEGER_MONEY = 9007199254740991;
const MAX_BOUND = sql.raw(String(MAX_SAFE_INTEGER_MONEY));
const intBounded = (col: unknown) =>
  sql`typeof(${col}) = 'integer' AND ${col} >= 0 AND ${col} <= ${MAX_BOUND}`;

// --- workspaces & keys ---
export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status", { enum: ["active", "suspended"] })
    .notNull()
    .default("active"),
  created_at: integer("created_at").notNull(),
});

export const workspaceMembers = sqliteTable(
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

export const instanceAdmins = sqliteTable("instance_admins", {
  user_id: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  created_at: integer("created_at").notNull(),
  added_by: text("added_by"),
});

export const apiKeys = sqliteTable(
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
    created_at: integer("created_at").notNull(),
    last_used_at: integer("last_used_at"),
    revoked_at: integer("revoked_at"),
  },
  (t) => [
    uniqueIndex("api_keys_key_hash").on(t.key_hash),
    check("api_keys_status", sql`${t.status} IN ('active','enabled','disabled','revoked')`),
  ],
);

export const keyRateLimits = sqliteTable("key_rate_limits", {
  api_key_id: text("api_key_id")
    .primaryKey()
    .references(() => apiKeys.id),
  window: text("window").notNull(),
  max_requests: integer("max_requests").notNull(),
});

// --- wallet & ledger ---
export const wallets = sqliteTable(
  "wallets",
  {
    id: text("id").primaryKey(),
    workspace_id: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    currency: text("currency").notNull().default("VND"),
    balance: integer("balance").notNull(),
    reserved: integer("reserved").notNull(),
    version: integer("version").notNull().default(0),
    created_at: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("wallets_workspace_id").on(t.workspace_id),
    check("wallets_currency", sql`${t.currency} = 'VND'`),
    check("wallets_balance_type", sql`typeof(${t.balance}) = 'integer'`),
    check("wallets_reserved_type", sql`typeof(${t.reserved}) = 'integer'`),
    check("wallets_balance_nonneg", sql`${t.balance} >= 0`),
    check("wallets_reserved_nonneg", sql`${t.reserved} >= 0`),
    check("wallets_balance_gte_reserved", sql`${t.balance} >= ${t.reserved}`),
  ],
);

export const ledgerEntries = sqliteTable(
  "ledger_entries",
  {
    id: text("id").primaryKey(),
    wallet_id: text("wallet_id")
      .notNull()
      .references(() => wallets.id),
    direction: text("direction", { enum: ["debit", "credit"] }).notNull(),
    billing_reservation_id: text("billing_reservation_id").references(() => billingReservations.id),
    amount: integer("amount").notNull(),
    kind: text("kind", { enum: ["topup", "settle", "adjustment", "refund"] }).notNull(),
    reservation_id: text("reservation_id").references(() => reservations.id),
    original_ledger_entry_id: text("original_ledger_entry_id").references(
      (): AnySQLiteColumn => ledgerEntries.id,
    ),
    payment_id: text("payment_id").references(() => payments.id),
    balance_after: integer("balance_after").notNull(),
    memo: text("memo"),
    created_at: integer("created_at").notNull(),
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
    check("ledger_direction", sql`${t.direction} IN ('debit','credit')`),
    check("ledger_kind", sql`${t.kind} IN ('topup','settle','adjustment','refund')`),
    check("ledger_amount_type", sql`typeof(${t.amount}) = 'integer'`),
    check("ledger_amount_positive", sql`${t.amount} > 0`),
    check("ledger_balance_after_type", sql`typeof(${t.balance_after}) = 'integer'`),
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
// --- payments ---
export const payments = sqliteTable(
  "payments",
  {
    id: text("id").primaryKey(),
    workspace_id: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    amount: integer("amount").notNull(),
    status: text("status", {
      enum: ["pending", "succeeded", "failed", "expired"],
    }).notNull(),
    provider: text("provider", { enum: ["mock", "vietqr_manual", "payos"] }).notNull(),
    provider_order_code: text("provider_order_code").notNull(),
    created_at: integer("created_at").notNull(),
    expires_at: integer("expires_at"),
  },
  (t) => [
    uniqueIndex("payments_provider_order").on(t.provider, t.provider_order_code),
    check("payments_amount_type", sql`typeof(${t.amount}) = 'integer'`),
    check("payments_amount_positive", sql`${t.amount} > 0`),
  ],
);

export const paymentEvents = sqliteTable(
  "payment_events",
  {
    id: text("id").primaryKey(),
    payment_id: text("payment_id")
      .notNull()
      .references(() => payments.id),
    provider: text("provider").notNull(),
    provider_reference: text("provider_reference").notNull(),
    raw_payload: text("raw_payload"),
    signature_valid: integer("signature_valid", { mode: "boolean" }),
    processed_at: integer("processed_at").notNull(),
  },
  (t) => [uniqueIndex("payment_events_provider_reference").on(t.provider, t.provider_reference)],
);

// --- canonical paid-gateway catalog ---
export const models = sqliteTable(
  "models",
  {
    id: text("id").primaryKey(),
    public_id: text("public_id").notNull(),
    slug: text("slug").notNull(),
    display_name: text("display_name").notNull(),
    provider: text("provider").notNull(),
    description: text("description"),
    capabilities: text("capabilities", { mode: "json" }),
    context_window: integer("context_window"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    published: integer("published", { mode: "boolean" }).notNull().default(false),
    // Per-model prompt-caching override; 'inherit' follows the global
    // instance_settings.prompt_caching_enabled flag.
    prompt_caching: text("prompt_caching", { enum: ["inherit", "on", "off"] })
      .notNull()
      .default("inherit"),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("models_public_id").on(t.public_id),
    check("models_prompt_caching", sql`${t.prompt_caching} IN ('inherit', 'on', 'off')`),
  ],
);

export const providerModelMappings = sqliteTable("provider_model_mappings", {
  id: text("id").primaryKey(),
  model_id: text("model_id")
    .notNull()
    .references(() => models.id),
  provider: text("provider").notNull(),
  upstream_model: text("upstream_model").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  created_at: integer("created_at").notNull(),
  updated_at: integer("updated_at").notNull(),
});

export const modelPrices = sqliteTable(
  "model_prices",
  {
    id: text("id").primaryKey(),
    model_id: text("model_id")
      .notNull()
      .references(() => models.id),
    input_usd_micro_per_1m: integer("input_usd_micro_per_1m").notNull(),
    output_usd_micro_per_1m: integer("output_usd_micro_per_1m").notNull(),
    cached_input_usd_micro_per_1m: integer("cached_input_usd_micro_per_1m").notNull(),
    reasoning_usd_micro_per_1m: integer("reasoning_usd_micro_per_1m").notNull(),
    markup_ppm: integer("markup_ppm").notNull(),
    effective_at: integer("effective_at").notNull(),
    retired_at: integer("retired_at"),
  },
  (t) => [
    check(
      "model_prices_integer_nonnegative",
      sql`typeof(${t.input_usd_micro_per_1m}) = 'integer' AND ${intBounded(t.input_usd_micro_per_1m)} AND typeof(${t.output_usd_micro_per_1m}) = 'integer' AND ${intBounded(t.output_usd_micro_per_1m)} AND typeof(${t.cached_input_usd_micro_per_1m}) = 'integer' AND ${intBounded(t.cached_input_usd_micro_per_1m)} AND typeof(${t.reasoning_usd_micro_per_1m}) = 'integer' AND ${intBounded(t.reasoning_usd_micro_per_1m)}`,
    ),
    check("model_prices_markup", intBounded(t.markup_ppm)),
  ],
);

export const apiKeyModelPermissions = sqliteTable(
  "api_key_model_permissions",
  {
    api_key_id: text("api_key_id")
      .notNull()
      .references(() => apiKeys.id),
    model_id: text("model_id")
      .notNull()
      .references(() => models.id),
    created_at: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.api_key_id, t.model_id] })],
);

// --- model catalog & price snapshots ---
export const modelBindings = sqliteTable(
  "model_bindings",
  {
    id: text("id").primaryKey(),
    workspace_id: text("workspace_id").references(() => workspaces.id), // NULL = global
    public_model: text("public_model").notNull(),
    cpa_alias: text("cpa_alias").notNull(),
    status: text("status", { enum: ["published", "disabled"] }).notNull(),
    price_input_per_1m: integer("price_input_per_1m").notNull(),
    price_output_per_1m: integer("price_output_per_1m").notNull(),
    effective_at: integer("effective_at").notNull(),
  },
  (t) => [
    check("mb_price_input_type", sql`typeof(${t.price_input_per_1m}) = 'integer'`),
    check("mb_price_output_type", sql`typeof(${t.price_output_per_1m}) = 'integer'`),
    check("mb_price_input_nonneg", sql`${t.price_input_per_1m} >= 0`),
    check("mb_price_output_nonneg", sql`${t.price_output_per_1m} >= 0`),
    check("mb_status", sql`${t.status} IN ('published','disabled')`),
  ],
);

export const priceSnapshots = sqliteTable(
  "price_snapshots",
  {
    id: text("id").primaryKey(),
    binding_id: text("binding_id")
      .notNull()
      .references(() => modelBindings.id),
    price_input: integer("price_input").notNull(),
    price_output: integer("price_output").notNull(),
    created_at: integer("created_at").notNull(),
  },
  (t) => [
    check("ps_price_input_type", sql`typeof(${t.price_input}) = 'integer'`),
    check("ps_price_input_nonneg", sql`${t.price_input} >= 0`),
    check("ps_price_output_type", sql`typeof(${t.price_output}) = 'integer'`),
    check("ps_price_output_nonneg", sql`${t.price_output} >= 0`),
  ],
);

// --- requests & usage ---
export const requests = sqliteTable(
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
    dispatched_at: integer("dispatched_at"),
    http_status: integer("http_status"),
    ttft_ms: integer("ttft_ms"),
    duration_ms: integer("duration_ms"),
    created_at: integer("created_at").notNull(),
  },
  (t) => [
    index("requests_cpa_trace_idx").on(t.cpa_trace_id),
    check("requests_endpoint", sql`${t.endpoint} IN ('/v1/chat/completions','/v1/responses')`),
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

export const usageEvents = sqliteTable("usage_events", {
  id: text("id").primaryKey(),
  source_request_id: text("source_request_id").notNull(),
  cpa_execution_uuid: text("cpa_execution_uuid"),
  gateway_request_id: text("gateway_request_id").references(() => requests.id),
  tokens_input: integer("tokens_input").notNull(),
  tokens_output: integer("tokens_output").notNull(),
  tokens_reasoning: integer("tokens_reasoning").notNull(),
  tokens_cached: integer("tokens_cached").notNull(),
  tokens_total: integer("tokens_total").notNull(),
  failed: integer("failed", { mode: "boolean" }).notNull(),
  latency_ms: integer("latency_ms"),
  raw_payload: text("raw_payload"),
  ingested_at: integer("ingested_at").notNull(),
});

// --- reservations ---
export const reservations = sqliteTable(
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
    cap_amount: integer("cap_amount").notNull(),
    estimated_input_tokens: integer("estimated_input_tokens").notNull(),
    created_at: integer("created_at").notNull(),
    resolved_at: integer("resolved_at"),
    expires_at: integer("expires_at"),
  },
  (t) => [
    uniqueIndex("reservations_gateway_request_id").on(t.gateway_request_id),
    check("res_cap_amount_type", sql`typeof(${t.cap_amount}) = 'integer'`),
    check("res_cap_amount_positive", sql`${t.cap_amount} > 0`),
    check("res_status", sql`${t.status} IN ('held','settled','released','unknown')`),
  ],
);

export const billingReservations = sqliteTable(
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
    usd_vnd_exchange_rate: integer("usd_vnd_exchange_rate").notNull(),
    markup_ppm: integer("markup_ppm").notNull(),
    cap_vnd: integer("cap_vnd").notNull(),
    status: text("status", {
      enum: ["held", "settled", "settled_full_hold", "released"],
    }).notNull(),
    created_at: integer("created_at").notNull(),
    resolved_at: integer("resolved_at"),
  },
  (t) => [
    check(
      "billing_reservations_money",
      sql`typeof(${t.cap_vnd}) = 'integer' AND ${t.cap_vnd} > 0 AND ${t.cap_vnd} <= ${MAX_BOUND} AND typeof(${t.usd_vnd_exchange_rate}) = 'integer' AND ${t.usd_vnd_exchange_rate} > 0 AND ${t.usd_vnd_exchange_rate} <= ${MAX_BOUND} AND typeof(${t.markup_ppm}) = 'integer' AND ${t.markup_ppm} >= 0 AND ${t.markup_ppm} <= ${MAX_BOUND}`,
    ),
    check(
      "billing_reservations_status",
      sql`${t.status} IN ('held','settled','settled_full_hold','released')`,
    ),
  ],
);

export const usageLogs = sqliteTable(
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
    input_tokens: integer("input_tokens").notNull(),
    output_tokens: integer("output_tokens").notNull(),
    cached_input_tokens: integer("cached_input_tokens").notNull(),
    reasoning_tokens: integer("reasoning_tokens").notNull(),
    status: text("status").notNull(),
    failure: text("failure"),
    latency_ms: integer("latency_ms"),
    ttft_ms: integer("ttft_ms"),
    upstream_cost_usd_micro: integer("upstream_cost_usd_micro"),
    usd_vnd_exchange_rate: integer("usd_vnd_exchange_rate"),
    markup_ppm: integer("markup_ppm"),
    charged_vnd: integer("charged_vnd"),
    raw_payload: text("raw_payload"),
    created_at: integer("created_at").notNull(),
  },
  (t) => [
    check(
      "usage_logs_tokens_nonnegative",
      sql`typeof(${t.input_tokens}) = 'integer' AND ${intBounded(t.input_tokens)} AND typeof(${t.output_tokens}) = 'integer' AND ${intBounded(t.output_tokens)} AND typeof(${t.cached_input_tokens}) = 'integer' AND ${intBounded(t.cached_input_tokens)} AND typeof(${t.reasoning_tokens}) = 'integer' AND ${intBounded(t.reasoning_tokens)} AND ${t.cached_input_tokens} <= ${t.input_tokens} AND ${t.reasoning_tokens} <= ${t.output_tokens}`,
    ),
    check(
      "usage_logs_snapshot_money",
      sql`(${t.upstream_cost_usd_micro} IS NULL OR (typeof(${t.upstream_cost_usd_micro}) = 'integer' AND ${t.upstream_cost_usd_micro} >= 0 AND ${t.upstream_cost_usd_micro} <= ${MAX_BOUND})) AND (${t.usd_vnd_exchange_rate} IS NULL OR (typeof(${t.usd_vnd_exchange_rate}) = 'integer' AND ${t.usd_vnd_exchange_rate} > 0 AND ${t.usd_vnd_exchange_rate} <= ${MAX_BOUND})) AND (${t.markup_ppm} IS NULL OR (typeof(${t.markup_ppm}) = 'integer' AND ${t.markup_ppm} >= 0 AND ${t.markup_ppm} <= ${MAX_BOUND})) AND (${t.charged_vnd} IS NULL OR (typeof(${t.charged_vnd}) = 'integer' AND ${t.charged_vnd} >= 0 AND ${t.charged_vnd} <= ${MAX_BOUND}))`,
    ),
  ],
);

/** Instance-level key/value settings (e.g. prompt_caching_enabled). Values are the string 'true'/'false' for booleans. */
export const instanceSettings = sqliteTable("instance_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updated_at: integer("updated_at").notNull(),
});

// --- Phase 2 settlement tables (schema preserved per spec; no app code touches them) ---
export const settlements = sqliteTable(
  "settlements",
  {
    id: text("id").primaryKey(),
    reservation_id: text("reservation_id").references(() => reservations.id),
    billing_reservation_id: text("billing_reservation_id").references(() => billingReservations.id),
    charged_input: integer("charged_input").notNull(),
    charged_output: integer("charged_output").notNull(),
    charged_total: integer("charged_total").notNull(),
    settled_at: integer("settled_at").notNull(),
    charged_vnd: integer("charged_vnd"),
    usage_log_id: text("usage_log_id").references(() => usageLogs.id),
    reason: text("reason"),
    created_at: integer("created_at"),
  },
  (t) => [
    uniqueIndex("settlements_reservation_id").on(t.reservation_id),
    uniqueIndex("settlements_billing_reservation_id").on(t.billing_reservation_id),
    check("st_charged_input_type", sql`typeof(${t.charged_input}) = 'integer'`),
    check("st_charged_output_type", sql`typeof(${t.charged_output}) = 'integer'`),
    check("st_charged_input_nonneg", sql`${t.charged_input} >= 0`),
    check("st_charged_output_nonneg", sql`${t.charged_output} >= 0`),
    check("st_charged_total_type", sql`typeof(${t.charged_total}) = 'integer'`),
    check("st_charged_total_nonneg", sql`${t.charged_total} >= 0`),
    check(
      "st_charged_vnd_nonneg",
      sql`${t.charged_vnd} IS NULL OR (typeof(${t.charged_vnd}) = 'integer' AND ${t.charged_vnd} >= 0 AND ${t.charged_vnd} <= ${MAX_BOUND})`,
    ),
    check(
      "st_one_reservation",
      sql`(${t.reservation_id} IS NOT NULL) != (${t.billing_reservation_id} IS NOT NULL)`,
    ),
  ],
);

export const settlementUsageEvents = sqliteTable(
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

export const unknownResolutions = sqliteTable(
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
    created_at: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("ur_resolution_key").on(t.resolution_key),
    uniqueIndex("ur_request_id").on(t.request_id),
    check("ur_outcome", sql`${t.outcome} IN ('hold_release','manual_settle')`),
  ],
);

export const refundOperations = sqliteTable(
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
    amount: integer("amount").notNull(),
    result: text("result").notNull(),
    actor_user_id: text("actor_user_id").references(() => users.id),
    created_at: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("ro_operation_key").on(t.operation_key),
    uniqueIndex("ro_original_ledger_entry_id").on(t.original_ledger_entry_id),
    check("ro_amount_type", sql`typeof(${t.amount}) = 'integer'`),
    check("ro_amount_positive", sql`${t.amount} > 0`),
  ],
);

// --- audit ---
export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey(),
  actor_user_id: text("actor_user_id").references(() => users.id),
  workspace_id: text("workspace_id").references(() => workspaces.id),
  action: text("action").notNull(),
  target: text("target").notNull(),
  detail: text("detail", { mode: "json" }),
  created_at: integer("created_at").notNull(),
});
