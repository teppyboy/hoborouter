CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "api_keys_status" CHECK("api_keys"."status" IN ('active','revoked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`workspace_id` text,
	`action` text NOT NULL,
	`target` text NOT NULL,
	`detail` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `instance_admins` (
	`user_id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`added_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `key_rate_limits` (
	`api_key_id` text PRIMARY KEY NOT NULL,
	`window` text NOT NULL,
	`max_requests` integer NOT NULL,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `ledger_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`wallet_id` text NOT NULL,
	`direction` text NOT NULL,
	`amount` integer NOT NULL,
	`kind` text NOT NULL,
	`reservation_id` text,
	`original_ledger_entry_id` text,
	`payment_id` text,
	`balance_after` integer NOT NULL,
	`memo` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reservation_id`) REFERENCES `reservations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`original_ledger_entry_id`) REFERENCES `ledger_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ledger_direction" CHECK("ledger_entries"."direction" IN ('debit','credit')),
	CONSTRAINT "ledger_kind" CHECK("ledger_entries"."kind" IN ('topup','settle','adjustment','refund')),
	CONSTRAINT "ledger_amount_type" CHECK(typeof("ledger_entries"."amount") = 'integer'),
	CONSTRAINT "ledger_amount_positive" CHECK("ledger_entries"."amount" > 0),
	CONSTRAINT "ledger_balance_after_type" CHECK(typeof("ledger_entries"."balance_after") = 'integer'),
	CONSTRAINT "ledger_refund_requires_original" CHECK(kind != 'refund' OR "ledger_entries"."original_ledger_entry_id" IS NOT NULL),
	CONSTRAINT "ledger_topup_settle_no_original" CHECK(kind NOT IN ('topup','settle') OR "ledger_entries"."original_ledger_entry_id" IS NULL)
);
--> statement-breakpoint
CREATE INDEX `ledger_wallet_idx` ON `ledger_entries` (`wallet_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_one_settle_per_reservation` ON `ledger_entries` (`reservation_id`) WHERE kind = 'settle';--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_one_topup_per_payment` ON `ledger_entries` (`payment_id`) WHERE kind = 'topup';--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_one_refund_per_original` ON `ledger_entries` (`original_ledger_entry_id`) WHERE kind = 'refund';--> statement-breakpoint
CREATE TABLE `model_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`public_model` text NOT NULL,
	`cpa_alias` text NOT NULL,
	`status` text NOT NULL,
	`price_input_per_1m` integer NOT NULL,
	`price_output_per_1m` integer NOT NULL,
	`effective_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "mb_price_input_type" CHECK(typeof("model_bindings"."price_input_per_1m") = 'integer'),
	CONSTRAINT "mb_price_output_type" CHECK(typeof("model_bindings"."price_output_per_1m") = 'integer'),
	CONSTRAINT "mb_price_input_nonneg" CHECK("model_bindings"."price_input_per_1m" >= 0),
	CONSTRAINT "mb_price_output_nonneg" CHECK("model_bindings"."price_output_per_1m" >= 0),
	CONSTRAINT "mb_status" CHECK("model_bindings"."status" IN ('published','disabled'))
);
--> statement-breakpoint
CREATE TABLE `payment_events` (
	`id` text PRIMARY KEY NOT NULL,
	`payment_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_reference` text NOT NULL,
	`raw_payload` text,
	`signature_valid` integer,
	`processed_at` integer NOT NULL,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_events_provider_reference` ON `payment_events` (`provider`,`provider_reference`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`amount` integer NOT NULL,
	`status` text NOT NULL,
	`provider` text NOT NULL,
	`provider_order_code` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payments_amount_type" CHECK(typeof("payments"."amount") = 'integer'),
	CONSTRAINT "payments_amount_positive" CHECK("payments"."amount" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_provider_order` ON `payments` (`provider`,`provider_order_code`);--> statement-breakpoint
CREATE TABLE `price_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`binding_id` text NOT NULL,
	`price_input` integer NOT NULL,
	`price_output` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`binding_id`) REFERENCES `model_bindings`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ps_price_input_type" CHECK(typeof("price_snapshots"."price_input") = 'integer'),
	CONSTRAINT "ps_price_input_nonneg" CHECK("price_snapshots"."price_input" >= 0),
	CONSTRAINT "ps_price_output_type" CHECK(typeof("price_snapshots"."price_output") = 'integer'),
	CONSTRAINT "ps_price_output_nonneg" CHECK("price_snapshots"."price_output" >= 0)
);
--> statement-breakpoint
CREATE TABLE `refund_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_key` text NOT NULL,
	`original_ledger_entry_id` text NOT NULL,
	`request_id` text NOT NULL,
	`reservation_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`amount` integer NOT NULL,
	`result` text NOT NULL,
	`actor_user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`original_ledger_entry_id`) REFERENCES `ledger_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reservation_id`) REFERENCES `reservations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ro_amount_type" CHECK(typeof("refund_operations"."amount") = 'integer'),
	CONSTRAINT "ro_amount_positive" CHECK("refund_operations"."amount" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ro_operation_key` ON `refund_operations` (`operation_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `ro_original_ledger_entry_id` ON `refund_operations` (`original_ledger_entry_id`);--> statement-breakpoint
CREATE TABLE `requests` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`api_key_id` text,
	`model_binding_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`mode` text NOT NULL,
	`cpa_trace_id` text,
	`status` text NOT NULL,
	`http_status` integer,
	`ttft_ms` integer,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`model_binding_id`) REFERENCES `model_bindings`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "requests_endpoint" CHECK("requests"."endpoint" IN ('/v1/chat/completions','/v1/responses')),
	CONSTRAINT "requests_mode" CHECK("requests"."mode" IN ('stream','non-stream')),
	CONSTRAINT "requests_status" CHECK("requests"."status" IN ('pending','ok','client_abort','upstream_error','unknown'))
);
--> statement-breakpoint
CREATE INDEX `requests_cpa_trace_idx` ON `requests` (`cpa_trace_id`);--> statement-breakpoint
CREATE TABLE `reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`wallet_id` text NOT NULL,
	`gateway_request_id` text NOT NULL,
	`api_key_id` text,
	`price_snapshot_id` text NOT NULL,
	`status` text NOT NULL,
	`cap_amount` integer NOT NULL,
	`estimated_input_tokens` integer NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	`expires_at` integer,
	FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`gateway_request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`price_snapshot_id`) REFERENCES `price_snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "res_cap_amount_type" CHECK(typeof("reservations"."cap_amount") = 'integer'),
	CONSTRAINT "res_cap_amount_positive" CHECK("reservations"."cap_amount" > 0),
	CONSTRAINT "res_status" CHECK("reservations"."status" IN ('held','settled','released','unknown'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reservations_gateway_request_id` ON `reservations` (`gateway_request_id`);--> statement-breakpoint
CREATE TABLE `settlement_usage_events` (
	`settlement_id` text NOT NULL,
	`usage_event_id` text NOT NULL,
	PRIMARY KEY(`settlement_id`, `usage_event_id`),
	FOREIGN KEY (`settlement_id`) REFERENCES `settlements`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`usage_event_id`) REFERENCES `usage_events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sue_usage_event_id` ON `settlement_usage_events` (`usage_event_id`);--> statement-breakpoint
CREATE TABLE `settlements` (
	`id` text PRIMARY KEY NOT NULL,
	`reservation_id` text NOT NULL,
	`charged_input` integer NOT NULL,
	`charged_output` integer NOT NULL,
	`charged_total` integer NOT NULL,
	`settled_at` integer NOT NULL,
	FOREIGN KEY (`reservation_id`) REFERENCES `reservations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "st_charged_input_type" CHECK(typeof("settlements"."charged_input") = 'integer'),
	CONSTRAINT "st_charged_output_type" CHECK(typeof("settlements"."charged_output") = 'integer'),
	CONSTRAINT "st_charged_input_nonneg" CHECK("settlements"."charged_input" >= 0),
	CONSTRAINT "st_charged_output_nonneg" CHECK("settlements"."charged_output" >= 0),
	CONSTRAINT "st_charged_total_type" CHECK(typeof("settlements"."charged_total") = 'integer'),
	CONSTRAINT "st_charged_total_nonneg" CHECK("settlements"."charged_total" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `settlements_reservation_id` ON `settlements` (`reservation_id`);--> statement-breakpoint
CREATE TABLE `unknown_resolutions` (
	`id` text PRIMARY KEY NOT NULL,
	`resolution_key` text NOT NULL,
	`request_id` text NOT NULL,
	`reservation_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`outcome` text NOT NULL,
	`result` text NOT NULL,
	`actor_user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reservation_id`) REFERENCES `reservations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ur_outcome" CHECK("unknown_resolutions"."outcome" IN ('hold_release','manual_settle'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ur_resolution_key` ON `unknown_resolutions` (`resolution_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `ur_request_id` ON `unknown_resolutions` (`request_id`);--> statement-breakpoint
CREATE TABLE `usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`source_request_id` text NOT NULL,
	`cpa_execution_uuid` text,
	`gateway_request_id` text,
	`tokens_input` integer NOT NULL,
	`tokens_output` integer NOT NULL,
	`tokens_reasoning` integer NOT NULL,
	`tokens_cached` integer NOT NULL,
	`tokens_total` integer NOT NULL,
	`failed` integer NOT NULL,
	`latency_ms` integer,
	`raw_payload` text,
	`ingested_at` integer NOT NULL,
	FOREIGN KEY (`gateway_request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `wallets` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`currency` text DEFAULT 'VND' NOT NULL,
	`balance` integer NOT NULL,
	`reserved` integer NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "wallets_currency" CHECK("wallets"."currency" = 'VND'),
	CONSTRAINT "wallets_balance_type" CHECK(typeof("wallets"."balance") = 'integer'),
	CONSTRAINT "wallets_reserved_type" CHECK(typeof("wallets"."reserved") = 'integer'),
	CONSTRAINT "wallets_balance_nonneg" CHECK("wallets"."balance" >= 0),
	CONSTRAINT "wallets_reserved_nonneg" CHECK("wallets"."reserved" >= 0),
	CONSTRAINT "wallets_balance_gte_reserved" CHECK("wallets"."balance" >= "wallets"."reserved")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wallets_workspace_id` ON `wallets` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "wm_role" CHECK("workspace_members"."role" IN ('owner','admin','member'))
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL
);
