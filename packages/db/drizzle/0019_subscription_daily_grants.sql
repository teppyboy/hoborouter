ALTER TABLE "subscription_plans" ADD COLUMN "daily_grant_vnd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD CONSTRAINT "sp_daily_grant_vnd" CHECK ("subscription_plans"."daily_grant_vnd" >= 0 AND "subscription_plans"."daily_grant_vnd" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_kind";--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_kind" CHECK ("ledger_entries"."kind" IN ('topup','settle','adjustment','refund','subscription_daily_grant'));--> statement-breakpoint
CREATE TABLE "subscription_daily_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"grant_day" text NOT NULL,
	"amount" bigint NOT NULL,
	"ledger_entry_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "subscription_daily_grants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "subscription_daily_grants_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "subscription_daily_grants_plan_id_subscription_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plans"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "subscription_daily_grants_ledger_entry_id_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "sdg_grant_day" CHECK ("subscription_daily_grants"."grant_day" ~ '^\d{4}-\d{2}-\d{2}$'),
	CONSTRAINT "sdg_amount" CHECK ("subscription_daily_grants"."amount" > 0 AND "subscription_daily_grants"."amount" <= 9007199254740991),
	CONSTRAINT "sdg_created_at" CHECK ("subscription_daily_grants"."created_at" >= 0 AND "subscription_daily_grants"."created_at" <= 9007199254740991)
);--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_daily_grants_one_per_day" ON "subscription_daily_grants" USING btree ("workspace_id","subscription_id","grant_day");
