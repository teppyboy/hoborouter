CREATE TABLE `__new_requests` (`id` text PRIMARY KEY NOT NULL, `workspace_id` text NOT NULL, `api_key_id` text, `model_binding_id` text, `model_id` text, `provider_model_mapping_id` text, `endpoint` text NOT NULL, `mode` text NOT NULL, `cpa_trace_id` text, `status` text NOT NULL, `dispatch_state` text DEFAULT 'reserved' NOT NULL, `dispatched_at` integer, `http_status` integer, `ttft_ms` integer, `duration_ms` integer, `created_at` integer NOT NULL, FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`), FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`), FOREIGN KEY (`model_binding_id`) REFERENCES `model_bindings`(`id`), FOREIGN KEY (`model_id`) REFERENCES `models`(`id`), FOREIGN KEY (`provider_model_mapping_id`) REFERENCES `provider_model_mappings`(`id`), CONSTRAINT "requests_endpoint" CHECK("endpoint" IN ('/v1/chat/completions','/v1/responses')), CONSTRAINT "requests_mode" CHECK("mode" IN ('stream','non-stream')), CONSTRAINT "requests_status" CHECK("status" IN ('pending','ok','client_abort','upstream_error','unknown')), CONSTRAINT "requests_dispatch_state" CHECK("dispatch_state" IN ('reserved','dispatching','terminal')), CONSTRAINT "requests_model_source" CHECK("model_binding_id" IS NOT NULL OR "model_id" IS NOT NULL));
--> statement-breakpoint
INSERT INTO `__new_requests` (id,workspace_id,api_key_id,model_binding_id,model_id,provider_model_mapping_id,endpoint,mode,cpa_trace_id,status,dispatch_state,dispatched_at,http_status,ttft_ms,duration_ms,created_at) SELECT id,workspace_id,api_key_id,model_binding_id,model_id,provider_model_mapping_id,endpoint,mode,cpa_trace_id,status,dispatch_state,dispatched_at,http_status,ttft_ms,duration_ms,created_at FROM `requests`;
--> statement-breakpoint
DROP TABLE `requests`;
--> statement-breakpoint
ALTER TABLE `__new_requests` RENAME TO `requests`;
--> statement-breakpoint
CREATE INDEX `requests_cpa_trace_idx` ON `requests` (`cpa_trace_id`);
--> statement-breakpoint
CREATE TRIGGER requests_dispatch_state_guard_insert BEFORE INSERT ON requests BEGIN SELECT CASE WHEN NEW.dispatch_state NOT IN ('reserved','dispatching','terminal') THEN RAISE(ABORT, 'invalid dispatch_state') END; END;--> statement-breakpoint
CREATE TRIGGER requests_dispatch_state_guard_update BEFORE UPDATE OF dispatch_state ON requests BEGIN SELECT CASE WHEN NEW.dispatch_state NOT IN ('reserved','dispatching','terminal') THEN RAISE(ABORT, 'invalid dispatch_state') END; END;--> statement-breakpoint
ALTER TABLE `ledger_entries` ADD `billing_reservation_id` text REFERENCES `billing_reservations`(`id`);
--> statement-breakpoint
CREATE INDEX `ledger_billing_reservation_idx` ON `ledger_entries` (`billing_reservation_id`);
