CREATE TABLE `api_key_model_permissions` (
	`api_key_id` text NOT NULL,
	`model_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`api_key_id`, `model_id`),
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `billing_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`wallet_id` text NOT NULL,
	`request_id` text NOT NULL,
	`api_key_id` text,
	`model_id` text NOT NULL,
	`model_price_id` text NOT NULL,
	`usd_vnd_exchange_rate` integer NOT NULL,
	`markup_ppm` integer NOT NULL,
	`cap_vnd` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`model_price_id`) REFERENCES `model_prices`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "billing_reservations_money" CHECK(typeof("billing_reservations"."cap_vnd") = 'integer' AND "billing_reservations"."cap_vnd" > 0 AND "billing_reservations"."cap_vnd" <= 9007199254740991 AND typeof("billing_reservations"."usd_vnd_exchange_rate") = 'integer' AND "billing_reservations"."usd_vnd_exchange_rate" > 0 AND "billing_reservations"."usd_vnd_exchange_rate" <= 9007199254740991 AND typeof("billing_reservations"."markup_ppm") = 'integer' AND "billing_reservations"."markup_ppm" >= 0 AND "billing_reservations"."markup_ppm" <= 9007199254740991),
	CONSTRAINT "billing_reservations_status" CHECK("billing_reservations"."status" IN ('held','settled','settled_full_hold','released'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_reservations_request_id_unique` ON `billing_reservations` (`request_id`);--> statement-breakpoint
CREATE TABLE `model_prices` (
	`id` text PRIMARY KEY NOT NULL,
	`model_id` text NOT NULL,
	`input_usd_micro_per_1m` integer NOT NULL,
	`output_usd_micro_per_1m` integer NOT NULL,
	`cached_input_usd_micro_per_1m` integer NOT NULL,
	`reasoning_usd_micro_per_1m` integer NOT NULL,
	`markup_ppm` integer NOT NULL,
	`effective_at` integer NOT NULL,
	`retired_at` integer,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "model_prices_integer_nonnegative" CHECK(typeof("model_prices"."input_usd_micro_per_1m") = 'integer' AND "model_prices"."input_usd_micro_per_1m" >= 0 AND "model_prices"."input_usd_micro_per_1m" <= 9007199254740991 AND typeof("model_prices"."output_usd_micro_per_1m") = 'integer' AND "model_prices"."output_usd_micro_per_1m" >= 0 AND "model_prices"."output_usd_micro_per_1m" <= 9007199254740991 AND typeof("model_prices"."cached_input_usd_micro_per_1m") = 'integer' AND "model_prices"."cached_input_usd_micro_per_1m" >= 0 AND "model_prices"."cached_input_usd_micro_per_1m" <= 9007199254740991 AND typeof("model_prices"."reasoning_usd_micro_per_1m") = 'integer' AND "model_prices"."reasoning_usd_micro_per_1m" >= 0 AND "model_prices"."reasoning_usd_micro_per_1m" <= 9007199254740991),
	CONSTRAINT "model_prices_markup" CHECK(typeof("model_prices"."markup_ppm") = 'integer' AND "model_prices"."markup_ppm" >= 0 AND "model_prices"."markup_ppm" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE `models` (
	`id` text PRIMARY KEY NOT NULL,
	`public_id` text NOT NULL,
	`slug` text NOT NULL,
	`display_name` text NOT NULL,
	`provider` text NOT NULL,
	`description` text,
	`capabilities` text,
	`context_window` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`published` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `models_public_id` ON `models` (`public_id`);--> statement-breakpoint
CREATE TABLE `provider_model_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`model_id` text NOT NULL,
	`provider` text NOT NULL,
	`upstream_model` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `usage_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_id` text NOT NULL,
	`api_key_id` text,
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`public_model` text NOT NULL,
	`upstream_model` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cached_input_tokens` integer NOT NULL,
	`reasoning_tokens` integer NOT NULL,
	`status` text NOT NULL,
	`failure` text,
	`latency_ms` integer,
	`ttft_ms` integer,
	`upstream_cost_usd_micro` integer,
	`usd_vnd_exchange_rate` integer,
	`markup_ppm` integer,
	`charged_vnd` integer,
	`raw_payload` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "usage_logs_tokens_nonnegative" CHECK(typeof("usage_logs"."input_tokens") = 'integer' AND "usage_logs"."input_tokens" >= 0 AND "usage_logs"."input_tokens" <= 9007199254740991 AND typeof("usage_logs"."output_tokens") = 'integer' AND "usage_logs"."output_tokens" >= 0 AND "usage_logs"."output_tokens" <= 9007199254740991 AND typeof("usage_logs"."cached_input_tokens") = 'integer' AND "usage_logs"."cached_input_tokens" >= 0 AND "usage_logs"."cached_input_tokens" <= 9007199254740991 AND typeof("usage_logs"."reasoning_tokens") = 'integer' AND "usage_logs"."reasoning_tokens" >= 0 AND "usage_logs"."reasoning_tokens" <= 9007199254740991 AND "usage_logs"."cached_input_tokens" <= "usage_logs"."input_tokens" AND "usage_logs"."reasoning_tokens" <= "usage_logs"."output_tokens"),
	CONSTRAINT "usage_logs_snapshot_money" CHECK(("usage_logs"."upstream_cost_usd_micro" IS NULL OR (typeof("usage_logs"."upstream_cost_usd_micro") = 'integer' AND "usage_logs"."upstream_cost_usd_micro" >= 0 AND "usage_logs"."upstream_cost_usd_micro" <= 9007199254740991)) AND ("usage_logs"."usd_vnd_exchange_rate" IS NULL OR (typeof("usage_logs"."usd_vnd_exchange_rate") = 'integer' AND "usage_logs"."usd_vnd_exchange_rate" > 0 AND "usage_logs"."usd_vnd_exchange_rate" <= 9007199254740991)) AND ("usage_logs"."markup_ppm" IS NULL OR (typeof("usage_logs"."markup_ppm") = 'integer' AND "usage_logs"."markup_ppm" >= 0 AND "usage_logs"."markup_ppm" <= 9007199254740991)) AND ("usage_logs"."charged_vnd" IS NULL OR (typeof("usage_logs"."charged_vnd") = 'integer' AND "usage_logs"."charged_vnd" >= 0 AND "usage_logs"."charged_vnd" <= 9007199254740991)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_logs_idempotency_key_unique` ON `usage_logs` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `usage_logs_request_id_unique` ON `usage_logs` (`request_id`);--> statement-breakpoint
ALTER TABLE `requests` ADD `model_id` text REFERENCES `models`(`id`);--> statement-breakpoint
ALTER TABLE `requests` ADD `provider_model_mapping_id` text REFERENCES `provider_model_mappings`(`id`);--> statement-breakpoint
ALTER TABLE `requests` ADD `dispatch_state` text NOT NULL DEFAULT 'reserved';--> statement-breakpoint
ALTER TABLE `requests` ADD `dispatched_at` integer;--> statement-breakpoint
CREATE TABLE `__new_settlements` (`id` text PRIMARY KEY NOT NULL, `reservation_id` text, `billing_reservation_id` text, `charged_input` integer NOT NULL, `charged_output` integer NOT NULL, `charged_total` integer NOT NULL, `settled_at` integer NOT NULL, `charged_vnd` integer, `usage_log_id` text, `reason` text, `created_at` integer, FOREIGN KEY (`reservation_id`) REFERENCES `reservations`(`id`), FOREIGN KEY (`billing_reservation_id`) REFERENCES `billing_reservations`(`id`), FOREIGN KEY (`usage_log_id`) REFERENCES `usage_logs`(`id`), CONSTRAINT `st_one_reservation` CHECK((`reservation_id` IS NOT NULL) != (`billing_reservation_id` IS NOT NULL)), CONSTRAINT `st_charged_vnd_nonneg` CHECK(`charged_vnd` IS NULL OR (typeof(`charged_vnd`) = 'integer' AND `charged_vnd` >= 0 AND `charged_vnd` <= 9007199254740991)), CONSTRAINT `st_charged_input_nonneg` CHECK(`charged_input` >= 0), CONSTRAINT `st_charged_output_nonneg` CHECK(`charged_output` >= 0), CONSTRAINT `st_charged_total_nonneg` CHECK(`charged_total` >= 0));
--> statement-breakpoint
INSERT INTO `__new_settlements` (id,reservation_id,charged_input,charged_output,charged_total,settled_at) SELECT id,reservation_id,charged_input,charged_output,charged_total,settled_at FROM settlements;
--> statement-breakpoint
DROP TABLE settlements;
--> statement-breakpoint
ALTER TABLE `__new_settlements` RENAME TO settlements;
--> statement-breakpoint
CREATE UNIQUE INDEX `settlements_reservation_id` ON settlements(reservation_id);
--> statement-breakpoint
CREATE UNIQUE INDEX `settlements_billing_reservation_id` ON settlements(billing_reservation_id);
--> statement-breakpoint
CREATE TRIGGER requests_dispatch_state_guard_insert BEFORE INSERT ON requests BEGIN SELECT CASE WHEN NEW.dispatch_state NOT IN ('reserved','dispatching','terminal') THEN RAISE(ABORT, 'invalid dispatch_state') END; END;--> statement-breakpoint
CREATE TRIGGER requests_dispatch_state_guard_update BEFORE UPDATE OF dispatch_state ON requests BEGIN SELECT CASE WHEN NEW.dispatch_state NOT IN ('reserved','dispatching','terminal') THEN RAISE(ABORT, 'invalid dispatch_state') END; END;--> statement-breakpoint
CREATE TRIGGER model_prices_no_update BEFORE UPDATE ON model_prices BEGIN SELECT RAISE(ABORT, 'model_prices is immutable'); END;--> statement-breakpoint
CREATE TRIGGER model_prices_no_delete BEFORE DELETE ON model_prices BEGIN SELECT RAISE(ABORT, 'model_prices is immutable'); END;--> statement-breakpoint
CREATE TRIGGER usage_logs_no_update BEFORE UPDATE ON usage_logs BEGIN SELECT RAISE(ABORT, 'usage_logs is immutable'); END;--> statement-breakpoint
CREATE TRIGGER usage_logs_no_delete BEFORE DELETE ON usage_logs BEGIN SELECT RAISE(ABORT, 'usage_logs is immutable'); END;--> statement-breakpoint
CREATE TRIGGER api_keys_status_guard BEFORE INSERT ON api_keys BEGIN SELECT CASE WHEN NEW.status NOT IN ('active','enabled','disabled','revoked') THEN RAISE(ABORT, 'invalid api key status') END; END;--> statement-breakpoint
CREATE TRIGGER api_keys_status_update_guard BEFORE UPDATE OF status ON api_keys BEGIN SELECT CASE WHEN NEW.status NOT IN ('active','enabled','disabled','revoked') THEN RAISE(ABORT, 'invalid api key status') END; END;--> statement-breakpoint
CREATE TRIGGER settlements_link_guard BEFORE INSERT ON settlements BEGIN SELECT CASE WHEN ((NEW.reservation_id IS NOT NULL) = (NEW.billing_reservation_id IS NOT NULL)) THEN RAISE(ABORT, 'exactly one reservation link required') END; END;--> statement-breakpoint
CREATE TRIGGER settlements_usage_fk_guard BEFORE INSERT ON settlements WHEN NEW.usage_log_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM usage_logs WHERE id = NEW.usage_log_id) BEGIN SELECT RAISE(ABORT, 'invalid usage_log_id') END; END;--> statement-breakpoint
CREATE TRIGGER settlements_cap_guard BEFORE INSERT ON settlements WHEN NEW.billing_reservation_id IS NOT NULL AND (NEW.charged_vnd IS NULL OR NEW.charged_vnd > (SELECT cap_vnd FROM billing_reservations WHERE id = NEW.billing_reservation_id)) BEGIN SELECT RAISE(ABORT, 'charged_vnd exceeds cap') END; END;--> statement-breakpoint
CREATE TRIGGER settlements_cap_guard_update BEFORE UPDATE OF charged_vnd, billing_reservation_id ON settlements WHEN NEW.billing_reservation_id IS NOT NULL AND (NEW.charged_vnd IS NULL OR NEW.charged_vnd > (SELECT cap_vnd FROM billing_reservations WHERE id = NEW.billing_reservation_id)) BEGIN SELECT RAISE(ABORT, 'charged_vnd exceeds cap') END; END;