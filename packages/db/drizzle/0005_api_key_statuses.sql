CREATE TABLE `__new_api_keys` (`id` text PRIMARY KEY NOT NULL, `workspace_id` text NOT NULL, `key_hash` text NOT NULL, `key_prefix` text NOT NULL, `name` text NOT NULL, `status` text DEFAULT 'active' NOT NULL, `created_at` integer NOT NULL, `last_used_at` integer, `revoked_at` integer, FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action, CONSTRAINT "api_keys_status" CHECK("status" IN ('active','enabled','disabled','revoked')));
--> statement-breakpoint
INSERT INTO `__new_api_keys` (id,workspace_id,key_hash,key_prefix,name,status,created_at,last_used_at,revoked_at) SELECT id,workspace_id,key_hash,key_prefix,name,status,created_at,last_used_at,revoked_at FROM `api_keys`;
--> statement-breakpoint
DROP TABLE `api_keys`;
--> statement-breakpoint
ALTER TABLE `__new_api_keys` RENAME TO `api_keys`;
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash` ON `api_keys` (`key_hash`);
--> statement-breakpoint
CREATE TRIGGER api_keys_status_guard BEFORE INSERT ON api_keys BEGIN SELECT CASE WHEN NEW.status NOT IN ('active','enabled','disabled','revoked') THEN RAISE(ABORT, 'invalid api key status') END; END;
--> statement-breakpoint
CREATE TRIGGER api_keys_status_update_guard BEFORE UPDATE OF status ON api_keys BEGIN SELECT CASE WHEN NEW.status NOT IN ('active','enabled','disabled','revoked') THEN RAISE(ABORT, 'invalid api key status') END; END;
--> statement-breakpoint
CREATE TABLE `__new_settlements` (`id` text PRIMARY KEY NOT NULL, `reservation_id` text, `billing_reservation_id` text, `charged_input` integer NOT NULL, `charged_output` integer NOT NULL, `charged_total` integer NOT NULL, `settled_at` integer NOT NULL, `charged_vnd` integer, `usage_log_id` text, `reason` text, `created_at` integer, FOREIGN KEY (`reservation_id`) REFERENCES `reservations`(`id`), FOREIGN KEY (`billing_reservation_id`) REFERENCES `billing_reservations`(`id`), FOREIGN KEY (`usage_log_id`) REFERENCES `usage_logs`(`id`), CONSTRAINT `st_one_reservation` CHECK((`reservation_id` IS NOT NULL) != (`billing_reservation_id` IS NOT NULL)), CONSTRAINT `st_charged_vnd_nonneg` CHECK(`charged_vnd` IS NULL OR (typeof(`charged_vnd`) = 'integer' AND `charged_vnd` >= 0 AND `charged_vnd` <= 9007199254740991)), CONSTRAINT `st_charged_input_type` CHECK(typeof(`charged_input`) = 'integer'), CONSTRAINT `st_charged_output_type` CHECK(typeof(`charged_output`) = 'integer'), CONSTRAINT `st_charged_total_type` CHECK(typeof(`charged_total`) = 'integer'), CONSTRAINT `st_charged_input_nonneg` CHECK(`charged_input` >= 0), CONSTRAINT `st_charged_output_nonneg` CHECK(`charged_output` >= 0), CONSTRAINT `st_charged_total_nonneg` CHECK(`charged_total` >= 0));
--> statement-breakpoint
INSERT INTO `__new_settlements` (id,reservation_id,billing_reservation_id,charged_input,charged_output,charged_total,settled_at,charged_vnd,usage_log_id,reason,created_at) SELECT id,reservation_id,billing_reservation_id,charged_input,charged_output,charged_total,settled_at,charged_vnd,usage_log_id,reason,created_at FROM `settlements`;
--> statement-breakpoint
DROP TABLE `settlements`;
--> statement-breakpoint
ALTER TABLE `__new_settlements` RENAME TO `settlements`;
--> statement-breakpoint
CREATE UNIQUE INDEX `settlements_reservation_id` ON `settlements` (`reservation_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `settlements_billing_reservation_id` ON `settlements` (`billing_reservation_id`);
--> statement-breakpoint
CREATE TRIGGER settlements_link_guard BEFORE INSERT ON settlements BEGIN SELECT CASE WHEN ((NEW.reservation_id IS NOT NULL) = (NEW.billing_reservation_id IS NOT NULL)) THEN RAISE(ABORT, 'exactly one reservation link required') END; END;
--> statement-breakpoint
CREATE TRIGGER settlements_usage_fk_guard BEFORE INSERT ON settlements WHEN NEW.usage_log_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM usage_logs WHERE id = NEW.usage_log_id) BEGIN SELECT RAISE(ABORT, 'invalid usage_log_id') END; END;
--> statement-breakpoint
CREATE TRIGGER settlements_cap_guard BEFORE INSERT ON settlements WHEN NEW.billing_reservation_id IS NOT NULL AND (NEW.charged_vnd IS NULL OR NEW.charged_vnd > (SELECT cap_vnd FROM billing_reservations WHERE id = NEW.billing_reservation_id)) BEGIN SELECT RAISE(ABORT, 'charged_vnd exceeds cap') END; END;
--> statement-breakpoint
CREATE TRIGGER settlements_cap_guard_update BEFORE UPDATE OF charged_vnd, billing_reservation_id ON settlements WHEN NEW.billing_reservation_id IS NOT NULL AND (NEW.charged_vnd IS NULL OR NEW.charged_vnd > (SELECT cap_vnd FROM billing_reservations WHERE id = NEW.billing_reservation_id)) BEGIN SELECT RAISE(ABORT, 'charged_vnd exceeds cap') END; END;
