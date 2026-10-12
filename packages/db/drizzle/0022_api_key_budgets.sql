ALTER TABLE "api_keys" ADD COLUMN "expires_at" bigint;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "budget_vnd" bigint;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "budget_period" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "budget_used_vnd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "budget_period_start" bigint;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_expires_at_bound" CHECK ("api_keys"."expires_at" IS NULL OR ("api_keys"."expires_at" >= 0 AND "api_keys"."expires_at" <= 9007199254740991));--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_budget_vnd_bound" CHECK ("api_keys"."budget_vnd" IS NULL OR ("api_keys"."budget_vnd" > 0 AND "api_keys"."budget_vnd" <= 9007199254740991));--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_budget_period_enum" CHECK ("api_keys"."budget_period" IS NULL OR "api_keys"."budget_period" IN ('daily','weekly','monthly'));--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_budget_used_bound" CHECK ("api_keys"."budget_used_vnd" >= 0 AND "api_keys"."budget_used_vnd" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_budget_period_start_bound" CHECK ("api_keys"."budget_period_start" IS NULL OR ("api_keys"."budget_period_start" >= 0 AND "api_keys"."budget_period_start" <= 9007199254740991));--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_budget_pair" CHECK (("api_keys"."budget_vnd" IS NULL) = ("api_keys"."budget_period" IS NULL));--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_budget_start_required" CHECK ("api_keys"."budget_vnd" IS NULL OR "api_keys"."budget_period_start" IS NOT NULL);
