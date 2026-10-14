-- Member chat policy (0025). Historical period rows are never reset by any
-- policy update: workspaces columns only ADD policy state; usage rows and
-- persisted hold tickets survive unchanged.
ALTER TABLE "workspaces" ADD COLUMN "member_chat_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "member_chat_daily_cap_vnd" bigint;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_member_chat_cap" CHECK ("workspaces"."member_chat_daily_cap_vnd" IS NULL OR ("workspaces"."member_chat_daily_cap_vnd" > 0 AND "workspaces"."member_chat_daily_cap_vnd" <= 9007199254740991));--> statement-breakpoint

ALTER TABLE "api_keys" ADD COLUMN "owner_user_id" text REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_purpose";--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_purpose" CHECK ("api_keys"."purpose" IN ('generic','chat','chat_member'));--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_chat_member_owner" CHECK ("api_keys"."purpose" != 'chat_member' OR "api_keys"."owner_user_id" IS NOT NULL);--> statement-breakpoint

CREATE TABLE "member_chat_usage" (
  "workspace_id" text NOT NULL REFERENCES "workspaces"("id"),
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "period_start" text NOT NULL,
  "used_vnd" bigint DEFAULT 0 NOT NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  PRIMARY KEY ("workspace_id", "user_id", "period_start")
);--> statement-breakpoint
ALTER TABLE "member_chat_usage" ADD CONSTRAINT "mcu_period_start" CHECK ("member_chat_usage"."period_start" ~ '^\d{4}-\d{2}-\d{2}$');--> statement-breakpoint
ALTER TABLE "member_chat_usage" ADD CONSTRAINT "mcu_used_vnd" CHECK ("member_chat_usage"."used_vnd" >= 0 AND "member_chat_usage"."used_vnd" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "member_chat_usage" ADD CONSTRAINT "mcu_created_at" CHECK ("member_chat_usage"."created_at" >= 0 AND "member_chat_usage"."created_at" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "member_chat_usage" ADD CONSTRAINT "mcu_updated_at" CHECK ("member_chat_usage"."updated_at" >= 0 AND "member_chat_usage"."updated_at" <= 9007199254740991);--> statement-breakpoint

-- Persisted hold tickets: member daily-cap period key + key-budget period
-- snapshot. Settlements of old periods modify the OLD period row only.
ALTER TABLE "billing_reservations" ADD COLUMN "member_budget_user_id" text REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "billing_reservations" ADD COLUMN "member_budget_period_start" text;--> statement-breakpoint
ALTER TABLE "billing_reservations" ADD COLUMN "key_budget_period_start" bigint;--> statement-breakpoint
ALTER TABLE "billing_reservations" ADD CONSTRAINT "billing_reservations_member_ticket_pair" CHECK (("billing_reservations"."member_budget_user_id" IS NULL) = ("billing_reservations"."member_budget_period_start" IS NULL));--> statement-breakpoint
ALTER TABLE "billing_reservations" ADD CONSTRAINT "billing_reservations_key_period_start_bound" CHECK ("billing_reservations"."key_budget_period_start" IS NULL OR ("billing_reservations"."key_budget_period_start" >= 0 AND "billing_reservations"."key_budget_period_start" <= 9007199254740991));
