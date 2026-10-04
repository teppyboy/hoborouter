CREATE TABLE "credit_bundles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"price_vnd" bigint NOT NULL,
	"credit_vnd" bigint NOT NULL,
	"bonus_vnd" bigint DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "cb_price_vnd" CHECK ("credit_bundles"."price_vnd" > 0 AND "credit_bundles"."price_vnd" <= 9007199254740991),
	CONSTRAINT "cb_credit_vnd" CHECK ("credit_bundles"."credit_vnd" >= 0 AND "credit_bundles"."credit_vnd" <= 9007199254740991),
	CONSTRAINT "cb_bonus_vnd" CHECK ("credit_bundles"."bonus_vnd" >= 0 AND "credit_bundles"."bonus_vnd" <= 9007199254740991),
	CONSTRAINT "cb_created_at" CHECK ("credit_bundles"."created_at" >= 0 AND "credit_bundles"."created_at" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "first_topup_bonuses" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"payment_id" text NOT NULL,
	"ledger_entry_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "ftb_amount" CHECK ("first_topup_bonuses"."amount" > 0 AND "first_topup_bonuses"."amount" <= 9007199254740991),
	CONSTRAINT "ftb_created_at" CHECK ("first_topup_bonuses"."created_at" >= 0 AND "first_topup_bonuses"."created_at" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "subscription_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"price_vnd" bigint NOT NULL,
	"credit_per_period_vnd" bigint NOT NULL,
	"period_days" integer DEFAULT 30 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "sp_price_vnd" CHECK ("subscription_plans"."price_vnd" > 0 AND "subscription_plans"."price_vnd" <= 9007199254740991),
	CONSTRAINT "sp_credit_per_period_vnd" CHECK ("subscription_plans"."credit_per_period_vnd" >= 0 AND "subscription_plans"."credit_per_period_vnd" <= 9007199254740991),
	CONSTRAINT "sp_period_days" CHECK ("subscription_plans"."period_days" >= 1),
	CONSTRAINT "sp_created_at" CHECK ("subscription_plans"."created_at" >= 0 AND "subscription_plans"."created_at" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"current_period_start" bigint NOT NULL,
	"current_period_end" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "subscriptions_status" CHECK ("subscriptions"."status" IN ('active','canceled')),
	CONSTRAINT "subscriptions_period" CHECK ("subscriptions"."current_period_start" < "subscriptions"."current_period_end"),
	CONSTRAINT "subscriptions_current_period_start" CHECK ("subscriptions"."current_period_start" >= 0 AND "subscriptions"."current_period_start" <= 9007199254740991),
	CONSTRAINT "subscriptions_current_period_end" CHECK ("subscriptions"."current_period_end" >= 0 AND "subscriptions"."current_period_end" <= 9007199254740991),
	CONSTRAINT "subscriptions_created_at" CHECK ("subscriptions"."created_at" >= 0 AND "subscriptions"."created_at" <= 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "bundle_id" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "subscription_plan_id" text;--> statement-breakpoint
ALTER TABLE "first_topup_bonuses" ADD CONSTRAINT "first_topup_bonuses_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "first_topup_bonuses" ADD CONSTRAINT "first_topup_bonuses_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "first_topup_bonuses" ADD CONSTRAINT "first_topup_bonuses_ledger_entry_id_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_subscription_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_one_active_per_workspace" ON "subscriptions" USING btree ("workspace_id") WHERE status = 'active';--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_bundle_id_credit_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."credit_bundles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_subscription_plan_id_subscription_plans_id_fk" FOREIGN KEY ("subscription_plan_id") REFERENCES "public"."subscription_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_one_adjustment_per_payment_memo" ON "ledger_entries" USING btree ("payment_id","memo") WHERE kind = 'adjustment';--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_one_purchase_kind" CHECK ("payments"."bundle_id" IS NULL OR "payments"."subscription_plan_id" IS NULL);
