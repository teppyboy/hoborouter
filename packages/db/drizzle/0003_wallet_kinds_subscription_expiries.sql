CREATE TABLE "subscription_expiries" (
	"subscription_id" text PRIMARY KEY NOT NULL,
	"period_end" bigint NOT NULL,
	"ledger_entry_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "se_period_end" CHECK ("subscription_expiries"."period_end" >= 0 AND "subscription_expiries"."period_end" <= 9007199254740991),
	CONSTRAINT "se_created_at" CHECK ("subscription_expiries"."created_at" >= 0 AND "subscription_expiries"."created_at" <= 9007199254740991)
);
--> statement-breakpoint
DROP INDEX "wallets_workspace_id";--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN "rate_limit_per_minute" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "kind" text DEFAULT 'topup' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_expiries" ADD CONSTRAINT "subscription_expiries_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_expiries" ADD CONSTRAINT "subscription_expiries_ledger_entry_id_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_workspace_kind" ON "wallets" USING btree ("workspace_id","kind");--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD CONSTRAINT "sp_rate_limit_per_minute" CHECK ("subscription_plans"."rate_limit_per_minute" >= 1 AND "subscription_plans"."rate_limit_per_minute" <= 600);--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_kind" CHECK ("wallets"."kind" IN ('topup','subscription'));