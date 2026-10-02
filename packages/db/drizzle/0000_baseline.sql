CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" bigint,
	"refresh_token_expires_at" bigint,
	"scope" text,
	"password" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_key_model_permissions" (
	"api_key_id" text NOT NULL,
	"model_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "api_key_model_permissions_api_key_id_model_id_pk" PRIMARY KEY("api_key_id","model_id")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" bigint NOT NULL,
	"last_used_at" bigint,
	"revoked_at" bigint,
	CONSTRAINT "api_keys_status" CHECK ("api_keys"."status" IN ('active','enabled','disabled','revoked'))
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_user_id" text,
	"workspace_id" text,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"detail" jsonb,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet_id" text NOT NULL,
	"request_id" text NOT NULL,
	"api_key_id" text,
	"model_id" text NOT NULL,
	"model_price_id" text NOT NULL,
	"usd_vnd_exchange_rate" bigint NOT NULL,
	"markup_ppm" bigint NOT NULL,
	"cap_vnd" bigint NOT NULL,
	"status" text NOT NULL,
	"created_at" bigint NOT NULL,
	"resolved_at" bigint,
	CONSTRAINT "billing_reservations_request_id_unique" UNIQUE("request_id"),
	CONSTRAINT "billing_reservations_money" CHECK ("billing_reservations"."cap_vnd" > 0 AND "billing_reservations"."cap_vnd" <= 9007199254740991 AND "billing_reservations"."usd_vnd_exchange_rate" > 0 AND "billing_reservations"."usd_vnd_exchange_rate" <= 9007199254740991 AND "billing_reservations"."markup_ppm" >= 0 AND "billing_reservations"."markup_ppm" <= 9007199254740991),
	CONSTRAINT "billing_reservations_status" CHECK ("billing_reservations"."status" IN ('held','settled','settled_full_hold','released'))
);
--> statement-breakpoint
CREATE TABLE "instance_admins" (
	"user_id" text PRIMARY KEY NOT NULL,
	"created_at" bigint NOT NULL,
	"added_by" text
);
--> statement-breakpoint
CREATE TABLE "instance_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "key_rate_limits" (
	"api_key_id" text PRIMARY KEY NOT NULL,
	"window" text NOT NULL,
	"max_requests" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet_id" text NOT NULL,
	"direction" text NOT NULL,
	"billing_reservation_id" text,
	"amount" bigint NOT NULL,
	"kind" text NOT NULL,
	"reservation_id" text,
	"original_ledger_entry_id" text,
	"payment_id" text,
	"balance_after" bigint NOT NULL,
	"memo" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "ledger_direction" CHECK ("ledger_entries"."direction" IN ('debit','credit')),
	CONSTRAINT "ledger_kind" CHECK ("ledger_entries"."kind" IN ('topup','settle','adjustment','refund')),
	CONSTRAINT "ledger_amount_type" CHECK ("ledger_entries"."amount" > 0 AND "ledger_entries"."amount" <= 9007199254740991),
	CONSTRAINT "ledger_balance_after_type" CHECK ("ledger_entries"."balance_after" >= 0 AND "ledger_entries"."balance_after" <= 9007199254740991),
	CONSTRAINT "ledger_refund_requires_original" CHECK (kind != 'refund' OR "ledger_entries"."original_ledger_entry_id" IS NOT NULL),
	CONSTRAINT "ledger_topup_settle_no_original" CHECK (kind NOT IN ('topup','settle') OR "ledger_entries"."original_ledger_entry_id" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "model_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"public_model" text NOT NULL,
	"cpa_alias" text NOT NULL,
	"status" text NOT NULL,
	"price_input_per_1m" bigint NOT NULL,
	"price_output_per_1m" bigint NOT NULL,
	"effective_at" bigint NOT NULL,
	CONSTRAINT "mb_price_input_type" CHECK ("model_bindings"."price_input_per_1m" >= 0 AND "model_bindings"."price_input_per_1m" <= 9007199254740991),
	CONSTRAINT "mb_price_output_type" CHECK ("model_bindings"."price_output_per_1m" >= 0 AND "model_bindings"."price_output_per_1m" <= 9007199254740991),
	CONSTRAINT "mb_status" CHECK ("model_bindings"."status" IN ('published','disabled'))
);
--> statement-breakpoint
CREATE TABLE "model_prices" (
	"id" text PRIMARY KEY NOT NULL,
	"model_id" text NOT NULL,
	"input_usd_micro_per_1m" bigint NOT NULL,
	"output_usd_micro_per_1m" bigint NOT NULL,
	"cached_input_usd_micro_per_1m" bigint NOT NULL,
	"reasoning_usd_micro_per_1m" bigint NOT NULL,
	"markup_ppm" bigint NOT NULL,
	"effective_at" bigint NOT NULL,
	"retired_at" bigint,
	CONSTRAINT "model_prices_integer_nonnegative" CHECK ("model_prices"."input_usd_micro_per_1m" >= 0 AND "model_prices"."input_usd_micro_per_1m" <= 9007199254740991 AND "model_prices"."output_usd_micro_per_1m" >= 0 AND "model_prices"."output_usd_micro_per_1m" <= 9007199254740991 AND "model_prices"."cached_input_usd_micro_per_1m" >= 0 AND "model_prices"."cached_input_usd_micro_per_1m" <= 9007199254740991 AND "model_prices"."reasoning_usd_micro_per_1m" >= 0 AND "model_prices"."reasoning_usd_micro_per_1m" <= 9007199254740991),
	CONSTRAINT "model_prices_markup" CHECK ("model_prices"."markup_ppm" >= 0 AND "model_prices"."markup_ppm" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"provider" text NOT NULL,
	"description" text,
	"capabilities" jsonb,
	"context_window" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"prompt_caching" text DEFAULT 'inherit' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "models_prompt_caching" CHECK ("models"."prompt_caching" IN ('inherit', 'on', 'off'))
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" text PRIMARY KEY NOT NULL,
	"payment_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_reference" text NOT NULL,
	"raw_payload" text,
	"signature_valid" boolean,
	"processed_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"status" text NOT NULL,
	"provider" text NOT NULL,
	"provider_order_code" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint,
	CONSTRAINT "payments_amount_type" CHECK ("payments"."amount" > 0 AND "payments"."amount" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "price_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"binding_id" text NOT NULL,
	"price_input" bigint NOT NULL,
	"price_output" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "ps_price_input_type" CHECK ("price_snapshots"."price_input" >= 0 AND "price_snapshots"."price_input" <= 9007199254740991),
	CONSTRAINT "ps_price_output_type" CHECK ("price_snapshots"."price_output" >= 0 AND "price_snapshots"."price_output" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "provider_model_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"model_id" text NOT NULL,
	"provider" text NOT NULL,
	"upstream_model" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refund_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"operation_key" text NOT NULL,
	"original_ledger_entry_id" text NOT NULL,
	"request_id" text NOT NULL,
	"reservation_id" text NOT NULL,
	"payload_hash" text NOT NULL,
	"amount" bigint NOT NULL,
	"result" text NOT NULL,
	"actor_user_id" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "ro_amount_type" CHECK ("refund_operations"."amount" > 0 AND "refund_operations"."amount" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"api_key_id" text,
	"model_binding_id" text,
	"model_id" text,
	"provider_model_mapping_id" text,
	"endpoint" text NOT NULL,
	"mode" text NOT NULL,
	"cpa_trace_id" text,
	"status" text NOT NULL,
	"dispatch_state" text DEFAULT 'reserved' NOT NULL,
	"dispatched_at" bigint,
	"http_status" integer,
	"ttft_ms" integer,
	"duration_ms" integer,
	"created_at" bigint NOT NULL,
	"deleted_at" bigint,
	"deleted_by" text,
	CONSTRAINT "requests_endpoint" CHECK ("requests"."endpoint" IN ('/v1/chat/completions','/v1/responses')),
	CONSTRAINT "requests_mode" CHECK ("requests"."mode" IN ('stream','non-stream')),
	CONSTRAINT "requests_status" CHECK ("requests"."status" IN ('pending','ok','client_abort','upstream_error','unknown')),
	CONSTRAINT "requests_dispatch_state" CHECK ("requests"."dispatch_state" IN ('reserved','dispatching','terminal')),
	CONSTRAINT "requests_model_source" CHECK ("requests"."model_binding_id" IS NOT NULL OR "requests"."model_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet_id" text NOT NULL,
	"gateway_request_id" text NOT NULL,
	"api_key_id" text,
	"price_snapshot_id" text NOT NULL,
	"status" text NOT NULL,
	"cap_amount" bigint NOT NULL,
	"estimated_input_tokens" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"resolved_at" bigint,
	"expires_at" bigint,
	CONSTRAINT "res_cap_amount_type" CHECK ("reservations"."cap_amount" > 0 AND "reservations"."cap_amount" <= 9007199254740991),
	CONSTRAINT "res_status" CHECK ("reservations"."status" IN ('held','settled','released','unknown'))
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" bigint NOT NULL,
	"token" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "settlement_usage_events" (
	"settlement_id" text NOT NULL,
	"usage_event_id" text NOT NULL,
	CONSTRAINT "settlement_usage_events_settlement_id_usage_event_id_pk" PRIMARY KEY("settlement_id","usage_event_id")
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" text PRIMARY KEY NOT NULL,
	"reservation_id" text,
	"billing_reservation_id" text,
	"charged_input" bigint NOT NULL,
	"charged_output" bigint NOT NULL,
	"charged_total" bigint NOT NULL,
	"settled_at" bigint NOT NULL,
	"charged_vnd" bigint,
	"usage_log_id" text,
	"reason" text,
	"created_at" bigint,
	CONSTRAINT "st_charged_input_type" CHECK ("settlements"."charged_input" >= 0 AND "settlements"."charged_input" <= 9007199254740991),
	CONSTRAINT "st_charged_output_type" CHECK ("settlements"."charged_output" >= 0 AND "settlements"."charged_output" <= 9007199254740991),
	CONSTRAINT "st_charged_total_type" CHECK ("settlements"."charged_total" >= 0 AND "settlements"."charged_total" <= 9007199254740991),
	CONSTRAINT "st_charged_vnd_nonneg" CHECK ("settlements"."charged_vnd" IS NULL OR "settlements"."charged_vnd" >= 0 AND "settlements"."charged_vnd" <= 9007199254740991),
	CONSTRAINT "st_one_reservation" CHECK (("settlements"."reservation_id" IS NOT NULL) != ("settlements"."billing_reservation_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "unknown_resolutions" (
	"id" text PRIMARY KEY NOT NULL,
	"resolution_key" text NOT NULL,
	"request_id" text NOT NULL,
	"reservation_id" text NOT NULL,
	"payload_hash" text NOT NULL,
	"outcome" text NOT NULL,
	"result" text NOT NULL,
	"actor_user_id" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "ur_outcome" CHECK ("unknown_resolutions"."outcome" IN ('hold_release','manual_settle'))
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"source_request_id" text NOT NULL,
	"cpa_execution_uuid" text,
	"gateway_request_id" text,
	"tokens_input" bigint NOT NULL,
	"tokens_output" bigint NOT NULL,
	"tokens_reasoning" bigint NOT NULL,
	"tokens_cached" bigint NOT NULL,
	"tokens_total" bigint NOT NULL,
	"failed" boolean NOT NULL,
	"latency_ms" integer,
	"raw_payload" text,
	"ingested_at" bigint NOT NULL,
	CONSTRAINT "usage_events_tokens_nonnegative" CHECK ("usage_events"."tokens_input" >= 0 AND "usage_events"."tokens_input" <= 9007199254740991 AND "usage_events"."tokens_output" >= 0 AND "usage_events"."tokens_output" <= 9007199254740991 AND "usage_events"."tokens_reasoning" >= 0 AND "usage_events"."tokens_reasoning" <= 9007199254740991 AND "usage_events"."tokens_cached" >= 0 AND "usage_events"."tokens_cached" <= 9007199254740991 AND "usage_events"."tokens_total" >= 0 AND "usage_events"."tokens_total" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "usage_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_id" text NOT NULL,
	"api_key_id" text,
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"public_model" text NOT NULL,
	"upstream_model" text NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cached_input_tokens" bigint NOT NULL,
	"reasoning_tokens" bigint NOT NULL,
	"status" text NOT NULL,
	"failure" text,
	"latency_ms" integer,
	"ttft_ms" integer,
	"upstream_cost_usd_micro" bigint,
	"usd_vnd_exchange_rate" bigint,
	"markup_ppm" bigint,
	"charged_vnd" bigint,
	"raw_payload" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "usage_logs_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "usage_logs_request_id_unique" UNIQUE("request_id"),
	CONSTRAINT "usage_logs_tokens_nonnegative" CHECK ("usage_logs"."input_tokens" >= 0 AND "usage_logs"."input_tokens" <= 9007199254740991 AND "usage_logs"."output_tokens" >= 0 AND "usage_logs"."output_tokens" <= 9007199254740991 AND "usage_logs"."cached_input_tokens" >= 0 AND "usage_logs"."cached_input_tokens" <= 9007199254740991 AND "usage_logs"."reasoning_tokens" >= 0 AND "usage_logs"."reasoning_tokens" <= 9007199254740991 AND "usage_logs"."cached_input_tokens" <= "usage_logs"."input_tokens" AND "usage_logs"."reasoning_tokens" <= "usage_logs"."output_tokens"),
	CONSTRAINT "usage_logs_snapshot_money" CHECK (("usage_logs"."upstream_cost_usd_micro" IS NULL OR "usage_logs"."upstream_cost_usd_micro" >= 0 AND "usage_logs"."upstream_cost_usd_micro" <= 9007199254740991) AND ("usage_logs"."usd_vnd_exchange_rate" IS NULL OR ("usage_logs"."usd_vnd_exchange_rate" > 0 AND "usage_logs"."usd_vnd_exchange_rate" <= 9007199254740991)) AND ("usage_logs"."markup_ppm" IS NULL OR "usage_logs"."markup_ppm" >= 0 AND "usage_logs"."markup_ppm" <= 9007199254740991) AND ("usage_logs"."charged_vnd" IS NULL OR "usage_logs"."charged_vnd" >= 0 AND "usage_logs"."charged_vnd" <= 9007199254740991))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"currency" text DEFAULT 'VND' NOT NULL,
	"balance" bigint NOT NULL,
	"reserved" bigint NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "wallets_currency" CHECK ("wallets"."currency" = 'VND'),
	CONSTRAINT "wallets_balance_type" CHECK ("wallets"."balance" >= 0 AND "wallets"."balance" <= 9007199254740991),
	CONSTRAINT "wallets_reserved_type" CHECK ("wallets"."reserved" >= 0 AND "wallets"."reserved" <= 9007199254740991),
	CONSTRAINT "wallets_balance_gte_reserved" CHECK ("wallets"."balance" >= "wallets"."reserved")
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "workspace_members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id"),
	CONSTRAINT "wm_role" CHECK ("workspace_members"."role" IN ('owner','admin','member'))
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_model_permissions" ADD CONSTRAINT "api_key_model_permissions_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_model_permissions" ADD CONSTRAINT "api_key_model_permissions_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_reservations" ADD CONSTRAINT "billing_reservations_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_reservations" ADD CONSTRAINT "billing_reservations_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_reservations" ADD CONSTRAINT "billing_reservations_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_reservations" ADD CONSTRAINT "billing_reservations_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_reservations" ADD CONSTRAINT "billing_reservations_model_price_id_model_prices_id_fk" FOREIGN KEY ("model_price_id") REFERENCES "public"."model_prices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_admins" ADD CONSTRAINT "instance_admins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key_rate_limits" ADD CONSTRAINT "key_rate_limits_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_billing_reservation_id_billing_reservations_id_fk" FOREIGN KEY ("billing_reservation_id") REFERENCES "public"."billing_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_original_ledger_entry_id_ledger_entries_id_fk" FOREIGN KEY ("original_ledger_entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_bindings" ADD CONSTRAINT "model_bindings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_prices" ADD CONSTRAINT "model_prices_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_snapshots" ADD CONSTRAINT "price_snapshots_binding_id_model_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."model_bindings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_model_mappings" ADD CONSTRAINT "provider_model_mappings_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_operations" ADD CONSTRAINT "refund_operations_original_ledger_entry_id_ledger_entries_id_fk" FOREIGN KEY ("original_ledger_entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_operations" ADD CONSTRAINT "refund_operations_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_operations" ADD CONSTRAINT "refund_operations_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_operations" ADD CONSTRAINT "refund_operations_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_model_binding_id_model_bindings_id_fk" FOREIGN KEY ("model_binding_id") REFERENCES "public"."model_bindings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_provider_model_mapping_id_provider_model_mappings_id_fk" FOREIGN KEY ("provider_model_mapping_id") REFERENCES "public"."provider_model_mappings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_gateway_request_id_requests_id_fk" FOREIGN KEY ("gateway_request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_price_snapshot_id_price_snapshots_id_fk" FOREIGN KEY ("price_snapshot_id") REFERENCES "public"."price_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_usage_events" ADD CONSTRAINT "settlement_usage_events_settlement_id_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."settlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_usage_events" ADD CONSTRAINT "settlement_usage_events_usage_event_id_usage_events_id_fk" FOREIGN KEY ("usage_event_id") REFERENCES "public"."usage_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_billing_reservation_id_billing_reservations_id_fk" FOREIGN KEY ("billing_reservation_id") REFERENCES "public"."billing_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_usage_log_id_usage_logs_id_fk" FOREIGN KEY ("usage_log_id") REFERENCES "public"."usage_logs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unknown_resolutions" ADD CONSTRAINT "unknown_resolutions_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unknown_resolutions" ADD CONSTRAINT "unknown_resolutions_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unknown_resolutions" ADD CONSTRAINT "unknown_resolutions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_gateway_request_id_requests_id_fk" FOREIGN KEY ("gateway_request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD CONSTRAINT "usage_logs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_hash" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "ledger_wallet_idx" ON "ledger_entries" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX "ledger_billing_reservation_idx" ON "ledger_entries" USING btree ("billing_reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_one_settle_per_reservation" ON "ledger_entries" USING btree ("reservation_id") WHERE kind = 'settle';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_one_topup_per_payment" ON "ledger_entries" USING btree ("payment_id") WHERE kind = 'topup';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_one_refund_per_original" ON "ledger_entries" USING btree ("original_ledger_entry_id") WHERE kind = 'refund';--> statement-breakpoint
CREATE UNIQUE INDEX "models_public_id" ON "models" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_provider_reference" ON "payment_events" USING btree ("provider","provider_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_order" ON "payments" USING btree ("provider","provider_order_code");--> statement-breakpoint
CREATE UNIQUE INDEX "ro_operation_key" ON "refund_operations" USING btree ("operation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "ro_original_ledger_entry_id" ON "refund_operations" USING btree ("original_ledger_entry_id");--> statement-breakpoint
CREATE INDEX "requests_cpa_trace_idx" ON "requests" USING btree ("cpa_trace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_gateway_request_id" ON "reservations" USING btree ("gateway_request_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sue_usage_event_id" ON "settlement_usage_events" USING btree ("usage_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_reservation_id" ON "settlements" USING btree ("reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_billing_reservation_id" ON "settlements" USING btree ("billing_reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ur_resolution_key" ON "unknown_resolutions" USING btree ("resolution_key");--> statement-breakpoint
CREATE UNIQUE INDEX "ur_request_id" ON "unknown_resolutions" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_workspace_id" ON "wallets" USING btree ("workspace_id");
-- ledger_entries is append-only (never rewrite money history).
CREATE FUNCTION hbr_append_only_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_no_update
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION hbr_append_only_guard();

-- price_snapshots are immutable; a price change publishes a NEW snapshot
-- referenced by reservations.
CREATE TRIGGER price_snapshots_no_update
BEFORE UPDATE OR DELETE ON price_snapshots
FOR EACH ROW EXECUTE FUNCTION hbr_append_only_guard();

-- model_prices are immutable; a price change inserts a NEW row (migration 0003).
CREATE TRIGGER model_prices_no_update
BEFORE UPDATE OR DELETE ON model_prices
FOR EACH ROW EXECUTE FUNCTION hbr_append_only_guard();

-- usage_logs are append-only; settled usage history is never edited.
CREATE TRIGGER usage_logs_no_update
BEFORE UPDATE OR DELETE ON usage_logs
FOR EACH ROW EXECUTE FUNCTION hbr_append_only_guard();

-- A settlement against a billing reservation may never exceed its cap
-- (migration 0003 settlements_cap_guard / _update).
CREATE FUNCTION hbr_settlements_cap_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.billing_reservation_id IS NOT NULL AND
     (NEW.charged_vnd IS NULL OR NEW.charged_vnd >
       (SELECT cap_vnd FROM billing_reservations WHERE id = NEW.billing_reservation_id)) THEN
    RAISE EXCEPTION 'charged_vnd exceeds cap';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER settlements_cap_guard
BEFORE INSERT ON settlements
FOR EACH ROW EXECUTE FUNCTION hbr_settlements_cap_guard();

CREATE TRIGGER settlements_cap_guard_update
BEFORE UPDATE OF charged_vnd, billing_reservation_id ON settlements
FOR EACH ROW EXECUTE FUNCTION hbr_settlements_cap_guard();
